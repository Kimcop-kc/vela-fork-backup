/**
 * 文风指南的编译与渲染
 *
 * 核心不变量：**没有证据的规则不进入指南**。
 * 无论是量化分析得出的规则，还是模型归纳出的规则，
 * 都必须能在参考文本里指回原文片段，否则一律丢弃。
 */
import i18n from '../../i18n'
import { locateQuote, splitParagraphSpans, splitSentenceSpans, countMeaningfulChars } from '../text-analysis'
import type { StyleEvidence, StyleGuide, StyleMetrics, StyleRule, StyleRuleCategory } from './types'
import { STYLE_RULE_CATEGORIES } from './types'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 生成规则 id（同一类别 + 同一指令在多轮编译之间保持稳定） */
export function styleRuleId(category: string, statement: string): string {
  let hash = 5381
  const seed = `${category}::${statement}`
  for (let index = 0; index < seed.length; index++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0
  }
  return `rule-${hash.toString(36)}`
}

const CATEGORY_KEYWORDS: Array<{ category: StyleRuleCategory; keywords: string[] }> = [
  { category: 'voice', keywords: ['voice', 'pov', 'person', '视角', '人称', '叙述者'] },
  { category: 'syntax', keywords: ['syntax', 'sentence', '句式', '句长', '语法'] },
  { category: 'rhythm', keywords: ['rhythm', 'paragraph', 'pace', '节奏', '段落', '留白'] },
  { category: 'dialogue', keywords: ['dialogue', 'dialog', '对话', '台词'] },
  { category: 'lexicon', keywords: ['lexicon', 'word', 'vocabulary', '用词', '词汇', '表达'] },
  { category: 'imagery', keywords: ['imagery', 'metaphor', 'image', '意象', '修辞', '比喻'] },
  { category: 'punctuation', keywords: ['punctuation', '标点', '符号'] },
]

/** 归一化类别，识别失败返回 null */
export function normalizeCategory(value: unknown): StyleRuleCategory | null {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  if (!lower) return null
  if ((STYLE_RULE_CATEGORIES as string[]).includes(lower)) return lower as StyleRuleCategory
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some(keyword => lower.includes(keyword))) return entry.category
  }
  return null
}

/** 把引文回帖到参考文本，得到带偏移的证据 */
export function anchorEvidence(referenceText: string, quotes: string[]): StyleEvidence[] {
  const evidence: StyleEvidence[] = []
  for (const quote of quotes) {
    const trimmed = quote.trim()
    if (!trimmed) continue
    const located = locateQuote(referenceText, trimmed)
    evidence.push({
      quote: trimmed,
      start: located ? located.start : -1,
      end: located ? located.end : -1,
    })
  }
  return evidence
}

/** 取文本中第一个包含指定字符的句子，作为标点习惯的证据 */
function sentenceContaining(text: string, mark: string): string | null {
  const sentences = splitSentenceSpans(text)
  return sentences.find(item => item.text.includes(mark))?.text.trim() ?? null
}

/** 取最具代表性的段落（最接近平均长度）的首句作为节奏证据 */
function representativeParagraphSentence(text: string): string | null {
  const paragraphs = splitParagraphSpans(text)
  if (paragraphs.length === 0) return null
  const average = paragraphs.reduce((sum, item) => sum + item.text.length, 0) / paragraphs.length
  const sorted = [...paragraphs].sort((a, b) => Math.abs(a.text.length - average) - Math.abs(b.text.length - average))
  const sentences = splitSentenceSpans(sorted[0].text)
  return sentences[0]?.text.trim() ?? sorted[0].text.slice(0, 60)
}

/**
 * 由量化分析直接推导规则。
 * 每条规则都必须带证据；拿不到证据的规则会被跳过。
 */
export function deriveMetricRules(metrics: StyleMetrics, referenceText: string): StyleRule[] {
  const rules: StyleRule[] = []
  const push = (
    category: StyleRuleCategory,
    statement: string,
    evidence: StyleEvidence[],
    metric: { label: string; value: number },
  ) => {
    const usable = evidence.filter(item => item.quote.trim() !== '')
    if (usable.length === 0) return
    rules.push({
      id: styleRuleId(category, statement),
      category,
      statement,
      evidence: usable,
      metric,
      confidence: 'high',
      origin: 'metric',
    })
  }

  const shortestAndLongest = [metrics.signatureSamples.shortest, metrics.signatureSamples.longest]
    .filter((item): item is StyleEvidence => item !== null)

  if (metrics.sentences > 0) {
    push(
      'syntax',
      t('styleGuide.rule.averageSentence', {
        length: metrics.averageSentenceLength,
        low: Math.round(metrics.averageSentenceLength * 0.7),
        high: Math.round(metrics.averageSentenceLength * 1.4),
      }),
      shortestAndLongest,
      { label: 'averageSentenceLength', value: metrics.averageSentenceLength },
    )

    const variation = metrics.sentenceLengthVariation
    push(
      'syntax',
      variation >= 0.45
        ? t('styleGuide.rule.variedSentences')
        : t('styleGuide.rule.evenSentences'),
      shortestAndLongest,
      { label: 'sentenceLengthVariation', value: variation },
    )
  }

  if (metrics.dialogueRatio >= 0.05 && metrics.signatureSamples.dialogue) {
    push(
      'dialogue',
      t('styleGuide.rule.dialogueRatio', { percent: Math.round(metrics.dialogueRatio * 100) }),
      [metrics.signatureSamples.dialogue],
      { label: 'dialogueRatio', value: metrics.dialogueRatio },
    )
  }

  if (metrics.frequentExpressions.length > 0) {
    const top = metrics.frequentExpressions[0]
    push(
      'lexicon',
      t('styleGuide.rule.signatureExpressions', {
        expressions: metrics.frequentExpressions.map(item => item.text).join('、'),
      }),
      anchorEvidence(referenceText, [top.text]),
      { label: 'expressionRepeats', value: top.count },
    )
  }

  for (const item of metrics.punctuationProfile.slice(0, 3)) {
    const sample = sentenceContaining(referenceText, item.mark)
    push(
      'punctuation',
      t('styleGuide.rule.punctuationHabit', { mark: item.mark, perKilo: item.perKiloChars }),
      sample ? anchorEvidence(referenceText, [sample]) : [],
      { label: 'perKiloChars', value: item.perKiloChars },
    )
  }

  if (metrics.paragraphs > 0) {
    const sample = representativeParagraphSentence(referenceText)
    push(
      'rhythm',
      t('styleGuide.rule.paragraphLength', {
        length: metrics.averageParagraphLength,
        low: Math.round(metrics.averageParagraphLength * 0.6),
        high: Math.round(metrics.averageParagraphLength * 1.5),
      }),
      sample ? anchorEvidence(referenceText, [sample]) : [],
      { label: 'averageParagraphLength', value: metrics.averageParagraphLength },
    )
  }

  return rules
}

/** 模型返回的原始规则 */
export interface RawStyleRule {
  category?: unknown
  statement?: unknown
  evidence?: unknown
  confidence?: unknown
}

/**
 * 归一化模型归纳的规则。
 *
 * 与量化规则不同，模型规则往往更具语义价值（视角、意象、语气），
 * 但同样必须带证据 —— 没有证据的规则一律丢弃。
 *
 * @returns rules 归一化后的规则；skipped 因缺少证据/无法识别而被丢弃的条数
 */
export function parseLlmRules(
  raw: unknown,
  referenceText: string,
  skillName: string,
): { rules: StyleRule[]; skipped: number } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { rules?: unknown }).rules)
      ? (raw as { rules: unknown[] }).rules
      : []

  const rules: StyleRule[] = []
  let skipped = 0

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const entry = item as RawStyleRule
    const category = normalizeCategory(entry.category)
    const statement = typeof entry.statement === 'string' ? entry.statement.trim() : ''
    if (!category || !statement) {
      skipped += 1
      continue
    }

    const rawQuotes = Array.isArray(entry.evidence) ? entry.evidence : []
    const quotes = rawQuotes
      .map(quote => (typeof quote === 'string'
        ? quote
        : quote && typeof quote === 'object' && typeof (quote as { quote?: unknown }).quote === 'string'
          ? String((quote as { quote: string }).quote)
          : ''))
      .filter(quote => quote.trim() !== '')
    const evidence = anchorEvidence(referenceText, quotes)
    if (evidence.length === 0) {
      skipped += 1
      continue
    }

    const confidence = entry.confidence === 'high' || entry.confidence === 'low' ? entry.confidence : 'medium'
    rules.push({
      id: styleRuleId(category, statement),
      category,
      statement,
      evidence,
      confidence,
      origin: 'llm',
      skillName,
    })
  }

  return { rules, skipped }
}

/** 合并两份规则列表，按指令文本去重（保留先出现的） */
export function mergeRules(base: StyleRule[], incoming: StyleRule[]): StyleRule[] {
  const merged = [...base]
  const seen = new Set(base.map(rule => rule.statement.trim()))
  for (const rule of incoming) {
    const key = rule.statement.trim()
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(rule)
  }
  return merged
}

/** 渲染为 Markdown 文风指南（可直接写入 NovelConfig.writingStyle） */
export function renderStyleGuide(guide: StyleGuide): string {
  const lines: string[] = []
  lines.push(t('styleGuide.render.title', { title: guide.source.title }))
  lines.push('')
  lines.push(t('styleGuide.render.metrics', {
    characters: guide.metrics.characters,
    sentences: guide.metrics.sentences,
    paragraphs: guide.metrics.paragraphs,
    sentenceLength: guide.metrics.averageSentenceLength,
    paragraphLength: guide.metrics.averageParagraphLength,
    dialogue: Math.round(guide.metrics.dialogueRatio * 100),
    diversity: guide.metrics.lexicalDiversity,
  }))
  lines.push('')

  for (const category of STYLE_RULE_CATEGORIES) {
    const rules = guide.rules.filter(rule => rule.category === category)
    if (rules.length === 0) continue
    lines.push(`## ${t(`styleGuide.category.${category}`)}`)
    for (const rule of rules) {
      lines.push(`- ${rule.statement}`)
      for (const evidence of rule.evidence.slice(0, 3)) {
        lines.push(`  - ${t('styleGuide.render.evidence', { quote: evidence.quote })}`)
      }
    }
    lines.push('')
  }

  lines.push(t('styleGuide.render.footer', { skill: guide.skillName }))
  return lines.join('\n')
}

/** 统计指南的规则数与证据数（供日志与 UI 摘要） */
export function summarizeGuide(guide: StyleGuide): { rules: number; evidence: number; categories: number } {
  return {
    rules: guide.rules.length,
    evidence: guide.rules.reduce((sum, rule) => sum + rule.evidence.length, 0),
    categories: new Set(guide.rules.map(rule => rule.category)).size,
  }
}

/** 参考文本的净字数（供上层做长度校验） */
export function referenceLength(referenceText: string): number {
  return countMeaningfulChars(referenceText)
}
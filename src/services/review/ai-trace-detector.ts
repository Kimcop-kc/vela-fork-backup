/**
 * 内置 AI 痕迹检测（确定性）
 *
 * 职责边界（重要）：
 *   - 本模块只做「标记」：找出高频词、句式单调、过度总结这类可修订位置，
 *     并给出量化指标与修订方向。
 *   - 本模块**不改稿**，也不按隐藏词表自动替换文本。
 *     真正的语义改写能力由可替换的 Skill（de-ai-tone）在用户显式调用时提供。
 *
 * 全部算法为纯函数 + 公开常量，保证检测结论可复现、可审计。
 */
import i18n from '../../i18n'
import type { AiTraceFinding, AiTraceThresholds } from './types'
import {
  coefficientOfVariation,
  countMeaningfulChars,
  countNgrams,
  findAllOccurrences,
  splitParagraphSpans,
  splitSentenceSpans,
} from '../text-analysis'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 默认阈值（全部公开，可通过 options.thresholds 覆盖） */
export const DEFAULT_AI_TRACE_THRESHOLDS: AiTraceThresholds = {
  minWordRepeats: 5,
  maxWordDensityPerKilo: 2.5,
  minSentencesForRhythm: 12,
  maxLengthVariation: 0.35,
  minConsecutiveSameStart: 3,
  minParagraphsForSummary: 3,
}

/**
 * 过度总结的提示短语。
 *
 * 这是公开、可审计、可覆盖的常量：它只用于「标记出可疑的总结句」，
 * 绝不会被用来自动替换或删除正文。用户可以在设置里覆盖它，
 * 也可以完全跳过 AI 痕迹检测。
 */
export const OVER_SUMMARY_CUES: string[] = [
  '这一切', '这一切都', '命运的齿轮', '命运', '注定', '才刚刚开始', '刚刚开始',
  '从此刻起', '从这一刻起', '新的篇章', '新的旅程', '无声地宣告', '宣告',
  '他知道', '她知道', '他们知道', '他明白', '她明白', '他意识到', '她意识到',
  '仿佛', '犹如', '宛如', '意味着', '预示', '宿命', '轮回',
]

/** 抽象名词（与提示短语配合判定「总结式旁白」） */
export const ABSTRACT_NOUNS: string[] = [
  '命运', '一切', '世界', '未来', '真相', '故事', '旅程', '宿命', '轮回',
  '结局', '开端', '篇章', '时代', '洪流', '洪流', '传说', '史诗', '序章',
]

/** 检测选项 */
export interface DetectAiTraceOptions {
  /** 覆盖默认阈值 */
  thresholds?: Partial<AiTraceThresholds>
  /** 每类最多返回多少条（默认 5） */
  maxFindingsPerKind?: number
}

/** 对话引号：出现在句子中时，判定为「非旁白」，跳过总结句检测 */
const DIALOGUE_PATTERN = /「[^」]*」|“[^”]*”|"[^"]*"/

/**
 * 内置 AI 痕迹检测入口。
 *
 * @param text 被审正文
 * @param options 阈值与条数限制
 * @returns 可修订位置列表（按正文位置排序）
 */
export function detectAiTraces(text: string, options: DetectAiTraceOptions = {}): AiTraceFinding[] {
  if (!text || !text.trim()) return []
  const thresholds = { ...DEFAULT_AI_TRACE_THRESHOLDS, ...options.thresholds }
  const maxPerKind = Math.max(1, options.maxFindingsPerKind ?? 5)

  const findings = [
    ...detectHighFrequencyWords(text, thresholds, maxPerKind),
    ...detectMonotonousSentences(text, thresholds, maxPerKind),
    ...detectOverSummary(text, thresholds, maxPerKind),
  ]

  return findings.sort((a, b) => a.start - b.start)
}

// ===== 1. 高频词 =====

function detectHighFrequencyWords(
  text: string,
  thresholds: AiTraceThresholds,
  maxFindings: number,
): AiTraceFinding[] {
  const counts = countNgrams(text, 2, 4)
  const kiloChars = Math.max(1, countMeaningfulChars(text) / 1000)

  const candidates = Array.from(counts.entries())
    .filter(([, repeat]) => repeat >= thresholds.minWordRepeats && repeat / kiloChars >= thresholds.maxWordDensityPerKilo)
    // 出现次数多的优先；次数相同时更长的词更有信息量
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))

  const accepted: Array<[string, number]> = []
  for (const [gram, repeat] of candidates) {
    // 同一批高频词里，「苏离」和「苏离的」会同时命中；保留信息量更大的那个
    const covered = accepted.some(([kept, keptRepeat]) =>
      keptRepeat === repeat && (kept.includes(gram) || gram.includes(kept)))
    if (covered) continue
    accepted.push([gram, repeat])
    if (accepted.length >= maxFindings) break
  }

  return accepted.map(([gram, repeat], index) => {
    const occurrences = findAllOccurrences(text, gram).slice(0, 30)
    const density = Math.round((repeat / kiloChars) * 100) / 100
    return {
      id: `trace-word-${index + 1}`,
      kind: 'high-frequency-word' as const,
      start: occurrences[0]?.start ?? -1,
      end: occurrences[0]?.end ?? -1,
      quote: gram,
      occurrences,
      message: t('review.aiTrace.highFrequency', { word: gram, count: repeat, density }),
      metric: { label: 'perKiloChars', value: density, threshold: thresholds.maxWordDensityPerKilo },
      hint: t('review.aiTrace.highFrequencyHint'),
    }
  })
}

// ===== 2. 句式单调 =====

function detectMonotonousSentences(
  text: string,
  thresholds: AiTraceThresholds,
  maxFindings: number,
): AiTraceFinding[] {
  const sentences = splitSentenceSpans(text)
  if (sentences.length < thresholds.minSentencesForRhythm) return []

  const findings: AiTraceFinding[] = []
  const lengths = sentences.map(s => countMeaningfulChars(s.text))
  const mean = lengths.reduce((sum, v) => sum + v, 0) / lengths.length
  const variation = coefficientOfVariation(lengths)

  // 2.1 句长高度均匀：找出最长的一段「长度接近均值」的连续句子
  if (variation < thresholds.maxLengthVariation && mean > 0) {
    const run = longestRun(sentences, (sentence) => {
      const length = countMeaningfulChars(sentence.text)
      return Math.abs(length - mean) <= mean * 0.2
    })
    if (run.length >= 4) {
      const first = run[0]
      const last = run[run.length - 1]
      findings.push({
        id: 'trace-rhythm-length',
        kind: 'monotonous-sentence',
        start: first.start,
        end: last.end - 1,
        quote: text.slice(first.start - 1, last.end - 1),
        occurrences: [{ start: first.start, end: last.end - 1 }],
        message: t('review.aiTrace.monotonousLength', {
          count: run.length,
          variation: Math.round(variation * 100) / 100,
        }),
        metric: { label: 'lengthVariation', value: Math.round(variation * 1000) / 1000, threshold: thresholds.maxLengthVariation },
        hint: t('review.aiTrace.monotonousLengthHint'),
      })
    }
  }

  // 2.2 连续同构开头：相邻句子以相同的两字开头
  const run = longestRunPairs(sentences, (a, b) => sentenceHead(a.text) !== '' && sentenceHead(a.text) === sentenceHead(b.text))
  if (run.length >= thresholds.minConsecutiveSameStart) {
    const first = run[0]
    const last = run[run.length - 1]
    findings.push({
      id: 'trace-rhythm-head',
      kind: 'monotonous-sentence',
      start: first.start,
      end: last.end - 1,
      quote: text.slice(first.start - 1, last.end - 1),
      occurrences: [{ start: first.start, end: last.end - 1 }],
      message: t('review.aiTrace.monotonousHead', { count: run.length, head: sentenceHead(first.text) }),
      metric: { label: 'consecutiveSameStart', value: run.length, threshold: thresholds.minConsecutiveSameStart },
      hint: t('review.aiTrace.monotonousHeadHint'),
    })
  }

  return findings.slice(0, maxFindings)
}

/** 句首两字（去掉标点与空白），用于识别同构开头 */
function sentenceHead(sentence: string): string {
  const compact = sentence.replace(/[\s\p{P}\p{S}]/gu, '')
  return compact.slice(0, 2)
}

/** 返回满足条件的最长连续句子段落 */
function longestRun<T>(items: T[], predicate: (item: T) => boolean): T[] {
  return longestRunPairs(items, (_, current) => predicate(current))
}

/** 返回相邻对满足条件的最长连续片段（至少包含 2 项才返回） */
function longestRunPairs<T>(items: T[], predicate: (previous: T, current: T) => boolean): T[] {
  let best: T[] = []
  let current: T[] = []
  for (let index = 0; index < items.length; index++) {
    if (index === 0) {
      current = [items[0]]
    } else if (predicate(items[index - 1], items[index])) {
      current.push(items[index])
    } else {
      if (current.length > best.length) best = current
      current = [items[index]]
    }
  }
  if (current.length > best.length) best = current
  return best
}

// ===== 3. 过度总结 =====

function detectOverSummary(
  text: string,
  thresholds: AiTraceThresholds,
  maxFindings: number,
): AiTraceFinding[] {
  const paragraphs = splitParagraphSpans(text)
  if (paragraphs.length < thresholds.minParagraphsForSummary) return []

  const findings: AiTraceFinding[] = []
  for (let index = 0; index < paragraphs.length; index++) {
    if (findings.length >= maxFindings) break
    const paragraph = paragraphs[index]
    const base = paragraph.start - 1
    const sentences = splitSentenceSpans(paragraph.text)
    if (sentences.length === 0) continue

    const tail = sentences[sentences.length - 1]
    const isFinalParagraph = index === paragraphs.length - 1
    const matched = matchOverSummary(tail.text, isFinalParagraph)
    if (!matched) continue

    findings.push({
      id: `trace-summary-${index + 1}`,
      kind: 'over-summary',
      start: base + tail.start,
      end: base + tail.end - 1,
      quote: tail.text.trim(),
      occurrences: [{ start: base + tail.start, end: base + tail.end - 1 }],
      message: t('review.aiTrace.overSummary', { cue: matched.cue, paragraph: paragraph.index }),
      metric: { label: matched.label, value: matched.value, threshold: matched.threshold },
      hint: t('review.aiTrace.overSummaryHint'),
    })
  }

  return findings
}

/** 判定一个段末句是否属于「总结式旁白」；返回命中依据 */
function matchOverSummary(
  sentence: string,
  isFinalParagraph: boolean,
): { cue: string; label: string; value: number; threshold: number } | null {
  // 含对话的句子优先视为剧情推进，不当作总结
  if (DIALOGUE_PATTERN.test(sentence)) return null

  const cue = OVER_SUMMARY_CUES.find(item => sentence.includes(item))
  const abstractCount = ABSTRACT_NOUNS.filter(item => sentence.includes(item)).length

  if (cue) {
    return { cue, label: 'cueHits', value: 1, threshold: 1 }
  }
  // 章末段 + 抽象名词密集，即使没有固定提示词也值得标记
  if (isFinalParagraph && abstractCount >= 2) {
    return { cue: '', label: 'abstractNouns', value: abstractCount, threshold: 2 }
  }
  return null
}

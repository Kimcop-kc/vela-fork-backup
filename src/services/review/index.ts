/**
 * 定性审稿 —— 统一门面
 *
 * 提供：
 *   - detectAiTraces：内置 AI 痕迹检测（确定性，只标记可修订位置）
 *   - observeChapter：把模型观察 + 本地规则检测合成一份审稿产物
 *   - buildRevisionBrief / buildAiTraceBrief：由用户或 Agent 显式发起修订时，
 *     把选中的观察/痕迹编译成可执行的修订说明
 *   - renderReviewMarkdown：把审稿产物渲染为可读报告
 *
 * 设计边界：
 *   审稿产物只是「可追溯的创作反馈」，不含通过/失败判定；
 *   本模块不会自动改写章节，也不按隐藏词表替换文本。
 */
export * from './types'
export {
  dialogueRatio,
  countMeaningfulChars,
  locateQuote,
  splitParagraphSpans,
  splitSentenceSpans,
  type ParagraphSpan,
  type SentenceSpan,
} from '../text-analysis'
export {
  ABSTRACT_NOUNS,
  DEFAULT_AI_TRACE_THRESHOLDS,
  OVER_SUMMARY_CUES,
  detectAiTraces,
  type DetectAiTraceOptions,
} from './ai-trace-detector'
export {
  detectUnregisteredSpeakers,
  groupObservations,
  normalizeDimension,
  normalizeEvidence,
  normalizeSeverity,
  observationId,
  parseObservations,
  type RawObservation,
} from './continuity-observer'

import i18n from '../../i18n'
import { detectAiTraces } from './ai-trace-detector'
import { detectUnregisteredSpeakers, groupObservations, parseObservations } from './continuity-observer'
import { countMeaningfulChars, dialogueRatio, splitParagraphSpans, splitSentenceSpans } from '../text-analysis'
import type { AiTraceFinding, QualitativeReview, ReviewObservation } from './types'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 合成审稿产物的参数 */
export interface ObserveChapterParams {
  chapterNumber: number
  chapterTitle: string
  chapterContent: string
  /** 已登记角色名（用于本地规则检测新角色） */
  knownCharacterNames?: string[]
  /** 模型返回的原始观察（未提供时只跑本地确定性检测） */
  rawLlmResult?: unknown
  /** 参与比对的上下文规模，仅用于追溯 */
  contextSize?: {
    timelineEvents: number
    characterStates: number
    openPlotLines: number
    knownFacts: number
  }
}

/**
 * 生成审稿产物。
 *
 * 注意：即使 rawLlmResult 缺失（模型不可用/被取消），本函数依旧会返回
 * 本地确定性检测的结果 —— 审稿不会因为一次模型失败而变成「失败判定」。
 */
export function observeChapter(params: ObserveChapterParams): QualitativeReview {
  const { chapterContent } = params
  const parsed = params.rawLlmResult === undefined
    ? { observations: [], skipped: 0 }
    : parseObservations(params.rawLlmResult, params.chapterNumber, chapterContent)

  const ruleObservations = detectUnregisteredSpeakers(
    chapterContent,
    params.knownCharacterNames ?? [],
    params.chapterNumber,
  )

  return {
    chapterNumber: params.chapterNumber,
    chapterTitle: params.chapterTitle,
    observations: [...parsed.observations, ...ruleObservations],
    aiTraces: detectAiTraces(chapterContent),
    context: params.contextSize ?? { timelineEvents: 0, characterStates: 0, openPlotLines: 0, knownFacts: 0 },
    stats: {
      characters: countMeaningfulChars(chapterContent),
      paragraphs: splitParagraphSpans(chapterContent).length,
      sentences: splitSentenceSpans(chapterContent).length,
      dialogueRatio: Math.round(dialogueRatio(chapterContent) * 1000) / 1000,
    },
    generatedAt: new Date().toISOString(),
  }
}

/**
 * 把选中的观察编译成修订说明。
 *
 * 这是「显式发起修订」的入口：调用方必须主动传入要处理的观察，
 * 审稿本身不会自己触发修订。
 */
export function buildRevisionBrief(
  observations: ReviewObservation[],
  chapterContent: string,
): string {
  if (observations.length === 0) return ''
  const lines: string[] = [t('review.brief.header', { count: observations.length })]

  for (const observation of observations) {
    lines.push('')
    lines.push(`- [${t(`review.dimension.${observation.dimension}`)}] ${observation.title}`)
    if (observation.detail) lines.push(`  ${observation.detail}`)
    for (const evidence of observation.evidence) {
      if (evidence.start > 0) {
        const snippet = chapterContent.slice(evidence.start - 1, evidence.end - 1)
        lines.push(`  ${t('review.brief.evidence', { quote: snippet })}`)
      } else {
        lines.push(`  ${t('review.brief.evidenceUnlocated', { quote: evidence.quote })}`)
      }
    }
    if (observation.suggestion) lines.push(`  ${t('review.brief.suggestion', { suggestion: observation.suggestion })}`)
  }

  lines.push('')
  lines.push(t('review.brief.footer'))
  return lines.join('\n')
}

/**
 * 把选中的 AI 痕迹编译成「去 AI 味」任务的输入。
 *
 * 注意：这里只把「位置 + 现象」交给调用方，具体怎么改由被激活的
 * de-ai-tone Skill 决定；本函数不会替换任何文字。
 */
export function buildAiTraceBrief(findings: AiTraceFinding[], chapterContent: string): string {
  if (findings.length === 0) return ''
  const lines: string[] = [t('review.aiTrace.briefHeader', { count: findings.length })]

  for (const finding of findings) {
    lines.push('')
    lines.push(`- [${t(`review.aiTrace.kind.${finding.kind}`)}] ${finding.message}`)
    lines.push(`  ${t('review.aiTrace.metricLine', {
      label: t(`review.aiTrace.metric.${finding.metric.label}`),
      value: finding.metric.value,
      threshold: finding.metric.threshold,
    })}`)
    for (const occurrence of finding.occurrences.slice(0, 8)) {
      if (occurrence.start <= 0) continue
      const snippet = chapterContent.slice(occurrence.start - 1, occurrence.end - 1)
      lines.push(`  ${t('review.brief.evidence', { quote: snippet })}`)
    }
    lines.push(`  ${finding.hint}`)
  }

  lines.push('')
  lines.push(t('review.aiTrace.briefFooter'))
  return lines.join('\n')
}

/**
 * 把审稿产物渲染成 Markdown 报告。
 *
 * @param review 审稿产物
 * @param chapterContent 可选；提供时会为证据标注行号，便于回到编辑器定位
 */
export function renderReviewMarkdown(review: QualitativeReview, chapterContent = ''): string {
  const lines: string[] = []
  lines.push(t('review.report.title', { chapter: review.chapterNumber, title: review.chapterTitle }))
  lines.push('')
  lines.push(t('review.report.summary', {
    characters: review.stats.characters,
    paragraphs: review.stats.paragraphs,
    sentences: review.stats.sentences,
    dialogue: Math.round(review.stats.dialogueRatio * 100),
  }))
  lines.push('')

  for (const group of groupObservations(review.observations)) {
    lines.push(`## ${t(`review.dimension.${group.dimension}`)}`)
    for (const observation of group.observations) {
      lines.push(`- **${observation.title}**（${t(`review.severity.${observation.severity}`)}）`)
      if (observation.detail) lines.push(`  ${observation.detail}`)
      for (const evidence of observation.evidence) {
        const quote = evidence.start > 0
          ? t('review.report.evidenceLocated', {
              quote: evidence.quote,
              line: lineNumberAt(chapterContent, evidence.start),
            })
          : t('review.brief.evidenceUnlocated', { quote: evidence.quote })
        lines.push(`  - ${quote}`)
      }
      if (observation.suggestion) lines.push(`  - ${t('review.brief.suggestion', { suggestion: observation.suggestion })}`)
    }
    lines.push('')
  }

  if (review.aiTraces.length > 0) {
    lines.push(`## ${t('review.report.aiTraceSection')}`)
    for (const finding of review.aiTraces) {
      lines.push(`- **${t(`review.aiTrace.kind.${finding.kind}`)}**：${finding.message}`)
      lines.push(`  - ${finding.hint}`)
    }
    lines.push('')
  }

  lines.push(t('review.report.noVerdictNote'))
  return lines.join('\n')
}

/** 计算字符偏移所在行号（1 基）；没有正文时返回 0 */
function lineNumberAt(chapterContent: string, offset: number): number {
  if (!chapterContent || offset <= 0) return 0
  return chapterContent.slice(0, offset - 1).split('\n').length
}

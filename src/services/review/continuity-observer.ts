/**
 * 连续性观察器
 *
 * 把「模型读出来的创作观察」和「本地确定性检测」统一成同一种可追溯的反馈：
 *   - 所有模型给出的引文都会回帖到原文，换算出真实字符偏移；
 *     定位失败时偏移记为 -1，只保留原文片段，绝不猜测位置。
 *   - 观察带有稳定 id，便于多轮审稿之间追踪同一条反馈的演化。
 *
 * 本模块不产生「通过 / 失败」判定，也不触发任何自动改稿。
 */
import i18n from '../../i18n'
import {
  OBSERVATION_DIMENSIONS,
  type ObservationDimension,
  type ObservationEvidence,
  type ObservationSeverity,
  type ReviewObservation,
} from './types'
import { locateQuote } from '../text-analysis'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 模型返回的原始观察（字段全部宽松，需归一化） */
export interface RawObservation {
  dimension?: unknown
  severity?: unknown
  title?: unknown
  detail?: unknown
  evidence?: unknown
  suggestion?: unknown
  relatedChapters?: unknown
}

const DIMENSION_KEYWORDS: Array<{ dimension: ObservationDimension; keywords: string[] }> = [
  { dimension: 'character-memory', keywords: ['memory', 'knowledge', 'know', '记忆', '认知', '知情'] },
  { dimension: 'prop-continuity', keywords: ['prop', 'item', 'resource', 'material', '物资', '道具', '资源'] },
  { dimension: 'foreshadowing', keywords: ['foreshadow', 'setup', 'payoff', '伏笔', '铺垫'] },
  { dimension: 'outline-deviation', keywords: ['outline', 'deviation', 'goal', 'blueprint', '大纲', '偏离', '蓝图'] },
  { dimension: 'pacing', keywords: ['pace', 'pacing', 'rhythm', 'tension', '节奏', '张弛'] },
  { dimension: 'emotional-arc', keywords: ['emotion', 'arc', 'feeling', '情感', '情绪', '弧线'] },
]

const SEVERITY_KEYWORDS: Array<{ severity: ObservationSeverity; keywords: string[] }> = [
  { severity: 'concern', keywords: ['concern', 'high', 'critical', 'serious', 'severe', '严重', '高'] },
  { severity: 'watch', keywords: ['watch', 'medium', 'warning', 'moderate', '注意', '中'] },
  { severity: 'note', keywords: ['note', 'low', 'info', 'info', '记录', '低'] },
]

/** 归一化维度：识别失败返回 null（调用方应丢弃并计数） */
export function normalizeDimension(value: unknown): ObservationDimension | null {
  if (typeof value !== 'string') return null
  const lower = value.trim().toLowerCase()
  if (!lower) return null
  if ((OBSERVATION_DIMENSIONS as string[]).includes(lower)) return lower as ObservationDimension
  for (const entry of DIMENSION_KEYWORDS) {
    if (entry.keywords.some(keyword => lower.includes(keyword))) return entry.dimension
  }
  return null
}

/** 归一化强度：识别失败回退到 note（只是阅读优先级，不构成判定） */
export function normalizeSeverity(value: unknown): ObservationSeverity {
  if (typeof value !== 'string') return 'note'
  const lower = value.trim().toLowerCase()
  for (const entry of SEVERITY_KEYWORDS) {
    if (entry.keywords.some(keyword => lower.includes(keyword))) return entry.severity
  }
  return 'note'
}

/** 稳定 id：同一维度 + 同一标题在多轮审稿之间保持不变 */
export function observationId(dimension: string, title: string): string {
  let hash = 5381
  const seed = `${dimension}::${title}`
  for (let index = 0; index < seed.length; index++) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) >>> 0
  }
  return `obs-${hash.toString(36)}`
}

/** 把任意形态的证据归一化为 ObservationEvidence，并回帖原文换算偏移 */
export function normalizeEvidence(value: unknown, chapterContent: string): ObservationEvidence[] {
  const items = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]
  const evidence: ObservationEvidence[] = []
  for (const item of items) {
    const quote = typeof item === 'string'
      ? item
      : item && typeof item === 'object' && typeof (item as { quote?: unknown }).quote === 'string'
        ? String((item as { quote: string }).quote)
        : ''
    if (!quote.trim()) continue
    const source = item && typeof item === 'object' && typeof (item as { source?: unknown }).source === 'string'
      ? String((item as { source: string }).source)
      : ''
    const located = locateQuote(chapterContent, quote)
    evidence.push({
      quote: quote.trim(),
      start: located ? located.start : -1,
      end: located ? located.end : -1,
      source,
    })
  }
  return evidence
}

/** 归一化关联章节号 */
function normalizeChapters(value: unknown, fallback: number): number[] {
  const raw = Array.isArray(value) ? value : []
  const chapters = raw
    .map(item => (typeof item === 'number' ? item : Number.parseInt(String(item), 10)))
    .filter(item => Number.isSafeInteger(item) && item > 0)
  return chapters.length > 0 ? Array.from(new Set(chapters)).sort((a, b) => a - b) : [fallback]
}

/**
 * 把模型返回的观察列表归一化为 ReviewObservation[]。
 *
 * @returns observations 归一化后的观察；skipped 维度无法识别的条数（供日志说明）
 */
export function parseObservations(
  raw: unknown,
  chapterNumber: number,
  chapterContent: string,
): { observations: ReviewObservation[]; skipped: number } {
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === 'object' && Array.isArray((raw as { observations?: unknown }).observations)
      ? (raw as { observations: unknown[] }).observations
      : []

  const observations: ReviewObservation[] = []
  let skipped = 0

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped += 1
      continue
    }
    const rawItem = item as RawObservation
    const dimension = normalizeDimension(rawItem.dimension)
    const title = typeof rawItem.title === 'string' ? rawItem.title.trim() : ''
    if (!dimension || !title) {
      skipped += 1
      continue
    }
    const detail = typeof rawItem.detail === 'string' ? rawItem.detail.trim() : ''
    const suggestion = typeof rawItem.suggestion === 'string' ? rawItem.suggestion.trim() : ''
    observations.push({
      id: observationId(dimension, title),
      dimension,
      severity: normalizeSeverity(rawItem.severity),
      title,
      detail,
      evidence: normalizeEvidence(rawItem.evidence, chapterContent),
      suggestion: suggestion || undefined,
      relatedChapters: normalizeChapters(rawItem.relatedChapters, chapterNumber),
      origin: 'llm',
    })
  }

  return { observations, skipped }
}

/**
 * 本地确定性观察：正文里出现「署名式说话人」但角色卡中没有登记。
 *
 * 判定条件故意保守：同一名字至少出现 2 次说话标记（如「苏离说」「苏离道」），
 * 避免把地名、称谓误报成新角色。
 */
export function detectUnregisteredSpeakers(
  chapterContent: string,
  knownNames: string[],
  chapterNumber: number,
): ReviewObservation[] {
  const known = new Set(knownNames.map(name => name.trim()).filter(Boolean))
  const speakers = new Map<string, number>()
  const pattern = /([\p{Script=Han}]{2,4})(?:说道|笑道|冷笑|开口|低声|问道|答道|吼道|说道|道|说)[：:，,、]/gu
  for (const match of chapterContent.matchAll(pattern)) {
    const name = match[1]
    if (known.has(name)) continue
    speakers.set(name, (speakers.get(name) ?? 0) + 1)
  }

  const observations: ReviewObservation[] = []
  for (const [name, count] of speakers) {
    if (count < 2) continue
    const located = locateQuote(chapterContent, name)
    observations.push({
      id: observationId('character-memory', `unregistered:${name}`),
      dimension: 'character-memory',
      severity: 'watch',
      title: t('review.rule.unregisteredSpeaker.title', { name }),
      detail: t('review.rule.unregisteredSpeaker.detail', { name, count }),
      evidence: [{
        quote: name,
        start: located ? located.start : -1,
        end: located ? located.end : -1,
        source: t('review.chapterSource', { chapter: chapterNumber }),
      }],
      suggestion: t('review.rule.unregisteredSpeaker.suggestion', { name }),
      relatedChapters: [chapterNumber],
      origin: 'rule',
    })
  }
  return observations
}

/** 按维度分组（保持 OBSERVATION_DIMENSIONS 的顺序） */
export function groupObservations(observations: ReviewObservation[]): Array<{
  dimension: ObservationDimension
  observations: ReviewObservation[]
}> {
  return OBSERVATION_DIMENSIONS
    .map(dimension => ({ dimension, observations: observations.filter(item => item.dimension === dimension) }))
    .filter(group => group.observations.length > 0)
}

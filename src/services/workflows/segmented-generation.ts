/**
 * 分段生成工具集（Segmented Generation）
 *
 * 背景：章节蓝图、章节要点、角色卡更新、逆向推演等任务的目标输出很长，
 * 单次调用容易撞上模型的上下文/输出上限，导致结果被截断（JSON 不完整、后半段丢失）。
 *
 * 本模块提供三类能力，供各 Command 组合使用：
 * 1. 预算：根据模型 maxTokens 推导单次请求的输入/输出 token 预算；
 * 2. 切分：把超长正文按段落/句子边界切成多段，或把条目按预算分组；
 * 3. 合并：把分段生成的结果按主键合并成一份完整结果。
 */
import i18n from '../../i18n'
// token 估算是通用文本能力，统一放在 text-analysis，避免与调用量统计各写一份
import { estimateTokens, isWideChar } from '../text-analysis'

export { estimateTokens } from '../text-analysis'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 单次请求的输入/输出 token 预算 */
export interface GenerationBudgets {
  /** 单次响应允许的最大输出 token（模型配置上限） */
  outputTokens: number
  /** 单次请求的输入 token 预算（保守估算，避免超出上下文窗口） */
  inputTokens: number
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

/**
 * 从模型 maxTokens 推导单次请求预算。
 * 模型未配置时回退到 4096，保持与既有行为一致。
 */
export function resolveGenerationBudgets(modelMaxTokens?: number): GenerationBudgets {
  const outputTokens = clampNumber(Math.floor(modelMaxTokens || 4096), 512, 65536)
  // 真实上下文窗口一般远大于输出上限，这里按 2.5 倍保守估算，并夹在 [4000, 48000]
  const inputTokens = clampNumber(Math.round(outputTokens * 2.5), 4000, 48000)
  return { outputTokens, inputTokens }
}

/** 按 token 预算截断文本（超预算时在句子边界收尾，避免切断半句话） */
export function clampToTokenBudget(text: string, maxTokens: number): string {
  if (!text) return ''
  const budget = Math.max(1, Math.floor(maxTokens))
  if (estimateTokens(text) <= budget) return text
  let used = 0
  let cut = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    used += isWideChar(char.codePointAt(0) ?? 0) ? 1 : 0.25
    if (used > budget) break
    cut = index + 1
  }
  const head = text.slice(0, cut)
  // 回退到最近的句末，避免把句子截成半截
  const lastStop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'))
  return lastStop > head.length * 0.5 ? head.slice(0, lastStop + 1) : head
}

/** 单段过长时，先按句末切，再退化为硬切 */
function splitOversizedUnit(unit: string, budget: number): string[] {
  const pieces: string[] = []
  let buffer = ''
  const sentences = unit.split(/(?<=[。！？!?；;…\n])/)
  for (const sentence of sentences) {
    if (buffer && estimateTokens(buffer + sentence) > budget) {
      pieces.push(buffer)
      buffer = ''
    }
    if (estimateTokens(sentence) > budget) {
      let rest = sentence
      while (estimateTokens(rest) > budget) {
        const head = clampToTokenBudget(rest, budget)
        if (!head) break
        pieces.push(head)
        rest = rest.slice(head.length)
      }
      buffer = rest
      continue
    }
    buffer += sentence
  }
  if (buffer) pieces.push(buffer)
  return pieces.filter(piece => piece.trim() !== '')
}

/**
 * 把长文本按 token 预算切成多段，优先在空行（段落）处切分，其次在句末。
 * 返回结果拼起来等于原文（除非原文含超长无标点片段被硬切）。
 */
/**
 * 按 token 预算切分文本（内部实现，不设预算下限，供递归缩段使用）。
 * 对外请用 splitTextByTokenBudget，它对过小的预算有兜底。
 */
function splitByBudget(text: string, budgetTokens: number): string[] {
  if (!text || !text.trim()) return []
  const budget = Math.max(1, Math.floor(budgetTokens))
  if (estimateTokens(text) <= budget) return [text]

  const paragraphs = text.split(/(?:\r?\n){2,}/)
  const chunks: string[] = []
  let buffer = ''
  for (const paragraph of paragraphs) {
    const merged = buffer ? `${buffer}\n\n${paragraph}` : paragraph
    if (estimateTokens(merged) <= budget) {
      buffer = merged
      continue
    }
    if (buffer) chunks.push(buffer)
    if (estimateTokens(paragraph) > budget) {
      const pieces = splitOversizedUnit(paragraph, budget)
      chunks.push(...pieces.slice(0, -1))
      buffer = pieces[pieces.length - 1] ?? ''
    } else {
      buffer = paragraph
    }
  }
  if (buffer) chunks.push(buffer)
  return chunks.filter(chunk => chunk.trim() !== '')
}

/** 把长文本按 token 预算切成多段；预算过小时按 200 兜底，避免切出无意义的碎片 */
export function splitTextByTokenBudget(text: string, maxTokensPerChunk: number): string[] {
  return splitByBudget(text, Math.max(200, Math.floor(maxTokensPerChunk)))
}

/** 把数组按固定大小切成多组（如角色卡按条数分批） */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const chunkSize = Math.max(1, Math.floor(size))
  const groups: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    groups.push(items.slice(index, index + chunkSize))
  }
  return groups
}

/**
 * 判断错误是否来自「模型输出被输出上限截断」。
 *
 * 供应商在 finish_reason=length 时会给出这类提示。它说明本段输入范围开得太大、
 * 一次要输出的结果超过了模型输出上限，应当缩小范围重试，而不是原样重跑
 * （原样重跑通常还会失败）。
 */
export function isOutputLengthError(error: unknown): boolean {
  const message = typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : String((error as { message?: unknown } | null)?.message ?? '')
  return message.includes('达到长度上限') || /finish_reason["\s:=]*length/i.test(message)
}

/**
 * 调用模型处理某一段文本；若失败原因是「输出达到长度上限」，把该段对半再切后递归重试。
 *
 * 这样即使模型的输出上限偏小，也能靠「缩小范围 → 逐段输出 → 合并」，把结果拿全，
 * 而不是让整段（乃至整步）失败。depth 控制最多下切几层，避免无意义地反复切分。
 */
export async function callWithShrink<T>(
  segment: string,
  budget: number,
  run: (segment: string) => Promise<T[]>,
  depth = 3,
): Promise<T[]> {
  try {
    return await run(segment)
  } catch (error) {
    if (depth <= 0 || !isOutputLengthError(error)) throw error
    const halfBudget = Math.max(1, Math.floor(budget / 2))
    const halves = splitByBudget(segment, halfBudget)
    // 已经切不动了（例如整段只有一个句子）：保持原来的错误向上抛
    if (halves.length <= 1) throw error
    const merged: T[] = []
    for (const half of halves) {
      merged.push(...await callWithShrink(half, halfBudget, run, depth - 1))
    }
    return merged
  }
}

/** 把条目数组按预算分组（每组的 token 总量不超过预算） */
export function splitItemsByTokenBudget<T>(
  items: T[],
  getText: (item: T) => string,
  maxTokensPerChunk: number,
): T[][] {
  const budget = Math.max(200, Math.floor(maxTokensPerChunk))
  const groups: T[][] = []
  let current: T[] = []
  let used = 0
  for (const item of items) {
    const cost = estimateTokens(getText(item)) + 16
    if (current.length > 0 && used + cost > budget) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(item)
    used += cost
  }
  if (current.length > 0) groups.push(current)
  return groups
}

// ===== 合并 =====

const PLACEHOLDER_VALUES = new Set(['（待确认）', '(待确认)', '待确认', '未知', '待定', '暂无', 'n/a', 'N/A', ''])

/** 判断字段是否含有有效信息（空串与常见占位符视为未填写） */
export function isFilledValue(value: unknown): boolean {
  if (value === null || value === undefined) return false
  if (typeof value === 'string') return !PLACEHOLDER_VALUES.has(value.trim())
  if (Array.isArray(value)) return value.length > 0
  return true
}

function mergeArrays(base: unknown[], incoming: unknown[]): unknown[] {
  const merged = [...base]
  for (const item of incoming) {
    const exists = merged.some(existing => JSON.stringify(existing) === JSON.stringify(item))
    if (!exists) merged.push(item)
  }
  return merged
}

/** 合并冲突时的取值策略：last=后出现优先，first=先出现优先，richest=信息量最大者优先 */
export type MergePreference = 'first' | 'last' | 'richest'

/**
 * 合并同一实体的两条记录：
 * - 空值/占位值永远让位于有效值；
 * - 双方都有效时，prefer='last' 取后出现的（默认，适用于按章节顺序推进的状态更新），
 *   prefer='first' 保留先出现的（适用于取"初次登场"信息的场景），
 *   prefer='richest' 取更长的文本（适用于合并分段推演出的描述性字段）；
 * - 对象递归合并，数组取并集。
 */
export function mergeFilled<T extends Record<string, unknown>>(
  base: T,
  incoming: T,
  prefer: MergePreference = 'last',
): T {
  const result: Record<string, unknown> = { ...base }
  for (const [key, incomingValue] of Object.entries(incoming)) {
    const baseValue = result[key]
    if (incomingValue === undefined) continue
    if (incomingValue !== null && typeof incomingValue === 'object' && !Array.isArray(incomingValue)) {
      if (baseValue !== null && typeof baseValue === 'object' && !Array.isArray(baseValue)) {
        result[key] = mergeFilled(baseValue as Record<string, unknown>, incomingValue as Record<string, unknown>, prefer)
      } else {
        result[key] = incomingValue
      }
      continue
    }
    if (Array.isArray(incomingValue)) {
      result[key] = Array.isArray(baseValue) ? mergeArrays(baseValue, incomingValue) : incomingValue
      continue
    }
    const incomingFilled = isFilledValue(incomingValue)
    if (!incomingFilled) continue
    if (!isFilledValue(baseValue)) {
      result[key] = incomingValue
      continue
    }
    if (prefer === 'first') continue
    if (prefer === 'richest' && typeof incomingValue === 'string' && typeof baseValue === 'string' &&
        incomingValue.length <= baseValue.length) {
      continue
    }
    result[key] = incomingValue
  }
  return result as T
}

export interface MergeByKeyOptions<T> {
  keyOf: (item: T) => string
  /** 冲突时优先保留哪一侧，默认 'last' */
  prefer?: MergePreference
  /** 键为空时是否保留该条目，默认丢弃 */
  keepInvalid?: boolean
}

/**
 * 按主键合并多组结果（分段生成的产物按顺序合并成一份）。
 * 组与组之间按传入顺序推进：`prefer='last'` 时后面的段落覆盖前面的同名字段。
 */
export function mergeByKey<T extends Record<string, unknown>>(
  groups: T[][],
  options: MergeByKeyOptions<T>,
): T[] {
  const prefer = options.prefer ?? 'last'
  const merged = new Map<string, T>()
  for (const group of groups) {
    for (const item of group) {
      const key = (options.keyOf(item) || '').trim()
      if (!key) {
        if (options.keepInvalid) merged.set(`__invalid_${merged.size}`, item)
        continue
      }
      const existing = merged.get(key)
      merged.set(key, existing ? mergeFilled(existing, item, prefer) : item)
    }
  }
  return [...merged.values()]
}

// ===== 章节要点（Markdown）合并 =====

interface ChapterNotesSections {
  title: string
  plotNodes: string[]
  characters: Array<{ name: string; description: string }>
  settings: string[]
  hooks: string[]
}

/** 要点小节标识（title 不参与小节匹配） */
type NotesSectionKey = 'plotNodes' | 'characters' | 'settings' | 'hooks'

const NOTES_SECTION_LABELS: Record<NotesSectionKey, string[]> = {
  plotNodes: ['剧情节点', 'plot nodes'],
  characters: ['角色动态', 'character'],
  settings: ['新增设定', 'new settings'],
  hooks: ['伏笔与钩子', 'hooks'],
}

function matchSection(heading: string, key: NotesSectionKey): NotesSectionKey | null {
  const lower = heading.toLowerCase()
  return NOTES_SECTION_LABELS[key].some(label => lower.includes(label.toLowerCase())) ? key : null
}

function parseNotesPart(part: string): ChapterNotesSections {
  const result: ChapterNotesSections = { title: '', plotNodes: [], characters: [], settings: [], hooks: [] }
  let section: 'plotNodes' | 'characters' | 'settings' | 'hooks' | null = null
  for (const rawLine of part.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('# ')) {
      if (!result.title) result.title = line.slice(2).trim()
      continue
    }
    if (line.startsWith('## ')) {
      const heading = line.slice(3).trim()
      section =
        matchSection(heading, 'plotNodes') ??
        matchSection(heading, 'characters') ??
        matchSection(heading, 'settings') ??
        matchSection(heading, 'hooks')
      continue
    }
    if (!section) continue
    if (section === 'characters') {
      if (!line.startsWith('|')) continue
      const cells = line.split('|').map(cell => cell.trim()).filter(cell => cell !== '')
      if (cells.length < 2) continue
      if (/^[-:]+$/.test(cells[0]) || cells[0].includes('角色')) continue
      result.characters.push({ name: cells[0], description: cells.slice(1).join(' ') })
      continue
    }
    if (section === 'plotNodes') result.plotNodes.push(line)
    else if (section === 'settings') result.settings.push(line)
    else result.hooks.push(line)
  }
  return result
}

function dedupeLines(lines: string[]): string[] {
  const seen = new Set<string>()
  const output: string[] = []
  for (const line of lines) {
    const key = line.replace(/^[-*]\s*/, '').replace(/\[[^\]]*\]/g, '').replace(/[\s，。；、,.;]/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    output.push(line.startsWith('-') || line.startsWith('*') ? line : `- ${line}`)
  }
  return output
}

/**
 * 合并分段的章节要点 Markdown：小节按标题归并，条目去重，角色表按角色名合并。
 * 任一段没有可识别的小节时，直接拼接该段原文，避免丢失信息。
 */
export function mergeChapterNotes(parts: string[]): string {
  const valid = parts.map(part => part.trim()).filter(part => part !== '')
  if (valid.length === 0) return ''
  if (valid.length === 1) return valid[0]

  const sections = valid.map(parseNotesPart)
  const hasStructured = sections.some(section =>
    section.plotNodes.length + section.characters.length + section.settings.length + section.hooks.length > 0,
  )
  if (!hasStructured) return valid.join('\n\n')

  const title = sections.find(section => section.title)?.title ?? ''
  const plotNodes = dedupeLines(sections.flatMap(section => section.plotNodes))
  const settings = dedupeLines(sections.flatMap(section => section.settings))
  const hooks = dedupeLines(sections.flatMap(section => section.hooks))
  // 角色动态按角色名归并：同一角色在不同分段的描述全部保留（「；」连接去重），避免丢失信息
  const characterDescriptions = new Map<string, string[]>()
  for (const section of sections) {
    for (const character of section.characters) {
      const descriptions = characterDescriptions.get(character.name) ?? []
      if (character.description && !descriptions.includes(character.description)) {
        descriptions.push(character.description)
      }
      characterDescriptions.set(character.name, descriptions)
    }
  }
  const characters = [...characterDescriptions.entries()].map(([name, descriptions]) => ({
    name,
    description: descriptions.join('；'),
  }))

  const lines: string[] = []
  if (title) lines.push(`# ${title}`, '')
  if (plotNodes.length > 0) lines.push('## 剧情节点', ...plotNodes, '')
  if (characters.length > 0) {
    lines.push('## 角色动态', '| 角色 | 本章变化/状态 |', '|------|-------------|')
    for (const character of characters) lines.push(`| ${character.name} | ${character.description} |`)
    lines.push('')
  }
  if (settings.length > 0) lines.push('## 新增设定', ...settings, '')
  if (hooks.length > 0) lines.push('## 伏笔与钩子', ...hooks)
  return lines.join('\n').trim()
}

// ===== JSON 容错解析 =====

/** 反引号代码块剥离（模型常把 JSON 包在 ```json 里） */
function stripCodeFences(text: string): string {
  return text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim()
}

/** 从 start 处尝试切出一个平衡的 JSON 片段，返回结束下标（无匹配返回 -1） */
function findBalancedEnd(clean: string, start: number): number {
  const open = clean[start]
  const close = open === '[' ? ']' : '}'
  let depth = 0
  let quoted = false
  let escaped = false
  for (let end = start; end < clean.length; end++) {
    const char = clean[end]
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '[' || char === '{') depth++
    else if (char === ']' || char === '}') {
      depth--
      if (depth === 0) return char === close ? end : -1
    }
  }
  return -1
}

function isParseableJson(fragment: string): boolean {
  try {
    JSON.parse(fragment)
    return true
  } catch {
    return false
  }
}

/** 单个方向最多检查的候选起点数，避免超长文本下退化为 O(n²) */
const MAX_JSON_CANDIDATES = 400

/**
 * 从模型输出中提取可用的 JSON 片段（兼容代码块、前导解释与后置说明）。
 *
 * 优先取「结尾即文本结尾」的完整片段（模型通常把最终答案放在最后，前面是推理或示例），
 * 找不到时退回第一个能成功解析的片段；输出被截断时返回 null。
 */
export function extractJsonFragment(text: string): string | null {
  const clean = stripCodeFences(text)
  // 1) 自右向左：寻找以文本结尾收束的完整 JSON
  let checked = 0
  for (let start = clean.length - 1; start >= 0 && checked < MAX_JSON_CANDIDATES; start--) {
    if (clean[start] !== '[' && clean[start] !== '{') continue
    checked++
    const end = findBalancedEnd(clean, start)
    if (end < 0) continue
    if (clean.slice(end + 1).trim() !== '') continue
    const fragment = clean.slice(start, end + 1)
    if (isParseableJson(fragment)) return fragment
  }
  // 2) 自左向右：答案是 JSON、后面还有解释文字时的兜底
  checked = 0
  for (let start = 0; start < clean.length && checked < MAX_JSON_CANDIDATES; start++) {
    if (clean[start] !== '[' && clean[start] !== '{') continue
    checked++
    const end = findBalancedEnd(clean, start)
    if (end < 0) continue
    const fragment = clean.slice(start, end + 1)
    if (isParseableJson(fragment)) return fragment
  }
  return null
}

/** 容错解析 JSON，失败返回 null（不抛错，由调用方决定降级策略） */
export function parseLooseJson<T>(text: string): T | null {
  const fragment = extractJsonFragment(text)
  if (!fragment) return null
  try {
    return JSON.parse(fragment) as T
  } catch {
    return null
  }
}

// ===== 分段 / 续写指令（i18n） =====

/** 分段指令：明确告知模型本次只处理第 index/total 段，禁止它脑补其余内容 */
export function buildSegmentDirective(index: number, total: number, hint?: string): string {
  if (total <= 1) return ''
  const blocks = [
    '---',
    t('segmented.segmentHeader', { index, total }),
    t('segmented.segmentBody'),
  ]
  if (hint) blocks.push(t('segmented.segmentHint', { hint }))
  return `\n\n${blocks.join('\n')}`
}

/** 续写指令：本批次输出不完整时，要求模型只补齐剩余区间 */
export function buildResumeDirective(fromChapter: number, toChapter: number, doneChapter: number): string {
  return `\n\n---\n${t('segmented.resumeHeader', { from: fromChapter, to: toChapter })}\n${t('segmented.resumeBody', { doneChapter })}`
}

/** 截断续写指令：把上一轮的结尾贴回给模型，要求从断点继续而非重写 */
export function buildTruncatedContinueDirective(tail: string, from: number, to: number): string {
  return `\n\n---\n${t('segmented.truncatedHeader', { from, to })}\n${t('segmented.truncatedTailLabel')}\n${tail}`
}

/** 角色过滤指令：本次只允许输出指定角色，避免角色卡批次之间串味 */
export function buildCharacterFilterDirective(names: string[]): string {
  if (names.length === 0) return ''
  return `\n\n${t('segmented.characterFilter', { names: names.join('、') })}`
}

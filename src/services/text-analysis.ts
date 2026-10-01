/**
 * 审稿用文本分析工具
 *
 * 全部为纯函数、确定性算法，不依赖模型，便于单测与「可追溯」地解释检测结论。
 * 所有偏移均为相对传入文本的 1 基字符偏移，与编辑器中的光标位置一致。
 */

/** 句末标点（中英文） */
const SENTENCE_END = /[。！？!?；;…]+/

/** 中日韩字符（1 字符 ≈ 1 token）的 Unicode 区间 */
const CJK_RANGES: Array<[number, number]> = [
  [0x2e80, 0x2eff], // 部首扩展
  [0x3000, 0x303f], // CJK 标点
  [0x3040, 0x30ff], // 日文假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区
  [0xac00, 0xd7af], // 韩文
  [0xf900, 0xfaff], // CJK 兼容
  [0xff00, 0xffef], // 全角字符
]

/** 是否为宽字符（中日韩） */
export function isWideChar(codePoint: number): boolean {
  return CJK_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)
}

/**
 * 粗略估算文本 token 数：中日韩字符按 1，其余按 0.25。
 *
 * 只用于分段预算与调用量统计，不追求与具体分词器完全一致；
 * 供应商返回真实 usage 时应以真实值为准。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  let total = 0
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0
    total += isWideChar(codePoint) ? 1 : 0.25
  }
  return Math.ceil(total)
}

/** 段落分割：空行分段 */
export function splitParagraphs(text: string): string[] {
  return text.split(/(?:\r?\n){2,}/)
}

/** 带偏移的段落（偏移为 1 基，end 不含） */
export interface ParagraphSpan {
  text: string
  start: number
  end: number
  /** 段落在全文中的序号（1 基） */
  index: number
}

/**
 * 段落切分并保留偏移。
 * 与 splitParagraphs 的分隔规则一致（连续空行分段）。
 */
export function splitParagraphSpans(text: string): ParagraphSpan[] {
  const spans: ParagraphSpan[] = []
  const separator = /(?:\r?\n){2,}/g
  let cursor = 0
  let index = 0
  for (;;) {
    const match = separator.exec(text)
    const end = match ? match.index : text.length
    const chunk = text.slice(cursor, end)
    if (chunk.trim() !== '') {
      index += 1
      spans.push({ text: chunk, start: cursor + 1, end: end + 1, index })
    }
    if (!match) break
    cursor = match.index + match[0].length
  }
  return spans
}

/**
 * 句子切分。
 * 使用「保留分隔符」的切分方式，保证各段拼起来等于原文，便于换算偏移。
 */
export function splitSentences(text: string): string[] {
  const sentences: string[] = []
  let buffer = ''
  for (const char of text) {
    buffer += char
    if (SENTENCE_END.test(char)) {
      sentences.push(buffer)
      buffer = ''
    }
  }
  if (buffer) sentences.push(buffer)
  return sentences.filter(s => s.trim() !== '')
}

/** 去掉标点与空白后的「净字数」，用于句长统计 */
export function countMeaningfulChars(text: string): number {
  return text.replace(/[\s\p{P}\p{S}]/gu, '').length
}

/** 句长序列（净字数） */
export function sentenceLengths(text: string): number[] {
  return splitSentences(text).map(countMeaningfulChars)
}

/** 带偏移的句子（偏移为 1 基，end 不含） */
export interface SentenceSpan {
  text: string
  start: number
  end: number
}

/**
 * 句子切分并保留偏移。
 * 与 splitSentences 使用同一套切分规则，保证两者结果逐句对应。
 */
export function splitSentenceSpans(text: string): SentenceSpan[] {
  const spans: SentenceSpan[] = []
  let buffer = ''
  let start = 0
  for (let index = 0; index < text.length; index++) {
    const char = text[index]
    buffer += char
    if (SENTENCE_END.test(char)) {
      if (buffer.trim() !== '') spans.push({ text: buffer, start: start + 1, end: index + 2 })
      buffer = ''
      start = index + 1
    }
  }
  if (buffer) {
    if (buffer.trim() !== '') spans.push({ text: buffer, start: start + 1, end: text.length + 1 })
  }
  return spans
}

/** 变异系数 = 标准差 / 均值；均值 0 时返回 0 */
export function coefficientOfVariation(values: number[]): number {
  if (values.length === 0) return 0
  const mean = values.reduce((sum, v) => sum + v, 0) / values.length
  if (mean === 0) return 0
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance) / mean
}

/** 对话占比：中文弯引号或标准双引号包裹的内容占正文比例（0-1） */
export function dialogueRatio(text: string): number {
  const total = countMeaningfulChars(text)
  if (total === 0) return 0
  const quoted = text.match(/「[^」]*」|“[^”]*”|"[^"]*"/g) ?? []
  const quotedChars = quoted.reduce((sum, q) => sum + countMeaningfulChars(q), 0)
  return Math.min(1, quotedChars / total)
}

/** 把偏移换算成行号（1 基），供 UI 定位 */
export function offsetToLine(text: string, offset: number): number {
  if (offset <= 1) return 1
  return text.slice(0, Math.max(0, offset - 1)).split('\n').length
}

/**
 * 在原文中定位引文，返回 1 基的 [start, end]。
 *
 * 模型的引文经常带有省略号、省略号占位或轻微改写，因此按三级降级：
 *   1. 精确匹配；
 *   2. 去空白后匹配（保留原文位置换算）；
 *   3. 取最长可用片段（去掉首尾各若干字符）再匹配。
 * 全部失败时返回 null —— 调用方应保留证据文本但把偏移标为 -1，
 * 绝不猜测位置（避免误导用户去改无关的地方）。
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const target = quote.trim()
  if (!target || !text) return null

  const direct = text.indexOf(target)
  if (direct >= 0) return { start: direct + 1, end: direct + target.length + 1 }

  // 去掉空白后匹配：先构建「去空白文本 -> 原始下标」的映射
  const compactChars: string[] = []
  const originIndex: number[] = []
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (/\s/.test(char)) continue
    compactChars.push(char)
    originIndex.push(i)
  }
  const compactText = compactChars.join('')
  const compactTarget = target.replace(/\s+/g, '')

  const findInCompact = (needle: string): { start: number; end: number } | null => {
    if (!needle) return null
    const hit = compactText.indexOf(needle)
    if (hit < 0) return null
    const start = originIndex[hit]
    const end = originIndex[hit + needle.length - 1]
    return { start: start + 1, end: end + 2 }
  }

  const compactHit = findInCompact(compactTarget)
  if (compactHit) return compactHit

  // 逐步砍掉首尾，容忍模型对引文的首尾改写
  for (let trim = 4; trim <= Math.floor(compactTarget.length / 2); trim += 4) {
    const partial = findInCompact(compactTarget.slice(0, compactTarget.length - trim))
    if (partial) return partial
  }

  return null
}

/**
 * 统计 2-4 字 n-gram 的出现次数。
 * 只统计纯中文/字母数字片段，跳过标点与空白，避免把标点组合算成高频词。
 */
export function countNgrams(text: string, minN = 2, maxN = 4): Map<string, number> {
  const counts = new Map<string, number>()
  const tokens = text.split(/[^\p{Script=Han}\p{L}\p{N}]+/u).filter(Boolean)
  for (const token of tokens) {
    for (let n = minN; n <= maxN; n++) {
      if (token.length < n) continue
      for (let i = 0; i + n <= token.length; i++) {
        const gram = token.slice(i, i + n)
        counts.set(gram, (counts.get(gram) ?? 0) + 1)
      }
    }
  }
  return counts
}

/** 找出所有出现的 [start, end) 偏移（1 基） */
export function findAllOccurrences(text: string, needle: string): Array<{ start: number; end: number }> {
  const hits: Array<{ start: number; end: number }> = []
  if (!needle) return hits
  let from = 0
  for (;;) {
    const index = text.indexOf(needle, from)
    if (index < 0) break
    hits.push({ start: index + 1, end: index + needle.length + 1 })
    from = index + needle.length
  }
  return hits
}

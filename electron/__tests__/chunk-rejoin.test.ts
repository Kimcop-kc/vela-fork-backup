/**
 * 文本块还原测试 — chunkText 分块后能否无损拼回原文
 *
 * 拆书章节正文回看、把某章送去文风分析都依赖这里：
 * 分块时为了检索召回保留了重叠字符，拼回时必须去掉重叠，且不能额外插入分隔符。
 */
import { describe, expect, it } from 'vitest'
import { chunkText, joinChunkTexts, stripChunkOverlap } from '../embedding'

/** 生成第 i 段正文（约 85 字，段落之间靠 \n\n 分隔） */
function paragraph(i: number): string {
  return `这是第${i}段测试文字。` + '他走到窗前，看着远处的山峦起伏，云层压低。'.repeat(4)
}

describe('stripChunkOverlap', () => {
  it('精确匹配时按给定 overlap 去掉重复部分', () => {
    const previous = '0123456789'
    const next = '56789后面的新内容'
    expect(stripChunkOverlap(previous, next, 5)).toBe('后面的新内容')
  })

  it('重叠不足 8 个字符时不误删', () => {
    expect(stripChunkOverlap('0123456789abcdefgh', 'gh新内容')).toBe('gh新内容')
  })

  it('找不到重叠时原样返回', () => {
    expect(stripChunkOverlap('前面一段话', '完全无关的另一段话')).toBe('完全无关的另一段话')
  })
})

describe('joinChunkTexts', () => {
  it('空数组返回空串，单块原样返回', () => {
    expect(joinChunkTexts([])).toBe('')
    expect(joinChunkTexts(['唯一一块正文'])).toBe('唯一一块正文')
  })

  it('按重叠还原，而不是简单首尾相接', () => {
    const previous = '0123456789abcdefgh'
    const next = 'abcdefghijklmnop'
    expect(joinChunkTexts([previous, next])).toBe('0123456789abcdefghijklmnop')
  })

  it('段落分块后可以无损还原原文', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join('\n\n')
    const chunks = chunkText(text, 500, 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(joinChunkTexts(chunks)).toBe(text)
  })

  it('超过 maxChars 的长段落按句分块后可以无损还原', () => {
    const text = '这是一句很长的测试句子，用来触发按句分块的逻辑。'.repeat(30)
    const chunks = chunkText(text, 500, 50)
    expect(chunks.length).toBeGreaterThan(1)
    expect(joinChunkTexts(chunks)).toBe(text)
  })

  it('还原后的段落分隔符仍是单个空行，不会多出空行', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i + 1)).join('\n\n')
    const restored = joinChunkTexts(chunkText(text, 500, 50))
    expect(restored.includes('\n\n\n')).toBe(false)
  })
})

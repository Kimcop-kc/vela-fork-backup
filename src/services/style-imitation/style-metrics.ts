/**
 * 参考文风的量化分析
 *
 * 全部为确定性算法：每一个数字都能在参考文本里指回原文，
 * 这是「有证据的文风指南」的基础 —— 即使模型不可用，
 * 也能据此编译出一份带证据的指南。
 */
import { locateQuote } from '../text-analysis'
import { coefficientOfVariation, countMeaningfulChars, countNgrams, dialogueRatio, splitParagraphSpans, splitSentenceSpans } from '../text-analysis'
import type { StyleEvidence, StyleMetrics } from './types'

/** 参与统计的标点 */
const TRACKED_PUNCTUATION = ['，', '。', '！', '？', '…', '—', '：', '；', '、', '「', '“']

/** 代表性样本句的选取条件 */
const MIN_SAMPLE_LENGTH = 6

/** 高频表达的最少出现次数 */
const MIN_EXPRESSION_REPEATS = 3

/** 分析参考文本，产出量化特征 */
export function measureStyle(referenceText: string, sampleLimit = 8): StyleMetrics {
  const text = referenceText ?? ''
  const characters = countMeaningfulChars(text)
  const sentences = splitSentenceSpans(text)
  const paragraphs = splitParagraphSpans(text)

  const lengths = sentences.map(item => countMeaningfulChars(item.text))
  const mean = lengths.length > 0 ? lengths.reduce((sum, v) => sum + v, 0) / lengths.length : 0
  const kiloChars = Math.max(1, characters / 1000)

  const punctuationProfile = TRACKED_PUNCTUATION
    .map(mark => {
      const count = countOccurrences(text, mark)
      return { mark, count, perKiloChars: Math.round((count / kiloChars) * 100) / 100 }
    })
    .filter(item => item.count > 0)
    .sort((a, b) => b.perKiloChars - a.perKiloChars)

  const bigrams = countNgrams(text, 2, 2)
  const distinctBigrams = bigrams.size
  const totalBigrams = Array.from(bigrams.values()).reduce((sum, v) => sum + v, 0)

  return {
    characters,
    sentences: sentences.length,
    paragraphs: paragraphs.length,
    averageSentenceLength: Math.round(mean * 10) / 10,
    sentenceLengthVariation: Math.round(coefficientOfVariation(lengths) * 1000) / 1000,
    dialogueRatio: Math.round(dialogueRatio(text) * 1000) / 1000,
    averageParagraphLength: paragraphs.length > 0
      ? Math.round((characters / paragraphs.length) * 10) / 10
      : 0,
    lexicalDiversity: totalBigrams > 0 ? Math.round((distinctBigrams / totalBigrams) * 1000) / 1000 : 0,
    punctuationProfile,
    frequentExpressions: topExpressions(text, sampleLimit),
    signatureSamples: pickSignatureSamples(text, sentences),
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0
  let from = 0
  for (;;) {
    const index = text.indexOf(needle, from)
    if (index < 0) break
    count += 1
    from = index + needle.length
  }
  return count
}

/** 高频特征表达：出现次数最多的 2-4 字片段（去掉被更长片段覆盖的短片段） */
function topExpressions(text: string, limit: number): Array<{ text: string; count: number }> {
  const counts = countNgrams(text, 2, 4)
  const candidates = Array.from(counts.entries())
    .filter(([, count]) => count >= MIN_EXPRESSION_REPEATS)
    .sort((a, b) => (b[1] - a[1]) || (b[0].length - a[0].length))

  const accepted: Array<[string, number]> = []
  for (const [gram, count] of candidates) {
    if (accepted.some(([kept, keptCount]) => keptCount === count && (kept.includes(gram) || gram.includes(kept)))) continue
    accepted.push([gram, count])
    if (accepted.length >= limit) break
  }
  return accepted.map(([expression, count]) => ({ text: expression, count }))
}

/** 挑出最短句、最长句和一条对话句作为「风格样本」 */
function pickSignatureSamples(
  text: string,
  sentences: Array<{ text: string; start: number; end: number }>,
): StyleMetrics['signatureSamples'] {
  const usable = sentences.filter(item => countMeaningfulChars(item.text) >= MIN_SAMPLE_LENGTH)
  if (usable.length === 0) return { shortest: null, longest: null, dialogue: null }

  const toEvidence = (item: { text: string; start: number; end: number }): StyleEvidence => {
    const quote = item.text.trim()
    const located = locateQuote(text, quote)
    return { quote, start: located ? located.start : -1, end: located ? located.end : -1 }
  }

  const sorted = [...usable].sort((a, b) => countMeaningfulChars(a.text) - countMeaningfulChars(b.text))
  const dialogue = usable.find(item => /「[^」]*」|“[^”]*”|"[^"]*"/.test(item.text))

  return {
    shortest: toEvidence(sorted[0]),
    longest: toEvidence(sorted[sorted.length - 1]),
    dialogue: dialogue ? toEvidence(dialogue) : null,
  }
}
/**
 * 文风仿写单测
 *
 * 核心不变量：**没有证据的规则不进入指南**。
 * 量化规则与模型规则走的是同一条约束，区别只在来源可追溯。
 */
import { describe, expect, it } from 'vitest'
import {
  compileStyleGuide,
  measureStyle,
  referenceLength,
  renderStyleGuide,
  splitStyleReference,
  summarizeGuide,
} from '../style-imitation'

const REFERENCE = [
  '他走进屋，把伞靠在门边。雨还在下。',
  '「你回来了。」她说。',
  '他没有回答，只是看着她。窗外的水声一直没停，像有人在外头轻轻地敲门。',
].join('\n\n')

describe('文风指南：无证据不入指南', () => {
  it('模型规则缺少证据时被丢弃', () => {
    const guide = compileStyleGuide({
      referenceText: REFERENCE,
      sourceTitle: '参考文本',
      skillName: 'test-skill',
      rawLlmRules: {
        rules: [
          { category: 'imagery', statement: '多用雨与水的意象', evidence: ['雨还在下'] },
          { category: 'voice', statement: '使用第三人称限知视角' },
          { category: 'lexicon', statement: '用词克制', evidence: [] },
          { category: 'no-such-category', statement: '类别无法识别', evidence: ['雨还在下'] },
        ],
      },
    })

    const fromLlm = guide.rules.filter(rule => rule.origin === 'llm')
    expect(fromLlm).toHaveLength(1)
    expect(fromLlm[0].statement).toContain('雨与水')
    expect(fromLlm[0].evidence[0].quote).toBe('雨还在下')
    expect(fromLlm[0].evidence[0].start).toBeGreaterThan(0)
  })

  it('量化规则同样全部带证据', () => {
    const guide = compileStyleGuide({ referenceText: REFERENCE, sourceTitle: '参考文本' })
    expect(guide.rules.length).toBeGreaterThan(0)
    for (const rule of guide.rules) {
      expect(rule.evidence.length).toBeGreaterThan(0)
      expect(rule.evidence.every(item => item.quote.trim() !== '')).toBe(true)
    }
    expect(summarizeGuide(guide).evidence).toBeGreaterThanOrEqual(guide.rules.length)
  })

  it('渲染结果只包含带证据的规则，并标明编译用的 Skill', () => {
    const guide = compileStyleGuide({
      referenceText: REFERENCE,
      sourceTitle: '参考文本',
      skillName: 'test-skill',
      rawLlmRules: {
        rules: [
          { category: 'imagery', statement: '多用雨与水的意象', evidence: ['雨还在下'] },
          { category: 'voice', statement: '使用第三人称限知视角' },
        ],
      },
    })
    const markdown = renderStyleGuide(guide)
    expect(markdown).toContain('test-skill')
    expect(markdown).toContain('证据')
    expect(markdown).toContain('雨与水的意象')
    expect(markdown).not.toContain('使用第三人称限知视角')
  })
})

describe('参考文本度量', () => {
  it('净字数忽略空白与标点', () => {
    expect(referenceLength('  \n ，。 ')).toBe(0)
    expect(referenceLength(REFERENCE)).toBeGreaterThan(0)
  })

  it('量化分析给出可复核的指标', () => {
    const metrics = measureStyle(REFERENCE)
    expect(metrics.characters).toBe(referenceLength(REFERENCE))
    expect(metrics.sentences).toBeGreaterThan(0)
    expect(metrics.averageSentenceLength).toBeGreaterThan(0)
    expect(metrics.dialogueRatio).toBeGreaterThan(0)
    expect(metrics.signatureSamples.shortest).not.toBeNull()
  })

  it('未超预算时参考文本原样作为单段', () => {
    expect(splitStyleReference('短文本。', 1000)).toEqual(['短文本。'])
  })
})

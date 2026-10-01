/**
 * 定性审稿单测
 *
 * 覆盖三类核心契约：
 *   1. 可追溯：模型的引文必须回帖到正文换算出真实偏移，定位失败只保留引文；
 *   2. 只标记：AI 痕迹检测只产出「可修订位置 + 指标 + 方向」，不改动正文；
 *   3. 不判定：审稿产物里没有通过/失败语义，修订只能被显式发起。
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_AI_TRACE_THRESHOLDS, detectAiTraces } from '../review/ai-trace-detector'
import {
  detectUnregisteredSpeakers,
  observationId,
  parseObservations,
} from '../review/continuity-observer'
import { buildRevisionBrief, observeChapter } from '../review'
import { countMeaningfulChars, locateQuote } from '../text-analysis'
import { splitDraftWithSpans } from '../workflows/commands/deai-revise.command'

describe('文本定位', () => {
  const content = '第一段没有什么特别的。\n第二段里有一句独特的话，值得引用。'

  it('精确定位引文并给出 1 基偏移', () => {
    const located = locateQuote(content, '独特的话')
    expect(located).not.toBeNull()
    expect(content.slice(located!.start - 1, located!.end - 1)).toBe('独特的话')
  })

  it('找不到时不猜测位置', () => {
    expect(locateQuote(content, '这段文字压根不存在')).toBeNull()
  })

  it('净字数忽略空白与标点', () => {
    expect(countMeaningfulChars('，。！  \n')).toBe(0)
    expect(countMeaningfulChars('雨还在下。')).toBe(4)
  })
})

describe('内置 AI 痕迹检测', () => {
  it('重复出现的高频词会被标记为可修订位置', () => {
    const text = '苏离走进门。苏离抬头。苏离笑了。苏离坐下。苏离开口。苏离走了。'
    const findings = detectAiTraces(text)
    const word = findings.find(finding => finding.kind === 'high-frequency-word')
    expect(word).toBeDefined()
    expect(word!.occurrences.length).toBeGreaterThan(1)
    expect(word!.metric.value).toBeGreaterThan(0)
    expect(word!.hint).not.toBe('')
  })

  it('段尾总结腔会被标记，但含对白的句子不算总结', () => {
    const narrative = [
      '他把刀收进鞘里，转身走出门去。',
      '院子里的灯还亮着，风吹得帘子乱响。',
      '他知道，命运的齿轮已经开始转动。',
    ].join('\n\n')
    const summary = detectAiTraces(narrative)
    expect(summary.some(finding => finding.kind === 'over-summary')).toBe(true)

    const withDialogue = [
      '他把刀收进鞘里，转身走出门去。',
      '院子里的灯还亮着，风吹得帘子乱响。',
      '「他知道，命运的齿轮已经开始转动。」她说。',
    ].join('\n\n')
    expect(detectAiTraces(withDialogue).some(finding => finding.kind === 'over-summary')).toBe(false)
  })

  it('连续同构开头会被标记为句式单调', () => {
    const text = [
      '他缓步走进屋子。他缓步放下包。他缓步坐了下来。',
      '窗外有风。远处传来脚步声。他抬头看了一眼。',
      '桌上放着一封信。信纸已经泛黄。他伸手拿起信。',
      '手指有些发抖。他慢慢拆开信封。里面只有一张纸。',
    ].join('')
    const findings = detectAiTraces(text)
    const monotone = findings.find(finding => finding.kind === 'monotonous-sentence')
    expect(monotone).toBeDefined()
    expect(monotone!.metric.label).toBe('consecutiveSameStart')
  })

  it('标记结果只含位置、指标与方向，不携带改写后的正文', () => {
    const text = '苏离走进门。苏离抬头。苏离笑了。苏离坐下。苏离开口。苏离走了。'
    const findings = detectAiTraces(text)
    expect(findings.length).toBeGreaterThan(0)
    for (const finding of findings) {
      expect(finding.start).toBeGreaterThanOrEqual(1)
      expect(finding.message).not.toBe('')
      expect(finding.hint).not.toBe('')
      expect(finding.metric.threshold).toBeGreaterThan(0)
    }
    // 阈值公开可覆盖：放大阈值后不再标记，说明检测完全由公开常量驱动
    expect(detectAiTraces(text, { thresholds: { minWordRepeats: 99 } })
      .some(finding => finding.kind === 'high-frequency-word')).toBe(false)
    expect(DEFAULT_AI_TRACE_THRESHOLDS.minWordRepeats).toBeGreaterThan(0)
  })
})

describe('观察归一化', () => {
  const content = '苏离推开门，看见桌上放着一枚铜钱。\n\n铜钱正面刻着一个字。'

  it('回帖证据并给出稳定 id，无法识别维度的条目被丢弃', () => {
    const raw = {
      observations: [
        {
          dimension: '角色记忆',
          severity: '严重',
          title: '角色认知越界',
          detail: '苏离不该知道铜钱的主人。',
          evidence: ['苏离推开门'],
          suggestion: '补一句得知的经过。',
        },
        { dimension: '天气', title: '维度无法识别' },
        { dimension: 'pacing', title: '节奏平直' },
        'not-an-object',
      ],
    }
    const { observations, skipped } = parseObservations(raw, 7, content)
    expect(observations).toHaveLength(2)
    expect(skipped).toBe(2)

    const [first, second] = observations
    expect(first.dimension).toBe('character-memory')
    expect(first.severity).toBe('concern')
    expect(first.id).toBe(observationId('character-memory', '角色认知越界'))
    expect(first.evidence[0].start).toBe(locateQuote(content, '苏离推开门')!.start)
    expect(first.relatedChapters).toEqual([7])

    expect(second.origin).toBe('llm')
    expect(second.evidence).toEqual([])
  })

  it('正文里找不到的引文只保留文本，偏移记为 -1', () => {
    const { observations } = parseObservations(
      { observations: [{ dimension: 'pacing', title: '节奏平直', evidence: ['这句在正文里不存在'] }] },
      1,
      content,
    )
    expect(observations[0].evidence[0].start).toBe(-1)
    expect(observations[0].evidence[0].quote).toBe('这句在正文里不存在')
  })

  it('本地规则只在同一说话人出现两次以上时才报告', () => {
    expect(detectUnregisteredSpeakers('张三说道：“走吧。”', [], 1)).toHaveLength(0)

    const repeated = '张三说道：“走吧。”\n\n张三说道：“好。”'
    const found = detectUnregisteredSpeakers(repeated, [], 1)
    expect(found).toHaveLength(1)
    expect(found[0].origin).toBe('rule')
    expect(found[0].severity).toBe('watch')
    expect(found[0].title).toContain('张三')
    expect(found[0].evidence[0].start).toBeGreaterThan(0)
  })
})

describe('审稿产物合成', () => {
  const content = '苏离说道：“走吧。”\n\n苏离说道：“好。”'

  it('合并模型观察与本地规则观察，并保留上下文规模', () => {
    const review = observeChapter({
      chapterNumber: 5,
      chapterTitle: '第五章',
      chapterContent: content,
      knownCharacterNames: [],
      rawLlmResult: { observations: [{ dimension: 'pacing', title: '节奏平直' }] },
      contextSize: { timelineEvents: 2, characterStates: 1, openPlotLines: 0, knownFacts: 3 },
    })
    expect(review.observations).toHaveLength(2)
    expect(review.observations.some(observation => observation.origin === 'rule')).toBe(true)
    expect(review.context.knownFacts).toBe(3)
    expect(review.stats.characters).toBe(countMeaningfulChars(content))
    expect(review.stats.sentences).toBeGreaterThan(0)
  })

  it('模型不可用时依旧产出本地检测结果（不是失败判定）', () => {
    const review = observeChapter({
      chapterNumber: 5,
      chapterTitle: '第五章',
      chapterContent: content,
      knownCharacterNames: [],
    })
    expect(review.observations.length).toBeGreaterThan(0)
    expect(JSON.stringify(review)).not.toContain('passed')
    expect(Object.keys(review)).not.toContain('verdict')
  })

  it('修订说明只覆盖被显式选中的观察', () => {
    const review = observeChapter({
      chapterNumber: 5,
      chapterTitle: '第五章',
      chapterContent: content,
      knownCharacterNames: [],
    })
    const brief = buildRevisionBrief(review.observations, content)
    expect(brief).toContain(review.observations[0].title)
    expect(brief).toContain('只处理以上列出的观察')
    expect(buildRevisionBrief([], content)).toBe('')
  })
})

describe('去 AI 味分段改写', () => {
  const longText = [
    '第一段：雨点砸在铁皮屋顶上，声音密得像有人在上面撒豆子。',
    '第二段：他把潮湿的外套挂在门后，抬手抹了一把脸上的水。',
    '第三段：屋里的炉火快灭了，只剩一层暗红的灰。他知道，命运的齿轮已经开始转动。',
    '第四段：他终于开口：“走吧，天亮之前必须出城。”',
  ].join('\n\n')

  it('按预算切段，且所有片段拼接后与原文完全一致', () => {
    const chunks = splitDraftWithSpans(longText, 30)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(longText)
    expect(chunks[0].start).toBe(0)
    expect(chunks[chunks.length - 1].end).toBe(longText.length)
  })

  it('段间空行归上一段，改写后接回去不会丢掉空行', () => {
    const chunks = splitDraftWithSpans(longText, 30)
    expect(chunks.some(chunk => chunk.trailing.includes('\n'))).toBe(true)
    const rebuilt = chunks
      .map((chunk, index) => (index === 0 ? `${chunk.leading}改写后的第一段。${chunk.trailing}` : chunk.text))
      .join('')
    expect(rebuilt.startsWith('改写后的第一段。')).toBe(true)
    expect(rebuilt).toContain('\n\n第二段')
    expect(rebuilt.endsWith('必须出城。”')).toBe(true)
  })

  it('预算足够时不分段，空文本也不产生空片段', () => {
    const single = splitDraftWithSpans('只有一个段落。', 500)
    expect(single).toHaveLength(1)
    expect(single[0].text).toBe('只有一个段落。')
    expect(splitDraftWithSpans('', 500)).toHaveLength(1)
  })

  it('每处标记恰好落在一个片段内，便于把修订精确到段', () => {
    const chunks = splitDraftWithSpans(longText, 30)
    for (const finding of detectAiTraces(longText)) {
      for (const occurrence of finding.occurrences) {
        const hits = chunks.filter(chunk => occurrence.start - 1 >= chunk.start && occurrence.start - 1 < chunk.end)
        expect(hits).toHaveLength(1)
      }
    }
  })
})

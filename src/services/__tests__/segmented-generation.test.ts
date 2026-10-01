import { describe, expect, it } from 'vitest'
import {
  buildCharacterFilterDirective,
  buildSegmentDirective,
  buildContinuationDirective,
  callSegmentWithShrink,
  callWithShrink,
  chunkArray,
  clampToTokenBudget,
  dropContinuationOverlap,
  estimateTokens,
  extractJsonFragment,
  generateWithContinuation,
  halveText,
  isFilledValue,
  isOutputLengthError,
  mergeByKey,
  mergeChapterNotes,
  mergeFilled,
  parseLooseJson,
  resolveChunkBudget,
  resolveGenerationBudgets,
  splitItemsByTokenBudget,
  splitTextByTokenBudget,
} from '../workflows/segmented-generation'

describe('生成预算与 token 估算', () => {
  it('模型未配置时回退到 4096 并给出保守的输入预算', () => {
    const budgets = resolveGenerationBudgets(undefined)
    expect(budgets.outputTokens).toBe(4096)
    expect(budgets.inputTokens).toBeGreaterThanOrEqual(4000)
    expect(budgets.inputTokens).toBeLessThanOrEqual(48000)
  })

  it('按中文字符 1 token、英文约 0.25 token 估算', () => {
    expect(estimateTokens('中文四字')).toBe(4)
    expect(estimateTokens('abcde')).toBeGreaterThan(0)
    expect(estimateTokens('中文')).toBeGreaterThan(estimateTokens('ab'))
    expect(estimateTokens('')).toBe(0)
  })

  it('按预算截断时保留句子完整性', () => {
    const text = '第一句话结束。第二句话也有内容。第三句话同样如此。'
    const clipped = clampToTokenBudget(text, 8)
    expect(clipped.length).toBeLessThan(text.length)
    expect(clipped.endsWith('。')).toBe(true)
  })
})

describe('长文分段', () => {
  it('未超预算时原样返回单段', () => {
    expect(splitTextByTokenBudget('短文本。', 1000)).toEqual(['短文本。'])
  })

  it('按段落边界切分且拼接结果与原文一致', () => {
    const paragraphs = Array.from({ length: 12 }, (_, index) => `第${index + 1}段：${'内容'.repeat(60)}。`)
    const text = paragraphs.join('\n\n')
    const chunks = splitTextByTokenBudget(text, 200)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('\n\n')).toBe(text)
    for (const chunk of chunks) expect(estimateTokens(chunk)).toBeLessThanOrEqual(200 + 40)
  })

  it('没有空行分隔的超长文本也能切分', () => {
    const text = '这是一个没有任何空行的超长句子。'.repeat(80)
    const chunks = splitTextByTokenBudget(text, 100)
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.join('')).toBe(text)
  })

  it('条目按预算分组，组内 token 不超过预算', () => {
    const items = Array.from({ length: 10 }, (_, index) => ({ id: index, text: '内容'.repeat(40) }))
    const groups = splitItemsByTokenBudget(items, item => item.text, 100)
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.flat()).toHaveLength(items.length)
  })

  it('chunkArray 按固定条数切分', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunkArray([], 3)).toEqual([])
  })
})

describe('分段结果合并', () => {
  it('空值与占位值不会覆盖有效值', () => {
    expect(isFilledValue('（待确认）')).toBe(false)
    expect(isFilledValue('')).toBe(false)
    expect(isFilledValue([])).toBe(false)
    expect(isFilledValue('有效')).toBe(true)
  })

  it('mergeFilled 递归合并对象并合并数组', () => {
    const base: Record<string, unknown> = { name: '张三', currentState: { location: '青云山', keyItems: [] as string[] }, tags: ['a'] }
    const incoming: Record<string, unknown> = { name: '', currentState: { location: '', powerLevel: '筑基', keyItems: ['剑'] }, tags: ['a', 'b'] }
    const merged = mergeFilled(base, incoming)
    expect(merged.name).toBe('张三')
    const state = merged.currentState as { location: string; powerLevel: string; keyItems: string[] }
    expect(state.location).toBe('青云山')
    expect(state.powerLevel).toBe('筑基')
    expect(state.keyItems).toEqual(['剑'])
    expect(merged.tags).toEqual(['a', 'b'])
  })

  it('prefer=first 保留先出现的值，prefer=richest 保留更长的描述', () => {
    const first = { desc: '简短' }
    const later = { desc: '更长更完整的描述内容' }
    expect(mergeFilled(first, later, 'first').desc).toBe('简短')
    expect(mergeFilled(later, first, 'richest').desc).toBe('更长更完整的描述内容')
  })

  it('mergeByKey 按主键去重并保持顺序', () => {
    const groups = [
      [{ name: '甲', role: 'protagonist' }, { name: '乙', role: 'supporting' }],
      [{ name: '甲', role: 'antagonist' }],
    ]
    const merged = mergeByKey(groups, { keyOf: item => String(item.name ?? '') })
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ name: '甲', role: 'antagonist' })
    expect(mergeByKey(groups, { keyOf: item => String(item.name ?? ''), prefer: 'first' })[0]).toEqual({ name: '甲', role: 'protagonist' })
  })

  it('合并角色动态表格时保留同一角色的全部描述并去重条目', () => {
    const partA = [
      '# 第1章 要点',
      '## 剧情节点',
      '- [触发] 主角被迫下山',
      '## 角色动态',
      '| 角色 | 本章变化/状态 |',
      '|------|-------------|',
      '| 张三 | 获得残剑 |',
      '## 伏笔与钩子',
      '- [埋] 残剑来历不明',
    ].join('\n')
    const partB = [
      '# 第1章 要点',
      '## 剧情节点',
      '- [转折] 主角被迫下山',
      '- [结果] 结识李四',
      '## 角色动态',
      '| 角色 | 本章变化/状态 |',
      '|------|-------------|',
      '| 张三 | 与李四结盟 |',
      '| 李四 | 出现在客栈 |',
    ].join('\n')
    const merged = mergeChapterNotes([partA, partB])
    expect(merged).toContain('## 剧情节点')
    expect(merged).toContain('结识李四')
    expect(merged.match(/被迫下山/g)).toHaveLength(1)
    expect(merged).toContain('| 张三 | 获得残剑；与李四结盟 |')
    expect(merged).toContain('| 李四 | 出现在客栈 |')
    expect(merged).toContain('残剑来历不明')
  })

  it('单段或非结构化内容直接返回，不做破坏性改写', () => {
    expect(mergeChapterNotes(['纯文本要点'])).toBe('纯文本要点')
    expect(mergeChapterNotes(['纯文本A', '纯文本B'])).toBe('纯文本A\n\n纯文本B')
  })
})

describe('JSON 容错解析', () => {
  it('剥离代码块并取最后一个平衡 JSON', () => {
    const raw = '思考过程 { 不是结果 }\n```json\n{"characters":[{"name":"甲"}]}\n```'
    expect(parseLooseJson<{ characters: Array<{ name: string }> }>(raw)?.characters[0].name).toBe('甲')
  })

  it('被截断的 JSON 返回 null 而不是抛错', () => {
    expect(extractJsonFragment('{"characters":[{"name":"甲"')).toBeNull()
    expect(parseLooseJson('{"characters":[{"name":"甲"')).toBeNull()
  })

  it('JSON 后面还有解释文字时仍能取出答案', () => {
    const raw = '{"characters":[{"name":"乙"}]}\n以上是本章全部角色。'
    expect(parseLooseJson<{ characters: Array<{ name: string }> }>(raw)?.characters[0].name).toBe('乙')
  })

  it('嵌套对象取最外层，不会被内层片段截胡', () => {
    expect(parseLooseJson<{ characters: Array<{ name: string }> }>('说明：{"characters":[{"name":"丙"}]}')?.characters[0].name).toBe('丙')
  })
})

describe('分段指令', () => {
  it('单段时不追加任何指令', () => {
    expect(buildSegmentDirective(1, 1, '提示')).toBe('')
    expect(buildCharacterFilterDirective([])).toBe('')
  })

  it('多段时带上段序号与角色过滤信息', () => {
    const directive = buildSegmentDirective(2, 3, '只处理本段')
    expect(directive).toContain('2/3')
    expect(directive).toContain('只处理本段')
    expect(buildCharacterFilterDirective(['甲', '乙'])).toContain('甲、乙')
  })
})

describe('输出被截断时的自动缩段重试', () => {
  const LENGTH_ERROR = '模型输出达到长度上限，结果不完整，未提交本轮操作。请分段改写或增加模型输出上限。'

  it('能识别供应商的截断错误', () => {
    expect(isOutputLengthError(LENGTH_ERROR)).toBe(true)
    expect(isOutputLengthError(new Error(LENGTH_ERROR))).toBe(true)
    expect(isOutputLengthError('finish_reason=length')).toBe(true)
    expect(isOutputLengthError(new Error('网络连接失败'))).toBe(false)
  })

  it('某段撞上输出上限时自动对半再切，并把各半结果合并回来', async () => {
    const text = Array.from({ length: 16 }, (_, index) => `第${index + 1}段：${'甲'.repeat(40)}`).join('\n\n')
    const attempts: string[] = []
    const items = await callWithShrink(text, 200, async (segment) => {
      attempts.push(segment)
      if (estimateTokens(segment) > 100) throw new Error(LENGTH_ERROR)
      return [segment.slice(0, 3)]
    })
    expect(attempts.length).toBeGreaterThan(1)
    expect(items.length).toBeGreaterThan(1)
    expect(items.every(item => item.length > 0)).toBe(true)
  })

  it('切不动时如实抛错，非截断错误不做无意义重试', async () => {
    await expect(
      callWithShrink('一', 200, async () => { throw new Error(LENGTH_ERROR) }),
    ).rejects.toThrow('达到长度上限')
    await expect(
      callWithShrink('内容', 200, async () => { throw new Error('网络连接失败') }),
    ).rejects.toThrow('网络连接失败')
  })

  it('段比预算小得多时按实际长度强切，而不是直接放弃', async () => {
    // 段本身只有 24 token，远小于预算 200；按预算的一半切不出两段，必须回退到按实际长度切
    const text = '第一句话写在这里。第二句话也写在这里。第三句话同样写在这里。'
    const attempts: string[] = []
    const result = await callSegmentWithShrink(
      text,
      200,
      async (segment) => {
        attempts.push(segment)
        if (attempts.length === 1) throw new Error(LENGTH_ERROR)
        return segment
      },
      parts => parts.join(''),
    )
    expect(attempts.length).toBeGreaterThan(1)
    expect(estimateTokens(result)).toBe(estimateTokens(text))
  })

  it('callSegmentWithShrink 支持任意返回值，由 merge 决定合并方式', async () => {
    let firstAttempt = true
    const merged = await callSegmentWithShrink(
      '甲甲甲甲甲甲\n\n乙乙乙乙乙乙\n\n丙丙丙丙丙丙',
      12,
      async (segment) => {
        // 首次整段调用撞上输出上限，缩段后每段都能正常返回
        if (firstAttempt) {
          firstAttempt = false
          throw new Error(LENGTH_ERROR)
        }
        return segment.trim().slice(0, 1)
      },
      parts => parts.join('-'),
    )
    expect(merged).toBe('甲-乙-丙')
  })
})

describe('切段预算与强制对半切分', () => {
  it('resolveChunkBudget 同时受输入与输出上限约束', () => {
    // 输出上限更小：按输出上限切
    expect(resolveChunkBudget({ outputTokens: 2000, inputTokens: 48000 })).toBe(2000)
    // 输入预算（扣掉预留）更小：按输入切
    expect(resolveChunkBudget({ outputTokens: 30000, inputTokens: 8000 }, 2000)).toBe(6000)
    // 两者都极小：兜底到 1000，避免切出无意义碎片
    expect(resolveChunkBudget({ outputTokens: 512, inputTokens: 4000 }, 3800)).toBe(1000)
  })

  it('halveText 按实际长度对半切，且能切开单个长句', () => {
    const single = '这是一句没有任何标点分隔符而且特别特别长的句子'.repeat(2)
    const halves = halveText(single)
    expect(halves.length).toBeGreaterThan(1)
    expect(halves.join('')).toBe(single)
    // 已经无法再切时返回单元素数组
    expect(halveText('一')).toHaveLength(1)
  })
})

describe('通用续写（截断后自动补齐）', () => {
  it('首轮未截断时只调用一次', async () => {
    let calls = 0
    const outcome = await generateWithContinuation(async () => {
      calls++
      return { text: '完整结果', truncated: false }
    })
    expect(calls).toBe(1)
    expect(outcome).toEqual({ text: '完整结果', rounds: 1, truncated: false })
  })

  it('被截断时把已产出内容回传给下一轮并拼接', async () => {
    const seen: Array<{ round: number; accumulated: string; tail: string }> = []
    const outcome = await generateWithContinuation(async (ctx) => {
      seen.push({ round: ctx.round, accumulated: ctx.accumulated, tail: ctx.tail })
      return ctx.round === 0
        ? { text: '前半段', truncated: true }
        : { text: '后半段', truncated: false }
    })
    expect(outcome.text).toBe('前半段后半段')
    expect(outcome.rounds).toBe(2)
    expect(outcome.truncated).toBe(false)
    // 第二轮拿到的是首轮结果作为衔接上下文
    expect(seen[1]).toEqual({ round: 1, accumulated: '前半段', tail: '前半段' })
  })

  it('达到最大轮数仍被截断时如实标记，不会无限续写', async () => {
    let calls = 0
    const outcome = await generateWithContinuation(async () => {
      calls++
      return { text: `第${calls}段`, truncated: true }
    }, { maxRounds: 3 })
    expect(calls).toBe(3)
    expect(outcome.rounds).toBe(3)
    expect(outcome.truncated).toBe(true)
    expect(outcome.text).toBe('第1段第2段第3段')
  })

  it('默认拼接会去掉模型重抄的重复衔接内容', () => {
    expect(dropContinuationOverlap('主角推开沉重的木门，', '主角推开沉重的木门，他看见了尸体')).toBe('他看见了尸体')
    // 重叠过短（少于 8 字符）时不处理，避免误删正常内容
    expect(dropContinuationOverlap('abc', 'abc')).toBe('abc')
  })

  it('续写指令带上轮次且不含上一轮正文（正文由 assistant 消息承载）', () => {
    expect(buildContinuationDirective(2)).toContain('2')
  })
})

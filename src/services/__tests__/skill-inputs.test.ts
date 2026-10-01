/**
 * Skill 输入参数测试
 *
 * 覆盖 SKILL.md 里 `inputs` 声明的解析、表单初值、必填校验、
 * 以及把参数套进方法正文时的替换行为。
 */
import { describe, expect, it } from 'vitest'
import {
  applySkillTemplate,
  applySkillValues,
  buildSkillArgs,
  defaultSkillValues,
  missingRequiredSkillValues,
  normalizeSkillInputs,
  skillInputLabel,
  skillInputType,
} from '../agent/skill-inputs'

describe('normalizeSkillInputs', () => {
  it('解析 frontmatter 里的单行 JSON', () => {
    const fields = normalizeSkillInputs('[{"name":"topic","label":"主题","type":"text","required":true}]')
    expect(fields).toEqual([
      {
        name: 'topic',
        label: '主题',
        type: 'text',
        description: undefined,
        placeholder: undefined,
        required: true,
        default: undefined,
        options: undefined,
      },
    ])
  })

  it('也接受已经解析好的数组', () => {
    expect(normalizeSkillInputs([{ name: 'count', type: 'number', default: 3 }])[0]).toMatchObject({
      name: 'count',
      type: 'number',
      default: 3,
    })
  })

  it('非法输入返回空数组而不是抛错', () => {
    expect(normalizeSkillInputs('不是 JSON')).toEqual([])
    expect(normalizeSkillInputs('{"name":"x"}')).toEqual([])
    expect(normalizeSkillInputs(undefined)).toEqual([])
    expect(normalizeSkillInputs([null, 42, 'x'])).toEqual([])
  })

  it('丢掉没有名字、名字非法或重复的字段', () => {
    const fields = normalizeSkillInputs([
      { name: 'ok-one' },
      { name: '  ' },
      { name: 'bad name' },
      { name: 'ok-one', label: '重复项' },
    ])
    // 连字符是 ${name} 的合法字符，空格会被去掉
    expect(fields.map(f => f.name)).toEqual(['ok-one', 'badname'])
  })

  it('select 没有候选项时退化成 text', () => {
    expect(normalizeSkillInputs([{ name: 'a', type: 'select' }])[0].type).toBe('text')
    expect(normalizeSkillInputs([{ name: 'a', type: 'select', options: [] }])[0].type).toBe('text')
    expect(
      normalizeSkillInputs([{ name: 'a', type: 'select', options: ['x', { value: 'y', label: 'Y' }] }])[0].options,
    ).toEqual([{ value: 'x' }, { value: 'y', label: 'Y' }])
  })

  it('未知 type 退回 text，布尔默认值归一化', () => {
    const fields = normalizeSkillInputs([
      { name: 'a', type: 'unknown' },
      { name: 'b', type: 'boolean', default: 'true' },
    ])
    expect(skillInputType(fields[0])).toBe('text')
    expect(fields[1].default).toBe(true)
  })

  it('标签缺省时退回字段名', () => {
    expect(skillInputLabel({ name: 'topic' })).toBe('topic')
    expect(skillInputLabel({ name: 'topic', label: '主题' })).toBe('主题')
  })
})

describe('defaultSkillValues / 必填校验', () => {
  const fields = normalizeSkillInputs([
    { name: 'topic', required: true },
    { name: 'tone', default: '克制' },
    { name: 'keep', type: 'boolean', default: false },
  ])

  it('有默认值用默认值，其余留空', () => {
    expect(defaultSkillValues(fields)).toEqual({ topic: '', tone: '克制', keep: 'false' })
  })

  it('只报必填且为空的字段', () => {
    expect(missingRequiredSkillValues(fields, { topic: '', tone: '克制' }).map(f => f.name)).toEqual(['topic'])
    expect(missingRequiredSkillValues(fields, { topic: '  ', tone: '' }).map(f => f.name)).toEqual(['topic'])
    expect(missingRequiredSkillValues(fields, { topic: '修仙' })).toEqual([])
  })
})

describe('buildSkillArgs', () => {
  const fields = normalizeSkillInputs([
    { name: 'topic', label: '主题' },
    { name: 'tone', label: '语气' },
    { name: 'keep', label: '保留原文', type: 'boolean' },
  ])

  it('跳过空值，保留显式的布尔 false', () => {
    expect(buildSkillArgs(fields, { topic: '修仙', tone: '', keep: 'false' })).toBe('主题: 修仙\n保留原文: false')
  })

  it('全部为空时返回空串', () => {
    expect(buildSkillArgs(fields, {})).toBe('')
  })
})

describe('applySkillValues', () => {
  it('按字段名替换', () => {
    expect(applySkillValues('围绕 ${topic} 写一段，语气 ${tone}。', { topic: '修仙', tone: '克制' }))
      .toBe('围绕 修仙 写一段，语气 克制。')
  })

  it('未提供的字段原样保留，方便看出漏填', () => {
    expect(applySkillValues('${a} 和 ${b}', { a: '1' })).toBe('1 和 ${b}')
  })

  it('值里的 $& / $1 不会被当成替换语法', () => {
    expect(applySkillValues('${a}', { a: '$& 与 $1' })).toBe('$& 与 $1')
  })
})

describe('applySkillTemplate', () => {
  it('命名参数优先，同时兼容 ${args} 与 $1', () => {
    const text = '话题 ${topic}；补充 ${args}；再来 $1'
    expect(applySkillTemplate(text, { values: { topic: '修仙' }, args: '别写感情线' }))
      .toBe('话题 修仙；补充 别写感情线；再来 别写感情线')
  })

  it('没有 args 时保留 ${args}，不做无意义的清空', () => {
    expect(applySkillTemplate('${args}', {})).toBe('${args}')
  })
})

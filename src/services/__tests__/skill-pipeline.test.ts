import { describe, it, expect } from 'vitest'
import {
  createPipelineStep,
  hasBlockingPipelineIssue,
  isValidPipelineName,
  movePipelineStep,
  normalizePipelineStep,
  normalizeSkillPipeline,
  pipelineChainLabel,
  pipelineStepDefaultValues,
  pipelineStepInput,
  validateSkillPipeline,
  type SkillPipeline,
} from '../agent/skill-pipeline'

const SKILLS = [
  { name: 'review-continuity', title: '连续性审稿', enabled: true },
  { name: 'deai-zh', title: '去 AI 味', enabled: true },
  { name: 'style-imitate', title: '文风仿写', enabled: false },
]

const SKILLS_WITH_INPUTS = [
  { name: 'deai-zh', title: '去 AI 味', enabled: true, inputs: [
    { name: 'level', label: '力度', required: true },
    { name: 'keepNames', label: '保留人名', type: 'boolean' as const },
  ] },
]

describe('skill-pipeline / 名字校验', () => {
  it('接受字母数字与 . _ -', () => {
    expect(isValidPipelineName('review-chain')).toBe(true)
    expect(isValidPipelineName('a.b_c-1')).toBe(true)
  })

  it('拒绝空值、路径穿越与非法字符', () => {
    expect(isValidPipelineName('')).toBe(false)
    expect(isValidPipelineName('../etc/passwd')).toBe(false)
    expect(isValidPipelineName('a/b')).toBe(false)
    expect(isValidPipelineName('-lead')).toBe(false)
    expect(isValidPipelineName(123)).toBe(false)
  })
})

describe('skill-pipeline / 归一化', () => {
  it('丢弃没有 Skill 名的步骤', () => {
    expect(normalizePipelineStep({ skill: '  ' })).toBeNull()
    expect(normalizePipelineStep(null)).toBeNull()
    expect(normalizePipelineStep({ skill: 'deai-zh' })).toEqual({ skill: 'deai-zh' })
  })

  it('保留 args、values、label 与 input 只接受两个合法值', () => {
    const step = normalizePipelineStep({
      skill: 'deai-zh',
      label: '去味',
      args: '轻度',
      values: { grade: 'low', keep: 'true' },
      input: 'chapter',
    })
    expect(step).toEqual({
      skill: 'deai-zh',
      label: '去味',
      args: '轻度',
      values: { grade: 'low', keep: 'true' },
      input: 'chapter',
    })
    expect(normalizePipelineStep({ skill: 'deai-zh', input: 'evil' })).toEqual({ skill: 'deai-zh' })
  })

  it('values 里的非标量值会被丢掉，对象参数不会带进来', () => {
    const step = normalizePipelineStep({
      skill: 'deai-zh',
      values: { ok: 'yes', num: 3, bad: { nested: true }, nil: null },
    })
    expect(step?.values).toEqual({ ok: 'yes', num: '3' })
  })

  it('整条流水线：空步骤或非法名字返回 null', () => {
    expect(normalizeSkillPipeline({ name: 'x y', steps: [{ skill: 'a' }] })).toBeNull()
    expect(normalizeSkillPipeline({ name: 'ok', steps: [] })).toBeNull()
    expect(normalizeSkillPipeline({ name: 'ok', steps: [{ skill: '' }] })).toBeNull()
    expect(normalizeSkillPipeline(null)).toBeNull()
  })

  it('整条流水线：过滤坏步骤并保留标题与描述', () => {
    const pipeline = normalizeSkillPipeline({
      name: 'review-chain',
      title: '审稿链',
      description: '  先审后改  ',
      steps: [{ skill: 'review-continuity' }, { bogus: 1 }, { skill: 'deai-zh' }],
      scope: 'project',
    })
    expect(pipeline).toEqual({
      name: 'review-chain',
      title: '审稿链',
      description: '先审后改',
      scope: 'project',
      steps: [{ skill: 'review-continuity' }, { skill: 'deai-zh' }],
    })
  })
})

describe('skill-pipeline / 输入来源', () => {
  const steps = [
    createPipelineStep('review-continuity'),
    createPipelineStep('deai-zh'),
    { skill: 'style-imitate', input: 'chapter' as const },
    { skill: 'style-imitate', input: 'previous' as const },
  ]

  it('首步永远是章节正文', () => {
    expect(pipelineStepInput(steps, 0)).toBe('chapter')
    expect(pipelineStepInput([{ skill: 'a', input: 'previous' }], 0)).toBe('chapter')
  })

  it('其余步骤默认接上一步输出，可显式改写', () => {
    expect(pipelineStepInput(steps, 1)).toBe('previous')
    expect(pipelineStepInput(steps, 2)).toBe('chapter')
    expect(pipelineStepInput(steps, 3)).toBe('previous')
  })
})

describe('skill-pipeline / 排序', () => {
  const steps = [createPipelineStep('a'), createPipelineStep('b'), createPipelineStep('c')]

  it('上移与下移', () => {
    expect(movePipelineStep(steps, 0, 1).map(s => s.skill)).toEqual(['b', 'a', 'c'])
    expect(movePipelineStep(steps, 2, 0).map(s => s.skill)).toEqual(['c', 'a', 'b'])
  })

  it('越界时返回原数组且不修改入参', () => {
    expect(movePipelineStep(steps, 5, 0)).toBe(steps)
    expect(movePipelineStep(steps, 1, 1)).toBe(steps)
    expect(steps.map(s => s.skill)).toEqual(['a', 'b', 'c'])
  })
})

describe('skill-pipeline / 校验', () => {
  const base: SkillPipeline = {
    name: 'review-chain',
    steps: [{ skill: 'review-continuity' }, { skill: 'deai-zh' }],
  }

  it('全部命中已启用 Skill 时没有 issue', () => {
    expect(validateSkillPipeline(base, SKILLS)).toEqual([])
    expect(hasBlockingPipelineIssue(validateSkillPipeline(base, SKILLS))).toBe(false)
  })

  it('没有流水线或没有步骤时是 empty 错误', () => {
    expect(validateSkillPipeline(null, SKILLS)[0].code).toBe('empty')
    expect(hasBlockingPipelineIssue(validateSkillPipeline({ name: 'x', steps: [] }, SKILLS))).toBe(true)
  })

  it('引用了不存在的 Skill 会拦住执行', () => {
    const issues = validateSkillPipeline({ name: 'x', steps: [{ skill: 'missing' }] }, SKILLS)
    expect(issues).toEqual([{ code: 'unknown-skill', severity: 'error', index: 0, skill: 'missing' }])
    expect(hasBlockingPipelineIssue(issues)).toBe(true)
  })

  it('引用了已停用的 Skill 会拦住执行', () => {
    const issues = validateSkillPipeline({ name: 'x', steps: [{ skill: 'style-imitate' }] }, SKILLS)
    expect(issues[0].code).toBe('disabled-skill')
    expect(hasBlockingPipelineIssue(issues)).toBe(true)
  })

  it('同一 Skill 重复出现只是 warning', () => {
    const issues = validateSkillPipeline(
      { name: 'x', steps: [{ skill: 'deai-zh' }, { skill: 'deai-zh' }] },
      SKILLS,
    )
    expect(issues).toEqual([{ code: 'duplicate-skill', severity: 'warning', index: 1, skill: 'deai-zh' }])
    expect(hasBlockingPipelineIssue(issues)).toBe(false)
  })

  it('名字非法时直接返回 invalid-name', () => {
    const issues = validateSkillPipeline({ name: '../x', steps: [{ skill: 'deai-zh' }] }, SKILLS)
    expect(issues).toEqual([{ code: 'invalid-name', severity: 'error' }])
  })

  it('必填参数没填会拦住执行，并报出缺的是哪个字段', () => {
    const issues = validateSkillPipeline(
      { name: 'x', steps: [{ skill: 'deai-zh' }] },
      SKILLS_WITH_INPUTS,
    )
    expect(issues).toEqual([
      { code: 'missing-field', severity: 'error', index: 0, skill: 'deai-zh', field: '力度' },
    ])
    expect(hasBlockingPipelineIssue(issues)).toBe(true)
  })

  it('必填参数填好后就没有 issue', () => {
    const issues = validateSkillPipeline(
      { name: 'x', steps: [{ skill: 'deai-zh', values: { level: '轻度' } }] },
      SKILLS_WITH_INPUTS,
    )
    expect(issues).toEqual([])
  })
})

describe('skill-pipeline / 展示与默认值', () => {
  it('链路文案优先用备注名，其次查 Skill 标题', () => {
    const pipeline: SkillPipeline = {
      name: 'x',
      steps: [{ skill: 'a', label: '第一步' }, { skill: 'deai-zh' }],
    }
    expect(pipelineChainLabel(pipeline, name => (name === 'deai-zh' ? '去 AI 味' : name))).toBe('第一步 → 去 AI 味')
    expect(pipelineChainLabel(null, name => name)).toBe('')
  })

  it('按 schema 生成默认参数', () => {
    expect(pipelineStepDefaultValues([
      { name: 'tone', default: '克制' },
      { name: 'length', type: 'number', default: 800 },
      { name: 'keep', type: 'boolean', default: true },
      { name: 'empty' },
    ])).toEqual({ tone: '克制', length: '800', keep: 'true' })
    expect(pipelineStepDefaultValues(undefined)).toEqual({})
  })
})

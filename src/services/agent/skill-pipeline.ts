/**
 * Skill 流水线（Pipeline）
 *
 * 单个 Skill 解决一个问题；流水线把多个 Skill 串成一条链，一次跑完，
 * 例如「连续性审稿 → 去 AI 味 → 文风仿写」。
 *
 * 设计约定：
 * - 流水线是**纯数据**（JSON），只记录「用哪个 Skill、什么参数、输入从哪里来」，
 *   不含任何可执行代码，所以可以安全地导入、导出与分发。
 * - 每一步默认拿**上一步的输出**作为输入（首步固定拿章节正文）；
 *   某一步可以显式声明 input: 'chapter' 退回原文，例如最后一步「按文风仿写」。
 * - 步与步之间由工作流引擎暂停并等待人工确认，用户确认后才继续下一步。
 */

import {
  missingRequiredSkillValues,
  normalizeSkillInputs,
  skillInputLabel,
  skillInputType,
  type SkillInputField,
} from './skill-inputs'

/** 某一步的输入来源 */
export type SkillPipelineStepInput = 'chapter' | 'previous'

/** 流水线存储位置，与 Skill 一致：用户级对所有项目生效，项目级只对当前项目生效 */
export type SkillPipelineScope = 'user' | 'project'

/** 流水线中的一步：调用某个 Skill */
export interface SkillPipelineStep {
  /** Skill 名（skill-registry 里的 metadata.name） */
  skill: string
  /** 展示用备注名，缺省时用 Skill 的 displayName */
  label?: string
  /** 自由参数（未声明 inputs schema 的 Skill 走这条） */
  args?: string
  /** 按 Skill 的 inputs schema 收集到的结构化参数 */
  values?: Record<string, string>
  /** 输入来源；缺省时首步为 chapter，其余为 previous */
  input?: SkillPipelineStepInput
}

/** 一条流水线 */
export interface SkillPipeline {
  /** 流水线名，同时是文件名（<name>.json） */
  name: string
  /** 展示标题 */
  title?: string
  description?: string
  /** 存储位置；读盘结果里由控制器填入 */
  scope?: SkillPipelineScope
  steps: SkillPipelineStep[]
  updatedAt?: string
}

/** 校验用得到的最小 Skill 信息 */
export interface PipelineSkillInfo {
  name: string
  title?: string
  enabled?: boolean
  /** 该 Skill 声明的输入参数 schema，用于校验必填项 */
  inputs?: SkillInputField[]
}

/** 流水线名合法性：与 Skill 名同一套规则，挡住路径穿越 */
const PIPELINE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

export function isValidPipelineName(name: unknown): name is string {
  return typeof name === 'string' && PIPELINE_NAME_RE.test(name)
}

function normalizeValues(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const values: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object') continue
    values[key] = String(value)
  }
  return values
}

/** 归一化单个步骤；缺少 Skill 名时返回 null（丢弃该步） */
export function normalizePipelineStep(raw: unknown): SkillPipelineStep | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const skill = typeof record.skill === 'string' ? record.skill.trim() : ''
  if (!skill) return null

  const step: SkillPipelineStep = { skill }
  if (typeof record.label === 'string' && record.label.trim()) step.label = record.label.trim()
  if (typeof record.args === 'string' && record.args) step.args = record.args
  const values = normalizeValues(record.values)
  if (Object.keys(values).length > 0) step.values = values
  if (record.input === 'chapter' || record.input === 'previous') step.input = record.input
  return step
}

/** 归一化整条流水线；名字非法或没有有效步骤时返回 null */
export function normalizeSkillPipeline(raw: unknown): SkillPipeline | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (!isValidPipelineName(name)) return null
  if (!Array.isArray(record.steps)) return null

  const steps = record.steps
    .map(normalizePipelineStep)
    .filter((step): step is SkillPipelineStep => step !== null)
  if (steps.length === 0) return null

  const pipeline: SkillPipeline = { name, steps }
  if (typeof record.title === 'string' && record.title.trim()) pipeline.title = record.title.trim()
  if (typeof record.description === 'string' && record.description.trim()) {
    pipeline.description = record.description.trim()
  }
  if (record.scope === 'user' || record.scope === 'project') pipeline.scope = record.scope
  if (typeof record.updatedAt === 'string') pipeline.updatedAt = record.updatedAt
  return pipeline
}

/** 某一步的输入来源：首步永远是章节正文，其余默认用上一步结果 */
export function pipelineStepInput(steps: SkillPipelineStep[], index: number): SkillPipelineStepInput {
  if (index <= 0) return 'chapter'
  return steps[index]?.input ?? 'previous'
}

/** 新建一个步骤（界面「添加一步」用） */
export function createPipelineStep(skill: string): SkillPipelineStep {
  return { skill }
}

/** 上移/下移一步；越界时返回原数组 */
export function movePipelineStep(steps: SkillPipelineStep[], from: number, to: number): SkillPipelineStep[] {
  if (from === to) return steps
  if (from < 0 || from >= steps.length) return steps
  if (to < 0 || to >= steps.length) return steps
  const next = [...steps]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}

export type SkillPipelineIssueCode =
  | 'empty'
  | 'unknown-skill'
  | 'disabled-skill'
  | 'duplicate-skill'
  | 'missing-field'
  | 'invalid-name'

export interface SkillPipelineIssue {
  code: SkillPipelineIssueCode
  /** error 会拦住执行；warning 只提示 */
  severity: 'error' | 'warning'
  /** 出问题的步骤下标（整体性问题没有） */
  index?: number
  skill?: string
  /** code=missing-field 时，缺的是哪些参数（已拼成可读文本） */
  field?: string
}

/**
 * 校验流水线是否可以执行。
 *
 * 同一个 Skill 出现多次是合法的（例如「审稿 → 修订 → 再审稿」），只给 warning。
 */
export function validateSkillPipeline(
  pipeline: SkillPipeline | null,
  skills: PipelineSkillInfo[],
): SkillPipelineIssue[] {
  if (!pipeline) return [{ code: 'empty', severity: 'error' }]
  if (!isValidPipelineName(pipeline.name)) {
    return [{ code: 'invalid-name', severity: 'error' }]
  }
  if (pipeline.steps.length === 0) return [{ code: 'empty', severity: 'error' }]

  const issues: SkillPipelineIssue[] = []
  const seen = new Set<string>()
  pipeline.steps.forEach((step, index) => {
    const found = skills.find(s => s.name === step.skill)
    if (!found) {
      issues.push({ code: 'unknown-skill', severity: 'error', index, skill: step.skill })
    } else if (found.enabled === false) {
      issues.push({ code: 'disabled-skill', severity: 'error', index, skill: step.skill })
    } else {
      const missing = missingRequiredSkillValues(found.inputs ?? [], step.values ?? {})
      if (missing.length > 0) {
        issues.push({
          code: 'missing-field',
          severity: 'error',
          index,
          skill: step.skill,
          field: missing.map(skillInputLabel).join(' / '),
        })
      }
    }
    if (seen.has(step.skill)) {
      issues.push({ code: 'duplicate-skill', severity: 'warning', index, skill: step.skill })
    }
    seen.add(step.skill)
  })
  return issues
}

/** 是否存在会拦住执行的错误 */
export function hasBlockingPipelineIssue(issues: SkillPipelineIssue[]): boolean {
  return issues.some(issue => issue.severity === 'error')
}

/** 把流水线拼成一行可读的链路，如「连续性审稿 → 去 AI 味 → 文风仿写」 */
export function pipelineChainLabel(
  pipeline: Pick<SkillPipeline, 'steps'> | null | undefined,
  titleOf: (skillName: string) => string,
  joiner = ' → ',
): string {
  if (!pipeline) return ''
  return pipeline.steps.map(step => step.label || titleOf(step.skill) || step.skill).join(joiner)
}

/** 为某一步生成默认参数（按 Skill 的 inputs schema 填默认值） */
export function pipelineStepDefaultValues(inputs: SkillInputField[] | undefined): Record<string, string> {
  const fields = normalizeSkillInputs(inputs)
  const values: Record<string, string> = {}
  for (const field of fields) {
    if (field.default === undefined) continue
    const type = skillInputType(field)
    values[field.name] = type === 'boolean'
      ? (field.default === true || field.default === 'true' ? 'true' : 'false')
      : String(field.default)
  }
  return values
}

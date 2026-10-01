/**
 * Skill 输入参数（input schema）
 *
 * 过去所有 Skill 都只有一个写死的 `${args}` 自由文本框，参数含义只能写在文档里。
 * 现在 SKILL.md 的 frontmatter 可以声明 `inputs`，界面按 schema 自动生成表单，
 * Agent 也按同一份 schema 收集参数 —— 两边共用本模块的纯函数，保证行为一致。
 *
 * frontmatter 写法（值必须写成单行 JSON，Vela 不额外引入 YAML 依赖）：
 * ```
 * ---
 * name: my-skill
 * inputs: [{"name":"topic","label":"主题","type":"text","required":true}]
 * ---
 * ```
 *
 * 方法正文里用 `${字段名}` 引用；老写法 `${args}` / `$1` 继续可用。
 */

export type SkillInputType = 'text' | 'textarea' | 'number' | 'boolean' | 'select'

export interface SkillInputOption {
  value: string
  label?: string
}

export interface SkillInputField {
  /** 变量名，方法正文里用 ${name} 引用 */
  name: string
  /** 界面标签，缺省时退回 name */
  label?: string
  type?: SkillInputType
  /** 帮助文本 / Agent 看到的参数说明 */
  description?: string
  placeholder?: string
  required?: boolean
  default?: string | number | boolean
  /** type=select 时的候选项 */
  options?: SkillInputOption[]
}

/** 把命名参数与自由参数套进 Skill 方法正文 */
export interface SkillTemplateBinding {
  /** 按字段名传入的参数 */
  values?: Record<string, string>
  /** 自由参数，替换 ${args} / $1（没有 schema 的老 Skill 走这条） */
  args?: string
}

const INPUT_TYPES: SkillInputType[] = ['text', 'textarea', 'number', 'boolean', 'select']

/** 变量名只保留能安全用在 ${name} 里的字符，避免声明了却替换不到 */
function normalizeName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '')
}

function normalizeOptions(raw: unknown): SkillInputOption[] {
  if (!Array.isArray(raw)) return []
  const options: SkillInputOption[] = []
  for (const item of raw) {
    if (typeof item === 'string') {
      const value = item.trim()
      if (value) options.push({ value })
      continue
    }
    if (item && typeof item === 'object') {
      const record = item as Record<string, unknown>
      const value = String(record.value ?? '').trim()
      if (!value) continue
      options.push({
        value,
        label: typeof record.label === 'string' ? record.label : undefined,
      })
    }
  }
  return options
}

function normalizeDefault(raw: unknown, type: SkillInputType): string | number | boolean | undefined {
  if (raw === undefined || raw === null) return undefined
  if (type === 'boolean') return raw === true || raw === 'true'
  if (type === 'number') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  return typeof raw === 'string' ? raw : String(raw)
}

/**
 * 归一化 `inputs` 声明。
 *
 * 同时接受「已经解析好的数组」和「frontmatter 里的单行 JSON 字符串」，
 * 后者让解析逻辑可以脱离 skill-registry 单独测试。
 */
export function normalizeSkillInputs(raw: unknown): SkillInputField[] {
  let value = raw
  if (typeof value === 'string') {
    const text = value.trim()
    if (!text) return []
    try {
      value = JSON.parse(text)
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []

  const fields: SkillInputField[] = []
  const seen = new Set<string>()
  for (const item of value) {
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const name = normalizeName(record.name)
    if (!name || seen.has(name)) continue
    seen.add(name)

    const declaredType = INPUT_TYPES.includes(record.type as SkillInputType)
      ? (record.type as SkillInputType)
      : 'text'
    const options = normalizeOptions(record.options)
    // select 没有候选项时退化成文本框，否则界面会给出一个空下拉
    const type: SkillInputType = declaredType === 'select' && options.length === 0 ? 'text' : declaredType

    fields.push({
      name,
      label: typeof record.label === 'string' ? record.label : undefined,
      type,
      description: typeof record.description === 'string' ? record.description : undefined,
      placeholder: typeof record.placeholder === 'string' ? record.placeholder : undefined,
      required: record.required === true,
      default: normalizeDefault(record.default, type),
      options: options.length > 0 ? options : undefined,
    })
  }
  return fields
}

/** 字段的最终类型（未声明按 text） */
export function skillInputType(field: SkillInputField): SkillInputType {
  return field.type ?? 'text'
}

/** 字段的界面标签 */
export function skillInputLabel(field: SkillInputField): string {
  return field.label ?? field.name
}

/** 表单初始值：有默认值用默认值，其余留空 */
export function defaultSkillValues(fields: SkillInputField[]): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of fields) {
    const fallback = field.default
    if (fallback === undefined) {
      values[field.name] = ''
    } else if (typeof fallback === 'boolean') {
      values[field.name] = fallback ? 'true' : 'false'
    } else {
      values[field.name] = String(fallback)
    }
  }
  return values
}

/** 必填但没填的字段（界面用它做校验提示） */
export function missingRequiredSkillValues(
  fields: SkillInputField[],
  values: Record<string, string>,
): SkillInputField[] {
  return fields.filter(field => field.required && !String(values[field.name] ?? '').trim())
}

/**
 * 把参数拼成一段人可读的文本，喂给 ${args}。
 *
 * 空字符串跳过；布尔值保留（显式的 false 也是有效信息）。
 */
export function buildSkillArgs(
  fields: SkillInputField[],
  values: Record<string, string>,
): string {
  const lines: string[] = []
  for (const field of fields) {
    const value = String(values[field.name] ?? '').trim()
    if (!value) continue
    lines.push(`${skillInputLabel(field)}: ${value}`)
  }
  return lines.join('\n')
}

/** 按字段名替换 ${name}（值里的 $ 不会被当成替换语法） */
export function applySkillValues(text: string, values: Record<string, string>): string {
  let result = text
  for (const [name, value] of Object.entries(values)) {
    if (!name) continue
    const pattern = new RegExp(`\\$\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g')
    result = result.replace(pattern, () => value ?? '')
  }
  return result
}

/**
 * 把参数套进 Skill 方法正文。
 *
 * 先替换命名参数，再处理 ${args} / $1；用函数式替换，避免用户输入里的
 * `$&`、`$1` 被 replace 当成特殊语法解释。
 */
export function applySkillTemplate(text: string, binding: SkillTemplateBinding = {}): string {
  const args = binding.args?.trim() ?? ''
  let result = applySkillValues(text, binding.values ?? {})
  if (args) {
    result = result.replace(/\$\{args\}/g, () => args)
    result = result.replace(/\$1/g, () => args)
  }
  return result
}

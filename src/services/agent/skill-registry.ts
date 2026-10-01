/**
 * Skill 注册中心
 *
 * 管理所有可用的 Skill（基于 SKILL.md 的模块化知识包）。
 * 支持：
 * - 内置 Skill（随 Vela 发布的预设 Skill）
 * - 用户 Skill（用户放在 ~/.vela/skills/ 下的自定义 Skill）
 * - 项目 Skill（放在项目的 .vela/skills/ 下的项目级 Skill）
 *
 * Skill 格式兼容 Cursor 的 SKILL.md 生态。
 */

import i18n from '../../i18n'
import { ipc } from '../ipc-client'
import { useProjectStore } from '../../stores/project-store'
import type { SkillOrigin } from '../../shared/ipc-channels'
import { toolRegistry, type AgentTool } from './tool-registry'
import {
  applySkillTemplate,
  buildSkillArgs,
  normalizeSkillInputs,
  skillInputType,
  type SkillInputField,
} from './skill-inputs'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'panels', ...opts })

// ===== 类型定义 =====

/** Skill 来源 */
export type SkillSource = 'builtin' | 'user' | 'project'

/** Skill 元数据（从 SKILL.md frontmatter 解析） */
export interface SkillMetadata {
  /** Skill 唯一名称 */
  name: string
  /** 显示名称 */
  displayName?: string
  /** 功能描述 */
  description: string
  /** 使用场景（用于 Agent 自动匹配） */
  whenToUse?: string
  /** 版本 */
  version?: string
  /** 允许的工具列表（白名单） */
  allowedTools?: string[]
  /** 参数提示 */
  argumentHint?: string
  /** 是否可由模型自动调用 */
  userInvocable?: boolean
  /**
   * 输入参数 schema。
   * 声明后界面按 schema 生成表单，Agent 也按同一份 schema 收集参数；
   * 未声明时沿用单个自由文本框（${args}）。
   */
  inputs?: SkillInputField[]
  /** 从外部包安装时的来源标记（.vela-source.json），手写 Skill 没有 */
  origin?: SkillOrigin
}

/** 加载后的 Skill */
export interface LoadedSkill {
  /** 元数据 */
  metadata: SkillMetadata
  /** Skill 内容（Markdown 提示词） */
  content: string
  /** 来源 */
  source: SkillSource
  /** 文件所在目录 */
  baseDir: string
  /** SKILL.md 文件路径 */
  filePath: string
  /** 是否启用（停用后不注册为 Agent 工具，也不参与 / 调用与技能方法替换） */
  enabled: boolean
}

// ===== Skill Registry =====

class SkillRegistryImpl {
  private skills: Map<string, LoadedSkill> = new Map()

  /** 已停用的 Skill 名 */
  private disabled: Set<string> = new Set()

  /** 变更订阅者（供界面刷新） */
  private listeners: Set<() => void> = new Set()

  /** 注册一个 Skill */
  register(skill: LoadedSkill): void {
    this.skills.set(skill.metadata.name, skill)
  }

  /** 查找 Skill */
  get(name: string): LoadedSkill | undefined {
    return this.skills.get(name)
  }

  /** 列出所有 Skill */
  listAll(): LoadedSkill[] {
    return Array.from(this.skills.values())
  }

  /** 只列出已启用的 Skill */
  listEnabled(): LoadedSkill[] {
    return this.listAll().filter(s => s.enabled)
  }

  /** Skill 是否启用（未加载视为未启用） */
  isEnabled(name: string): boolean {
    return this.skills.get(name)?.enabled ?? false
  }

  /** 启用 / 停用某个 Skill，并持久化到 ~/.vela/skills-state.json */
  async setEnabled(name: string, enabled: boolean): Promise<void> {
    if (enabled) this.disabled.delete(name)
    else this.disabled.add(name)
    this.applyEnabledFlags()
    try {
      await ipc.invoke('skill:set-disabled', Array.from(this.disabled))
    } catch {
      // 状态落盘失败不影响本次会话
    }
    this.registerToToolRegistry()
    this.notify()
  }

  /** 订阅 Skill 变更（返回取消订阅函数） */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** 通知订阅者 Skill 列表已变化 */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // 单个订阅者异常不影响其它订阅者
      }
    }
  }

  /** 把停用状态套用到已加载的 Skill 上 */
  private applyEnabledFlags(): void {
    for (const skill of this.skills.values()) {
      skill.enabled = !this.disabled.has(skill.metadata.name)
    }
  }

  /** 从主进程读取停用列表并套用 */
  private async loadDisabledState(): Promise<void> {
    try {
      const state = await ipc.invoke('skill:get-disabled')
      this.disabled = new Set(state.disabled ?? [])
    } catch {
      this.disabled = new Set()
    }
    this.applyEnabledFlags()
  }

  /** 重新加载全部 Skill（磁盘内容变化后调用） */
  async reload(): Promise<void> {
    await this.loadAll()
  }

  /** 按来源列出 */
  listBySource(source: SkillSource): LoadedSkill[] {
    return this.listAll().filter(s => s.source === source)
  }

  /** Skill 数量 */
  get size(): number {
    return this.skills.size
  }

  /** 清空 */
  clear(): void {
    this.skills.clear()
  }

  /**
   * 从目录加载 Skills
   *
   * 扫描指定目录下的 skill-name/SKILL.md 格式
   */
  async loadFromDirectory(dir: string, source: SkillSource): Promise<number> {
    let count = 0
    try {
      const entries = await ipc.invoke('fs:list-dir', dir)
      for (const entry of entries) {
        if (!entry.isDir) continue

        const skillFile = `${entry.path}/SKILL.md`
        try {
          const exists = await ipc.invoke('fs:check-exists', skillFile)
          if (!exists) continue

          const result = await ipc.invoke('fs:read-file', skillFile)
          if (!result.success) continue

          const origin = await readSkillOrigin(`${entry.path}/.vela-source.json`)
          const skill = parseSkillMd(result.content, entry.name, source, entry.path, skillFile, origin)
          if (skill) {
            this.register(skill)
            count++
          }
        } catch {
          // 单个 Skill 加载失败不影响整体
        }
      }
    } catch {
      // 目录不存在等情况，静默处理
    }
    return count
  }

  /**
   * 加载所有 Skill（内置 + 用户 + 项目）
   */
  async loadAll(): Promise<void> {
    this.clear()

    // 注册内置 Skill
    registerBuiltinSkills(this)

    // 加载用户 Skill（~/.vela/skills/）
    try {
      const velaHome = await ipc.invoke('config:get-vela-home')
      const userSkillsDir = `${velaHome}/skills`
      const userCount = await this.loadFromDirectory(userSkillsDir, 'user')
      if (userCount > 0) {
        console.log(`[Skills] 加载了 ${userCount} 个用户 Skill`)
      }
    } catch {
      // 静默处理
    }

    // 加载项目 Skill（项目/.vela/skills/）
    const project = useProjectStore.getState().currentProject
    if (project) {
      const projectSkillsDir = `${project.path}/.vela/skills`
      const projectCount = await this.loadFromDirectory(projectSkillsDir, 'project')
      if (projectCount > 0) {
        console.log(`[Skills] 加载了 ${projectCount} 个项目 Skill`)
      }
    }

    // 读取停用状态并套用
    await this.loadDisabledState()

    // 将所有 Skill 注册为 Agent Tool（停用的会被跳过）
    this.registerToToolRegistry()

    this.notify()
    console.log(`[Skills] 共加载 ${this.size} 个 Skill（启用 ${this.listEnabled().length} 个）`)
  }

  /**
   * 将 Skill 注册为 Agent Tool
   */
  private registerToToolRegistry(): void {
    // 先清理旧的 Skill Tool
    toolRegistry.unregisterBySource('skill')

    for (const skill of this.listEnabled()) {
      const inputFields = skill.metadata.inputs ?? []

      // 声明了 inputs 的 Skill：每个字段单独暴露给模型
      const properties: Record<string, { type: string; description: string; enum?: string[] }> = {}
      const required: string[] = []
      for (const field of inputFields) {
        const type = skillInputType(field)
        properties[field.name] = {
          type: type === 'number' ? 'number' : type === 'boolean' ? 'boolean' : 'string',
          description: field.description ?? field.label ?? field.name,
        }
        if (type === 'select' && field.options?.length) {
          properties[field.name].enum = field.options.map(option => option.value)
        }
        if (field.required) required.push(field.name)
      }
      // 没声明 inputs 的老 Skill：保留原来的自由 args
      if (inputFields.length === 0) {
        properties.args = {
          type: 'string',
          description: skill.metadata.argumentHint ?? t('agent.skills.optionalArgs'),
        }
      }

      const agentTool: AgentTool = {
        name: `skill__${skill.metadata.name}`,
        description: skill.metadata.description + (skill.metadata.whenToUse ? ` — ${skill.metadata.whenToUse}` : ''),
        source: 'skill',
        inputSchema: {
          type: 'object',
          properties,
          ...(required.length > 0 ? { required } : {}),
        },
        requiresConfirmation: false,
        isReadOnly: true,
        userFacingName: skill.metadata.displayName ?? skill.metadata.name,
        execute: async (toolArgs) => {
          const values: Record<string, string> = {}
          for (const field of inputFields) {
            const value = toolArgs[field.name]
            if (value === undefined || value === null) continue
            values[field.name] = String(value)
          }
          const freeArgs = typeof toolArgs.args === 'string' ? toolArgs.args : ''
          const args = freeArgs || buildSkillArgs(inputFields, values)

          let content = applySkillTemplate(skill.content, { values, args })
          content = content.replace(/\$\{SKILL_DIR\}/g, () => skill.baseDir)

          return {
            success: true,
            content: `[Skill: ${skill.metadata.displayName ?? skill.metadata.name}]\n\n${content}`,
          }
        },
      }
      toolRegistry.register(agentTool)
    }
  }
}

/** 全局 Skill 注册中心 */
export const skillRegistry = new SkillRegistryImpl()

/**
 * 内置 Skill 名。
 *
 * 服务层按名取用 Skill，从而实现「可替换」：
 * 用户把自己的同名 SKILL.md 放进 ~/.vela/skills/（或项目的 .vela/skills/），
 * 即可整体替换内置方法，而无需改代码 —— 用户/项目 Skill 会覆盖同名内置 Skill。
 */
export const BUILTIN_SKILL_NAMES = {
  /** 去 AI 味：提供语义改写方法（显式调用，不做自动改稿） */
  deaiTone: 'de-ai-tone',
  /** 文风仿写：提供从参考文本归纳文风的分析方法 */
  styleImitation: 'style-imitation',
} as const

/** 按名读取 Skill 内容；未加载时返回 undefined，调用方应回退到内置兜底方法 */
export function getSkillContent(name: string): string | undefined {
  const skill = skillRegistry.get(name)
  if (!skill || !skill.enabled) return undefined
  return skill.content
}

/** Skill 是否由用户/项目自定义（用于判断「可替换」是否已生效） */
export function isSkillOverridden(name: string): boolean {
  const source = skillRegistry.get(name)?.source
  return source === 'user' || source === 'project'
}

// ===== SKILL.md 解析 =====

/**
 * 解析 SKILL.md 文件内容
 *
 * 格式：
 * ```
 * ---
 * name: skill-name
 * description: 功能描述
 * when_to_use: 什么时候使用
 * allowed-tools: [read_file, search_knowledge]
 * ---
 *
 * # Skill 提示词内容
 * ...
 * ```
 */
function parseSkillMd(
  raw: string,
  fallbackName: string,
  source: SkillSource,
  baseDir: string,
  filePath: string,
  origin?: SkillOrigin,
): LoadedSkill | null {
  // 解析 frontmatter
  const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  const frontmatter: Record<string, unknown> = {}
  let content = raw

  if (fmMatch) {
    const fmText = fmMatch[1]
    content = raw.slice(fmMatch[0].length)

    // 简单的 YAML 解析（支持 key: value 和 key: [items]）
    for (const line of fmText.split('\n')) {
      const kvMatch = line.match(/^\s*([^:]+):\s*(.*)$/)
      if (!kvMatch) continue
      const key = kvMatch[1].trim()
      let val: unknown = kvMatch[2].trim()

      // 解析数组 [a, b, c]；inputs 这类结构化声明用单行 JSON
      if (typeof val === 'string' && (val.startsWith('[') || val.startsWith('{'))) {
        const raw = val
        try {
          val = JSON.parse(raw)
        } catch {
          // 不是合法 JSON，退回原来的逗号分隔数组写法
          if (raw.startsWith('[') && raw.endsWith(']')) {
            val = raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
          }
        }
      }
      // 解析布尔值
      if (val === 'true') val = true
      if (val === 'false') val = false

      frontmatter[key] = val
    }
  }

  const metadata: SkillMetadata = {
    name: (frontmatter['name'] as string) || fallbackName,
    displayName: frontmatter['display_name'] as string,
    description: (frontmatter['description'] as string) || `Skill: ${fallbackName}`,
    whenToUse: frontmatter['when_to_use'] as string,
    version: frontmatter['version'] as string,
    allowedTools: frontmatter['allowed-tools'] as string[],
    argumentHint: frontmatter['argument-hint'] as string,
    userInvocable: frontmatter['user-invocable'] !== false,
    inputs: normalizeSkillInputs(frontmatter['inputs']),
    origin,
  }

  return {
    metadata,
    content: content.trim(),
    source,
    baseDir,
    filePath,
    enabled: true,
  }
}

/** 读取 Skill 目录下的来源标记文件（没有或格式不对就当作手写 Skill） */
async function readSkillOrigin(filePath: string): Promise<SkillOrigin | undefined> {
  try {
    const exists = await ipc.invoke('fs:check-exists', filePath)
    if (!exists) return undefined
    const result = await ipc.invoke('fs:read-file', filePath)
    if (!result.success) return undefined
    const parsed = JSON.parse(result.content) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return undefined
    return {
      kind: typeof parsed.kind === 'string' ? parsed.kind : undefined,
      label: typeof parsed.label === 'string' ? parsed.label : undefined,
      url: typeof parsed.url === 'string' ? parsed.url : null,
      ref: typeof parsed.ref === 'string' ? parsed.ref : null,
      subdir: typeof parsed.subdir === 'string' ? parsed.subdir : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      importedAt: typeof parsed.importedAt === 'string' ? parsed.importedAt : undefined,
    }
  } catch {
    return undefined
  }
}

// ===== 内置 Skills =====

function registerBuiltinSkills(registry: SkillRegistryImpl): void {
  const builtins: Array<{ metadata: SkillMetadata; content: string }> = [
    {
      metadata: {
        name: 'review-chapter',
        displayName: t('agent.skills.reviewChapter.name'),
        description: t('agent.skills.reviewChapter.desc'),
        whenToUse: t('agent.skills.reviewChapter.when'),
      },
      content: `# 章节审阅

请对目标章节进行专业的小说审阅。依次检查以下维度：

## 1. 剧情逻辑
- 情节是否连贯，有无逻辑矛盾
- 因果关系是否成立

## 2. 角色一致性
- 角色行为是否符合既定性格
- 对话风格是否一致

## 3. 节奏感
- 张弛是否有度
- 是否有不必要的拖沓或过于仓促的转折

## 4. 伏笔与呼应
- 已有伏笔是否得到了回应
- 新埋的伏笔是否自然

## 5. 文笔与风格
- 描写是否生动
- 是否符合整体文风设定

请先使用 read_drafts 工具读取目标章节，再使用 read_architecture 读取故事架构进行对比评估。
输出格式：每个维度评分（1-5星）+ 详细说明 + 修改建议。`,
    },
    {
      metadata: {
        name: 'brainstorm',
        displayName: t('agent.skills.brainstorm.name'),
        description: t('agent.skills.brainstorm.desc'),
        whenToUse: t('agent.skills.brainstorm.when'),
      },
      content: `# 创意脑暴

请围绕用户给出的话题进行专业的创意脑暴。

## 输出格式
为每个创意方向提供：
1. **创意概念**（一句话）
2. **详细展开**（100-200 字）
3. **可行性评估**（高/中/低）
4. **与已有剧情的融合度**

请先使用 read_architecture 和 read_project_state 了解项目背景，确保创意与现有设定不矛盾。
至少提供 5 个不同方向的创意。`,
    },
    {
      metadata: {
        name: 'character-analysis',
        displayName: t('agent.skills.characterAnalysis.name'),
        description: t('agent.skills.characterAnalysis.desc'),
        whenToUse: t('agent.skills.characterAnalysis.when'),
      },
      content: `# 角色深度分析

请对目标角色进行全方位的深度分析。

## 分析维度
1. **核心性格特质** — MBTI、大五人格倾向
2. **深层动机** — 驱动角色行动的核心诉求
3. **角色弧预测** — 基于当前设定推演角色成长轨迹
4. **关系网络** — 与其他角色的关系图谱
5. **冲突点** — 角色面临的核心矛盾和困境
6. **独特标识** — 口头禅、习惯动作、标志性特征

请先使用 read_characters 读取角色卡，以及 read_architecture 了解故事结构。`,
    },
    {
      metadata: {
        name: 'continuity-check',
        displayName: t('agent.skills.continuityCheck.name'),
        description: t('agent.skills.continuityCheck.desc'),
        whenToUse: t('agent.skills.continuityCheck.when'),
      },
      content: `# 连续性与一致性检查

请对项目进行全面的连续性检查。

## 检查项
1. **时间线一致性** — 事件发生顺序是否合理
2. **地理一致性** — 地点描述是否前后一致
3. **角色状态** — 角色的伤病、装备、能力等是否正确追踪
4. **设定遵守** — 是否与世界观设定产生矛盾
5. **伏笔追踪** — 哪些伏笔已回收，哪些待回收

请使用 list_chapters 了解进度，使用 read_architecture 获取设定，逐章检查关键节点。
输出为表格形式，标注问题严重程度（🔴严重 / 🟡注意 / 🟢正常）。`,
    },
    {
      metadata: {
        name: 'writing-coach',
        displayName: t('agent.skills.writingCoach.name'),
        description: t('agent.skills.writingCoach.desc'),
        whenToUse: t('agent.skills.writingCoach.when'),
      },
      content: `# 写作教练

作为专业的写作教练，为用户提供针对性的指导。

## 指导范围
- 叙述技巧（视角运用、时间线处理）
- 描写技法（环境渲染、人物刻画）
- 对话写作（个性化对话、潜台词运用）
- 节奏控制（场景切换、留白技巧）
- 悬念设置（钩子、反转、暗线）

请先使用 read_project_state 了解项目的写作风格设定，
再根据用户的具体问题提供定制化建议，并附上示例对比。`,
    },
    {
      metadata: {
        name: BUILTIN_SKILL_NAMES.deaiTone,
        displayName: t('agent.skills.deaiTone.name'),
        description: t('agent.skills.deaiTone.desc'),
        whenToUse: t('agent.skills.deaiTone.when'),
        argumentHint: t('agent.skills.deaiTone.args'),
      },
      content: `# 去 AI 味（语义改写方法）

本 Skill 只在用户显式调用时生效。它提供的是**语义判断方法**，不是一份替换词表：
请按方法逐处判断该不该改、怎么改，而不是把词表里的词机械换掉。

## 一、先判断，再动手
对每个被标记的位置，先回答三个问题：
1. 这里为什么读起来像机器写的？（用词太抽象 / 句式太整齐 / 节奏太均匀 / 在替读者总结）
2. 这段文字此刻承担什么功能？（推进动作 / 交代信息 / 渲染情绪 / 埋钩子）
3. 在保住这个功能的前提下，一个真人会怎么写？先想两个候选，再挑更像人的那个。

## 二、五类常见「AI 味」与对应手法
1. **抽象替代具体** —— 「他感到一阵难以言喻的情绪」。
   换成具体可感的身体反应或动作：手心的汗、放下杯子时磕到桌面的声音、没说完的半句话。
2. **句式过于整齐** —— 连续同长度句、连续同结构开头。
   长短句交错；允许残句与破折号打断；把一句拆成两句，或把两句并成一句。
3. **过度总结** —— 段尾或章尾冒出「他知道，这一切才刚刚开始」。
   删掉总结句，让事件自己收尾；或把总结改写成一个具体动作、一个物件意象。
4. **解释而不是呈现** —— 先写情绪结论，再补原因。
   去掉情绪的命名（愤怒、悲伤、震惊），只保留触发它的具体细节。
5. **用词套子** —— 反复出现的「仿佛 / 犹如 / 宛如 / 不禁 / 深深地 / 缓缓地」。
   同一个词在同一章里保留一次即可，其余改用具体动词或直接省略。

## 三、绝对不能动的
- 人名、地名、专有名词、数字、时间线
- 已经发生的事件、对话传达的信息、伏笔与钩子
- 段落划分与空行格式

## 四、边界
- 有的位置本来就自然，就保持原样。不要为了「改过」而改。
- 修订幅度控制在 ±10% 字数以内。

## 五、输出
直接输出完整修订正文，不要输出说明、对比或 JSON。`,
    },
    {
      metadata: {
        name: BUILTIN_SKILL_NAMES.styleImitation,
        displayName: t('agent.skills.styleImitation.name'),
        description: t('agent.skills.styleImitation.desc'),
        whenToUse: t('agent.skills.styleImitation.when'),
        argumentHint: t('agent.skills.styleImitation.args'),
      },
      content: `# 文风仿写（分析方法）

把参考文本编译成「有证据、可执行」的文风指南。
本 Skill 负责分析方法；参考文本与量化特征由本地工具注入到上下文中。

## 一、先找「稳定重复」
出现过一次的叫偶然，反复出现三次以上的才叫风格。只归纳稳定重复的写法。
量化特征里已经给出高频表达与标点频次 —— 从那里入手，但一定要回到原文确认语境。

## 二、七个观察角度
1. **视角与人称**：第几人称、是否限制视角、内心独白出现的频率与位置
2. **句式与句长**：平均句长落在什么区间、长短句怎么交错、有没有标志性的断句方式
3. **段落与节奏**：段落偏长还是偏短、场景切换靠空行还是靠过渡句、留白多少
4. **对话与叙述配比**：对话占比、对话是否单独成段、叙述是否总是紧跟解释
5. **用词倾向**：偏书面还是口语、喜用哪一类动词与形容词、有没有个人化的口头禅
6. **意象与修辞**：反复出现的意象（雨、灯、镜子…）、比喻的密度与来源
7. **标点习惯**：破折号、省略号、问号的偏好，以及它们承担的功能

## 三、必须给证据
每条结论都要附 1-3 条原文引文，逐字照抄，不要改写、不要用省略号省略。
找不到证据的结论不要写 —— 宁可少写两条，也不要写没有依据的结论。

## 四、必须可执行
结论写成祈使句式的写作指令，让人拿起来就能照着写：
- 好：「多用短句断句，单句控制在 12 字以内」
- 不好：「文笔简洁有力」

## 五、量化特征怎么用
量化特征只是佐证，不要把它直接抄成结论；要解释「这个数字意味着什么」，
也不要输出与量化特征明显矛盾的结论。

## 六、输出
只输出 JSON，其中每条规则包含 category、statement、evidence（原文引文）与 confidence。
category 取 voice / syntax / rhythm / dialogue / lexicon / imagery / punctuation 之一。`,
    },
  ]

  for (const { metadata, content } of builtins) {
    registry.register({
      metadata,
      content,
      source: 'builtin',
      baseDir: '',
      filePath: `builtin://${metadata.name}`,
      enabled: true,
    })
  }
}

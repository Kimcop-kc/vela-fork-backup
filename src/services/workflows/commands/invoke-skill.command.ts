import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { resolveChunkBudget, resolveGenerationBudgets, splitTextByTokenBudget } from '../segmented-generation'
import { applySkillTemplate, buildSkillArgs, type SkillInputField } from '../../agent/skill-inputs'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export interface InvokeSkillParams {
  /** Skill 名（用于日志与统计展示） */
  skillName: string
  /** Skill 的方法正文（SKILL.md 的 Markdown 部分） */
  skillContent: string
  /** 调用参数，会替换方法正文里的 ${args} */
  args?: string
  /** 按 Skill 的 inputs schema 收集到的结构化参数 */
  values?: Record<string, string>
  /** 输入参数 schema（用于把 values 拼成 ${args} 文本） */
  inputs?: SkillInputField[]
  /** 目标文本（通常是当前章节正文）；为空时只按参数执行方法 */
  targetText?: string
  /** 目标说明（如「第 3 章」），仅用于提示词 */
  targetLabel?: string
}

/**
 * 调用 Skill 命令
 *
 * 写章节时可直接把当前正文交给某个 Skill 处理：
 * 长正文按模型预算切段，逐段套用同一套 Skill 方法，最后按顺序拼回。
 * 结果流式输出到「AI 输出」面板，不自动改写草稿（是否采用由用户决定）。
 */
export class InvokeSkillCommand extends BaseWorkflowCommand<string> {
  constructor(private params: InvokeSkillParams) {
    super()
  }

  async execute({ callbacks, context }: CommandExecuteParams): Promise<string> {
    const skillContent = this.params.skillContent?.trim()
    if (!skillContent) throw new Error(t('invokeSkill.noSkill'))

    const values = this.params.values ?? {}
    // 结构化参数同步拼一份可读文本，让还在用 ${args} 的 Skill 也能拿到值
    const args = this.params.args?.trim() || buildSkillArgs(this.params.inputs ?? [], values)
    // 参数替换：${字段名} / ${args} / $1 三种写法都支持
    const instruction = applySkillTemplate(skillContent, { values, args })

    const systemPrompt = t('invokeSkill.systemPrompt', { skill: this.params.skillName })
    callbacks.log(t('invokeSkill.started', { skill: this.params.skillName }))

    const target = this.params.targetText?.trim() ?? ''

    /** 拼装单次请求的提示词 */
    const buildPrompt = (chunk?: string, partLabel?: string) => [
      instruction,
      '',
      t('invokeSkill.taskHeader', { task: this.params.targetLabel || this.params.skillName }),
      args ? t('invokeSkill.argsBlock', { args }) : '',
      chunk ? t('invokeSkill.targetBlock', { text: chunk, part: partLabel ?? '' }) : '',
      t('invokeSkill.outputRule'),
    ].filter(Boolean).join('\n')

    // 没有目标文本：直接按方法产出
    if (!target) {
      // Skill 产出（如文风指南、审稿报告）同样可能撞上输出上限，截断时自动续写补齐
      const text = await this.callLLMWithContinuation(buildPrompt(), systemPrompt, callbacks, {
        purpose: `Skill:${this.params.skillName}`,
      }, context)
      return this.stripThinkingTags(text)
    }

    // 目标文本可能超过上下文：按模型预算切段，逐段应用同一套方法
    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.modelForPurpose('invoke_skill')
    const budgets = resolveGenerationBudgets(defaultModel?.maxTokens)
    const chunkBudget = resolveChunkBudget(budgets, 3000)
    const chunks = splitTextByTokenBudget(target, chunkBudget)
    const effectiveChunks = chunks.length > 0 ? chunks : [target]

    const parts: string[] = []
    for (let index = 0; index < effectiveChunks.length; index++) {
      if (context.cancelled) throw new Error(t('base.workflowCancelled'))
      const partLabel = effectiveChunks.length > 1
        ? t('invokeSkill.partLabel', { index: index + 1, total: effectiveChunks.length })
        : ''
      if (effectiveChunks.length > 1) {
        callbacks.log(t('segmented.chunkLog', { index: index + 1, total: effectiveChunks.length }))
      }
      const text = await this.callLLMWithContinuation(
        buildPrompt(effectiveChunks[index], partLabel),
        systemPrompt,
        callbacks,
        { purpose: `Skill:${this.params.skillName}#${index + 1}` },
        context,
      )
      parts.push(this.stripThinkingTags(text))
    }

    return parts.join('\n\n')
  }
}

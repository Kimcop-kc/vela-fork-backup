/**
 * 文风仿写编译命令
 *
 * 按「被激活的仿写 Skill」提供的分析方法，把参考文本编译成
 * 有证据、可执行的文风指南：
 *   - 量化规则由本地确定性分析直接得出（每条都指得回原文）；
 *   - 语义规则由模型按 Skill 方法归纳（无证据的规则会被丢弃）；
 *   - 参考文本过长时按 token 预算分段归纳再合并。
 *
 * 只有当用户显式运行本工作流时，才会写入或覆盖项目的文风设定。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { resolveGenerationBudgets } from '../segmented-generation'
import { BUILTIN_SKILL_NAMES, getSkillContent, isSkillOverridden } from '../../agent/skill-registry'
import {
  DEFAULT_STYLE_SKILL_NAME,
  buildStyleGuidePrompt,
  compileStyleGuide,
  measureStyle,
  referenceLength,
  renderStyleGuide,
  splitStyleReference,
  styleGuideSystemRole,
  summarizeGuide,
  type StyleGuide,
} from '../../style-imitation'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export interface CompileStyleGuideParams {
  /** 参考文本（待仿写的作者正文） */
  referenceText: string
  /** 参考文本来源标题（书名 / 作者 / 文件名），用于报告溯源 */
  sourceTitle: string
  /** 是否把编译结果写入项目文风设定（仅显式传入 true 时才写入） */
  applyToProject?: boolean
}

export class CompileStyleGuideCommand extends BaseWorkflowCommand<StyleGuide> {
  constructor(private params: CompileStyleGuideParams) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<StyleGuide> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const referenceText = this.params.referenceText?.trim()
    if (!referenceText) throw new Error(t('styleGuide.emptyReference'))
    if (referenceLength(referenceText) < 200) throw new Error(t('styleGuide.referenceTooShort'))

    // ── 分析方法来自「被激活的 Skill」，用户替换同名 Skill 即整体替换方法 ──
    const skillName = DEFAULT_STYLE_SKILL_NAME
    const skillContent = getSkillContent(BUILTIN_SKILL_NAMES.styleImitation) || getSkillContent(skillName)
    callbacks.log(skillContent
      ? (isSkillOverridden(skillName)
        ? t('styleGuide.skillOverridden', { skill: skillName })
        : t('styleGuide.skillBuiltin', { skill: skillName }))
      : t('styleGuide.skillFallback'))

    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.models.find(m => m.id === llmStore.defaultModelId)
    const budgets = resolveGenerationBudgets(defaultModel?.maxTokens)

    // ── 分段归纳：参考文本可能很长，逐段归纳后合并规则 ──
    const chunks = splitStyleReference(referenceText, Math.max(2000, budgets.inputTokens - 2500))
    const effectiveChunks = chunks.length > 0 ? chunks : [referenceText]
    const collectedRules: unknown[] = []
    let failedChunks = 0

    for (let index = 0; index < effectiveChunks.length; index++) {
      if (effectiveChunks.length > 1) {
        callbacks.log(t('segmented.chunkLog', { index: index + 1, total: effectiveChunks.length }))
      }
      const prompt = buildStyleGuidePrompt({
        referenceText: effectiveChunks[index],
        metrics: measureStyle(effectiveChunks[index]),
        skillContent,
        segment: { index: index + 1, total: effectiveChunks.length },
      })

      try {
        const raw = await this.callLLM(
          prompt,
          styleGuideSystemRole(),
          callbacks,
          { responseFormat: { type: 'json_object' }, maxTokens: budgets.outputTokens },
        )
        const parsed = this.parseJSON<{ rules?: unknown[] }>(raw)
        if (Array.isArray(parsed.rules)) collectedRules.push(...parsed.rules)
      } catch (e) {
        // 单段失败不放弃整体：量化规则依然能编译出一份有证据的指南
        failedChunks += 1
        callbacks.log(t('styleGuide.chunkFailed', {
          index: index + 1,
          error: e instanceof Error ? e.message : String(e),
        }))
      }
    }

    const guide = compileStyleGuide({
      referenceText,
      sourceTitle: this.params.sourceTitle,
      rawLlmRules: { rules: collectedRules },
      skillName,
    })

    const summary = summarizeGuide(guide)
    callbacks.log(t('styleGuide.compiled', {
      rules: summary.rules,
      evidence: summary.evidence,
      categories: summary.categories,
    }))
    if (failedChunks > 0) {
      callbacks.log(t('styleGuide.partialCompile', { failed: failedChunks, total: effectiveChunks.length }))
    }

    const markdown = renderStyleGuide(guide)

    // ── 只有显式要求时才写入项目设定，避免「悄悄改掉文风」──
    if (this.params.applyToProject) {
      const { updateNovelConfig, saveProject } = useProjectStore.getState()
      updateNovelConfig({ writingStyle: markdown })
      await saveProject()
      callbacks.log(t('styleGuide.applied'))
    } else {
      callbacks.log(t('styleGuide.notApplied'))
    }

    return guide
  }
}

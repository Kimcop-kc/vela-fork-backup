/**
 * 去 AI 味修订命令（显式发起）
 *
 * 这是「显式调用」路径：只有用户或 Agent 主动启动本工作流时才会运行。
 *   - 内置检测器只负责标记可修订位置，不修改任何文字；
 *   - 语义改写方法来自可替换的 Skill（de-ai-tone），不是隐藏词表；
 *   - 修订结果以 pending 修稿的形式产出，交给人审阅后才算落地。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { estimateTokens, splitParagraphSpans } from '../../text-analysis'
import { BUILTIN_SKILL_NAMES, getSkillContent, isSkillOverridden } from '../../agent/skill-registry'
import { buildAiTraceBrief, detectAiTraces, type AiTraceFinding, type AiTraceKind } from '../../review'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 默认的去 AI 味 Skill 名（用户可用同名 Skill 整体替换） */
export const DEFAULT_DEAI_SKILL_NAME = BUILTIN_SKILL_NAMES.deaiTone

/** Skill 缺失时的兜底方法：只描述边界，不提供词表 */
export const FALLBACK_DEAI_METHOD = [
  '逐处判断：这里的「机器感」来自用词太抽象、句式太整齐、节奏太均匀，还是在替读者总结。',
  '先确定这段文字的功能（推进动作 / 交代信息 / 渲染情绪 / 埋钩子），再在保住功能的前提下改写。',
  '优先把抽象情绪换成具体的动作、身体反应或细节，而不是换成另一个抽象词。',
  '长短句交错，允许残句与破折号打断。',
  '删掉段尾与章尾的总结句，让事件自己收尾。',
  '不要机械替换词语；本来就自然的位置保持原样。',
].join('\n')

/**
 * 把草稿按 token 预算切成「带 0 基偏移的段落组」。
 *
 * 相邻片段首尾相接：段落之间的空行归上一段所有，所以把所有片段的 text
 * 顺序拼接必然等于原文 —— 这是「本段没有标记就原样保留」的前提。
 * start / end 为 0 基且 end 不含；leading / trailing 是本段首尾的空白，
 * 改写后要原样接回去，避免段间空行被吃掉。
 */
export function splitDraftWithSpans(text: string, inputBudget: number): Array<{
  text: string
  start: number
  end: number
  leading: string
  trailing: string
}> {
  if (!text) return [{ text: '', start: 0, end: 0, leading: '', trailing: '' }]

  const paragraphs = splitParagraphSpans(text)
  if (paragraphs.length === 0) {
    return [{ text, start: 0, end: text.length, leading: '', trailing: '' }]
  }

  const budget = Math.max(1, inputBudget)
  const groups: Array<{ start: number; end: number }> = []
  let groupStart = 0
  for (let index = 1; index < paragraphs.length; index++) {
    const paragraphStart = paragraphs[index].start - 1
    const paragraphEnd = paragraphs[index].end - 1
    if (estimateTokens(text.slice(groupStart, paragraphEnd)) <= budget) continue
    // 切在下一段开头：中间的空行归上一段，保证不丢字符
    groups.push({ start: groupStart, end: paragraphStart })
    groupStart = paragraphStart
  }
  groups.push({ start: groupStart, end: text.length })

  return groups.map(group => {
    const raw = text.slice(group.start, group.end)
    const leading = raw.slice(0, raw.length - raw.trimStart().length)
    const trailing = raw.slice(leading.length + raw.trim().length)
    return { text: raw, start: group.start, end: group.end, leading, trailing }
  })
}

export interface DeaiReviseParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 只处理指定的痕迹类型；缺省时处理全部类型 */
  kinds?: AiTraceKind[]
  /** 由调用方（如定性审稿页签）传入的痕迹；缺省时在本地重新检测 */
  findings?: AiTraceFinding[]
}

export class DeaiReviseCommand extends BaseWorkflowCommand<string> {
  constructor(private params: DeaiReviseParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<string> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const draft = this.params.draftContent
    if (!draft || !draft.trim()) throw new Error(t('common.noDraftContent'))

    // ── 1. 标记：只检测，不改稿 ──
    const allFindings = this.params.findings ?? detectAiTraces(draft)
    const findings = this.params.kinds && this.params.kinds.length > 0
      ? allFindings.filter(item => this.params.kinds?.includes(item.kind))
      : allFindings

    if (findings.length === 0) {
      callbacks.log(t('deai.noFindings'))
      return ''
    }
    callbacks.log(t('deai.marked', { count: findings.length }))

    // ── 2. 语义方法：来自可替换的 Skill ──
    const skillContent = getSkillContent(DEFAULT_DEAI_SKILL_NAME)
    callbacks.log(skillContent
      ? (isSkillOverridden(DEFAULT_DEAI_SKILL_NAME)
        ? t('deai.skillOverridden', { skill: DEFAULT_DEAI_SKILL_NAME })
        : t('deai.skillBuiltin', { skill: DEFAULT_DEAI_SKILL_NAME }))
      : t('deai.skillFallback'))

    const template = getPromptTemplate('deai_revise')
    if (!template) throw new Error(t('deai.templateMissing'))

    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.modelForPurpose('deai_revise')
    const outputTokens = Math.max(2048, Math.floor((defaultModel?.maxTokens || 4096)))
    const inputBudget = Math.max(2000, Math.floor(outputTokens * 2.5) - 2500)

    // ── 3. 分段改写：长章节按预算切段，每段只带自己范围内的标记 ──
    const chunks = splitDraftWithSpans(draft, inputBudget)
    const revisedParts: string[] = []

    for (let index = 0; index < chunks.length; index++) {
      const chunk = chunks[index]
      if (context.cancelled) throw new Error(t('base.workflowCancelled'))

      // 标记携带的是 1 基字符偏移，换算成 0 基下标后判断落在哪一段
      const localFindings = findings.filter(item => item.start - 1 >= chunk.start && item.start - 1 < chunk.end)
      const brief = buildAiTraceBrief(localFindings, draft)

      if (chunks.length > 1) {
        callbacks.log(t('deai.chunkLog', { index: index + 1, total: chunks.length, marks: localFindings.length }))
      }

      // 本段没有标记时，直接原样保留，避免无意义的改写
      if (brief === '') {
        revisedParts.push(chunk.text)
        continue
      }

      const builder = new BasePromptBuilder(template).withVariables({
        skill_method: skillContent?.trim() || FALLBACK_DEAI_METHOD,
        trace_brief: brief,
        draft_content: chunk.text,
      })
      const revised = await this.callLLM(
        builder.build(),
        builder.getSystemRole(),
        callbacks,
        { maxTokens: outputTokens },
        context,
      )
      // 段首段尾的空白属于段落边界（空行），改写后必须原样接回去
      const clean = this.stripThinkingTags(revised).trim()
      revisedParts.push(clean ? `${chunk.leading}${clean}${chunk.trailing}` : chunk.text)
    }

    const finalText = revisedParts.join('')
    if (!finalText.trim()) throw new Error(t('deai.emptyResult'))

    // ── 4. 落盘为 pending 修稿，交给人审阅（不自动替换原稿）──
    const { parseDraftMeta } = await import('../chapter-workflow')
    const baseDraft = await parseDraftMeta(this.params.draftPath)
    if (baseDraft) {
      const revIndex = await ipc.invoke('db:revision-next-index', baseDraft.id)
      const pendingRevisions = await ipc.invoke('db:revision-get-pending', baseDraft.id)
      for (const revision of pendingRevisions) {
        await ipc.invoke('db:revision-mark-discarded', revision.id)
      }
      const created = await ipc.invoke('db:revision-create', {
        baseDraftId: baseDraft.id,
        revisionIndex: revIndex,
        revisionType: 'deai',
        content: finalText,
        wordCount: finalText.length,
        userPrompt: t('deai.revisionPrompt', { count: findings.length }),
      }) as { success: boolean; id: number }

      const { useEditorStore } = await import('../../../stores/editor-store')
      useEditorStore.getState().openFile({
        id: `diff-${this.params.draftPath}-${created.id}`,
        name: t('deai.tabName', { chapter: this.params.chapterNumber }),
        type: 'diff',
        filePath: this.params.draftPath,
        originalContent: draft,
        content: finalText,
        revisionPath: String(created.id),
        chapterNumber: this.params.chapterNumber,
        chapterDir: `vela://draft/ch${this.params.chapterNumber}`,
      })
      callbacks.log(t('deai.completed', { version: revIndex, length: finalText.length }))
    } else {
      callbacks.log(t('deai.baseDraftMissing'))
    }

    return finalText
  }
}

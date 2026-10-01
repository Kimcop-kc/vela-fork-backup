/**
 * 定性审稿命令
 *
 * 产出「可追溯的创作观察」与「AI 痕迹标记」，两者都只是反馈：
 *   - 不做通过/失败判定，不阻断流程；
 *   - 不自动改稿；是否修订由用户或 Agent 显式发起（见 buildRevisionBrief）。
 *
 * 长章节按 token 预算分段观察后合并，避免一次请求超出上下文导致观察缺失。
 */
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { BasePromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import { buildCanonContext, renderCanonContext } from '../../narrative-consistency'
import { buildSegmentDirective, resolveGenerationBudgets, splitTextByTokenBudget } from '../segmented-generation'
import { observeChapter, type ReviewObservation, type QualitativeReview } from '../../review'
import i18n from '../../../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

export interface QualitativeReviewParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 本次审稿的侧重点（可选） */
  reviewFocus?: string
}

export class QualitativeReviewCommand extends BaseWorkflowCommand<QualitativeReview> {
  constructor(private params: QualitativeReviewParams) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<QualitativeReview> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const draft = this.params.draftContent
    if (!draft || !draft.trim()) throw new Error(t('common.noDraftContent'))

    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.modelForPurpose('qualitative_review')
    const budgets = resolveGenerationBudgets(defaultModel?.maxTokens)

    // ── 既有事实基线：观察必须对照 Canon，才能发现「角色记忆 / 物资」类问题 ──
    let canonContext = ''
    let canonSize = { timelineEvents: 0, characterStates: 0, openPlotLines: 0, knownFacts: 0 }
    let knownCharacterNames: string[] = []
    try {
      const [core, allCharacters] = await Promise.all([
        ipc.invoke('db:project-core-get').catch(() => null as null | { premise?: string; charactersArch?: string; worldbuilding?: string; synopsis?: string }),
        ipc.invoke('db:character-get-all').catch(() => [] as Array<Record<string, unknown>>),
      ])
      knownCharacterNames = (allCharacters || [])
        .map(item => String(item.name ?? ''))
        .filter(Boolean)
      const canon = await buildCanonContext({
        chapterNumber: this.params.chapterNumber,
        architecture: {
          premise: core?.premise || '',
          charactersArch: core?.charactersArch || '',
          worldbuilding: core?.worldbuilding || '',
          synopsis: core?.synopsis || '',
        },
        characters: (allCharacters || []).map(item => ({
          name: String(item.name ?? ''),
          role: String(item.role ?? ''),
          currentState: item.currentState as { location?: string; powerLevel?: string; physicalState?: string; mentalState?: string; keyItems?: string; recentEvents?: string; updatedAtChapter?: number } | undefined,
        })),
        chapterGoal: t('qualitativeReview.chapterGoal', { chapter: this.params.chapterNumber }),
        previousEnding: '',
        ragContext: '',
        writingStyle: project.novelConfig.writingStyle || '',
        globalGuidance: project.novelConfig.globalGuidance || '',
      })
      canonContext = renderCanonContext(canon)
      canonSize = {
        timelineEvents: canon.timeline.length,
        characterStates: canon.characterStates.length,
        openPlotLines: canon.openPlotLines.length,
        knownFacts: canon.knownFacts.length,
      }
      callbacks.log(t('qualitativeReview.canonInjected', {
        timeline: canon.timeline.length,
        characters: canon.characterStates.length,
        plots: canon.openPlotLines.length,
      }))
    } catch (e) {
      callbacks.log(t('qualitativeReview.canonFailed', { error: String(e) }))
    }

    const template = getPromptTemplate('qualitative_review')
    if (!template) throw new Error(t('qualitativeReview.templateMissing'))

    // ── 分段观察：长章节切段，逐段让模型记录观察，最后合并 ──
    const chunks = splitTextByTokenBudget(draft, Math.max(2000, budgets.inputTokens - 3000))
    const effectiveChunks = chunks.length > 0 ? chunks : [draft]
    const llmObservations: ReviewObservation[] = []
    let llmFailed = false

    for (let index = 0; index < effectiveChunks.length; index++) {
      if (effectiveChunks.length > 1) {
        callbacks.log(t('segmented.chunkLog', { index: index + 1, total: effectiveChunks.length }))
      }
      const builder = new BasePromptBuilder(template).withVariables({
        chapter_info: t('qualitativeReview.chapterInfo', {
          chapter: this.params.chapterNumber,
          title: this.params.chapterTitle,
        }),
        canon_context: canonContext || t('qualitativeReview.noCanon'),
        chapter_content: effectiveChunks[index],
        review_focus: this.params.reviewFocus || '',
      })
      let prompt = builder.build()
      if (effectiveChunks.length > 1) {
        prompt += buildSegmentDirective(index + 1, effectiveChunks.length, t('qualitativeReview.segmentHint'))
      }

      callbacks.log(t('qualitativeReview.callingModel', { index: index + 1, total: effectiveChunks.length }))
      let raw: unknown
      try {
        const text = await this.callLLM(
          prompt,
          builder.getSystemRole(),
          callbacks,
          { responseFormat: { type: 'json_object' }, maxTokens: budgets.outputTokens },
        )
        raw = this.parseJSON<Record<string, unknown>>(text)
      } catch (e) {
        // 审稿失败不应该变成「判定失败」：记录日志，继续用本地确定性检测保住大部分反馈
        llmFailed = true
        callbacks.log(t('qualitativeReview.segmentFailed', {
          index: index + 1,
          error: e instanceof Error ? e.message : String(e),
        }))
        continue
      }

      const parsed = observeChapter({
        chapterNumber: this.params.chapterNumber,
        chapterTitle: this.params.chapterTitle,
        chapterContent: effectiveChunks[index],
        knownCharacterNames,
        rawLlmResult: raw,
      })
      llmObservations.push(...parsed.observations.filter(item => item.origin === 'llm'))
    }

    if (effectiveChunks.length > 1) {
      callbacks.log(t('segmented.chunkDoneLog', { total: effectiveChunks.length }))
    }

    // ── 合并：模型观察 + 本地规则观察 + AI 痕迹检测（确定性，始终可用）──
    const review = observeChapter({
      chapterNumber: this.params.chapterNumber,
      chapterTitle: this.params.chapterTitle,
      chapterContent: draft,
      knownCharacterNames,
      rawLlmResult: { observations: [] },
      contextSize: canonSize,
    })
    const merged: QualitativeReview = {
      ...review,
      observations: dedupeObservations([...llmObservations, ...review.observations]),
    }

    if (llmFailed) {
      callbacks.log(t('qualitativeReview.localOnly'))
    }

    callbacks.log(t('qualitativeReview.found', {
      observations: merged.observations.length,
      traces: merged.aiTraces.length,
    }))

    // ── 存档：审稿产物写进 reviews 表，保持可追溯 ──
    try {
      const { parseDraftMeta } = await import('../chapter-workflow')
      const baseDraft = await parseDraftMeta(this.params.draftPath)
      if (baseDraft) {
        const reviewIndex = await ipc.invoke('db:review-next-index', baseDraft.id)
        await ipc.invoke('db:review-create', {
          baseDraftId: baseDraft.id,
          reviewIndex,
          // 存结构化 JSON：观察与痕迹都可被后续工具读取与追踪，
          // markdown 只是渲染结果，不承担数据职责
          content: JSON.stringify(merged),
        })
        callbacks.log(t('qualitativeReview.saved', { index: reviewIndex }))
      }
    } catch (e) {
      callbacks.log(t('qualitativeReview.saveFailed', { error: String(e) }))
    }

    return merged
  }
}

/** 合并观察列表：同 id 保留信息更完整的一条（避免分段重叠导致的重复） */
function dedupeObservations(observations: ReviewObservation[]): ReviewObservation[] {
  const byId = new Map<string, ReviewObservation>()
  for (const observation of observations) {
    const existing = byId.get(observation.id)
    if (!existing || observation.evidence.length > existing.evidence.length) {
      byId.set(observation.id, observation)
    }
  }
  return Array.from(byId.values())
}

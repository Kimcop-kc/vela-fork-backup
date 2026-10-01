import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { DirectoryPromptBuilder } from '../../prompts/prompt-builder'
import { DirectoryWorkflowParams, ChapterBlueprint, parseTextBlueprints, saveAllBlueprints } from '../directory-workflow'
import { buildTruncatedContinueDirective, isOutputLengthError, resolveGenerationBudgets } from '../segmented-generation'
import i18n from '../../../i18n'
import { globalEventBus } from '../../../shared/event-bus'

export class GenerateDirectoryCommand extends BaseWorkflowCommand<ChapterBlueprint[]> {
  constructor(private params: DirectoryWorkflowParams) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<ChapterBlueprint[]> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(i18n.t('common.noProject', { ns: 'commands' }))
    const assertCurrent = () => {
      const active = useProjectStore.getState()
      if (context.cancelled) throw new Error(i18n.t('base.workflowCancelled', { ns: 'commands' }))
      if (active.loading || active.currentProject?.id !== project.id || active.currentProject?.path !== project.path ||
          (context.data.directoryProjectPath && context.data.directoryProjectPath !== project.path)) throw new Error('PROJECT_CHANGED')
    }
    assertCurrent()
    context.data.directoryProjectPath = project.path

    const architecture = context.data.architecture as string
    const existingBlueprints = (context.data.existingBlueprints || []) as ChapterBlueprint[]

    const totalChapters = project.novelConfig.totalChapters
    const globalGuidance = project.novelConfig.globalGuidance || ''
    const genre = project.novelConfig.genre || ''

    let startChapter = 1
    let endChapter = totalChapters

    if (this.params.mode === 'append') {
      startChapter = this.params.startChapter || (Math.max(0, ...existingBlueprints.map(bp => bp.chapterNumber)) + 1)
      if (this.params.count && this.params.count > 0) {
        endChapter = startChapter + this.params.count - 1
      }
    } else if (this.params.count && this.params.count > 0) {
      endChapter = Math.min(this.params.count, totalChapters)
    }

    if (!Number.isSafeInteger(startChapter) || !Number.isSafeInteger(endChapter) || startChapter < 1 || endChapter < startChapter) {
      throw new Error(i18n.t('directory.invalidRange', { ns: 'commands' }))
    }

    callbacks.log(i18n.t('directory.generatingBlueprintsRange', { ns: 'commands', from: startChapter, to: endChapter }))

    // 从当前默认模型获取 maxTokens，动态计算每批次章节数（分段生成：单批只请求能完整输出的章节数）
    const llmStore = (await import('../../../stores/llm-store')).useLLMStore.getState()
    const defaultModel = llmStore.models.find(m => m.id === llmStore.defaultModelId)
    const budgets = resolveGenerationBudgets(defaultModel?.maxTokens)
    const outputBudget = Math.floor(budgets.outputTokens * 0.6)  // 预留 40% 给 prompt + 思考
    const tokensPerChapter = 600
    const maxBatchSize = Math.min(20, Math.max(1, Math.floor(outputBudget / tokensPerChapter)))

    /** 构建某一批次的蓝图 Prompt（明确告知模型本次只生成 from→to 章） */
    const buildBatchPrompt = (from: number, to: number): string => {
      if (from === 1 && this.params.mode === 'full') {
        const template = getPromptTemplate('chapter_blueprint')
        if (!template) throw new Error(i18n.t('common.templateMissing', { ns: 'commands' }))
        return new DirectoryPromptBuilder(template)
          .withNovelArchitecture(architecture)
          .withNumberOfChapters(to)
          .withGlobalGuidance(globalGuidance)
          .withGenre(genre)
          .withPacingGuidance((context.data.pacingGuidance as string) || '')
          .build()
      }
      const template = getPromptTemplate('chapter_blueprint_chunk')
      if (!template) throw new Error(i18n.t('common.templateMissing', { ns: 'commands' }))

      const prevAll = [...existingBlueprints, ...newBlueprints]
      const chapterList = prevAll.slice(-100).map(c => `${i18n.t('generateDraft.chapterNumberTitle', { ns: 'commands', chapter: c.chapterNumber, title: c.title })}：${c.keyEvents}`).join('\n')

      return new DirectoryPromptBuilder(template)
        .withNovelArchitecture(architecture)
        .withChapterList(chapterList || i18n.t('directory.firstBatchPlaceholder', { ns: 'commands' }))
        .withNumberOfChapters(totalChapters)
        .withN(from)
        .withM(to)
        .withGlobalGuidance(globalGuidance)
        .withGenre(genre)
        .withPacingGuidance((context.data.pacingGuidance as string) || '')
        .build()
    }

    const newBlueprints: ChapterBlueprint[] = []
    // 使用游标追踪生成进度，支持 AI 超额返回时智能跳过后续批次
    let cursor = startChapter
    // 输出被截断时保留结尾片段，供下一轮续写指令衔接
    let truncatedTail = ''
    let truncatedCursor = 0

    while (cursor <= endChapter) {
      assertCurrent()

      // 分段重试：先按预算请求一批；输出残缺（空结果/断号）时缩小本批范围重试，
      // 只有缩小到单章仍无法产出才判定失败，避免一次截断就中断整个目录生成。
      let batchSize = Math.min(maxBatchSize, endChapter - cursor + 1)
      let parsed: ChapterBlueprint[] = []
      let failure: Error | null = null

      while (batchSize >= 1) {
        const batchEnd = Math.min(cursor + batchSize - 1, endChapter)
        callbacks.log(`  ${i18n.t('directory.generatingBatch', { ns: 'commands', from: cursor, to: batchEnd })}`)

        let prompt = buildBatchPrompt(cursor, batchEnd)
        if (truncatedTail && truncatedCursor === cursor) {
          prompt += buildTruncatedContinueDirective(truncatedTail, cursor, batchEnd)
        }

        callbacks.setProgress(Math.round(((cursor - startChapter) / (endChapter - startChapter + 1)) * 90))

        // systemRole 由模板定义，不再硬编码
        const systemRole = getPromptTemplate('chapter_blueprint')?.systemRole || i18n.t('directory.systemRoleDefault', { ns: 'commands' })
        let resultText = ''
        // 某批章节太多时，模型可能直接以「输出达到长度上限」失败。
        // 这不是致命错误，按「本批太大」处理，交给下面的缩批逻辑换成更小的批次重试。
        let lengthLimitError: Error | null = null
        try {
          resultText = await this.callLLM(
            prompt,
            systemRole,
            callbacks,
            { responseFormat: { type: 'json_object' }, thinking: false, maxTokens: budgets.outputTokens },
            context,
          )
        } catch (error) {
          if (!isOutputLengthError(error)) throw error
          lengthLimitError = error instanceof Error ? error : new Error(String(error))
        }
        assertCurrent()

        // ★ 关键修复：接受 AI 返回的从 cursor 到 endChapter 范围内的所有有效章节
        // AI 可能一次性返回超出本批次（batchEnd）的章节，全部保留，避免浪费和重复 LLM 请求
        const candidate = parseTextBlueprints(resultText, cursor, endChapter)
        if (!candidate.length) {
          failure = lengthLimitError ?? new Error(i18n.t('directory.emptyResult', { ns: 'commands', from: cursor, to: batchEnd }))
        } else if (candidate.some((bp, index) => bp.chapterNumber !== cursor + index)) {
          // 不允许跳号：缺章说明输出被截断，必须重试而不是把残缺批次当成功
          failure = new Error(i18n.t('directory.missingChapters', { ns: 'commands', from: cursor, to: batchEnd }))
        } else {
          parsed = candidate
          break
        }

        truncatedTail = resultText.slice(-600)
        truncatedCursor = cursor
        batchSize = Math.floor(batchSize / 2)
        if (batchSize >= 1) {
          callbacks.log(i18n.t('segmented.shrinkLog', { ns: 'commands', from: cursor, to: Math.min(cursor + batchSize - 1, endChapter) }))
        }
      }

      if (!parsed.length) {
        throw failure ?? new Error(i18n.t('directory.emptyResult', { ns: 'commands', from: cursor, to: cursor }))
      }
      truncatedTail = ''
      truncatedCursor = 0
      newBlueprints.push(...parsed)

      // ==== 批次入库 ====
      if (parsed.length > 0) {
        await saveAllBlueprints(parsed, project.path)
        assertCurrent()
        globalEventBus.emit('BLUEPRINTS_UPDATED', { projectPath: project.path, count: newBlueprints.length })
        void useProjectStore.getState().refreshFileTree()
      }

      // 计算本次实际生成到的最大章节号，推进游标到已生成的最后一章之后
      const actualMaxChapter = Math.max(...parsed.map(p => p.chapterNumber))
      callbacks.log(`  ${i18n.t('directory.batchComplete', { ns: 'commands', from: cursor, max: actualMaxChapter, count: parsed.length })}`)

      cursor = actualMaxChapter + 1
    }

    context.data.newBlueprints = newBlueprints
    context.data.existingBlueprints = existingBlueprints

    callbacks.log(i18n.t('directory.totalGenerated', { ns: 'commands', count: newBlueprints.length }))
    return newBlueprints
  }
}

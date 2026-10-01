/**
 * 导入小说 — Command 集合
 *
 * 三个独立 Command 组成逆向推演全链路：
 * 1. ImportInitializeCommand — 写入正文 + 构建知识库
 * 2. InferGlobalSettingsCommand — 向量采样 + AI 推演全局配置/架构/角色
 * 3. InferBlueprintsPerChapterCommand — 按章逐一推演精准蓝图 + 蓝图入向量库 + 拼装轻量全局摘要
 */

import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { getPromptTemplate } from '../../prompt-templates'
import { ImportPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import i18n from '../../../i18n'
import { useLLMStore } from '../../../stores/llm-store'
import type { CharacterData } from '../../../../electron/repositories/character-repository'
import {
  buildSegmentDirective,
  callSegmentWithShrink,
  estimateTokens,
  halveText,
  isFilledValue,
  isOutputLengthError,
  mergeByKey,
  mergeFilled,
  parseLooseJson,
  resolveChunkBudget,
  resolveGenerationBudgets,
  splitTextByTokenBudget,
} from '../segmented-generation'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 拆分后的章节数据（从 context.data 中传递） */
export interface ImportedChapter {
  number: number
  title: string
  content: string
  wordCount: number
}

/** 逆向推演的部分结果（分段生成时每个片段返回一份） */
interface InferPartial {
  novelConfig?: Record<string, string>
  architectureFiles?: Record<string, string>
  characterCards?: Array<Record<string, unknown>>
}

/** 供分段推演使用的采样片段 */
interface InferSampleField {
  key: 'worldview' | 'protagonist' | 'conflict' | 'style' | 'first' | 'latest'
  label: string
  text: string
}

/** 读取「逆向推演」用途模型的 token 预算，供分段生成使用 */
function currentGenerationBudgets() {
  const llmStore = useLLMStore.getState()
  const model = llmStore.modelForPurpose('infer_novel_config')
  return resolveGenerationBudgets(model?.maxTokens)
}

/** 按 token 预算把采样片段切成多组（分段推演：单组输入不超出上下文预算） */
function groupSampleFields(fields: InferSampleField[], maxTokensPerGroup: number): InferSampleField[][] {
  const groups: InferSampleField[][] = []
  let current: InferSampleField[] = []
  let used = 0
  for (const field of fields) {
    const cost = estimateTokens(field.text) + 200
    if (current.length > 0 && used + cost > maxTokensPerGroup) {
      groups.push(current)
      current = []
      used = 0
    }
    current.push(field)
    used += cost
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** 合并分段推演结果：描述性字段取信息量最大者，角色卡按名字去重 */
function mergeInferPartials(partials: InferPartial[]): {
  novelConfig: Record<string, string>
  architectureFiles: Record<string, string>
  characterCards: Array<Record<string, unknown>>
} {
  let novelConfig: Record<string, unknown> = {}
  let architectureFiles: Record<string, unknown> = {}
  const characterCards: Array<Record<string, unknown>> = []
  for (const partial of partials) {
    if (partial.novelConfig) {
      novelConfig = mergeFilled(novelConfig, { ...partial.novelConfig }, 'richest')
    }
    if (partial.architectureFiles) {
      architectureFiles = mergeFilled(architectureFiles, { ...partial.architectureFiles }, 'richest')
    }
    if (Array.isArray(partial.characterCards)) characterCards.push(...partial.characterCards)
  }
  return {
    novelConfig: novelConfig as Record<string, string>,
    architectureFiles: architectureFiles as Record<string, string>,
    characterCards: mergeByKey([characterCards], { keyOf: (card) => String(card.name ?? ''), prefer: 'last' }),
  }
}

// =================================================================
// 1. 初始化：写入正文 + 构建知识库
// =================================================================

export class ImportInitializeCommand extends BaseWorkflowCommand<void> {
  constructor(private chapters: ImportedChapter[]) {
    super()
  }

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    callbacks.log(t('importNovel.importingChapters', { count: this.chapters.length }))
    callbacks.setProgress(5)

    // 1. 批量创建草稿并标记为 finalized
    for (let i = 0; i < this.chapters.length; i++) {
      const ch = this.chapters[i]

      // 直接调用 DB 写库（来源设为 write）
      await ipc.invoke('db:draft-create', {
        chapterNumber: ch.number,
        version: 1,
        content: ch.content,
        wordCount: ch.wordCount,
        source: 'write'
      })

      if (i % 10 === 0) {
        callbacks.setProgress(5 + Math.round((i / this.chapters.length) * 40))
        callbacks.log(t('importNovel.importedChapter', { chapter: ch.number, words: ch.wordCount }))
      }
    }
    callbacks.log(t('importNovel.allChaptersImported', { count: this.chapters.length }))
    callbacks.setProgress(45)

    // 2. 逐章导入知识库（向量化）
    callbacks.log(t('importNovel.buildingKB'))
    let successCount = 0
    let failCount = 0
    for (let i = 0; i < this.chapters.length; i++) {
      const ch = this.chapters[i]
      try {
        const fileName = ch.title
          ? `第${ch.number}章 ${ch.title}.txt`
          : `chapter_${ch.number}.txt`
        const result = await ipc.invoke('kb:import-text', ch.content, fileName, project.path) as { success: boolean; error?: string }
        if (result.success) {
          successCount++
        } else {
          callbacks.log(t('importNovel.kbImportFailed', { file: fileName, error: result.error }))
          failCount++
        }
      } catch {
        failCount++
      }
      if (i % 10 === 0) {
        callbacks.setProgress(45 + Math.round((i / this.chapters.length) * 45))
      }
    }
    callbacks.log(t('importNovel.kbBuilt', { success: successCount, fail: failCount }))
    callbacks.setProgress(90)

    // 将章节数据存入 context 供后续步骤使用
    context.data.chapters = this.chapters
    context.data.totalChapters = this.chapters.length

    // 刷新文件树
    useProjectStore.getState().refreshFileTree()
  }
}

// =================================================================
// 2. 向量采样 + AI 推演全局配置/架构/角色
// =================================================================

export class InferGlobalSettingsCommand extends BaseWorkflowCommand<void> {
  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const chapters = context.data.chapters as ImportedChapter[]
    if (!chapters || chapters.length === 0) throw new Error(t('importNovel.noChapterData'))

    callbacks.log(t('importNovel.searchingFragments'))
    callbacks.setProgress(5)

    // ===== 向量检索采样 =====
    const searchTopics = [
      { key: 'worldview', query: '世界观 力量体系 修炼等级 境界', labelKey: 'importNovel.searchTopicWorldview' },
      { key: 'protagonist', query: '主角 金手指 核心能力 天赋 系统', labelKey: 'importNovel.searchTopicProtagonist' },
      { key: 'conflict', query: '敌人 反派 阴谋 危机 矛盾 对手', labelKey: 'importNovel.searchTopicConflict' },
      { key: 'style', query: '视角 叙述 描写 风格 节奏', labelKey: 'importNovel.searchTopicStyle' },
    ]

    const sampledContent: Record<string, string> = {}
    for (const topic of searchTopics) {
      try {
        const results = await ipc.invoke('kb:search', topic.query, 5)
        if (results.length > 0) {
          sampledContent[topic.key] = results
            .map((r: { text: string; score: number; fileName: string }, i: number) =>
              `[${i + 1}] (${r.fileName}, 相关度 ${(r.score * 100).toFixed(0)}%)\n${r.text}`
            ).join('\n\n')
        } else {
          sampledContent[topic.key] = t('importNovel.noRelevantContent')
        }
        callbacks.log(t('importNovel.retrievedTopic', { label: t(topic.labelKey), count: results.length }))
      } catch {
        sampledContent[topic.key] = t('importNovel.vectorSearchUnavailable')
        callbacks.log(t('importNovel.topicSearchFailed', { label: t(topic.labelKey) }))
      }
    }
    callbacks.setProgress(20)

    // ===== 构建 Prompt =====
    // 优先使用向量增强版 Prompt
    const template = getPromptTemplate('infer_novel_config_with_vectors')
      || getPromptTemplate('infer_novel_config')
    if (!template) throw new Error(t('importNovel.templateNotFound'))

    const firstChapter = chapters[0]?.content?.slice(0, 3000) || t('importNovel.firstChapterUnavailable')
    const latestChapter = chapters[chapters.length - 1]?.content?.slice(0, 3000) || t('importNovel.latestChapterUnavailable')

    // ===== 分段推演：把采样片段按 token 预算切组，逐组推演后再合并 =====
    // 一次性把「首章 + 最新章 + 四类向量片段」塞进一个 Prompt 时，超长输入会挤占输出预算，
    // 导致返回的 JSON 被截断、字段大量缺失；分段后每段输入更短，单次输出更完整。
    const budgets = currentGenerationBudgets()
    const allSampleFields: InferSampleField[] = [
      { key: 'worldview', label: t('importNovel.searchTopicWorldview'), text: sampledContent.worldview || '' },
      { key: 'protagonist', label: t('importNovel.searchTopicProtagonist'), text: sampledContent.protagonist || '' },
      { key: 'conflict', label: t('importNovel.searchTopicConflict'), text: sampledContent.conflict || '' },
      { key: 'style', label: t('importNovel.searchTopicStyle'), text: sampledContent.style || '' },
      { key: 'first', label: t('importNovel.firstChapterLabel'), text: firstChapter },
      { key: 'latest', label: t('importNovel.latestChapterLabel'), text: latestChapter },
    ]
    const sampleFields = allSampleFields.filter(field => field.text.trim() !== '')

    const sampleGroups = groupSampleFields(sampleFields, resolveChunkBudget(budgets, 2000))
    const effectiveGroups = sampleGroups.length > 0 ? sampleGroups : [[] as InferSampleField[]]
    const partials: InferPartial[] = []

    /** 单次推演：给定采样字段组，返回解析后的结果（解析失败返回 null） */
    const runInferGroup = async (group: InferSampleField[], directive: string): Promise<InferPartial | null> => {
      const fieldText = (key: InferSampleField['key']) => group.find(field => field.key === key)?.text || ''
      const builder = new ImportPromptBuilder(template)
        .withSampledWorldview(fieldText('worldview'))
        .withSampledProtagonist(fieldText('protagonist'))
        .withSampledConflict(fieldText('conflict'))
        .withSampledStyle(fieldText('style'))
        .withFirstChapter(fieldText('first'))
        .withLatestChapter(fieldText('latest'))
        .withTotalChapters(chapters.length)
        // 兼容旧版 Prompt 的 sample_content 变量
        .withSampleContent(group.map(field => `【${field.label}】\n${field.text}`).join('\n\n'))
      // 推演结果 JSON 天然较长，撞上输出上限时自动续写补齐，避免字段大面积缺失
      const rawResult = await this.callLLMWithContinuation(
        builder.build() + directive,
        template.systemRole || '你是一位顶级网文主编和资深阅读分析师。',
        callbacks,
        { responseFormat: { type: 'json_object' }, maxTokens: budgets.outputTokens }
      )
      return parseLooseJson<InferPartial>(rawResult)
    }

    /**
     * 推演一组采样片段；输出撞上模型上限时把这一组拆小后重试
     * （先按字段拆半，只剩一个字段时再按正文长度拆半），避免整步失败。
     */
    const runInferGroupWithShrink = async (
      group: InferSampleField[],
      directive: string,
      depth = 2,
    ): Promise<InferPartial[]> => {
      try {
        const parsed = await runInferGroup(group, directive)
        return parsed ? [parsed] : []
      } catch (error) {
        if (depth <= 0 || !isOutputLengthError(error)) throw error
        if (group.length > 1) {
          const half = Math.ceil(group.length / 2)
          return [
            ...await runInferGroupWithShrink(group.slice(0, half), directive, depth - 1),
            ...await runInferGroupWithShrink(group.slice(half), directive, depth - 1),
          ]
        }
        const only = group[0]
        if (!only) throw error
        const halves = halveText(only.text)
        if (halves.length <= 1) throw error
        const parts: InferPartial[] = []
        for (const half of halves) {
          parts.push(...await runInferGroupWithShrink([{ ...only, text: half }], directive, depth - 1))
        }
        return parts
      }
    }

    for (let index = 0; index < effectiveGroups.length; index++) {
      const group = effectiveGroups[index]
      if (effectiveGroups.length > 1) {
        callbacks.log(t('segmented.chunkLog', { index: index + 1, total: effectiveGroups.length }))
      }
      callbacks.log(t('importNovel.inferringConfig'))
      callbacks.setProgress(25 + Math.round((index / effectiveGroups.length) * 40))

      const directive = effectiveGroups.length > 1
        ? buildSegmentDirective(index + 1, effectiveGroups.length, t('importNovel.configSegmentHint'))
        : ''
      const groupPartials = await runInferGroupWithShrink(group, directive)
      if (groupPartials.length > 0) {
        partials.push(...groupPartials)
      } else {
        callbacks.log(t('segmented.chunkFallbackLog', { index: index + 1, done: partials.length, error: t('importNovel.inferChunkUnparsable') }))
      }
    }

    if (partials.length === 0) throw new Error(t('importNovel.inferFailed'))

    callbacks.setProgress(70)
    callbacks.log(t('importNovel.parsingResult'))

    // ===== 合并分段推演结果 =====
    const inferResult = mergeInferPartials(partials)
    if (effectiveGroups.length > 1) {
      callbacks.log(t('segmented.chunkDoneLog', { total: effectiveGroups.length }))
    }

    // ===== 写入小说配置 =====
    if (inferResult.novelConfig) {
      const novelConfig = {
        ...project.novelConfig,
        ...inferResult.novelConfig,
        totalChapters: chapters.length,
        wordsPerChapter: Math.round(chapters.reduce((s, c) => s + c.wordCount, 0) / chapters.length),
      }
      // 更新内存
      useProjectStore.getState().updateNovelConfig(novelConfig)
      // 持久化到 config 文件
      const updatedProject = useProjectStore.getState().currentProject
      if (updatedProject) {
        // 仅提取 ProjectData 字段，防止 structured clone 序列化异常
        const plainData = {
          id: updatedProject.id,
          name: updatedProject.name,
          path: updatedProject.path,
          novelConfig: { ...updatedProject.novelConfig },
          characterStates: updatedProject.characterStates,
          createdAt: updatedProject.createdAt,
          updatedAt: updatedProject.updatedAt,
        }
        await ipc.invoke('project:save', plainData.id, plainData)
      }
      callbacks.log(t('importNovel.configUpdated'))

      // 生成配置摘要供后续步骤使用
      const noneLabel = t('importNovel.novelConfigSummaryNone')
      context.data.novelConfigSummary =
        `${t('importNovel.novelConfigSummaryGenre', { value: novelConfig.genre || noneLabel })} | ` +
        `${t('importNovel.novelConfigSummarySubGenre', { value: novelConfig.subGenre || noneLabel })} | ` +
        `${t('importNovel.novelConfigSummaryAudience', { value: novelConfig.targetAudience || noneLabel })}\n` +
        `${t('importNovel.novelConfigSummaryOutline', { value: novelConfig.coreOutline || noneLabel })}\n` +
        `${t('importNovel.novelConfigSummaryWorldSetting', { value: novelConfig.worldSetting || noneLabel })}\n` +
        `${t('importNovel.novelConfigSummaryGoldenFinger', { value: novelConfig.goldenFinger || noneLabel })}\n` +
        `${t('importNovel.novelConfigSummaryProtagonist', { value: novelConfig.protagonistProfile || noneLabel })}`
    }

    // ===== 写入架构信息 =====
    if (inferResult.architectureFiles) {
      await ipc.invoke('db:project-core-update', {
        premise: inferResult.architectureFiles.premise,
        charactersArch: inferResult.architectureFiles.characters,
        worldbuilding: inferResult.architectureFiles.world,
        synopsis: inferResult.architectureFiles.synopsis,
      })
      callbacks.log(t('importNovel.architecturePersisted'))
    }

    // ===== 写入角色卡 =====
    if (inferResult.characterCards && Array.isArray(inferResult.characterCards)) {
      let createdCount = 0
      const cardsToSave: CharacterData[] = []
      for (const card of inferResult.characterCards) {
        if (!card.name) continue
        const validRoles = ['protagonist', 'antagonist', 'supporting', 'minor']
        const role = validRoles.includes(card.role as string) ? card.role : 'supporting'
        cardsToSave.push({
          name: card.name as string,
          role: role as 'protagonist' | 'antagonist' | 'supporting' | 'minor',
          gender: (card.gender as string) || '',
          age: (card.age as string) || '',
          appearance: (card.appearance as string) || '',
          personality: (card.personality as string) || '',
          background: (card.background as string) || '',
          abilities: (card.abilities as string) || '',
          motivation: (card.motivation as string) || '',
          relationships: (card.relationships as string) || '',
          arc: (card.arc as string) || '',
          notes: (card.notes as string) || ''
        })
        createdCount++
      }
      if (cardsToSave.length > 0) {
        await ipc.invoke('db:character-save-all', cardsToSave)
      }
      callbacks.log(t('importNovel.cardsGenerated', { count: createdCount }))
    }

    callbacks.setProgress(90)
    this.notifyRefresh(['fileTree', 'characterCards'])
  }
}


// =================================================================
// 3. 按章逐一推演精准蓝图（限流并发）
// =================================================================

export class InferBlueprintsPerChapterCommand extends BaseWorkflowCommand<void> {
  /** 最大并发数，防止触发模型提供商 Rate Limit */
  private static readonly CONCURRENCY_LIMIT = 3

  async execute({ context, callbacks }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const chapters = context.data.chapters as ImportedChapter[]
    const configSummary = (context.data.novelConfigSummary as string) || t('importNovel.configSummaryUnavailable')
    if (!chapters || chapters.length === 0) throw new Error(t('importNovel.noChapterData'))

    const template = getPromptTemplate('infer_single_chapter_blueprint')
    if (!template) throw new Error(t('importNovel.singleChapterTemplateNotFound'))

    callbacks.log(t('importNovel.inferringBlueprints', { count: chapters.length, limit: InferBlueprintsPerChapterCommand.CONCURRENCY_LIMIT }))
    callbacks.setProgress(5)

    let completedCount = 0
    let failedCount = 0

    // 限流并发执行器
    const runWithConcurrency = async (tasks: (() => Promise<void>)[], limit: number) => {
      const executing = new Set<Promise<void>>()
      for (const task of tasks) {
        const p = task().then(() => { executing.delete(p) })
        executing.add(p)
        if (executing.size >= limit) {
          await Promise.race(executing)
        }
      }
      await Promise.all(executing)
    }

    const budgets = currentGenerationBudgets()
    const contentBudget = resolveChunkBudget(budgets, 2500)

    /** 合并同一章多个分片推演出的蓝图：事件与悬念串起来，其余字段取首个非空值 */
    const mergeBlueprints = (parts: Array<Record<string, unknown>>): Record<string, unknown> => {
      const merged: Record<string, unknown> = {}
      const keyEvents: string[] = []
      const hooks: string[] = []
      for (const part of parts) {
        if (typeof part.keyEvents === 'string' && part.keyEvents.trim()) keyEvents.push(part.keyEvents.trim())
        if (typeof part.suspenseHook === 'string' && part.suspenseHook.trim()) hooks.push(part.suspenseHook.trim())
        for (const [key, value] of Object.entries(part)) {
          if (key === 'keyEvents' || key === 'suspenseHook') continue
          if (!isFilledValue(merged[key])) merged[key] = value
        }
      }
      if (keyEvents.length > 0) merged.keyEvents = keyEvents.join(' / ')
      if (hooks.length > 0) merged.suspenseHook = hooks.join(' / ')
      return merged
    }

    const tasks = chapters.map((ch) => async () => {
      try {
        const runBlueprint = async (content: string, directive: string) => {
          const prompt = new ImportPromptBuilder(template)
            .withChapterContent(content)
            .withChapterNumber(ch.number)
            .withChapterTitle(ch.title)
            .withNovelConfigSummary(configSummary)
            .build() + directive
          // 单章蓝图同样可能超长：截断时续写补齐，而不是整章重来
          const rawResult = await this.callLLMWithContinuation(
            prompt,
            template.systemRole || '你是一位专业的网文结构分析师。',
            callbacks,
            { responseFormat: { type: 'json_object' }, maxTokens: budgets.outputTokens }
          )
          return this.parseJSON<Record<string, unknown>>(rawResult)
        }

        // 单章正文超长时按 token 预算切段：先逐段提取本段事件，再合并成整章蓝图。
        // 单段仍撞上输出上限时自动再切一半重试，避免整章推演失败。
        const contentChunks = splitTextByTokenBudget(ch.content, contentBudget)
        let blueprint: Record<string, unknown>
        if (contentChunks.length <= 1) {
          blueprint = await callSegmentWithShrink(ch.content, contentBudget, text => runBlueprint(text, ''), mergeBlueprints)
        } else {
          const segmentNotes: string[] = []
          for (let index = 0; index < contentChunks.length; index++) {
            const directive = buildSegmentDirective(index + 1, contentChunks.length, t('importNovel.blueprintSegmentHint'))
            const partial = await callSegmentWithShrink(
              contentChunks[index],
              contentBudget,
              text => runBlueprint(text, directive),
              mergeBlueprints,
            )
            const events = [partial.keyEvents, partial.suspenseHook]
              .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
              .join(' / ')
            if (events) segmentNotes.push(`第${index + 1}段：${events}`)
          }
          blueprint = await runBlueprint(segmentNotes.join('\n') || ch.content, t('importNovel.blueprintMergeDirective'))
        }

        // 确保必要字段
        const finalBlueprint = {
          chapterNumber: ch.number,
          title: (blueprint.title as string) || ch.title,
          role: (blueprint.role as string) || '发展',
          purpose: (blueprint.purpose as string) || '',
          keyEvents: (blueprint.keyEvents as string) || '',
          characters: Array.isArray(blueprint.characters) ? blueprint.characters as string[] : [],
          suspenseHook: (blueprint.suspenseHook as string) || '',
          userGuidance: '',
          notes: '',
          notesUpdatedAt: '',
        }

        await ipc.invoke('db:blueprint-upsert', finalBlueprint)

        completedCount++
        callbacks.log(t('importNovel.blueprintGenerated', { chapter: ch.number }))
      } catch (err) {
        failedCount++
        callbacks.log(t('importNovel.blueprintFailed', { chapter: ch.number, error: err instanceof Error ? err.message : String(err) }))
      }

      // 更新进度
      const total = chapters.length
      const done = completedCount + failedCount
      callbacks.setProgress(5 + Math.round((done / total) * 90))
    })

    await runWithConcurrency(tasks, InferBlueprintsPerChapterCommand.CONCURRENCY_LIMIT)

    callbacks.log(`\n${t('importNovel.blueprintSummary')}`)
    callbacks.log(t('importNovel.blueprintSummaryLine', { success: completedCount, fail: failedCount }))
    callbacks.setProgress(85)

    callbacks.setProgress(100)
    this.notifyRefresh(['fileTree', 'blueprints'])
  }
}

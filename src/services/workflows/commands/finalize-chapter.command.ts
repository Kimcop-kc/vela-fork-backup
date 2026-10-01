import i18n from '../../../i18n'
import { BaseWorkflowCommand, CommandExecuteParams } from './base-command'
import { useProjectStore } from '../../../stores/project-store'
import { useLLMStore } from '../../../stores/llm-store'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })
import { getPromptTemplate } from '../../prompt-templates'
import { PostProcessPromptBuilder } from '../../prompts/prompt-builder'
import { ipc } from '../../ipc-client'
import {
  buildCharacterFilterDirective,
  buildSegmentDirective,
  chunkArray,
  mergeByKey,
  mergeChapterNotes,
  resolveGenerationBudgets,
  splitTextByTokenBudget,
} from '../segmented-generation'

import {
  runPostProcessPipeline,
  getChapterFinalizeScope,
  stripThinkingTags,
  type PostProcessStep,
} from '../workflow-utils'
import type { ChapterInfo } from '../chapter-workflow'
import { extractAndWriteback, runConsistencyGate, buildCanonContext } from '../../narrative-consistency'

export interface FinalizeChapterParams {
  draftPath: string
  draftContent: string
  chapterNumber: number
  chapterInfo: ChapterInfo
}

// ===== 工具函数：流式调用大模型并返回完整文本 =====

/**
 * 使用 PromptBuilder 调用 LLM（不依赖 BaseWorkflowCommand 实例）
 * 独立函数，可被 PostProcessStep 的 executor 直接调用
 */
async function callLLMForPostProcess(
  prompt: string,
  systemRole: string,
  callbacks: { appendText: (text: string) => void },
  options?: { responseFormat?: { type: string } },
): Promise<string> {
  const llmStore = useLLMStore.getState()
  if (!llmStore.defaultModelId) throw new Error(t('base.noDefaultModel'))

  return new Promise<string>((resolve, reject) => {
    let fullContent = ''
    llmStore.generateStream(
      [
        { role: 'system', content: systemRole },
        { role: 'user', content: prompt },
      ],
      {
        onChunk: (chunk) => { fullContent += chunk; callbacks.appendText(chunk) },
        onDone: (text) => {
          const raw = text || fullContent
          resolve(stripThinkingTags(raw))
        },
        onError: (err) => reject(new Error(err || t('base.streamFailed'))),
      },
      undefined,
      options,
    )
  })
}

/** 读取当前默认模型的 token 预算，供分段生成使用 */
function currentGenerationBudgets() {
  const llmStore = useLLMStore.getState()
  const model = llmStore.models.find(m => m.id === llmStore.defaultModelId)
  return resolveGenerationBudgets(model?.maxTokens)
}

/** 容错 JSON 解析（剥离 Markdown 代码块 + 自动截取有效 JSON 边界） */
function parseJSON<T>(text: string): T {
  let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
  const firstBrace = cleanText.indexOf('{')
  const lastBrace = cleanText.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace !== -1) {
    cleanText = cleanText.substring(firstBrace, lastBrace + 1)
  }
  return JSON.parse(cleanText) as T
}

// ===== 后处理步骤构建器 =====

/**
 * 构建章节定稿后处理步骤列表
 *
 * 每个步骤都是独立的 PostProcessStep，由 runPostProcessPipeline
 * 统一调度执行、持久化状态、支持单步重试。
 * 导出供 createRepairFinalizeWorkflow 复用。
 *
 * @param project       当前项目信息
 * @param chapterNumber 章节号
 * @param chapterTitle  章节标题
 * @param draftContent  定稿正文内容
 */
export function buildFinalizePostProcessSteps(
  _project: { path: string },
  chapterNumber: number,
  chapterTitle: string,
  draftContent: string,
): PostProcessStep[] {
  const steps: PostProcessStep[] = []

  // ─── 步骤 1: 导入知识库 ───────────────────────────────────────────
  steps.push({
    key: 'kb_import',
    label: t('finalize.kbImport'),
    critical: true,
    executor: async (callbacks) => {
      const contentFileName = chapterTitle
        ? `第${chapterNumber}章 ${chapterTitle}.txt`
        : `chapter_${chapterNumber}.txt`
      const result = await ipc.invoke('kb:import-text', draftContent, contentFileName, _project.path) as { success: boolean; error?: string; chunkCount?: number }
      if (result.success) {
        callbacks.log(t('finalize.kbImportDone', { chunks: result.chunkCount }))
      } else {
        throw new Error(t('finalize.kbImportFailed', { error: result.error }))
      }
    },
  })

  // ─── 步骤 2: 本章剧情要点提取 ─────────────────────────────────────
  const notesTemplate = getPromptTemplate('generate_chapter_notes')
  if (notesTemplate) {
    steps.push({
      key: 'chapter_notes',
      label: t('finalize.chapterNotes'),
      critical: true,
      executor: async (callbacks) => {
        // 长章节按 token 预算切段逐段生成要点，再合并成一份，避免单次请求超出上下文导致要点缺失
        const budgets = currentGenerationBudgets()
        const contentChunks = splitTextByTokenBudget(draftContent, budgets.inputTokens - 1500)
        const notesParts: string[] = []
        for (let index = 0; index < contentChunks.length; index++) {
          if (contentChunks.length > 1) {
            callbacks.log(t('segmented.chunkLog', { index: index + 1, total: contentChunks.length }))
          }
          const notesBuilder = new PostProcessPromptBuilder(notesTemplate)
            .withChapterContent(contentChunks[index])
            .withChapterNumber(chapterNumber)
            .withChapterTitle(chapterTitle)
          let prompt = notesBuilder.build()
          if (contentChunks.length > 1) {
            prompt += buildSegmentDirective(index + 1, contentChunks.length, t('finalize.notesSegmentHint'))
          }
          notesParts.push(await callLLMForPostProcess(prompt, notesBuilder.getSystemRole(), callbacks))
        }
        const cleanNotes = contentChunks.length > 1 ? mergeChapterNotes(notesParts) : (notesParts[0] ?? '')
        if (contentChunks.length > 1) {
          callbacks.log(t('segmented.chunkDoneLog', { total: contentChunks.length }))
        }

        // 写入蓝图 JSON 的 notes 字段
        await ipc.invoke('db:blueprint-update-notes', chapterNumber, cleanNotes)
        callbacks.log(t('finalize.notesExtracted'))

        // [Canon] 同步写入章节级结构化摘要，供下一次生成引用
        try {
          await ipc.invoke('db:canon-summary-upsert', {
            chapterNumber,
            title: chapterTitle,
            summary: cleanNotes,
            createdAt: new Date().toISOString(),
          })
          callbacks.log('  🛡️ [Canon] 结构化摘要已写入 Canon Store')
        } catch (e) {
          callbacks.log(`  ⚠️ [Canon] 摘要写入失败：${String(e)}`)
        }
      },
    })
  }

  // ─── 步骤 2.5: [Canon] 写回 —— 把本章提取为结构化时间线/角色/事实/剧情线 ────
  steps.push({
    key: 'canon_writeback',
    label: t('finalize.canonWriteback'),
    critical: false,
    executor: async (callbacks) => {
      try {
        const [allChars, blueprint] = await Promise.all([
          ipc.invoke('db:character-get-all').catch(() => [] as Array<{ name: string; role: string; currentState?: { location?: string; powerLevel?: string; physicalState?: string; mentalState?: string; keyItems?: string; recentEvents?: string } }>),
          ipc.invoke('db:blueprint-get', chapterNumber).catch(() => null as null | { keyEvents?: string; characters?: string[]; suspenseHook?: string }),
        ])
        // 取出已生成的 notes 作为摘要来源
        const notes = await ipc.invoke('db:canon-summary-get', chapterNumber).catch(() => null as null | { summary?: string }) || null
        const existingNotes = notes?.summary || ''
        const result = await extractAndWriteback({
          chapterNumber,
          chapterTitle,
          chapterContent: draftContent,
          characters: (allChars || []).map(c => ({
            name: c.name,
            role: c.role,
            currentState: c.currentState,
          })),
          chapterBlueprint: blueprint ? {
            keyEvents: blueprint.keyEvents,
            characters: blueprint.characters,
            suspenseHook: blueprint.suspenseHook,
          } : undefined,
          existingNotes,
        })
        if (result.ok) {
          callbacks.log(t('finalize.canonWritebackSuccess', { events: (blueprint as unknown as { keyEvents?: string })?.keyEvents ? '已抽取' : '见正文' }))
        } else if (result.errors.length > 0) {
          callbacks.log(t('finalize.canonWritebackPartial', { count: result.errors.length, errors: result.errors.slice(0, 3).join('；') }))
        }
      } catch (e) {
        callbacks.log(t('finalize.canonWritebackError', { error: String(e) }))
      }
    },
  })

    // ─── 步骤 2.6: [Compression v3] 长期记忆压缩（每5章执行一次）──────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'canon_compression',
      label: t('finalize.compression'),
      critical: false,
      executor: async (callbacks: any) => {
        try {
          const { canonStore } = await import('../../narrative-consistency/canon-store');
          const recent = await canonStore.getRecentSummaries(20);
          if (recent.length < 5) {
            callbacks.log(t('finalize.compressionSkip'));
            return;
          }
          // 将前15章合并为压缩摘要
          const oldSummaries = recent.slice(0, 15);
          const compressed = oldSummaries
            .map((s: any) => '第' + s.chapterNumber + '章：' + (s.summary || '').slice(0, 80))
            .join(' | ');
          callbacks.log(t('finalize.compressionDone', { count: oldSummaries.length, length: compressed.length }));
          // 写入压缩后的 canonical summary
          await ipc.invoke('db:canon-summary-upsert', {
            chapterNumber: -1, // 特殊标记：压缩摘要
            title: t('finalize.compressionTitle', { chapter: chapterNumber }),
            summary: compressed,
            createdAt: new Date().toISOString(),
          });
        } catch (e) {
          callbacks.log(t('finalize.compressionError', { error: String(e) }));
        }
      },
    });
  }

// ─── 步骤 3: 角色状态更新 ────────────────────────────────────────
  const cardTemplate = getPromptTemplate('update_character_cards')
  if (cardTemplate) {
    steps.push({
      key: 'character_cards',
      label: t('finalize.charStateUpdate'),
      critical: false,
      executor: async (callbacks) => {
        // 读取现有角色卡
        const allChars = (await ipc.invoke('db:character-get-all')) as unknown as Array<Record<string, unknown>>
        const simpleCards = allChars.map((c) => ({ name: c.name, role: c.role }))

        type LLMUpdateState = {
          location?: string
          powerLevel?: string
          physicalState?: string
          mentalState?: string
          keyItems?: string
          recentEvents?: string
        }
        type LLMCardUpdate = { name: string; currentState: LLMUpdateState }
        type LLMNewCharacter = { name: string; role: string; currentState: LLMUpdateState }
        type LLMCardResult = { updates?: LLMCardUpdate[]; newCharacters?: LLMNewCharacter[] }

        // 双向分段：正文按 token 预算切段 + 角色卡按条数分批，
        // 避免一次性输出全部角色状态被输出上限截断（旧实现还会硬截断正文前 5000 字）
        const budgets = currentGenerationBudgets()
        const contentChunks = splitTextByTokenBudget(draftContent, budgets.inputTokens - 3000)
        const cardsPerCall = Math.max(1, Math.min(12, Math.floor((budgets.outputTokens * 0.5) / 150)))
        const cardGroups = chunkArray(simpleCards, cardsPerCall)
        const chunkList = contentChunks.length > 0 ? contentChunks : ['']
        const groupList = cardGroups.length > 0 ? cardGroups : [[] as Array<{ name: unknown; role: unknown }>]
        const totalCalls = chunkList.length * groupList.length

        const collectedUpdates: Array<Record<string, unknown>> = []
        const collectedNewCharacters: Array<Record<string, unknown>> = []
        let callIndex = 0

        for (const contentChunk of chunkList) {
          for (const cardGroup of groupList) {
            callIndex++
            if (totalCalls > 1) {
              callbacks.log(t('segmented.chunkLog', { index: callIndex, total: totalCalls }))
            }
            const cardBuilder = new PostProcessPromptBuilder(cardTemplate)
              .withChapterContent(contentChunk)
              .withChapterNumber(chapterNumber)
              .withExistingCardsJson(cardGroup)
            let prompt = cardBuilder.build()
            if (totalCalls > 1) {
              prompt += buildSegmentDirective(callIndex, totalCalls, t('finalize.cardsSegmentHint'))
              prompt += buildCharacterFilterDirective(cardGroup.map(card => String(card.name)))
            }
            const cardsResult = await callLLMForPostProcess(prompt, cardBuilder.getSystemRole(), callbacks, { responseFormat: { type: 'json_object' } })
            const parsedCards = parseJSON<LLMCardResult>(cardsResult)
            collectedUpdates.push(...(Array.isArray(parsedCards.updates) ? parsedCards.updates : []))
            collectedNewCharacters.push(...(Array.isArray(parsedCards.newCharacters) ? parsedCards.newCharacters : []))
          }
        }
        if (totalCalls > 1) {
          callbacks.log(t('segmented.chunkDoneLog', { total: totalCalls }))
        }

        // 分段结果按角色名合并：后出现的段落代表更接近章末的状态，冲突时覆盖
        const cardUpdates: LLMCardResult = {
          updates: mergeByKey([collectedUpdates], { keyOf: (item) => String(item.name ?? '') }) as unknown as LLMCardUpdate[],
          newCharacters: mergeByKey([collectedNewCharacters], { keyOf: (item) => String(item.name ?? '') }) as unknown as LLMNewCharacter[],
        }

        if (cardUpdates.updates && Array.isArray(cardUpdates.updates)) {
          for (const upd of cardUpdates.updates) {
            const dbChar = allChars.find((c) => c.name === upd.name)
            if (dbChar && upd.currentState) {
              const cs = upd.currentState
              const dbCharState = (dbChar.currentState as Record<string, unknown>) || {}
              const newState = {
                location: cs.location || (dbCharState.location as string) || '',
                powerLevel: cs.powerLevel || (dbCharState.powerLevel as string) || '',
                physicalState: cs.physicalState || (dbCharState.physicalState as string) || '',
                mentalState: cs.mentalState || (dbCharState.mentalState as string) || '',
                keyItems: cs.keyItems || (dbCharState.keyItems as string) || '',
                recentEvents: cs.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
              await ipc.invoke('db:character-update-state', upd.name, newState)
              callbacks.log(t('finalize.charStateUpdated', { name: dbChar.name }))
            }
          }
        }

        if (cardUpdates.newCharacters && Array.isArray(cardUpdates.newCharacters)) {
          let newCharCount = 0
          for (const newChar of cardUpdates.newCharacters) {
            if (allChars.some((c) => c.name === newChar.name)) continue
            newCharCount++
            const cs = newChar.currentState || {}
            await ipc.invoke('db:character-upsert', {
              name: newChar.name,
              role: newChar.role || 'supporting',
              gender: '', age: '', appearance: '', personality: '', background: '',
              abilities: '', motivation: '', relationships: '', arc: '', notes: '',
              currentState: {
                location: cs.location || '',
                powerLevel: cs.powerLevel || '',
                physicalState: cs.physicalState || '',
                mentalState: cs.mentalState || '',
                keyItems: cs.keyItems || '',
                recentEvents: cs.recentEvents || '',
                updatedAtChapter: chapterNumber,
              }
            })
          }
          if (newCharCount > 0) {
            callbacks.log(t('finalize.newCharsRegistered', { count: newCharCount }))
          }
        }
      },
    })
  }

  // ─── 步骤 4: 文风自动学习（每5章触发一次）─────────────────────────
  if (chapterNumber % 5 === 0) {
    steps.push({
      key: 'style_analysis',
      label: t('finalize.styleLearning'),
      critical: false,
      executor: async (callbacks) => {
        callbacks.log(t('finalize.styleLearningTriggered'))
        const { AnalyzeWritingStyleCommand } = await import('./analyze-style.command')
        await new AnalyzeWritingStyleCommand().execute({
          step: {} as unknown,
          context: { data: {}, cancelled: false },
          callbacks,
        })
        callbacks.log(t('finalize.styleAnalysisDone'))
      },
    })
  }

  return steps
}

// ===== 定稿命令 =====

export class FinalizeChapterCommand extends BaseWorkflowCommand<void> {
  constructor(private params: FinalizeChapterParams) {
    super()
  }

  async execute({ callbacks }: CommandExecuteParams): Promise<void> {
    const project = useProjectStore.getState().currentProject
    if (!project) throw new Error(t('common.noProject'))

    const refinedDraftText = this.params.draftContent
    if (!refinedDraftText) throw new Error(t('finalize.noFinalizedContent'))

    callbacks.log('\n' + t('finalize.startFinalize'))

    // 1. 获取对应草稿。一致性 Gate 必须先通过，才能写入 finalized/物理文件。
    const { parseDraftMeta } = await import('../chapter-workflow')
    const dbDraft = await parseDraftMeta(this.params.draftPath)
    if (!dbDraft) throw new Error(t('finalize.internalStateError'))

    // ==========================================
    // [Gate v2] 叙事一致性强制门禁 — 必须在任何定稿写入之前通过
    // ==========================================
    let gatedContent = refinedDraftText
    try {
      const [core, allCharacters] = await Promise.all([
        ipc.invoke('db:project-core-get').catch(() => null),
        ipc.invoke('db:character-get-all').catch(() => []),
      ])
      const canon = await buildCanonContext({
        chapterNumber: this.params.chapterNumber,
        architecture: {
          premise: (core as any)?.premise || '',
          charactersArch: (core as any)?.charactersArch || '',
          worldbuilding: (core as any)?.worldbuilding || '',
          synopsis: (core as any)?.synopsis || '',
        },
        characters: (allCharacters || []).map((c: any) => ({
          name: c.name as string,
          role: c.role as string,
          currentState: c.currentState as any,
        })),
        chapterGoal: t('finalize.chapterGoalPrefix', { chapter: this.params.chapterNumber }),
        previousEnding: '',
        ragContext: '',
        writingStyle: project.novelConfig.writingStyle || '',
        globalGuidance: project.novelConfig.globalGuidance || '',
      })
      const gateResult = await runConsistencyGate({
        chapterNumber: this.params.chapterNumber,
        chapterContent: gatedContent,
        canon,
        isRewrite: false,
      })
      callbacks.log(t('canon.finalizeGateVerdict', { verdict: gateResult.verdict, report: gateResult.report }))
      if (gateResult.verdict === 'BLOCK') {
        callbacks.log(t('canon.finalizeGateBlocked'))
        return
      }
      if (gateResult.verdict === 'REPAIR' && gateResult.repairedContent) {
        gatedContent = gateResult.repairedContent
        callbacks.log(t('canon.finalizeGateRepaired', { attempts: gateResult.repairAttempts }))
      }
    } catch (e) {
      callbacks.log(t('canon.finalizeGateError', { error: String(e) }))
      throw new Error(t('finalize.gateExecutionFailed', { error: String(e) }))
    }

    await ipc.invoke('db:draft-update-content', dbDraft.id, gatedContent, gatedContent.length)
    await ipc.invoke('db:draft-update-status', dbDraft.id, 'finalized', gatedContent.length)

    // 【重要】：除了写入 DB，对于已定稿的章节需要实体化为物理文件放在根目录，供外部系统读取或备份
    const safeTitle = this.params.chapterInfo.title ? ` ${this.params.chapterInfo.title.replace(/[/\\]/g, '_')}` : ''
    const physicalPath = `${project.path}/第${this.params.chapterNumber}章${safeTitle}.txt`
    try {
      const titleLine = this.params.chapterInfo.title ? `第${this.params.chapterNumber}章 ${this.params.chapterInfo.title}\n\n` : `第${this.params.chapterNumber}章\n\n`
      const contentToWrite = titleLine + gatedContent.replace(/^#+ .*\n*/, '')
      await ipc.invoke('fs:write-file', physicalPath, contentToWrite)
    } catch (e) {
      callbacks.log(t('finalize.fileWriteFailed', { error: String(e) }))
    }

    callbacks.log(t('finalize.finalizedSaved', { chapter: this.params.chapterNumber, title: safeTitle }))

    // 3. 通过 PostProcessPipeline 执行后处理（状态持久化 + 支持重试）
    callbacks.log(t('finalize.launchingPostProcess'))

    const scope = getChapterFinalizeScope(this.params.chapterNumber)
    const sourceLabel = t('finalize.chapterGoalPrefix', { chapter: this.params.chapterNumber })
    const steps = buildFinalizePostProcessSteps(
      project,
      this.params.chapterNumber,
      this.params.chapterInfo.title,
      gatedContent,
    )

    await runPostProcessPipeline(project.path, scope, sourceLabel, steps, callbacks)

    callbacks.log('\n' + t('finalize.chapterComplete', { chapter: this.params.chapterNumber }))
    useProjectStore.getState().refreshFileTree()

    // 通过 EventBus 通知 ProjectService 执行定稿后的统一刷新
    const { globalEventBus } = await import('../../../shared/event-bus')
    globalEventBus.emit('FINALIZE_COMPLETE', { chapterNumber: this.params.chapterNumber })
  }
}

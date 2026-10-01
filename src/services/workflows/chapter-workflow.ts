import type { WorkflowDefinition } from '../../stores/workflow-store'
import type { DraftMeta } from '../draft-index'
import type { SkillInputField } from '../agent/skill-inputs'
import i18n from '../../i18n'

import type { DraftStatus } from '../../shared/draft-status'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

// ==========================================
// 1. 结构与类型导出 (保留对外的向后兼容)
// ==========================================
export type { DraftStatus, DraftMeta }

export interface ChapterInfo {
  chapterNumber: number
  title: string
  role: string
  purpose: string
  characters: string[]
  keyEvents: string
  suspenseHook?: string
  userGuidance?: string
  /** 用户自定义知识库检索关键词（追加到向量搜索 query） */
  knowledgeQueryHint?: string
}

export interface RefineOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  userRefinePrompt?: string
}

export interface RefineFromReviewParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  reviewReport: string
  reviewFileName: string
  userRefinePrompt?: string
}

export interface ReviewOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 审稿维度侧重点（可选） */
  reviewFocus?: string
}

export interface FinalizeOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
}

/** 定性审稿参数 */
export interface QualitativeReviewOnlyParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  reviewFocus?: string
}

/** 去 AI 味修订参数（显式发起） */
export interface DeaiReviseParams {
  chapterNumber: number
  chapterTitle: string
  draftPath: string
  draftContent: string
  /** 只处理指定的痕迹类型；缺省时处理全部 */
  kinds?: Array<'high-frequency-word' | 'monotonous-sentence' | 'over-summary'>
}

/** 文风指南编译参数 */
export interface CompileStyleGuideParams {
  referenceText: string
  sourceTitle: string
  applyToProject?: boolean
}

// ==========================================
// 2. 草稿文件工具函数 (供前端 UI 侧调用)
// ==========================================

export function getDraftDir(_projectPath: string, chapterNumber: number): string {
  return `vela://draft/ch${chapterNumber}`
}

export function getDraftPath(_projectPath: string, chapterNumber: number, version: number): string {
  return `vela://draft/ch${chapterNumber}/v${version}`
}

export async function parseDraftMeta(filePath: string): Promise<DraftMeta | null> {
  const { ipc } = await import('../ipc-client')

  // 优先处理 vela://draft/{id} 纯数字 ID 格式（DB 化后的标准路径）
  const idMatch = filePath.match(/^vela:\/\/(?:draft|manuscript)\/(\d+)$/)
  if (idMatch) {
    const draftId = parseInt(idMatch[1])
    const dbMeta = await ipc.invoke('db:draft-get-meta', draftId)
    if (!dbMeta) return null
    return {
      ...dbMeta,
      status: dbMeta.status as DraftStatus,
      source: dbMeta.source as 'write' | 'rewrite',
      fileName: `draft_v${dbMeta.version}.md`,
      filePath: `vela://draft/${dbMeta.id}`,
    } as unknown as DraftMeta
  }

  // 兼容旧格式 draft_v(\d+).md 和 vela://draft/ch{N}/v{V}
  const versionMatch = filePath.match(/v(\d+)(?:\.md)?$/)
  if (!versionMatch) return null
  const version = parseInt(versionMatch[1])

  // 提取章节号
  const chMatch = filePath.match(/ch(\d+)/)
  if (!chMatch) return null
  const chapterNumber = parseInt(chMatch[1])

  const drafts = await ipc.invoke('db:draft-list', chapterNumber)
  const d = (drafts as unknown as Array<Record<string, unknown>>).find((d) => d.version === version)
  return d ? (d as unknown as DraftMeta) : null
}

export async function updateDraftStatus(filePath: string, newStatus: DraftStatus): Promise<void> {
  const meta = await parseDraftMeta(filePath)
  if (meta) {
    const { ipc } = await import('../ipc-client')
    await ipc.invoke('db:draft-update-status', meta.id, newStatus)
  }
}

// ==========================================
// 3. 工作流定义映射工厂 (Command 调度层)
// 将原有的 1500 多行核心面条代码剥离为微内核执行器。
// ==========================================

export function createChapterWorkflow(chapterInfo: ChapterInfo): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.chapterWriteTitle', { chapter: chapterInfo.chapterNumber, title: chapterInfo.title }),
    steps: [
      {
        name: t('workflowDefs.chapterWriteStepName'),
        description: t('workflowDefs.chapterWriteStepDesc'),
        executor: async (step, context, callbacks) => {
          const { GenerateDraftCommand } = await import('./commands/generate-draft.command')
          const cmd = new GenerateDraftCommand(chapterInfo)
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflowDefs.chapterWriteCompleted', { chapter: chapterInfo.chapterNumber }) },
  }
}

export function createRefineOnlyWorkflow(params: RefineOnlyParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.chapterRefineTitle', { chapter: params.chapterNumber, title: params.chapterTitle }),
    steps: [
      {
        name: t('workflowDefs.chapterRefineStepName'),
        description: t('workflowDefs.chapterRefineStepDesc'),
        executor: async (step, context, callbacks) => {
          const { RefineDraftCommand } = await import('./commands/refine-draft.command')
          const cmd = new RefineDraftCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo: { chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' },
            userRefinePrompt: params.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

/** Skill 调用参数：把章节正文交给某个 Skill 处理 */
export interface SkillInvokeParams {
  /** Skill 名（日志与统计展示用） */
  skillName: string
  /** Skill 方法正文 */
  skillContent: string
  /** 调用参数，会替换方法正文里的 ${args} */
  args?: string
  /** 按 Skill 的 inputs schema 收集到的结构化参数 */
  values?: Record<string, string>
  /** 输入参数 schema（用于把 values 拼成 ${args} 文本） */
  inputs?: SkillInputField[]
  /** 目标文本，通常是当前章节正文 */
  targetText?: string
  /** 目标说明，如「第 3 章」 */
  targetLabel?: string
}

/**
 * 写章节时调用 Skill：正文按模型预算切段，逐段套用同一套 Skill 方法。
 * 结果输出到「AI 输出」面板，不自动改写草稿。
 */
export function createSkillInvokeWorkflow(params: SkillInvokeParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.skillInvokeTitle', { skill: params.skillName }),
    steps: [
      {
        name: t('workflowDefs.skillInvokeStepName', { skill: params.skillName }),
        description: t('workflowDefs.skillInvokeStepDesc'),
        executor: async (step, context, callbacks) => {
          const { InvokeSkillCommand } = await import('./commands/invoke-skill.command')
          const cmd = new InvokeSkillCommand(params)
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'silent' },
  }
}

/** 流水线中一步的解析结果：Skill 正文与参数都已就位，可以直接跑 */
export interface SkillPipelineWorkflowStep {
  /** Skill 名（日志与统计展示用） */
  skillName: string
  /** Skill 方法正文 */
  skillContent: string
  /** 自由参数（老 Skill 走这条） */
  args?: string
  /** 结构化参数 */
  values?: Record<string, string>
  /** 输入参数 schema */
  inputs?: SkillInputField[]
  /** 输入来源：chapter=本章正文，previous=上一步的输出 */
  input: 'chapter' | 'previous'
}

/** Skill 流水线参数：把多个 Skill 串成一条链，一次跑完 */
export interface SkillPipelineWorkflowParams {
  /** 流水线展示名 */
  pipelineName: string
  /** 首步输入：当前章节正文 */
  chapterText: string
  /** 目标说明（如「第 3 章」），仅用于提示词 */
  targetLabel?: string
  steps: SkillPipelineWorkflowStep[]
}

/**
 * Skill 流水线工作流。
 *
 * 每步 = 一次 Skill 调用，默认把上一步的输出喂给下一步；
 * 调用方以 stepByStep 方式启动，步与步之间会暂停等待人工确认，
 * 确认满意再继续下一步，不确认就停在原地。
 */
export function createSkillPipelineWorkflow(params: SkillPipelineWorkflowParams): WorkflowDefinition {
  const pipelineSteps: WorkflowDefinition['steps'] = params.steps.map((pipelineStep, index) => ({
    name: t('workflowDefs.skillPipelineStepName', { index: index + 1, skill: pipelineStep.skillName }),
    description: pipelineStep.input === 'chapter'
      ? t('workflowDefs.skillPipelineStepDescChapter')
      : t('workflowDefs.skillPipelineStepDescPrevious'),
    executor: async (step, context, callbacks) => {
      const { InvokeSkillCommand } = await import('./commands/invoke-skill.command')
      const previous = context.data['pipeline.previous']
      const source = pipelineStep.input === 'chapter' || typeof previous !== 'string'
        ? params.chapterText
        : previous
      const cmd = new InvokeSkillCommand({
        skillName: pipelineStep.skillName,
        skillContent: pipelineStep.skillContent,
        args: pipelineStep.args,
        values: pipelineStep.values,
        inputs: pipelineStep.inputs,
        targetText: source,
        targetLabel: params.targetLabel,
      })
      const output = await cmd.execute({ step, context, callbacks })
      // 供下一步取用；同时按步号留档，方便对照每一步的产出
      context.data['pipeline.previous'] = output
      context.data[`pipeline.step.${index + 1}`] = output
      callbacks.log(t('workflowDefs.skillPipelineStepDone', { index: index + 1, chars: output.length }))
      return output
    },
  }))

  return {
    type: 'skill_pipeline',
    title: t('workflowDefs.skillPipelineTitle', { name: params.pipelineName }),
    steps: pipelineSteps,
    onComplete: { mode: 'silent' },
  }
}

export function createRefineFromReviewWorkflow(params: RefineFromReviewParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.chapterReviewFixTitle', { chapter: params.chapterNumber, title: params.chapterTitle }),
    steps: [
      {
        name: t('workflowDefs.chapterReviewFixStepName'),
        description: t('workflowDefs.chapterReviewFixStepDesc'),
        executor: async (step, context, callbacks) => {
          const { RefineFromReviewCommand } = await import('./commands/refine-from-review.command')
          const cmd = new RefineFromReviewCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            reviewReport: params.reviewReport,
            reviewFileName: params.reviewFileName,
            chapterNumber: params.chapterNumber,
            userRefinePrompt: params.userRefinePrompt,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', openResult: async () => { } },
  }
}

export function createReviewOnlyWorkflow(params: ReviewOnlyParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.chapterReviewTitle', { chapter: params.chapterNumber, title: params.chapterTitle }),
    steps: [
      {
        name: t('workflowDefs.chapterReviewStepName'),
        description: t('workflowDefs.chapterReviewStepDesc'),
        executor: async (step, context, callbacks) => {
          const { ReviewChapterCommand } = await import('./commands/review-chapter.command')
          const cmd = new ReviewChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            reviewFocus: params.reviewFocus,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflowDefs.chapterReviewCompleted', { chapter: params.chapterNumber }) },
  }
}

/**
 * 定性审稿工作流
 *
 * 产出可追溯的 observation 与 AI 痕迹标记，并在编辑器里打开审稿报告。
 * 注意：本工作流不修改正文，也不产生通过/失败判定。
 */
export function createQualitativeReviewWorkflow(params: QualitativeReviewOnlyParams): WorkflowDefinition {
  // 报告内容在 executor 里产生，onComplete 也要用它打开页签，所以存在闭包里
  let lastReviewJson = ''
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.qualitativeReviewTitle', { chapter: params.chapterNumber }),
    steps: [
      {
        name: t('workflowDefs.qualitativeReviewStepName'),
        description: t('workflowDefs.qualitativeReviewStepDesc'),
        executor: async (step, context, callbacks) => {
          const { QualitativeReviewCommand } = await import('./commands/qualitative-review.command')
          const cmd = new QualitativeReviewCommand({
            chapterNumber: params.chapterNumber,
            chapterTitle: params.chapterTitle,
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            reviewFocus: params.reviewFocus,
          })
          const review = await cmd.execute({ step, context, callbacks })
          context.data.qualitativeReview = review
          // 页签直接渲染结构化 JSON：观察与痕迹都能被逐条定位，而不是一段富文本
          lastReviewJson = JSON.stringify(review)
          return lastReviewJson
        },
      },
    ],
    onComplete: {
      mode: 'open',
      message: t('workflowDefs.qualitativeReviewCompleted', { chapter: params.chapterNumber }),
      openResult: async () => {
        if (!lastReviewJson) return
        const { useEditorStore } = await import('../../stores/editor-store')
        useEditorStore.getState().openFile({
          id: `qualitative-review-${params.chapterNumber}-${Date.now()}`,
          name: t('workflowDefs.qualitativeReviewTitle', { chapter: params.chapterNumber }),
          type: 'review-report',
          content: lastReviewJson,
          filePath: params.draftPath,
          reviewReport: lastReviewJson,
          chapterNumber: params.chapterNumber,
          chapterDir: `vela://draft/ch${params.chapterNumber}`,
        })
      },
    },
  }
}

/**
 * 去 AI 味修订工作流（显式发起）。
 *
 * 语义改写方法来自可替换的 de-ai-tone Skill；
 * 结果以「待审阅修订」的形式产出，不自动替换原稿。
 */
export function createDeaiReviseWorkflow(params: DeaiReviseParams): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.deaiTitle', { chapter: params.chapterNumber }),
    steps: [
      {
        name: t('workflowDefs.deaiStepName'),
        description: t('workflowDefs.deaiStepDesc'),
        executor: async (step, context, callbacks) => {
          const { DeaiReviseCommand } = await import('./commands/deai-revise.command')
          const cmd = new DeaiReviseCommand({
            chapterNumber: params.chapterNumber,
            chapterTitle: params.chapterTitle,
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            kinds: params.kinds,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflowDefs.deaiCompleted', { chapter: params.chapterNumber }) },
  }
}

/**
 * 文风指南编译工作流。
 *
 * 按激活的仿写 Skill 把参考文本编译成有证据的可执行文风指南；
 * 是否写入项目文风设定由 applyToProject 显式决定。
 */
export function createCompileStyleGuideWorkflow(params: CompileStyleGuideParams): WorkflowDefinition {
  // 指南内容在 executor 里产生，onComplete 也要用它开页签，所以存在闭包里
  let lastGuide = ''
  let lastTitle = params.sourceTitle
  return {
    type: 'style_study',
    title: t('workflowDefs.styleGuideTitle'),
    steps: [
      {
        name: t('workflowDefs.styleGuideStepName'),
        description: t('workflowDefs.styleGuideStepDesc'),
        executor: async (step, context, callbacks) => {
          const { CompileStyleGuideCommand } = await import('./commands/compile-style-guide.command')
          const cmd = new CompileStyleGuideCommand({
            referenceText: params.referenceText,
            sourceTitle: params.sourceTitle,
            applyToProject: params.applyToProject,
          })
          const guide = await cmd.execute({ step, context, callbacks })
          const { renderStyleGuide } = await import('../style-imitation')
          context.data.styleGuide = guide
          lastGuide = renderStyleGuide(guide)
          lastTitle = guide.source.title || params.sourceTitle
          return lastGuide
        },
      },
    ],
    onComplete: {
      mode: 'open',
      message: t('workflowDefs.styleGuideCompleted'),
      openResult: async () => {
        if (!lastGuide) return
        const { useEditorStore } = await import('../../stores/editor-store')
        useEditorStore.getState().openFile({
          id: `style-guide-${Date.now()}`,
          name: lastTitle || t('workflowDefs.styleGuideTitle'),
          type: 'style-guide',
          content: lastGuide,
        })
      },
    },
  }
}

export function createFinalizeWorkflow(params: FinalizeOnlyParams): WorkflowDefinition {
  const chapterInfo = { chapterNumber: params.chapterNumber, title: params.chapterTitle, role: '', purpose: '', characters: [], keyEvents: '' }
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.chapterFinalizeTitle', { chapter: params.chapterNumber, title: params.chapterTitle }),
    steps: [
      {
        name: t('workflowDefs.chapterFinalizeStepName'),
        description: t('workflowDefs.chapterFinalizeStepDesc'),
        executor: async (step, context, callbacks) => {
          const { FinalizeChapterCommand } = await import('./commands/finalize-chapter.command')
          const cmd = new FinalizeChapterCommand({
            draftPath: params.draftPath,
            draftContent: params.draftContent,
            chapterNumber: params.chapterNumber,
            chapterInfo,
          })
          return cmd.execute({ step, context, callbacks })
        },
      },
    ],
    onComplete: {
      mode: 'open', message: t('workflowDefs.chapterFinalizeCompleted', { chapter: params.chapterNumber }), openResult: async () => {
        const { useEditorStore } = await import('../../stores/editor-store')
        const { useProjectStore } = await import('../../stores/project-store')
        const project = useProjectStore.getState().currentProject
        if (!project) return
        const { ipc } = await import('../ipc-client')
        const draftMeta = await ipc.invoke('db:draft-get-finalized', params.chapterNumber)
        if (draftMeta) {
          const fullContent = await ipc.invoke('db:draft-get-full', draftMeta.id)
          // 从数据库蓝图读取正式标题
          let displayTitle = params.chapterTitle
          try {
            const bp = await ipc.invoke('db:blueprint-get', params.chapterNumber)
            if (bp?.title) displayTitle = bp.title
          } catch { /* 蓝图读取失败时回退到 params */ }
          const dbPath = `vela://manuscript/${draftMeta.id}`
          useEditorStore.getState().openFile({
            id: dbPath,
            name: t('generateDraft.chapterNumberTitle', { chapter: params.chapterNumber, title: displayTitle }),
            type: 'chapter',
            filePath: dbPath,
            content: fullContent?.content || '',
          })
        }
      }
    },
  }
}

/**
 * 修复定稿后处理工作流 — 当定稿后的三路推演失败时可重跑
 * 从 manuscript/ 读取已定稿内容，重新执行 FinalizeChapterCommand 的后处理部分
 */
export function createRepairFinalizeWorkflow(chapterNumber: number): WorkflowDefinition {
  return {
    type: 'chapter_creation',
    title: t('workflowDefs.repairFinalizeTitle', { chapter: chapterNumber }),
    steps: [
      {
        name: t('workflowDefs.repairFinalizeStepName'),
        description: t('workflowDefs.repairFinalizeStepDesc'),
        executor: async (_step, _context, callbacks) => {
          const { useProjectStore } = await import('../../stores/project-store')
          const { ipc } = await import('../ipc-client')
          const project = useProjectStore.getState().currentProject
          if (!project) throw new Error(t('common.noProject'))

          // 使用数据库定稿源
          const draftMeta = await ipc.invoke('db:draft-get-finalized', chapterNumber)
          if (!draftMeta) throw new Error(t('workflowDefs.repairFinalizeNoRecord', { chapter: chapterNumber }))
          const full = await ipc.invoke('db:draft-get-full', draftMeta.id)
          if (!full) throw new Error(t('workflowDefs.repairFinalizeContentFailed', { id: draftMeta.id }))

          // 从数据库蓝图读取正式标题
          let chapterTitle = t('workflowDefs.chapterTitleFallback', { chapter: chapterNumber })
          try {
            const bp = await ipc.invoke('db:blueprint-get', chapterNumber)
            if (bp?.title) chapterTitle = bp.title
          } catch { /* 蓝图读取失败时使用默认标题 */ }

          // 构建后处理步骤并以修复模式执行（跳过已成功的步骤）
          const { buildFinalizePostProcessSteps } = await import('./commands/finalize-chapter.command')
          const { runPostProcessPipeline, getChapterFinalizeScope } = await import('./workflow-utils')
          const scope = getChapterFinalizeScope(chapterNumber)
          const steps = buildFinalizePostProcessSteps(project, chapterNumber, chapterTitle, full.content)

          await runPostProcessPipeline(project.path, scope, t('finalize.chapterGoalPrefix', { chapter: chapterNumber }), steps, callbacks, { onlyFailed: true })

          // 通知刷新
          const { globalEventBus } = await import('../../shared/event-bus')
          globalEventBus.emit('FINALIZE_COMPLETE', { chapterNumber })
        },
      },
    ],
    onComplete: { mode: 'open', message: t('workflowDefs.repairFinalizeCompleted', { chapter: chapterNumber }) },
  }
}

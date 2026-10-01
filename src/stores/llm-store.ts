import { create } from 'zustand'
import { ipc } from '../services/ipc-client'
import { estimateTokens } from '../services/text-analysis'
import type { ModelProfile, LLMResponse, TokenUsage } from '../shared/ipc-channels'
import i18n from '../i18n'

/** 调用用途：用于统计面板里区分「这次 token 花在哪」 */
export type LLMCallPurpose = string

interface CallRecordInput {
  modelId: string
  modelName: string
  purpose: LLMCallPurpose
  /** 请求侧的文本（消息拼接），用于在供应商未返回 usage 时估算 */
  promptText: string
  /** 响应侧的文本 */
  completionText: string
  usage?: TokenUsage
  durationMs: number
  success: boolean
  errorMessage?: string
}

/** 供应商没有返回 usage 时，用文本长度粗略估算，避免统计面板永远为 0 */
function estimateUsage(promptText: string, completionText: string): TokenUsage {
  const promptTokens = estimateTokens(promptText)
  const completionTokens = estimateTokens(completionText)
  return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
}

/** 把一次调用写入 llm_calls 表（统计面板的数据来源） */
function recordCall(input: CallRecordInput): void {
  if (!ipc.isElectron) return
  const usage = input.usage && input.usage.totalTokens > 0
    ? input.usage
    : estimateUsage(input.promptText, input.completionText)
  const payload = {
    modelId: input.modelId,
    modelName: input.modelName,
    purpose: input.purpose,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    durationMs: input.durationMs,
    success: input.success,
    errorMessage: input.errorMessage ?? '',
  }
  // 统计失败不应影响生成流程，这里只静默忽略
  Promise.resolve(ipc.invoke('db:log-llm-call', payload)).catch(() => undefined)
}

/** 流式生成的回调 */
interface StreamCallbacks {
  onChunk?: (chunk: string) => void
  onDone?: (fullText: string, usage?: TokenUsage) => void
  onError?: (error: string) => void
}

interface LLMState {
  /** 已配置的模型列表 */
  models: ModelProfile[]
  /** 当前默认生成模型 ID */
  defaultModelId: string | null
  /** 当前默认向量模型 ID */
  defaultEmbeddingModelId: string | null
  /** 正在进行的活跃请求 */
  activeRequests: Map<string, { status: 'running' | 'done' | 'error'; text: string }>
  /** 是否已加载模型配置 */
  loaded: boolean

  // ===== Actions =====
  /** 初始化（加载模型列表 + 默认模型 ID） */
  init: () => Promise<void>
  /** 加载模型列表 */
  loadModels: () => Promise<void>
  /** 保存模型 */
  saveModel: (model: ModelProfile) => Promise<boolean>
  /** 删除模型 */
  deleteModel: (modelId: string) => Promise<boolean>
  /** 设置默认生成模型（持久化到 ~/.vela/config.json） */
  setDefaultModel: (modelId: string) => void
  /** 设置默认向量模型（持久化到 ~/.vela/config.json） */
  setDefaultEmbeddingModel: (modelId: string) => void
  /** 非流式生成 */
  generate: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    modelId?: string,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: LLMCallPurpose }
  ) => Promise<LLMResponse>
  /** 流式生成 */
  generateStream: (
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    callbacks: StreamCallbacks,
    modelId?: string,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: LLMCallPurpose }
  ) => Promise<string>
  /** 取消生成 */
  cancelGeneration: (requestId: string) => Promise<void>
  /** 测试模型连接 */
  testConnection: (model: ModelProfile) => Promise<{ success: boolean; error?: string }>
}

export const useLLMStore = create<LLMState>()((set, get) => ({
  models: [],
  defaultModelId: null,
  defaultEmbeddingModelId: null,
  activeRequests: new Map(),
  loaded: false,

  init: async () => {
    if (get().loaded) return
    // 从 ~/.vela/ 加载模型列表和默认模型 ID
    await get().loadModels()
    if (ipc.isElectron) {
      const [defaultId, defaultEmbeddingId] = await Promise.all([
        ipc.invoke('llm:get-default-model'),
        ipc.invoke('llm:get-default-embedding-model'),
      ])
      set({ defaultModelId: defaultId, defaultEmbeddingModelId: defaultEmbeddingId, loaded: true })
    } else {
      set({ loaded: true })
    }
  },

  loadModels: async () => {
    if (!ipc.isElectron) return
    const models = await ipc.invoke('llm:list-models')
    set({ models, loaded: true })
  },

  saveModel: async (model) => {
    const result = await ipc.invoke('llm:save-model', model)
    if (result.success) {
      await get().loadModels()
    }
    return result.success
  },

  deleteModel: async (modelId) => {
    const result = await ipc.invoke('llm:delete-model', modelId)
    if (result.success) {
      await get().loadModels()
      // 如果删除的是默认生成模型，清空默认
      if (get().defaultModelId === modelId) {
        set({ defaultModelId: null })
        ipc.invoke('llm:set-default-model', null)
      }
      // 如果删除的是默认向量模型，清空默认
      if (get().defaultEmbeddingModelId === modelId) {
        set({ defaultEmbeddingModelId: null })
        ipc.invoke('llm:set-default-embedding-model', null)
      }
    }
    return result.success
  },

  setDefaultModel: (modelId) => {
    set({ defaultModelId: modelId })
    ipc.invoke('llm:set-default-model', modelId)
  },

  setDefaultEmbeddingModel: (modelId) => {
    set({ defaultEmbeddingModelId: modelId })
    ipc.invoke('llm:set-default-embedding-model', modelId)
  },

  generate: async (messages, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) return { success: false, content: '', error: i18n.t('llm.noDefaultModel', { ns: 'stores' }) }
    const startedAt = Date.now()
    const result = await ipc.invoke('llm:generate', {
      modelId: mid,
      messages,
      responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
      thinking: options?.thinking,
      maxTokens: options?.maxTokens
    }) as LLMResponse

    recordCall({
      modelId: mid,
      modelName: get().models.find(model => model.id === mid)?.name ?? mid,
      purpose: options?.purpose ?? i18n.t('llm.purposeDefault', { ns: 'stores' }),
      promptText: messages.map(message => message.content).join('\n'),
      completionText: result?.content ?? '',
      usage: result?.usage,
      durationMs: Date.now() - startedAt,
      success: result?.success !== false,
      errorMessage: result?.error,
    })

    return result
  },

  generateStream: async (messages, callbacks, modelId, options) => {
    const mid = modelId ?? get().defaultModelId
    if (!mid) {
      callbacks.onError?.(i18n.t('llm.noDefaultModel', { ns: 'stores' }))
      return ''
    }

    const requestId = crypto.randomUUID()
    const startedAt = Date.now()
    const promptText = messages.map(message => message.content).join('\n')
    const modelName = get().models.find(model => model.id === mid)?.name ?? mid
    const purpose = options?.purpose ?? i18n.t('llm.purposeDefault', { ns: 'stores' })

    // 注册流式事件监听
    const unsubChunk = ipc.on('llm:stream-chunk', (data) => {
      if (data.requestId === requestId) {
        callbacks.onChunk?.(data.chunk)
      }
    })

    const unsubDone = ipc.on('llm:stream-done', (data) => {
      if (data.requestId === requestId) {
        recordCall({
          modelId: mid,
          modelName,
          purpose,
          promptText,
          completionText: data.fullText ?? '',
          usage: data.usage,
          durationMs: Date.now() - startedAt,
          success: true,
        })
        callbacks.onDone?.(data.fullText, data.usage)
        cleanup()
      }
    })

    const unsubError = ipc.on('llm:stream-error', (data) => {
      if (data.requestId === requestId) {
        recordCall({
          modelId: mid,
          modelName,
          purpose,
          promptText,
          completionText: '',
          durationMs: Date.now() - startedAt,
          success: false,
          errorMessage: data.error,
        })
        callbacks.onError?.(data.error)
        cleanup()
      }
    })

    const cleanup = () => {
      unsubChunk()
      unsubDone()
      unsubError()
      const reqs = new Map(get().activeRequests)
      reqs.delete(requestId)
      set({ activeRequests: reqs })
    }

    // 标记活跃请求
    const reqs = new Map(get().activeRequests)
    reqs.set(requestId, { status: 'running', text: '' })
    set({ activeRequests: reqs })

    // 发起流式请求
    const startRes = (await ipc.invoke('llm:generate-stream', requestId, {
      modelId: mid,
      messages,
      stream: true,
      responseFormat: options?.responseFormat as { type: 'json_object' | 'text' } | undefined,
      thinking: options?.thinking,
      maxTokens: options?.maxTokens
    })) as { requestId: string; started: boolean } | undefined

    // 模型未找到/未配置时主进程直接返回 started:false，不会发任何流事件；
    // 必须主动报错，否则调用方会永远等待 onDone/onError
    if (startRes && startRes.started === false) {
      recordCall({
        modelId: mid,
        modelName,
        purpose,
        promptText,
        completionText: '',
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: i18n.t('llm.modelNotFound', { ns: 'stores' }),
      })
      callbacks.onError?.(i18n.t('llm.modelNotFound', { ns: 'stores' }))
      cleanup()
    }

    return requestId
  },

  cancelGeneration: async (requestId) => {
    await ipc.invoke('llm:cancel', requestId)
  },

  testConnection: async (model) => {
    return ipc.invoke('llm:test-connection', model)
  },
}))

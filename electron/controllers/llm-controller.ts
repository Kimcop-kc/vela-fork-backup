import { ipcMain, BrowserWindow } from 'electron'
import { readJsonFile, writeJsonFile, MODELS_CONFIG_PATH, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG } from '../utils/config-utils'
import { ModelProfile, GlobalConfig, LLMPurposeCategory, PurposeModelBindings } from '../../src/shared/ipc-channels'
import { PURPOSE_CATEGORIES, categorizePurpose, pickModelIdForCategory } from '../../src/shared/purpose-routing'
import { LLMFactory } from '../llm/llm-factory'
import { listOllamaModels } from '../llm/ollama-models'
import { joinMessages, recordLLMCall } from '../llm/call-log'

const activeStreams = new Map<string, AbortController>()

function loadModelConfigs(): ModelProfile[] {
  return readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
}

function saveModelConfigs(models: ModelProfile[]) {
  writeJsonFile(MODELS_CONFIG_PATH, models)
}

function getModelConfig(modelId: string): ModelProfile | null {
  const models = loadModelConfigs()
  return models.find((m) => m.id === modelId) ?? null
}

/**
 * 解析本次调用实际使用的模型。
 *
 * 显式指定的模型优先；缺失或已被删除时按「用途绑定 → 默认模型 → 模型池」回退，
 * 回退链与渲染进程共用 src/shared/purpose-routing.ts，保证两侧结论一致。
 */
function resolveModelForRequest(modelId: string | undefined, purpose?: string): ModelProfile | null {
  if (modelId) {
    const explicit = getModelConfig(modelId)
    if (explicit) return explicit
  }
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const resolvedId = pickModelIdForCategory(categorizePurpose(purpose), {
    models: loadModelConfigs(),
    bindings: config.purposeModels ?? {},
    defaultModelId: config.defaultModelId ?? null,
    defaultEmbeddingModelId: config.defaultEmbeddingModelId ?? null,
  })
  return resolvedId ? getModelConfig(resolvedId) : null
}

function applyProxyConfig() {
  try {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    if (config.proxy?.enabled && config.proxy.host) {
      const proxyUrl = config.proxy.type === 'socks5'
        ? `socks5://${config.proxy.host}:${config.proxy.port}`
        : `http://${config.proxy.host}:${config.proxy.port}`
      process.env.HTTP_PROXY = proxyUrl
      process.env.HTTPS_PROXY = proxyUrl
      process.env.http_proxy = proxyUrl
      process.env.https_proxy = proxyUrl
    } else {
      delete process.env.HTTP_PROXY
      delete process.env.HTTPS_PROXY
      delete process.env.http_proxy
      delete process.env.https_proxy
    }
  } catch { /* 忽略 */ }
}

export function registerLLMController() {
  ipcMain.handle('llm:ollama-models', async (_event, baseUrl: string, apiKey?: string) => {
    try {
      return { success: true, models: await listOllamaModels(baseUrl, apiKey) }
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      const code = /^(INVALID_URL|INVALID_RESPONSE|HTTP_\d+)$/.test(message) ? message :
        error instanceof Error && error.name === 'TimeoutError' ? 'TIMEOUT' : 'CONNECTION_FAILED'
      return { success: false, models: [], error: code }
    }
  })
  ipcMain.handle('llm:generate', async (_event, request: { modelId: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: string }; thinking?: boolean; purpose?: string }) => {
    const startedAt = Date.now()
    const promptText = joinMessages(request.messages)
    try {
      applyProxyConfig()
      const model = resolveModelForRequest(request.modelId, request.purpose)
      if (!model) {
        recordLLMCall({ modelId: request.modelId, purpose: request.purpose, promptText, completionText: '', startedAt, success: false, errorMessage: '未找到模型配置' })
        return { success: false, content: '', error: '未找到模型配置' }
      }

      const provider = LLMFactory.getProvider(model)
      const result = await provider.generate(model, request.messages, {
        temperature: request.temperature ?? model.temperature,
        maxTokens: request.maxTokens ?? model.maxTokens,
        responseFormat: request.responseFormat,
        thinking: request.thinking,
      })
      recordLLMCall({
        model,
        modelId: model.id,
        purpose: request.purpose,
        promptText,
        completionText: result.content ?? '',
        usage: result.usage,
        startedAt,
        success: result.success !== false,
        errorMessage: result.error,
      })
      return result
    } catch (error) {
      recordLLMCall({ modelId: request.modelId, purpose: request.purpose, promptText, completionText: '', startedAt, success: false, errorMessage: String(error) })
      return { success: false, content: '', error: String(error) }
    }
  })

  ipcMain.handle('llm:generate-stream', async (event, requestId: string, request: { modelId: string; messages: Array<{ role: string; content: string }>; temperature?: number; maxTokens?: number; responseFormat?: { type: string }; thinking?: boolean; purpose?: string }) => {
    applyProxyConfig()
    const model = resolveModelForRequest(request.modelId, request.purpose)
    const startedAt = Date.now()
    const promptText = joinMessages(request.messages)
    if (!model) {
      recordLLMCall({ modelId: request.modelId, purpose: request.purpose, promptText, completionText: '', startedAt, success: false, errorMessage: '未找到模型配置' })
      return { requestId, started: false }
    }

    const abortController = new AbortController()
    activeStreams.set(requestId, abortController)
    const win = BrowserWindow.fromWebContents(event.sender)

    const provider = LLMFactory.getProvider(model)
    
    // We do not await this globally since it's streaming independently
    provider.generateStream(model, request.messages, {
      temperature: request.temperature ?? model.temperature,
      maxTokens: request.maxTokens ?? model.maxTokens,
      responseFormat: request.responseFormat,
      thinking: request.thinking,
      signal: abortController.signal,
      onChunk: (chunk: string) => win?.webContents.send('llm:stream-chunk', { requestId, chunk }),
      onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }, meta?: { truncated?: boolean; finishReason?: string }) => {
        recordLLMCall({
          model,
          modelId: model.id,
          purpose: request.purpose,
          promptText,
          completionText: fullText ?? '',
          usage,
          startedAt,
          success: true,
        })
        win?.webContents.send('llm:stream-done', { requestId, fullText, usage, meta })
        activeStreams.delete(requestId)
      },
      onError: (error: string) => {
        recordLLMCall({
          model,
          modelId: model.id,
          purpose: request.purpose,
          promptText,
          completionText: '',
          startedAt,
          success: false,
          errorMessage: error,
        })
        win?.webContents.send('llm:stream-error', { requestId, error })
        activeStreams.delete(requestId)
      },
      // 输出被长度上限截断：把已产出的部分内容交给渲染进程，由其决定续写还是报错
      onTruncated: (partialText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }, meta?: { truncated?: boolean; finishReason?: string }) => {
        // 截断时 token 已真实消耗，按成功计入统计，避免漏记
        recordLLMCall({
          model,
          modelId: model.id,
          purpose: request.purpose,
          promptText,
          completionText: partialText ?? '',
          usage,
          startedAt,
          success: true,
          errorMessage: '输出达到长度上限',
        })
        win?.webContents.send('llm:stream-truncated', { requestId, partialText, usage, meta })
        activeStreams.delete(requestId)
      },
    })

    return { requestId, started: true }
  })

  ipcMain.handle('llm:cancel', async (_event, requestId: string) => {
    const controller = activeStreams.get(requestId)
    if (controller) {
      controller.abort()
      activeStreams.delete(requestId)
      return { success: true }
    }
    return { success: false }
  })

  ipcMain.handle('llm:list-models', async () => loadModelConfigs())

  ipcMain.handle('llm:save-model', async (_event, model: ModelProfile) => {
    try {
      const models = loadModelConfigs()
      const idx = models.findIndex((m) => m.id === model.id)
      if (idx >= 0) models[idx] = model
      else models.push(model)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:delete-model', async (_event, modelId: string) => {
    try {
      const models = loadModelConfigs().filter((m) => m.id !== modelId)
      saveModelConfigs(models)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:set-default-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultModelId
  })

  ipcMain.handle('llm:set-default-embedding-model', async (_event, modelId: string | null) => {
    try {
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      config.defaultEmbeddingModelId = modelId
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:get-default-embedding-model', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.defaultEmbeddingModelId ?? null
  })

  /** 用途 → 模型绑定表（多模型管理：先导入模型，再为每个用途挑选模型） */
  ipcMain.handle('llm:get-purpose-models', async () => {
    const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
    return config.purposeModels ?? {}
  })

  ipcMain.handle('llm:set-purpose-model', async (_event, purpose: LLMPurposeCategory, modelId: string | null) => {
    try {
      if (!PURPOSE_CATEGORIES.includes(purpose)) return { success: false, error: 'INVALID_PURPOSE' }
      const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
      const purposeModels: PurposeModelBindings = { ...(config.purposeModels ?? {}) }
      // 传 null 表示解除绑定，回落到默认模型
      if (modelId) purposeModels[purpose] = modelId
      else delete purposeModels[purpose]
      config.purposeModels = purposeModels
      writeJsonFile(GLOBAL_CONFIG_PATH, config)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  ipcMain.handle('llm:test-connection', async (_event, model: ModelProfile) => {
    try {
      applyProxyConfig()
      
      const messages = [{ role: 'user', content: 'Say "hello" and nothing else.' }]
      const provider = LLMFactory.getProvider(model)
      
      let result = { success: true, error: undefined as undefined | string }
      if (model.purposes?.includes('embedding')) {
        const { generateEmbeddings } = await import('../embedding')
        await generateEmbeddings(['hello'], model.protocol, model)
      } else {
        const res = await provider.generate(model, messages, {
          temperature: 0.7,
          maxTokens: 10,
        })
        result = { success: res.success, error: res.error }
      }
      
      return { success: result.success, error: result.error }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

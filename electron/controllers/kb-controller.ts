import { ipcMain, dialog } from 'electron'
import fs from 'node:fs'
import {
  importDocument, importFolder, importText, searchKnowledge, searchKnowledgeFTS,
  listDocuments, removeDocument, getKnowledgeStats,
  getVectorlessCount, backfillVectors,
  getDocumentText,
} from '../knowledge-base'
import { readJsonFile, GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG, MODELS_CONFIG_PATH, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { deconstructBook, listBooks, removeBook } from '../book-deconstruct'
import { GlobalConfig, ModelProfile } from '../../src/shared/ipc-channels'
import { pickModelIdForCategory } from '../../src/shared/purpose-routing'

function getEmbeddingConfig(): { protocol: 'openai' | 'gemini'; model: { baseUrl: string; apiKey: string; modelName: string } } | null {
  const config = readJsonFile<GlobalConfig>(GLOBAL_CONFIG_PATH, DEFAULT_GLOBAL_CONFIG)
  const models = readJsonFile<ModelProfile[]>(MODELS_CONFIG_PATH, [])
  // 与渲染进程共用同一条回退链：用途绑定 → 默认向量模型 → 声明向量能力的模型 → 默认生成模型
  const targetModelId = pickModelIdForCategory('embedding', {
    models,
    bindings: config.purposeModels ?? {},
    defaultModelId: config.defaultModelId ?? null,
    defaultEmbeddingModelId: config.defaultEmbeddingModelId ?? null,
  })
  if (!targetModelId) return null

  const model = models.find((m) => m.id === targetModelId)
  if (!model) return null
  return {
    protocol: model.protocol as 'openai' | 'gemini',
    model: { baseUrl: model.baseUrl, apiKey: model.apiKey, modelName: model.modelName },
  }
}

function getCurrentProjectPath(): string | null {
  try {
    const recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_PATH, 'utf-8')) as Array<{ path: string }>
    return recent[0]?.path ?? null
  } catch { return null }
}

export function registerKBController() {
  ipcMain.handle('kb:import-document', async (_event, filePath: string) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importDocument(filePath, projectPath, protocol, model)
  })

  ipcMain.handle('kb:import-folder', async (_event, folderPath: string) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importFolder(folderPath, projectPath, protocol, model)
  })

  ipcMain.handle('kb:import-text', async (_event, text: string, fileName: string, projectPath: string) => {
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return importText(text, fileName, projectPath, protocol, model)
  })

  ipcMain.handle('kb:search', async (_event, query: string, topK?: number) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []

    if (embConfig) {
      return searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5)
    }
    return searchKnowledgeFTS(query, projectPath, topK ?? 5)
  })

  ipcMain.handle('kb:search-with-scope', async (_event, query: string, fromChapter: number, toChapter: number, topK?: number) => {
    const embConfig = getEmbeddingConfig()
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []

    const scope: [number, number] = [fromChapter, toChapter]
    if (embConfig) {
      return searchKnowledge(query, projectPath, embConfig.protocol, embConfig.model, topK ?? 5, scope)
    }
    return searchKnowledgeFTS(query, projectPath, topK ?? 5, scope)
  })

  ipcMain.handle('kb:list-documents', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []
    return listDocuments(projectPath)
  })

  ipcMain.handle('kb:remove-document', async (_event, docId: string) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false }
    return { success: removeDocument(docId, projectPath) }
  })

  ipcMain.handle('kb:stats', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { documentCount: 0, totalChunks: 0, vectorDimension: 0 }
    return getKnowledgeStats(projectPath)
  })

  ipcMain.handle('kb:get-vectorless-count', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { count: 0 }
    return getVectorlessCount(projectPath)
  })

  ipcMain.handle('kb:backfill-vectors', async () => {
    const embConfig = getEmbeddingConfig()
    if (!embConfig) return { success: false, processed: 0, failed: 0, error: '未配置 Embedding 模型' }
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, processed: 0, failed: 0, error: '未打开项目' }
    return backfillVectors(projectPath, embConfig.protocol, embConfig.model)
  })

  // ===== 拆书知识库 =====

  /** 拆书：把参考小说按章拆开并写入本地知识库，同时留一份拆书档案 */
  ipcMain.handle('kb:deconstruct-book', async (_event, filePath: string) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    const embConfig = getEmbeddingConfig()
    const protocol = embConfig?.protocol ?? 'openai'
    const model = embConfig?.model ?? { baseUrl: '', apiKey: '' }
    return deconstructBook(filePath, projectPath, protocol, model)
  })

  /** 列出本项目已有的拆书档案 */
  ipcMain.handle('kb:list-books', async () => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return []
    return listBooks(projectPath)
  })

  /** 按文档 id 取回整篇正文（拆书章节回看 / 作为文风参考） */
  ipcMain.handle('kb:get-document-text', async (_event, docId: string) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, error: '未打开项目' }
    return getDocumentText(docId, projectPath)
  })

  /** 移除一本拆书（档案 + 知识库中的章节） */
  ipcMain.handle('kb:remove-book', async (_event, bookId: string) => {
    const projectPath = getCurrentProjectPath()
    if (!projectPath) return { success: false, removedChapters: 0, error: '未打开项目' }
    return removeBook(bookId, projectPath)
  })

  ipcMain.handle('dialog:select-files', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      title: '选择要导入的文档',
      filters: [{ name: '文本文件', extensions: ['txt', 'md', 'markdown'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths
  })

  ipcMain.handle('dialog:select-import-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择要批量导入的文件夹',
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

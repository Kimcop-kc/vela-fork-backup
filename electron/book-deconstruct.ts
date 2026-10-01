/**
 * 拆书知识库 — 主进程
 *
 * 把参考小说按章拆开，逐章写入本地知识库（LanceDB），
 * 并在 {projectPath}/.vela/books/ 下留一份「拆书档案」，
 * 供界面列出、检索与管理。拆章规则与「导入小说」完全一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { chunkText, generateEmbeddings } from './embedding'
import { addChunks, removeDocument as removeDocFromStore, listDocuments as storeListDocuments } from './vector-store'
import { splitFilePathsIntoChapters } from './chapter-splitting'
import type { BookChapterEntry, BookRecord } from '../src/shared/ipc-channels'

export type { BookChapterEntry, BookRecord }

/** 拆书档案存放目录 */
function booksDir(projectPath: string): string {
  return path.join(projectPath, '.vela', 'books')
}

/** 列出本项目已有的拆书档案（按导入时间倒序） */
export function listBooks(projectPath: string): BookRecord[] {
  try {
    const dir = booksDir(projectPath)
    if (!fs.existsSync(dir)) return []
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.json'))
      .map(f => {
        try {
          return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as BookRecord
        } catch {
          return null
        }
      })
      .filter((b): b is BookRecord => !!b && typeof b.id === 'string')
      .sort((a, b) => b.importedAt.localeCompare(a.importedAt))
  } catch {
    return []
  }
}

/**
 * 拆书：分章 → 逐章入本地知识库 → 写入拆书档案
 */
export async function deconstructBook(
  filePath: string,
  projectPath: string,
  protocol: 'openai' | 'gemini',
  model: { baseUrl: string; apiKey: string },
): Promise<{ success: boolean; book?: BookRecord; error?: string }> {
  try {
    const split = splitFilePathsIntoChapters([filePath])
    if (!split.success) return { success: false, error: split.error ?? '拆分章节失败' }
    if (split.chapters.length === 0) return { success: false, error: '未能从文件中拆出任何章节' }

    const bookName = path.basename(filePath, path.extname(filePath))
    const bookId = randomUUID()
    const now = new Date().toISOString()

    const entries: BookChapterEntry[] = []
    let vectorized = false

    for (const chapter of split.chapters) {
      const fileName = `${bookName} · 第${chapter.number}章 ${chapter.title}`.trim()
      const docId = randomUUID()
      const chunks = chunkText(chapter.content, 500, 50)
      if (chunks.length === 0) continue

      // 可选：生成向量（未配置 Embedding 模型时降级为纯全文检索）
      let vectors: number[][] | undefined
      if (model.apiKey) {
        try {
          vectors = await generateEmbeddings(chunks, protocol, model)
          if (vectors.length > 0) vectorized = true
        } catch (e) {
          console.warn('[Vela 拆书] Embedding 失败，本章降级为 FTS-only:', e)
        }
      }

      // 重复导入同一本书时，先清掉同名的旧文档
      const existingDocs = await storeListDocuments(projectPath)
      const duplicate = existingDocs.find(d => d.fileName === fileName)
      if (duplicate) {
        await removeDocFromStore(projectPath, duplicate.id)
      }

      const result = await addChunks(
        projectPath,
        docId,
        fileName,
        chunks,
        vectors,
        undefined,
        { chapterNumber: chapter.number, chapterTitle: chapter.title },
      )
      if (!result.success) continue

      entries.push({
        number: chapter.number,
        title: chapter.title,
        wordCount: chapter.wordCount,
        docId,
        fileName,
      })
    }

    if (entries.length === 0) {
      return { success: false, error: '章节入库失败，请检查知识库状态后重试' }
    }

    const book: BookRecord = {
      id: bookId,
      name: bookName,
      sourcePath: filePath,
      importedAt: now,
      chapterCount: entries.length,
      wordCount: entries.reduce((sum, e) => sum + e.wordCount, 0),
      vectorized,
      chapters: entries,
    }

    const dir = booksDir(projectPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${bookId}.json`), JSON.stringify(book, null, 2), 'utf-8')

    return { success: true, book }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}

/**
 * 移除一本拆书：删除档案 + 清掉它在知识库里的所有章节
 */
export async function removeBook(
  bookId: string,
  projectPath: string,
): Promise<{ success: boolean; removedChapters: number; error?: string }> {
  try {
    const dir = booksDir(projectPath)
    const manifestPath = path.join(dir, `${bookId}.json`)
    if (!fs.existsSync(manifestPath)) {
      return { success: false, removedChapters: 0, error: '未找到该拆书档案' }
    }

    let book: BookRecord | null = null
    try {
      book = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as BookRecord
    } catch {
      book = null
    }

    let removed = 0
    if (book?.chapters?.length) {
      for (const chapter of book.chapters) {
        await removeDocFromStore(projectPath, chapter.docId)
        removed++
      }
    }

    fs.rmSync(manifestPath, { force: true })
    return { success: true, removedChapters: removed }
  } catch (error) {
    return { success: false, removedChapters: 0, error: String(error) }
  }
}

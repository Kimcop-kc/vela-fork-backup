import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { buildEpub, type EpubChapter } from '../utils/epub-builder'
import { createZip, type ZipEntry } from '../utils/zip-writer'

/**
 * 导出控制器 — 需要二进制写盘与压缩，所以放在主进程：
 * - EPUB：OCF 就是 ZIP，打包要用 node:zlib
 * - 项目备份包（.zip）：把渲染层整理好的纯文本条目打成一个包
 *
 * 纯文本 / Markdown 的导出仍然走 fs:write-file，不经过这里。
 */

/** 文件名安全化：去掉目录分隔符与 Windows 非法字符 */
function safeFileBase(name: string, fallback: string): string {
  const cleaned = (name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || fallback
}

/** 拼出输出路径，并确保仍然落在用户选的目录里 */
function resolveOutput(outputDir: string, fileName: string): { filePath: string; error?: string } {
  const dir = path.resolve(outputDir)
  const filePath = path.resolve(path.join(dir, fileName))
  if (path.dirname(filePath) !== dir) return { filePath, error: '非法的导出路径' }
  return { filePath }
}

export function registerExportController() {
  /** 把章节拼成 EPUB 并写盘 */
  ipcMain.handle('novel:export-epub', async (_event, options: {
    outputDir: string
    fileName: string
    title: string
    author?: string
    language?: string
    description?: string
    chapters: EpubChapter[]
  }) => {
    try {
      if (!options?.outputDir || !Array.isArray(options.chapters)) {
        return { success: false, error: '导出参数不完整' }
      }
      const title = options.title?.trim() || '未命名作品'
      const buffer = buildEpub({
        title,
        author: options.author?.trim() || undefined,
        language: options.language,
        description: options.description,
        chapters: options.chapters,
      })
      const fileName = `${safeFileBase(options.fileName, title)}.epub`
      const { filePath, error } = resolveOutput(options.outputDir, fileName)
      if (error) return { success: false, error }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, buffer)
      return { success: true, path: filePath, size: buffer.length }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 把若干纯文本条目打成一个 zip（项目备份包） */
  ipcMain.handle('novel:write-zip', async (_event, options: {
    outputDir: string
    fileName: string
    entries: Array<{ path: string; content: string }>
  }) => {
    try {
      if (!options?.outputDir || !Array.isArray(options.entries) || options.entries.length === 0) {
        return { success: false, error: '导出参数不完整' }
      }
      const entries: ZipEntry[] = options.entries
        .filter(entry => entry && typeof entry.path === 'string' && typeof entry.content === 'string')
        // 包内路径统一用 /，并挡掉 .. 之类的穿越写法
        .map(entry => ({
          path: entry.path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\.\//g, ''),
          data: entry.content,
        }))
      const buffer = createZip(entries)
      const fileName = `${safeFileBase(options.fileName, 'vela-backup')}.zip`
      const { filePath, error } = resolveOutput(options.outputDir, fileName)
      if (error) return { success: false, error }
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, buffer)
      return { success: true, path: filePath, size: buffer.length }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

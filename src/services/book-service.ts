/**
 * book-service — 拆书知识库数据访问服务
 *
 * 拆书 = 把参考小说按章拆开后写入本地知识库（LanceDB），
 * 并在项目的 .vela/books/ 下留一份拆书档案，供界面列出与管理。
 */

import { ipc } from './ipc-client'
import type { BookRecord } from '../shared/ipc-channels'

export type { BookRecord } from '../shared/ipc-channels'
export type { BookChapterEntry } from '../shared/ipc-channels'

/** 选择要拆解的小说文件（txt / md） */
export async function selectBookFiles(): Promise<string[] | null> {
  return ipc.invoke('dialog:select-novel-files')
}

/** 拆书：分章 → 写入本地知识库 → 生成拆书档案 */
export async function deconstructBook(filePath: string) {
  return ipc.invoke('kb:deconstruct-book', filePath)
}

/** 列出本项目已有的拆书档案 */
export async function listBooks(): Promise<BookRecord[]> {
  return ipc.invoke('kb:list-books')
}

/** 移除一本拆书（档案 + 知识库中的章节） */
export async function removeBook(bookId: string) {
  return ipc.invoke('kb:remove-book', bookId)
}

/** 按章节文档 id 取回正文（拆书章节回看 / 作为文风参考） */
export async function getChapterText(docId: string) {
  return ipc.invoke('kb:get-document-text', docId)
}

/** 在知识库中检索（结果按拆书前缀过滤即为「本书范围内检索」） */
export async function searchKnowledgeBase(query: string, topK: number) {
  return ipc.invoke('kb:search', query, topK)
}

/** 某章在知识库里的文档名前缀（用于把检索结果限定到某一本书） */
export function bookFileNamePrefix(bookName: string): string {
  return `${bookName} · `
}

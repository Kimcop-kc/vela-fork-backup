import { beforeEach, describe, expect, it, vi } from 'vitest'
import { exportNovel } from '../export-service'
import { useProjectStore } from '../../stores/project-store'
import { ipc } from '../ipc-client'

/** 两章定稿：蓝图标题 + 正文（正文首行自带「第N章 xxx」） */
const blueprints = [
  { chapterNumber: 1, title: '试炼之始' },
  { chapterNumber: 2, title: '暗流' },
]
const makeBodies = (): Record<number, string> => ({
  1: '# 第1章 试炼之始\n\n林尘推开石门。\n\n**山风**裹着雪粒。',
  2: '# 第2章 暗流\n\n暗处有人窥视。',
})
let bodies = makeBodies()

let written: Record<string, string> = {}
let epubArgs: Record<string, unknown> | null = null
let zipArgs: Record<string, unknown> | null = null
let epubResult: Record<string, unknown> = { success: true, path: 'D:/out/book.epub' }

function handleInvoke(channel: string, ...args: unknown[]): Promise<unknown> {
  switch (channel) {
    case 'db:blueprint-get-all':
      return Promise.resolve(blueprints)
    case 'db:draft-get-finalized':
      return Promise.resolve({ id: args[0] })
    case 'db:draft-get-full':
      return Promise.resolve({ content: bodies[args[0] as number] })
    case 'db:project-core-get':
      return Promise.resolve({ synopsis: '全书梗概' })
    case 'db:character-get-all':
      return Promise.resolve([{ name: '林尘' }])
    case 'fs:mkdir':
      return Promise.resolve({ success: true })
    case 'fs:write-file':
      written[args[0] as string] = args[1] as string
      return Promise.resolve({ success: true })
    case 'novel:export-epub':
      epubArgs = args[0] as Record<string, unknown>
      return Promise.resolve(epubResult)
    case 'novel:write-zip':
      zipArgs = args[0] as Record<string, unknown>
      return Promise.resolve({ success: true, path: 'D:/out/book-backup.zip' })
    default:
      return Promise.reject(new Error('unexpected channel: ' + channel))
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  written = {}
  epubArgs = null
  zipArgs = null
  epubResult = { success: true, path: 'D:/out/book.epub' }
  bodies = makeBodies()
  useProjectStore.setState({
    currentProject: {
      id: 'A',
      name: '试炼之书',
      path: 'D:/p',
      novelConfig: { genre: '', subGenre: '', targetAudience: '', totalChapters: 2 },
    } as never,
  })
  vi.spyOn(ipc, 'invoke').mockImplementation(handleInvoke as never)
})

describe('exportNovel', () => {
  it('EPUB：把定稿章节按蓝图顺序交给主进程，并带上作者', async () => {
    const result = await exportNovel({ format: 'epub', outputDir: 'D:/out', author: '某作者' })

    expect(result).toMatchObject({ success: true, path: 'D:/out/book.epub' })
    expect(epubArgs).toMatchObject({ fileName: '试炼之书', title: '试炼之书', author: '某作者', outputDir: 'D:/out' })
    expect(epubArgs!.chapters).toEqual([
      { title: '试炼之始', content: bodies[1] },
      { title: '暗流', content: bodies[2] },
    ])
  })

  it('TXT：每章只出现一次章名，且去掉 Markdown 标记', async () => {
    await exportNovel({ format: 'txt', outputDir: 'D:/out' })
    const text = written['D:/out/试炼之书.txt']

    expect(text).toContain('第1章 试炼之始')
    expect(text.split('试炼之始')).toHaveLength(2)
    expect(text).toContain('山风裹着雪粒。')
    expect(text).not.toContain('**')
    expect(text).not.toContain('#')
  })

  it('合并 Markdown：元信息为空时不写出空的引用行', async () => {
    await exportNovel({ format: 'merged-md', outputDir: 'D:/out', includeOutline: true })
    const text = written['D:/out/试炼之书.md']

    expect(text.startsWith('# 试炼之书\n\n---\n')).toBe(true)
    expect(text).not.toContain('>  · ')
    expect(text).toContain('全书梗概')
    expect(text).toContain('# 第2章 暗流')
  })

  it('分章 Markdown：正文缺标题时补上蓝图标题', async () => {
    bodies[2] = '暗处有人窥视。'
    await exportNovel({ format: 'split-md', outputDir: 'D:/out' })

    expect(written['D:/out/试炼之书/002-暗流.md']).toBe('# 暗流\n\n暗处有人窥视。')
  })

  it('备份包：条目包含配置、蓝图、角色卡与定稿正文', async () => {
    const result = await exportNovel({ format: 'epub', outputDir: 'D:/out', backup: true })
    const entries = zipArgs!.entries as Array<{ path: string; content: string }>
    const paths = entries.map(entry => entry.path)

    expect(result.backupPath).toBe('D:/out/book-backup.zip')
    expect(paths).toEqual(expect.arrayContaining([
      'README.md', 'project.json', 'project-core.json', 'blueprints.json', 'characters.json',
      'chapters/001-试炼之始.md', 'chapters/002-暗流.md',
    ]))
    expect(zipArgs!.fileName).toBe('试炼之书-backup')
  })

  it('没有定稿章节时不生成产物', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(((channel: string, ...args: unknown[]) => {
      if (channel === 'db:blueprint-get-all') return Promise.resolve([])
      return handleInvoke(channel, ...args)
    }) as never)

    const result = await exportNovel({ format: 'epub', outputDir: 'D:/out' })

    expect(result.success).toBe(false)
    expect(result.error).toBeTruthy()
    expect(epubArgs).toBeNull()
  })

  it('主进程导出失败时把错误如实透出', async () => {
    epubResult = { success: false, error: '磁盘已满' }

    const result = await exportNovel({ format: 'epub', outputDir: 'D:/out' })

    expect(result).toEqual({ success: false, error: '磁盘已满' })
  })

  it('备份说明排在最前，且只列包里真实存在的文件', async () => {
    vi.spyOn(ipc, 'invoke').mockImplementation(((channel: string, ...args: unknown[]) => {
      if (channel === 'db:character-get-all') return Promise.resolve([])
      return handleInvoke(channel, ...args)
    }) as never)

    await exportNovel({ format: 'epub', outputDir: 'D:/out', backup: true })
    const entries = zipArgs!.entries as Array<{ path: string; content: string }>
    const readme = entries[0]

    expect(readme.path).toBe('README.md')
    expect(readme.content).toContain('`blueprints.json`')
    expect(readme.content).not.toContain('characters.json')
    expect(readme.content).toContain('`chapters/` — 各章定稿正文（Markdown），共 2 章')
  })
})

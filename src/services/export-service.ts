/**
 * 导出服务 — 把已定稿章节合成为完整作品
 *
 * 支持四种产物：
 * - EPUB 3 电子书（带目录，阅读器通用）
 * - 合并 Markdown / 分章 Markdown
 * - 纯文本 TXT
 *
 * 另外可选「项目备份包」（.zip）：把项目配置、故事架构、章节蓝图、角色卡与
 * 定稿正文一起打包，方便存档或换机器继续写。
 *
 * EPUB 与 zip 在主进程生成（要用 node:zlib 且是二进制写盘），
 * 纯文本类产物仍然走 fs:write-file。
 */
import { ipc } from './ipc-client'
import { useProjectStore } from '../stores/project-store'
import { useWorkflowStore } from '../stores/workflow-store'
import i18n from '../i18n'

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'dialogs', ...opts })

export type ExportFormat = 'epub' | 'merged-md' | 'split-md' | 'txt'

interface ExportOptions {
  format: ExportFormat
  outputDir: string
  includeOutline?: boolean
  /** EPUB 的作者署名 */
  author?: string
  /** 同时生成项目备份包（.zip） */
  backup?: boolean
}

export interface ExportResult {
  success: boolean
  /** 主产物路径 */
  path?: string
  /** 备份包路径（勾选了备份才有） */
  backupPath?: string
  error?: string
}

/** 收集到的一章：编号 + 标题 + 定稿正文 */
interface CollectedChapter {
  chapterNumber: number
  title: string
  content: string
}

/** 文件名片段安全化（章节标题可能带 / : 等字符） */
function safeName(text: string, fallback: string): string {
  const cleaned = (text || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '')
  return cleaned.slice(0, 40) || fallback
}

/** 按章节蓝图顺序收集「已定稿」的章节正文 */
async function collectChapters(): Promise<CollectedChapter[]> {
  const blueprints = (await ipc.invoke('db:blueprint-get-all')) as unknown as Array<Record<string, unknown>>
  const sorted = [...(blueprints ?? [])].sort(
    (a, b) => (a.chapterNumber as number) - (b.chapterNumber as number),
  )

  const chapters: CollectedChapter[] = []
  for (const bp of sorted) {
    const chapterNumber = bp.chapterNumber as number
    const meta = await ipc.invoke('db:draft-get-finalized', chapterNumber)
    const draftId = (meta as { id?: number } | null)?.id
    if (draftId === undefined) continue

    const full = await ipc.invoke('db:draft-get-full', draftId)
    const content = (full as { content?: string } | null)?.content
    if (!content) continue

    chapters.push({
      chapterNumber,
      title: String(bp.title ?? '').trim() || `第 ${chapterNumber} 章`,
      content,
    })
  }
  return chapters
}

/** 去掉常见 Markdown 标记，得到可读纯文本 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/\*(.*?)\*/g, '$1')
    .replace(/`(.*?)`/g, '$1')
    .replace(/---+/g, '\n')
    .trim()
}

/** 正文首行是否已经带了这一章的标题（带了就不再补标题行） */
function firstLineHasTitle(text: string, title: string): boolean {
  const firstLine = text.split('\n').map(line => line.replace(/^#+\s*/, '').trim()).find(Boolean) ?? ''
  const wanted = title.trim()
  return wanted.length > 0 && firstLine.includes(wanted)
}

/** 正文没自带章节标题时补一个，保证各格式每章都有标题 */
function withChapterHeading(content: string, title: string): string {
  return firstLineHasTitle(content, title) ? content : `# ${title}\n\n${content}`
}

/** 备份包内各文件的用途说明 */
const BACKUP_FILE_NOTES: Record<string, string> = {
  'project.json': '小说配置（书名、类型、字数设定等）',
  'project-core.json': '故事架构（前提 / 角色图谱 / 世界观 / 情节大纲）',
  'blueprints.json': '章节蓝图',
  'characters.json': '角色卡与状态',
}

/** 备份包里的说明文件 —— 只列包里真实存在的文件，没有的（比如还没生成角色卡）不写 */
function buildBackupReadme(projectName: string, format: ExportFormat, entries: Array<{ path: string }>): string {
  const chapterCount = entries.filter(entry => entry.path.startsWith('chapters/')).length
  const listing = entries
    .filter(entry => !entry.path.startsWith('chapters/'))
    .map(entry => {
      const note = BACKUP_FILE_NOTES[entry.path]
      return note ? `- \`${entry.path}\` — ${note}` : `- \`${entry.path}\``
    })
  if (chapterCount > 0) listing.push(`- \`chapters/\` — 各章定稿正文（Markdown），共 ${chapterCount} 章`)

  return [
    `# ${projectName} · 项目备份`,
    '',
    `导出时间：${new Date().toLocaleString()}`,
    `导出格式：${formatLabel(format)}`,
    `已定稿章节：${chapterCount} 章`,
    '',
    '包内文件：',
    ...listing,
    '',
    '这些是纯文本资料，不包含数据库与向量库；换机器后用同一份配置重建项目即可继续写。',
  ].join('\n')
}

/** 整理备份包条目 */
async function buildBackupEntries(
  projectName: string,
  format: ExportFormat,
  chapters: CollectedChapter[],
): Promise<Array<{ path: string; content: string }>> {
  const project = useProjectStore.getState().currentProject
  const entries: Array<{ path: string; content: string }> = [
    {
      path: 'project.json',
      content: JSON.stringify({
        name: projectName,
        novelConfig: project?.novelConfig ?? null,
        characterStates: project?.characterStates ?? '',
        exportedAt: new Date().toISOString(),
      }, null, 2),
    },
  ]

  try {
    const core = await ipc.invoke('db:project-core-get')
    if (core) entries.push({ path: 'project-core.json', content: JSON.stringify(core, null, 2) })
  } catch { /* 架构还没生成时跳过 */ }

  try {
    const blueprints = await ipc.invoke('db:blueprint-get-all')
    if (blueprints?.length) entries.push({ path: 'blueprints.json', content: JSON.stringify(blueprints, null, 2) })
  } catch { /* 没有蓝图时跳过 */ }

  try {
    const characters = await ipc.invoke('db:character-get-all')
    if (characters?.length) entries.push({ path: 'characters.json', content: JSON.stringify(characters, null, 2) })
  } catch { /* 没有角色卡时跳过 */ }

  for (const chapter of chapters) {
    const prefix = String(chapter.chapterNumber).padStart(3, '0')
    entries.push({
      path: `chapters/${prefix}-${safeName(chapter.title, `chapter-${chapter.chapterNumber}`)}.md`,
      content: chapter.content,
    })
  }

  // 说明文件放最前，且按实际收集到的条目生成清单
  entries.unshift({ path: 'README.md', content: buildBackupReadme(projectName, format, entries) })
  return entries
}

/** 导出全书 */
export async function exportNovel(options: ExportOptions): Promise<ExportResult> {
  const project = useProjectStore.getState().currentProject
  if (!project) return { success: false, error: t('export.noProjectError') }

  const addLog = useWorkflowStore.getState().addLog
  addLog('info', t('export.started', { format: formatLabel(options.format) }))

  try {
    const chapters = await collectChapters()
    if (chapters.length === 0) {
      return { success: false, error: t('export.noFinalizedChapters') }
    }
    addLog('info', t('export.foundChapters', { count: chapters.length }))

    // 输出目录可能还不存在
    await ipc.invoke('fs:mkdir', options.outputDir)

    let outputPath = ''

    switch (options.format) {
      case 'epub': {
        const result = await ipc.invoke('novel:export-epub', {
          outputDir: options.outputDir,
          fileName: project.name,
          title: project.name,
          author: options.author?.trim() || undefined,
          language: 'zh',
          description: [project.novelConfig.genre, project.novelConfig.subGenre].filter(Boolean).join(' · ') || undefined,
          chapters: chapters.map(chapter => ({ title: chapter.title, content: chapter.content })),
        })
        if (!result.success) return { success: false, error: result.error ?? '' }
        outputPath = result.path ?? ''
        break
      }

      case 'merged-md': {
        // 合并为单个 Markdown
        let content = `# ${project.name}\n\n`
        const meta = [project.novelConfig.genre, project.novelConfig.targetAudience].filter(Boolean).join(' · ')
        if (meta) content += `> ${meta}\n\n`
        content += `---\n\n`

        if (options.includeOutline) {
          const core = await ipc.invoke('db:project-core-get')
          if (core?.synopsis) {
            content += core.synopsis + '\n\n---\n\n'
          }
        }

        for (const chapter of chapters) {
          content += withChapterHeading(chapter.content, chapter.title) + '\n\n---\n\n'
        }

        outputPath = `${options.outputDir}/${project.name}.md`
        await ipc.invoke('fs:write-file', outputPath, content)
        break
      }

      case 'split-md': {
        // 每章一个 Markdown
        const splitDir = `${options.outputDir}/${project.name}`
        await ipc.invoke('fs:mkdir', splitDir)

        for (const chapter of chapters) {
          const prefix = String(chapter.chapterNumber).padStart(3, '0')
          const name = `${prefix}-${safeName(chapter.title, `chapter-${chapter.chapterNumber}`)}.md`
          await ipc.invoke('fs:write-file', `${splitDir}/${name}`, withChapterHeading(chapter.content, chapter.title))
        }

        outputPath = splitDir
        break
      }

      case 'txt': {
        // 纯文本（带章标题，去掉 Markdown 标记）
        let content = `${project.name}\n${'='.repeat(Math.max(project.name.length * 2, 4))}\n\n`

        for (const chapter of chapters) {
          const plain = stripMarkdown(withChapterHeading(chapter.content, chapter.title))
          content += (firstLineHasTitle(plain, chapter.title) ? '' : `${chapter.title}\n\n`) + plain + '\n\n'
        }

        outputPath = `${options.outputDir}/${project.name}.txt`
        await ipc.invoke('fs:write-file', outputPath, content)
        break
      }
    }

    // 可选：项目备份包（与上面的格式无关，两种都能要）
    let backupPath: string | undefined
    if (options.backup) {
      const entries = await buildBackupEntries(project.name, options.format, chapters)
      const result = await ipc.invoke('novel:write-zip', {
        outputDir: options.outputDir,
        fileName: `${project.name}-backup`,
        entries,
      })
      if (result.success) {
        backupPath = result.path
        addLog('info', t('export.backupDone', { path: backupPath }))
      } else {
        addLog('warn', t('export.backupFailed', { error: result.error ?? '' }))
      }
    }

    addLog('info', t('export.exportComplete', { path: outputPath }))
    return { success: true, path: outputPath, backupPath }
  } catch (error) {
    addLog('error', t('export.exportFailed', { error: String(error) }))
    return { success: false, error: String(error) }
  }
}

function formatLabel(format: ExportFormat): string {
  const labels: Record<ExportFormat, string> = {
    'epub': t('export.formatEpub'),
    'merged-md': t('export.formatMergedMd'),
    'split-md': t('export.formatSplitMd'),
    'txt': t('export.formatTxt'),
  }
  return labels[format]
}

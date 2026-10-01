/**
 * Skill 分发包解析（纯函数，不碰磁盘也不发网络请求）
 *
 * 「Skill 包」= 一个 zip 或一个 GitHub 仓库，里面至少有一个 SKILL.md。
 * 这里负责：
 * - 解析 GitHub 地址 → owner / repo / ref / 子目录
 * - 从包内条目里找出所有可安装的 Skill（SKILL.md 所在目录）
 * - 收集某个 Skill 目录下的全部文件（脚本、参考资料一并带上）
 * - 规范化 SKILL.md 的 frontmatter name，保证「目录名 == Skill 名」
 * - 生成来源标记文件（记录版本、来源地址、导入时间）
 */

import type { ReadZipEntry } from './zip-reader'

/** 安装 Skill 的文件名约定 */
export const SKILL_ENTRY_FILE = 'SKILL.md'

/** 记录「这个 Skill 是从哪来的」的标记文件 */
export const SKILL_SOURCE_FILE = '.vela-source.json'

/** 打包时忽略的目录 / 文件（版本库元数据、系统缓存、依赖目录） */
const IGNORED_SEGMENTS = new Set(['.git', '__MACOSX', 'node_modules', '.DS_Store'])

export type PackageFile = ReadZipEntry

export interface SkillPackageCandidate {
  /** 包内目录；根目录为空串 */
  dir: string
  /** SKILL.md 在包内的路径 */
  indexPath: string
  /** 默认安装名（取目录名，退回 frontmatter，再退回 skill） */
  name: string
  displayName?: string
  description?: string
  version?: string
  /** 该目录下的文件数（含 SKILL.md） */
  fileCount: number
  /** SKILL.md 正文（已去掉 frontmatter），供界面预览 */
  body: string
}

export interface SkillSourceInfo {
  kind: 'zip' | 'github'
  /** 界面展示用的来源标签 */
  label: string
  url?: string
  ref?: string
  subdir?: string
  filePath?: string
}

/** Skill 名安全化（安装目录名必须符合这个名字规则） */
export function sanitizeSkillName(raw: string): string {
  const cleaned = (raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-{2,}/g, '-')
    .replace(/[-.]+$/, '')
  return cleaned.slice(0, 64) || 'skill'
}

/** 包内路径是否要忽略 */
export function isIgnoredPath(entryPath: string): boolean {
  return entryPath.split('/').some(segment => IGNORED_SEGMENTS.has(segment))
}

/** 解析 SKILL.md 的 frontmatter（只取顶层 key: value，够用即可） */
export function parseSkillFrontmatter(raw: string): { frontmatter: Record<string, string>; body: string } {
  const match = raw.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (!match) return { frontmatter: {}, body: raw.trim() }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (!kv) continue
    frontmatter[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, '')
  }
  return { frontmatter, body: raw.slice(match[0].length).trim() }
}

/**
 * 解析 GitHub 地址
 *
 * 支持 https://github.com/owner/repo、/tree/<ref>/<subdir>、/blob/<ref>/... 以及 owner/repo 简写。
 */
export function parseGithubUrl(input: string): { owner: string; repo: string; ref?: string; subdir?: string } | null {
  const trimmed = (input || '').trim()
  if (!trimmed) return null

  const shorthand = trimmed.match(/^([\w.-]+)\/([\w.-]+)$/)
  if (shorthand) return { owner: shorthand[1], repo: shorthand[2].replace(/\.git$/, '') }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2) return null

  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/, '')
  const marker = segments[2]
  if (marker !== 'tree' && marker !== 'blob') return { owner, repo }

  const rest = segments.slice(3)
  const ref = rest.shift()
  const subdir = rest.length > 0 ? rest.join('/') : undefined
  return { owner, repo, ref, subdir }
}

/** GitHub 仓库压缩包下载地址（按顺序试：分支 → 标签 → 裸 ref） */
export function githubZipUrls(parsed: { owner: string; repo: string; ref?: string }): string[] {
  const base = `https://codeload.github.com/${parsed.owner}/${parsed.repo}/zip`
  if (!parsed.ref) return [`${base}/HEAD`]
  return [`${base}/refs/heads/${parsed.ref}`, `${base}/refs/tags/${parsed.ref}`, `${base}/${parsed.ref}`]
}

/** 收集某个 Skill 目录（含子目录）下的全部文件；dir 为空串表示包根目录 */
export function packageFilesFor(files: PackageFile[], dir: string): Array<{ relPath: string; data: Buffer }> {
  const prefix = dir ? `${dir}/` : ''
  const result: Array<{ relPath: string; data: Buffer }> = []
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue
    const relPath = prefix ? file.path.slice(prefix.length) : file.path
    if (!relPath || isIgnoredPath(relPath)) continue
    result.push({ relPath, data: file.data })
  }
  return result
}

/**
 * 找出包里所有可安装的 Skill
 *
 * 每个 SKILL.md 所在目录算一个候选；浅层的排在前面（GitHub 仓库常见根目录一个、
 * examples/ 里一堆的情况，默认选中根目录那个）。
 */
export function findSkillCandidates(files: PackageFile[]): SkillPackageCandidate[] {
  const entryByDir = new Map<string, PackageFile>()
  for (const file of files) {
    const segments = file.path.split('/')
    if (segments[segments.length - 1] !== SKILL_ENTRY_FILE) continue
    if (isIgnoredPath(file.path)) continue
    const dir = segments.slice(0, -1).join('/')
    if (!entryByDir.has(dir)) entryByDir.set(dir, file)
  }

  const candidates: SkillPackageCandidate[] = []
  for (const [dir, entry] of entryByDir) {
    const { frontmatter, body } = parseSkillFrontmatter(entry.data.toString('utf-8'))
    const folder = dir ? dir.split('/').filter(Boolean).pop() ?? '' : ''
    candidates.push({
      dir,
      indexPath: entry.path,
      name: sanitizeSkillName(folder || frontmatter['name'] || 'skill'),
      displayName: frontmatter['display_name'],
      description: frontmatter['description'],
      version: frontmatter['version'],
      fileCount: packageFilesFor(files, dir).length,
      body,
    })
  }

  return candidates.sort((a, b) => {
    const depth = a.dir.split('/').length - b.dir.split('/').length
    return depth !== 0 ? depth : a.dir.localeCompare(b.dir)
  })
}

/**
 * 把 SKILL.md 的 frontmatter name 改成安装名
 *
 * 注册中心以 frontmatter 的 name 作为 Skill 身份，而读写删除都按目录名走，
 * 两者不一致会让「编辑 / 删除」找不到文件，所以安装时统一一次。
 */
export function withSkillName(content: string, name: string): string {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n/)
  if (!match) return `---\nname: ${name}\n---\n\n${content.replace(/^\n+/, '')}`

  const lines = match[1].split('\n')
  const index = lines.findIndex(line => /^\s*name\s*:/.test(line))
  if (index >= 0) lines[index] = `name: ${name}`
  else lines.unshift(`name: ${name}`)

  const body = content.slice(match[0].length).replace(/^\n+/, '')
  return `---\n${lines.join('\n')}\n---\n\n${body}`
}

/** 生成来源标记文件内容 */
export function buildSourceFile(
  source: SkillSourceInfo,
  candidate: SkillPackageCandidate,
  installedName: string,
): string {
  return JSON.stringify({
    name: installedName,
    kind: source.kind,
    label: source.label,
    url: source.url ?? null,
    ref: source.ref ?? null,
    subdir: source.subdir ?? null,
    packageDir: candidate.dir || null,
    version: candidate.version ?? null,
    importedAt: new Date().toISOString(),
  }, null, 2)
}

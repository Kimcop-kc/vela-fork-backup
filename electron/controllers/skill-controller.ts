import { ipcMain, dialog, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { VELA_HOME, RECENT_PROJECTS_PATH } from '../utils/config-utils'
import { readZip, stripArchiveRoot } from '../utils/zip-reader'
import {
  SKILL_SOURCE_FILE,
  buildSourceFile,
  findSkillCandidates,
  githubZipUrls,
  packageFilesFor,
  parseGithubUrl,
  withSkillName,
  type PackageFile,
  type SkillPackageCandidate,
  type SkillSourceInfo,
} from '../utils/skill-package'

/**
 * Skill 管理控制器 — 让用户在应用内创建 / 替换 / 启用 / 停用 Skill
 *
 * Skill 存放位置（均为 <name>/SKILL.md 结构）：
 * - 用户级：~/.vela/skills/        对所有项目生效
 * - 项目级：<项目>/.vela/skills/   仅当前项目生效，同名时覆盖用户级与内置
 *
 * 启用状态记录在 ~/.vela/skills-state.json：
 * { "disabled": ["skill-a", "skill-b"] }
 *
 * 另外管理「Skill 流水线」：多条 Skill 串成一条链，一次跑完，每步之间可人工确认。
 * 流水线只存纯数据（JSON），不含可执行代码：
 * - 用户级：~/.vela/pipelines/<name>.json
 * - 项目级：<项目>/.vela/pipelines/<name>.json
 */

type SkillScope = 'user' | 'project'

/** 启用状态文件 */
const SKILL_STATE_PATH = path.join(VELA_HOME, 'skills-state.json')

/**
 * 待安装的 Skill 包
 *
 * 「检查」时把解包结果留在内存里，「安装」时直接取用，避免 GitHub 包被下载两次。
 * 条目带 TTL，没人安装就自然过期，不会长期占内存。
 */
const pendingPackages = new Map<string, { files: PackageFile[]; source: SkillSourceInfo; createdAt: number }>()
const PENDING_TTL_MS = 10 * 60 * 1000

/** 清掉过期的待安装包 */
function prunePendingPackages(): void {
  const now = Date.now()
  for (const [token, value] of pendingPackages) {
    if (now - value.createdAt > PENDING_TTL_MS) pendingPackages.delete(token)
  }
}

/** 取待安装包（顺带清理过期项） */
function takePendingPackage(token: string): { files: PackageFile[]; source: SkillSourceInfo } | null {
  prunePendingPackages()
  return pendingPackages.get(token) ?? null
}

/** 下载 GitHub 仓库压缩包（依次尝试分支 / 标签 / 裸 ref） */
async function downloadGithubZip(parsed: { owner: string; repo: string; ref?: string }): Promise<Buffer> {
  let lastError = ''
  for (const url of githubZipUrls(parsed)) {
    try {
      // 加超时：网络异常时不能让对话框一直停在「检查中」
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30000) })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = String(error)
    }
  }
  throw new Error(`下载仓库压缩包失败：${lastError}`)
}

/** Skill 名合法性校验（挡住路径穿越） */
function isValidSkillName(name: string): boolean {
  if (typeof name !== 'string') return false
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)
}

/** 取当前项目路径（以最近打开的项目为准，与知识库控制器一致） */
function getCurrentProjectPath(): string | null {
  try {
    const recent = JSON.parse(fs.readFileSync(RECENT_PROJECTS_PATH, 'utf-8')) as Array<{ path: string }>
    return recent[0]?.path ?? null
  } catch {
    return null
  }
}

/** 解析某个范围内 Skill 的存放目录；项目未打开时项目级返回 null */
function getSkillsDir(scope: SkillScope): string | null {
  if (scope === 'user') return path.join(VELA_HOME, 'skills')
  const projectPath = getCurrentProjectPath()
  return projectPath ? path.join(projectPath, '.vela', 'skills') : null
}

/** 解析某个范围内流水线的存放目录；项目未打开时项目级返回 null */
function getPipelinesDir(scope: SkillScope): string | null {
  if (scope === 'user') return path.join(VELA_HOME, 'pipelines')
  const projectPath = getCurrentProjectPath()
  return projectPath ? path.join(projectPath, '.vela', 'pipelines') : null
}

/** 从流水线 JSON 里取列表用的摘要；解析失败返回 null */
function summarizePipeline(content: string): { title: string; stepCount: number } | null {
  try {
    const raw = JSON.parse(content) as { title?: unknown; steps?: unknown }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.steps)) return null
    return {
      title: typeof raw.title === 'string' ? raw.title : '',
      stepCount: raw.steps.length,
    }
  } catch {
    return null
  }
}

/** 读取启用状态 */
function readSkillState(): { disabled: string[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(SKILL_STATE_PATH, 'utf-8')) as { disabled?: unknown }
    const disabled = Array.isArray(raw.disabled)
      ? raw.disabled.filter((n): n is string => typeof n === 'string' && isValidSkillName(n))
      : []
    return { disabled }
  } catch {
    return { disabled: [] }
  }
}

/** 写入启用状态 */
function writeSkillState(state: { disabled: string[] }): void {
  fs.mkdirSync(VELA_HOME, { recursive: true })
  fs.writeFileSync(SKILL_STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
}

/** 扫描目录下的 <name>/SKILL.md */
function listSkillFiles(dir: string, scope: SkillScope): Array<{ name: string; scope: SkillScope; filePath: string; size: number }> {
  const result: Array<{ name: string; scope: SkillScope; filePath: string; size: number }> = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const filePath = path.join(dir, entry.name, 'SKILL.md')
    try {
      const stat = fs.statSync(filePath)
      if (!stat.isFile()) continue
      result.push({ name: entry.name, scope, filePath, size: stat.size })
    } catch {
      // 没有 SKILL.md 的目录跳过
    }
  }
  return result
}

export function registerSkillController() {
  /** 查询 Skill 目录 */
  ipcMain.handle('skill:get-paths', async () => ({
    velaHome: VELA_HOME,
    userDir: path.join(VELA_HOME, 'skills'),
    projectDir: getSkillsDir('project'),
  }))

  /** 列出两个范围内已有的 Skill 文件 */
  ipcMain.handle('skill:list-files', async () => {
    const files = listSkillFiles(path.join(VELA_HOME, 'skills'), 'user')
    const projectDir = getSkillsDir('project')
    if (projectDir) files.push(...listSkillFiles(projectDir, 'project'))
    return files
  })

  /** 读取 SKILL.md 原文 */
  ipcMain.handle('skill:read-file', async (_event, name: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, content: '', filePath: '', error: '非法的 Skill 名' }
    const dir = getSkillsDir(scope)
    if (!dir) return { success: false, content: '', filePath: '', error: '未打开项目' }
    const filePath = path.join(dir, name, 'SKILL.md')
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return { success: true, content, filePath }
    } catch (error) {
      return { success: false, content: '', filePath, error: String(error) }
    }
  })

  /** 写入 / 覆盖 SKILL.md（应用内创建或替换 Skill） */
  ipcMain.handle('skill:write-file', async (_event, name: string, content: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, error: '非法的 Skill 名（仅限字母、数字、点、下划线、短横线）' }
    if (typeof content !== 'string' || !content.trim()) return { success: false, error: 'Skill 内容不能为空' }
    const dir = getSkillsDir(scope)
    if (!dir) return { success: false, error: '未打开项目' }
    const skillDir = path.join(dir, name)
    const filePath = path.join(skillDir, 'SKILL.md')
    try {
      fs.mkdirSync(skillDir, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true, filePath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 删除项目级 / 用户级 Skill */
  ipcMain.handle('skill:delete-file', async (_event, name: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, error: '非法的 Skill 名' }
    const dir = getSkillsDir(scope)
    if (!dir) return { success: false, error: '未打开项目' }
    const skillDir = path.join(dir, name)
    // 双保险：解析后的绝对路径必须仍在 Skill 目录内
    if (path.dirname(path.resolve(skillDir)) !== path.resolve(dir)) {
      return { success: false, error: '非法的 Skill 路径' }
    }
    try {
      fs.rmSync(skillDir, { recursive: true, force: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 跨范围复制（例如：用户级 Skill 复制一份到项目级） */
  ipcMain.handle('skill:copy-file', async (_event, name: string, from: SkillScope, to: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, error: '非法的 Skill 名' }
    const fromDir = getSkillsDir(from)
    const toDir = getSkillsDir(to)
    if (!fromDir || !toDir) return { success: false, error: '未打开项目' }
    const sourcePath = path.join(fromDir, name, 'SKILL.md')
    const targetDir = path.join(toDir, name)
    const targetPath = path.join(targetDir, 'SKILL.md')
    try {
      const content = fs.readFileSync(sourcePath, 'utf-8')
      fs.mkdirSync(targetDir, { recursive: true })
      fs.writeFileSync(targetPath, content, 'utf-8')
      return { success: true, filePath: targetPath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 读取停用列表 */
  ipcMain.handle('skill:get-disabled', async () => readSkillState())

  /** 写入停用列表 */
  ipcMain.handle('skill:set-disabled', async (_event, names: string[]) => {
    const disabled = Array.isArray(names)
      ? names.filter((n): n is string => typeof n === 'string' && isValidSkillName(n))
      : []
    try {
      writeSkillState({ disabled })
      return { success: true }
    } catch {
      return { success: false }
    }
  })

  /** 从磁盘导入一个 SKILL.md 作为替换内容 */
  ipcMain.handle('skill:import-file', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择要导入的 SKILL.md',
      properties: ['openFile'],
      filters: [{ name: 'Skill 文件', extensions: ['md', 'markdown', 'txt'] }],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const filePath = result.filePaths[0]
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      return { name: path.basename(path.dirname(filePath)) || path.basename(filePath, path.extname(filePath)), content }
    } catch {
      return null
    }
  })

  /** 在系统文件管理器中打开 Skill 目录 */
  ipcMain.handle('skill:open-dir', async (_event, scope: SkillScope) => {
    const dir = getSkillsDir(scope)
    if (!dir) return { success: false, error: '未打开项目' }
    try {
      fs.mkdirSync(dir, { recursive: true })
      await shell.openPath(dir)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ===== Skill 分发：从 zip / GitHub 导入整包（含脚本与参考资料） =====

  /**
   * 检查 Skill 包：zip 走文件选择框，GitHub 直接下载解包，
   * 返回包内可安装的候选 Skill 列表（含版本、描述、文件数与正文预览）。
   */
  ipcMain.handle('skill:inspect-package', async (_event, options: {
    kind: 'zip' | 'github'
    filePath?: string
    url?: string
  }) => {
    try {
      let files: PackageFile[]
      let source: SkillSourceInfo

      if (options.kind === 'zip') {
        let zipPath = options.filePath
        if (!zipPath) {
          const picked = await dialog.showOpenDialog({
            title: '选择 Skill 压缩包',
            properties: ['openFile'],
            filters: [{ name: 'Skill 压缩包', extensions: ['zip'] }],
          })
          if (picked.canceled || picked.filePaths.length === 0) return { success: false, cancelled: true }
          zipPath = picked.filePaths[0]
        }
        if (!fs.existsSync(zipPath)) return { success: false, error: '压缩包不存在' }
        // 用户自己打的包不强拆顶层目录：可能是 <skill>/SKILL.md，也可能直接是 SKILL.md
        files = readZip(fs.readFileSync(zipPath))
        source = { kind: 'zip', label: path.basename(zipPath), filePath: zipPath }
      } else {
        const parsed = parseGithubUrl(options.url ?? '')
        if (!parsed) return { success: false, error: '无法识别的 GitHub 地址' }

        const buffer = await downloadGithubZip(parsed)
        // zipball 的顶层固定是 <repo>-<ref>/，统一去掉，包内路径才好识别
        files = stripArchiveRoot(readZip(buffer))

        if (parsed.subdir) {
          const prefix = `${parsed.subdir}/`
          if (!files.some(file => file.path.startsWith(prefix))) {
            return { success: false, error: `仓库里没有找到目录 ${parsed.subdir}` }
          }
          files = files
            .filter(file => file.path.startsWith(prefix))
            .map(file => ({ ...file, path: file.path.slice(prefix.length) }))
        }

        source = {
          kind: 'github',
          label: `${parsed.owner}/${parsed.repo}`,
          url: `https://github.com/${parsed.owner}/${parsed.repo}`,
          ref: parsed.ref,
          subdir: parsed.subdir,
        }
      }

      const candidates = findSkillCandidates(files)
      if (candidates.length === 0) return { success: false, error: '包里没有找到 SKILL.md' }

      prunePendingPackages()
      const token = randomUUID()
      pendingPackages.set(token, { files, source, createdAt: Date.now() })
      return { success: true, token, source, candidates }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 安装检查过的 Skill 包：把候选目录整份写入目标范围，并落一个来源标记 */
  ipcMain.handle('skill:install-package', async (_event, options: {
    token: string
    dir: string
    scope: SkillScope
    name?: string
    overwrite?: boolean
  }) => {
    const pending = takePendingPackage(options.token)
    if (!pending) return { success: false, error: '安装会话已过期，请重新检查压缩包' }

    const candidate: SkillPackageCandidate | undefined =
      findSkillCandidates(pending.files).find(item => item.dir === options.dir)
    if (!candidate) return { success: false, error: '包里找不到这个 Skill' }

    const skillsDir = getSkillsDir(options.scope)
    if (!skillsDir) return { success: false, error: '未打开项目' }

    const name = (options.name?.trim() || candidate.name)
    if (!isValidSkillName(name)) {
      return { success: false, error: '非法的 Skill 名（仅限字母、数字、点、下划线、短横线）' }
    }

    const targetDir = path.join(skillsDir, name)
    if (path.dirname(path.resolve(targetDir)) !== path.resolve(skillsDir)) {
      return { success: false, error: '非法的 Skill 路径' }
    }
    if (fs.existsSync(targetDir) && !options.overwrite) {
      return { success: false, code: 'exists', error: `已存在同名 Skill：${name}` }
    }

    const files = packageFilesFor(pending.files, candidate.dir)
      .filter(file => file.relPath !== SKILL_SOURCE_FILE)
    if (files.length === 0) return { success: false, error: '包里没有可安装的文件' }

    try {
      // 覆盖安装先清空旧目录，避免上一版留下的文件混在里面
      fs.rmSync(targetDir, { recursive: true, force: true })
      for (const file of files) {
        const filePath = path.join(targetDir, file.relPath)
        if (path.dirname(path.resolve(filePath)) !== path.resolve(targetDir)
          && !path.resolve(filePath).startsWith(`${path.resolve(targetDir)}${path.sep}`)) {
          return { success: false, error: `包内路径非法：${file.relPath}` }
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true })
        // SKILL.md 统一一次 frontmatter name，保证「目录名 == Skill 名」
        const data = file.relPath === 'SKILL.md'
          ? Buffer.from(withSkillName(file.data.toString('utf-8'), name), 'utf-8')
          : file.data
        fs.writeFileSync(filePath, data)
      }
      fs.writeFileSync(
        path.join(targetDir, SKILL_SOURCE_FILE),
        buildSourceFile(pending.source, candidate, name),
        'utf-8',
      )
      pendingPackages.delete(options.token)
      return {
        success: true,
        name,
        dir: targetDir,
        fileCount: files.length,
        version: candidate.version ?? '',
      }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  // ===== Skill 流水线（纯数据，不含可执行代码） =====

  /** 列出两个范围内已有的流水线 */
  ipcMain.handle('skill:list-pipelines', async () => {
    const result: Array<{ name: string; scope: SkillScope; filePath: string; title: string; stepCount: number }> = []
    const collect = (dir: string, scope: SkillScope) => {
      let entries: fs.Dirent[]
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue
        const filePath = path.join(dir, entry.name)
        try {
          const summary = summarizePipeline(fs.readFileSync(filePath, 'utf-8'))
          if (!summary) continue
          result.push({
            name: entry.name.replace(/\.json$/, ''),
            scope,
            filePath,
            title: summary.title,
            stepCount: summary.stepCount,
          })
        } catch {
          // 读不了的单个文件跳过
        }
      }
    }
    collect(path.join(VELA_HOME, 'pipelines'), 'user')
    const projectDir = getPipelinesDir('project')
    if (projectDir) collect(projectDir, 'project')
    return result
  })

  /** 读取流水线 JSON 原文 */
  ipcMain.handle('skill:read-pipeline', async (_event, name: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, content: '', filePath: '', error: '非法的流水线名' }
    const dir = getPipelinesDir(scope)
    if (!dir) return { success: false, content: '', filePath: '', error: '未打开项目' }
    const filePath = path.join(dir, `${name}.json`)
    try {
      return { success: true, content: fs.readFileSync(filePath, 'utf-8'), filePath }
    } catch (error) {
      return { success: false, content: '', filePath, error: String(error) }
    }
  })

  /** 写入 / 覆盖流水线 JSON */
  ipcMain.handle('skill:write-pipeline', async (_event, name: string, content: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, error: '非法的流水线名（仅限字母、数字、点、下划线、短横线）' }
    if (typeof content !== 'string' || !content.trim()) return { success: false, error: '流水线内容不能为空' }
    if (!summarizePipeline(content)) return { success: false, error: '流水线必须是含 steps 数组的 JSON' }
    const dir = getPipelinesDir(scope)
    if (!dir) return { success: false, error: '未打开项目' }
    const filePath = path.join(dir, `${name}.json`)
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(filePath, content, 'utf-8')
      return { success: true, filePath }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })

  /** 删除项目级 / 用户级流水线 */
  ipcMain.handle('skill:delete-pipeline', async (_event, name: string, scope: SkillScope) => {
    if (!isValidSkillName(name)) return { success: false, error: '非法的流水线名' }
    const dir = getPipelinesDir(scope)
    if (!dir) return { success: false, error: '未打开项目' }
    const filePath = path.join(dir, `${name}.json`)
    // 双保险：解析后的绝对路径必须仍在流水线目录内
    if (path.dirname(path.resolve(filePath)) !== path.resolve(dir)) {
      return { success: false, error: '非法的流水线路径' }
    }
    try {
      fs.rmSync(filePath, { force: true })
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  })
}

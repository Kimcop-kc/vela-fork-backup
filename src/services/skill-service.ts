/**
 * skill-service — Skill 数据访问服务
 *
 * 封装 Skill 的读写 IPC，供 Skill 管理界面调用。
 * Skill 以 <name>/SKILL.md 形式存放：
 * - 用户级 ~/.vela/skills/（对所有项目生效）
 * - 项目级 <项目>/.vela/skills/（仅当前项目，优先级最高）
 */

import { ipc } from './ipc-client'
import type { SkillPackageCandidate, SkillPackageSource } from '../shared/ipc-channels'

/** Skill 存放范围 */
export type SkillScope = 'user' | 'project'

/** 磁盘上的 Skill 文件 */
export interface SkillFileInfo {
  name: string
  scope: SkillScope
  filePath: string
  size: number
}

/** Skill 目录信息 */
export interface SkillPaths {
  velaHome: string
  userDir: string
  projectDir: string | null
}

/** 查询 Skill 目录 */
export async function getSkillPaths(): Promise<SkillPaths> {
  return ipc.invoke('skill:get-paths')
}

/** 列出磁盘上已存在的 Skill 文件 */
export async function listSkillFiles(): Promise<SkillFileInfo[]> {
  return ipc.invoke('skill:list-files')
}

/** 读取 SKILL.md 原文 */
export async function readSkillFile(name: string, scope: SkillScope) {
  return ipc.invoke('skill:read-file', name, scope)
}

/** 写入（创建或覆盖）SKILL.md */
export async function writeSkillFile(name: string, content: string, scope: SkillScope) {
  return ipc.invoke('skill:write-file', name, content, scope)
}

/** 删除 SKILL.md 所在目录 */
export async function deleteSkillFile(name: string, scope: SkillScope) {
  return ipc.invoke('skill:delete-file', name, scope)
}

/** 跨范围复制 Skill */
export async function copySkillFile(name: string, from: SkillScope, to: SkillScope) {
  return ipc.invoke('skill:copy-file', name, from, to)
}

/** 读取停用列表 */
export async function getDisabledSkills(): Promise<string[]> {
  const result = await ipc.invoke('skill:get-disabled')
  return result.disabled
}

/** 写入停用列表 */
export async function setDisabledSkills(names: string[]): Promise<boolean> {
  const result = await ipc.invoke('skill:set-disabled', names)
  return result.success
}

/** 从磁盘导入 SKILL.md */
export async function importSkillFile(): Promise<{ name: string; content: string } | null> {
  return ipc.invoke('skill:import-file')
}

/** 检查 Skill 包（zip 或 GitHub 仓库），返回包内可安装的候选列表 */
export async function inspectSkillPackage(options: {
  kind: 'zip' | 'github'
  filePath?: string
  url?: string
}): Promise<{
  success: boolean
  cancelled?: boolean
  token?: string
  source?: SkillPackageSource
  candidates?: SkillPackageCandidate[]
  error?: string
}> {
  return ipc.invoke('skill:inspect-package', options)
}

/** 安装检查过的 Skill 包（整包落盘，并记录来源与版本） */
export async function installSkillPackage(options: {
  token: string
  dir: string
  scope: SkillScope
  name?: string
  overwrite?: boolean
}): Promise<{
  success: boolean
  name?: string
  dir?: string
  fileCount?: number
  version?: string
  code?: 'exists'
  error?: string
}> {
  return ipc.invoke('skill:install-package', options)
}

/** 在系统文件管理器中打开 Skill 目录 */
export async function openSkillDir(scope: SkillScope) {
  return ipc.invoke('skill:open-dir', scope)
}

/** 新建 Skill 的 SKILL.md 模板 */
export function buildSkillTemplate(name: string): string {
  return [
    '---',
    `name: ${name}`,
    'display_name: 我的 Skill',
    'description: 一句话说明这个 Skill 做什么',
    'when_to_use: 什么场景下使用',
    'version: 1.0.0',
    'user-invocable: true',
    '---',
    '',
    `# ${name}`,
    '',
    '在这里写这个 Skill 的方法步骤。可以引用 ${args} 作为调用时传入的参数。',
    '',
    '## 需要结构化参数时（可选）',
    '',
    '把下面这行复制到上面的 frontmatter 里，界面会按 schema 自动生成表单，',
    '方法正文里用 ${字段名} 取值；不声明时仍然是单个自由输入框。',
    '',
    '```',
    'inputs: [{"name":"topic","label":"主题","type":"text","required":true},{"name":"tone","label":"语气","type":"select","options":["克制","热烈"]}]',
    '```',
    '',
    'type 可选 text / textarea / number / boolean / select；值必须写成单行 JSON。',
    '',
  ].join('\n')
}

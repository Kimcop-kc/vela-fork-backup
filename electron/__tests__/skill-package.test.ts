import { describe, expect, it } from 'vitest'
import { createZip, type ZipEntry } from '../utils/zip-writer'
import { normalizeZipEntryPath, readZip, stripArchiveRoot } from '../utils/zip-reader'
import {
  buildSourceFile,
  findSkillCandidates,
  githubZipUrls,
  packageFilesFor,
  parseGithubUrl,
  parseSkillFrontmatter,
  sanitizeSkillName,
  withSkillName,
} from '../utils/skill-package'

const zipOf = (entries: ZipEntry[]) => createZip(entries, new Date('2026-01-01T00:00:00Z'))

const SKILL_MD = [
  '---',
  'name: demo-skill',
  'display_name: 演示 Skill',
  'description: 一句话说明',
  'version: 1.2.0',
  '---',
  '',
  '# 演示',
  '',
  '正文内容 ${args}',
].join('\n')

describe('zip 读取器', () => {
  it('能读回 store 与 deflate 两种条目', () => {
    const zip = zipOf([
      { path: 'mimetype', data: 'application/epub+zip', store: true },
      { path: 'demo/SKILL.md', data: SKILL_MD },
      { path: 'demo/scripts/run.py', data: 'print(1)\n' },
    ])
    const entries = readZip(zip)

    expect(entries.map(entry => entry.path)).toEqual(['mimetype', 'demo/SKILL.md', 'demo/scripts/run.py'])
    expect(entries[0].data.toString('utf-8')).toBe('application/epub+zip')
    expect(entries[1].data.toString('utf-8')).toBe(SKILL_MD)
    expect(entries[2].data.toString('utf-8')).toBe('print(1)\n')
  })

  it('归一化路径时挡掉穿越与绝对路径', () => {
    expect(normalizeZipEntryPath('demo/SKILL.md')).toBe('demo/SKILL.md')
    expect(normalizeZipEntryPath('./demo/SKILL.md')).toBe('demo/SKILL.md')
    expect(normalizeZipEntryPath('demo\\SKILL.md')).toBe('demo/SKILL.md')
    expect(normalizeZipEntryPath('demo/')).toBeNull()
    expect(normalizeZipEntryPath('../evil.md')).toBeNull()
    expect(normalizeZipEntryPath('demo/../../evil.md')).toBeNull()
    expect(normalizeZipEntryPath('/etc/passwd')).toBeNull()
    expect(normalizeZipEntryPath('C:/windows/system32')).toBeNull()
  })

  it('非 zip 内容直接报错', () => {
    expect(() => readZip(Buffer.from('这不是压缩包'))).toThrow()
  })

  it('所有条目共用一个顶层目录时去掉它', () => {
    const entries = readZip(zipOf([
      { path: 'repo-main/SKILL.md', data: SKILL_MD },
      { path: 'repo-main/a/b.txt', data: 'x' },
    ]))
    expect(stripArchiveRoot(entries).map(entry => entry.path)).toEqual(['SKILL.md', 'a/b.txt'])
    // 顶层不唯一时保持原样
    const mixed = readZip(zipOf([
      { path: 'a/one.txt', data: '1' },
      { path: 'b/two.txt', data: '2' },
    ]))
    expect(stripArchiveRoot(mixed).map(entry => entry.path)).toEqual(['a/one.txt', 'b/two.txt'])
  })
})

describe('GitHub 地址解析', () => {
  it('支持仓库根、tree 子目录与 owner/repo 简写', () => {
    expect(parseGithubUrl('https://github.com/owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
    expect(parseGithubUrl('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
    expect(parseGithubUrl('https://github.com/owner/repo/tree/dev/skills/writer')).toEqual({
      owner: 'owner', repo: 'repo', ref: 'dev', subdir: 'skills/writer',
    })
    expect(parseGithubUrl('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  })

  it('拒绝非 GitHub 地址', () => {
    expect(parseGithubUrl('')).toBeNull()
    expect(parseGithubUrl('https://gitlab.com/owner/repo')).toBeNull()
    expect(parseGithubUrl('https://github.com/only-owner')).toBeNull()
    expect(parseGithubUrl('随便写的字')).toBeNull()
  })

  it('下载地址按分支 → 标签 → 裸 ref 依次尝试', () => {
    expect(githubZipUrls({ owner: 'o', repo: 'r' })).toEqual(['https://codeload.github.com/o/r/zip/HEAD'])
    expect(githubZipUrls({ owner: 'o', repo: 'r', ref: 'dev' })).toEqual([
      'https://codeload.github.com/o/r/zip/refs/heads/dev',
      'https://codeload.github.com/o/r/zip/refs/tags/dev',
      'https://codeload.github.com/o/r/zip/dev',
    ])
  })
})

describe('包内 Skill 识别', () => {
  it('每个 SKILL.md 目录算一个候选，浅层的排在前面', () => {
    const entries = readZip(zipOf([
      { path: 'SKILL.md', data: SKILL_MD },
      { path: 'writer/SKILL.md', data: '---\nname: writer\nversion: 0.9.0\n---\n\n写作方法' },
      { path: 'examples/tone/SKILL.md', data: '---\nname: tone\n---\n\n语气示例' },
      { path: '__MACOSX/._SKILL.md', data: '垃圾文件' },
    ]))
    const candidates = findSkillCandidates(entries)

    expect(candidates.map(candidate => candidate.dir)).toEqual(['', 'writer', 'examples/tone'])
    expect(candidates[0].name).toBe('demo-skill')
    expect(candidates[0].version).toBe('1.2.0')
    expect(candidates[0].body.startsWith('# 演示')).toBe(true)
    expect(candidates[1].name).toBe('writer')
    expect(candidates[1].fileCount).toBe(1)
  })

  it('收集整个 Skill 目录，跳过 git / 依赖目录', () => {
    const entries = readZip(zipOf([
      { path: 'writer/SKILL.md', data: SKILL_MD },
      { path: 'writer/references/style.md', data: '参考' },
      { path: 'writer/.git/config', data: 'git 垃圾' },
      { path: 'writer/node_modules/x/index.js', data: '依赖' },
      { path: 'other/SKILL.md', data: '别的' },
    ]))
    const files = packageFilesFor(entries, 'writer')

    expect(files.map(file => file.relPath)).toEqual(['SKILL.md', 'references/style.md'])
  })

  it('frontmatter 解析容错，缺字段不报错', () => {
    expect(parseSkillFrontmatter(SKILL_MD).frontmatter['version']).toBe('1.2.0')
    expect(parseSkillFrontmatter(SKILL_MD).frontmatter['display_name']).toBe('演示 Skill')
    expect(parseSkillFrontmatter('# 没有 frontmatter').frontmatter).toEqual({})
    expect(parseSkillFrontmatter('# 没有 frontmatter').body).toBe('# 没有 frontmatter')
  })

  it('安装名安全化', () => {
    expect(sanitizeSkillName('My Skill!!')).toBe('my-skill')
    expect(sanitizeSkillName('已有名字')).toBe('skill')
    expect(sanitizeSkillName('  ')).toBe('skill')
    expect(sanitizeSkillName('a/b')).toBe('a-b')
  })
})

describe('SKILL.md 名称规范化', () => {
  it('替换已有的 name', () => {
    const result = withSkillName(SKILL_MD, 'installed-name')
    expect(result).toContain('name: installed-name')
    expect(result).not.toContain('name: demo-skill')
    expect(result).toContain('version: 1.2.0')
    expect(result.endsWith('正文内容 ${args}')).toBe(true)
  })

  it('frontmatter 里没有 name 时补一行', () => {
    const result = withSkillName('---\ndescription: x\n---\n\n正文', 'added')
    expect(result.startsWith('---\nname: added\ndescription: x\n---\n\n正文')).toBe(true)
  })

  it('完全没有 frontmatter 时新建一段', () => {
    expect(withSkillName('# 标题\n\n正文', 'plain')).toBe('---\nname: plain\n---\n\n# 标题\n\n正文')
  })
})

describe('来源标记文件', () => {
  it('记录来源类型、地址、版本与导入时间', () => {
    const file = JSON.parse(buildSourceFile(
      { kind: 'github', label: 'owner/repo', url: 'https://github.com/owner/repo', ref: 'main', subdir: 'skills/w' },
      { dir: 'skills/w', indexPath: 'skills/w/SKILL.md', name: 'w', version: '2.0.0', fileCount: 3, body: '' },
      'w',
    )) as Record<string, unknown>

    expect(file).toMatchObject({
      name: 'w',
      kind: 'github',
      label: 'owner/repo',
      url: 'https://github.com/owner/repo',
      ref: 'main',
      subdir: 'skills/w',
      packageDir: 'skills/w',
      version: '2.0.0',
    })
    expect(typeof file.importedAt).toBe('string')
  })
})

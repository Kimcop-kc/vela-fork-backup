/**
 * 导出相关测试 — ZIP 打包器与 EPUB 组包
 *
 * 导出是「写完小说最后一步」，出错代价高又不容易肉眼发现（EPUB 打不开、
 * 目录点不动），所以这里把包按字节解回来验证：
 * 条目顺序、压缩方式、CRC、以及 EPUB 必备文件是否齐全。
 */
import { describe, expect, it } from 'vitest'
import { inflateRawSync } from 'node:zlib'
import { createZip, crc32, type ZipEntry } from '../utils/zip-writer'
import { buildEpub, markdownToXhtml } from '../utils/epub-builder'

/** 只认本地文件头的最小解包器（够测试用：条目是连续写出来的） */
function readZip(buffer: Buffer): Map<string, { method: number; data: Buffer }> {
  const entries = new Map<string, { method: number; data: Buffer }>()
  let offset = 0
  while (offset + 4 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8)
    const crc = buffer.readUInt32LE(offset + 14)
    const compressedSize = buffer.readUInt32LE(offset + 18)
    const rawSize = buffer.readUInt32LE(offset + 22)
    const nameLength = buffer.readUInt16LE(offset + 26)
    const extraLength = buffer.readUInt16LE(offset + 28)
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString('utf-8')
    const start = offset + 30 + nameLength + extraLength
    const body = buffer.subarray(start, start + compressedSize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)

    expect(data.length).toBe(rawSize)
    expect(crc32(data)).toBe(crc)
    entries.set(name, { method, data })
    offset = start + compressedSize
  }
  return entries
}

const text = (buffer: Buffer | undefined) => buffer?.toString('utf-8') ?? ''

describe('zip-writer', () => {
  it('crc32 与标准测试向量一致', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })

  it('能原样解回存进去的内容（含中文路径）', () => {
    const zip = createZip([
      { path: 'a.txt', data: 'hello' },
      { path: '目录/第二章.md', data: '# 第二章\n正文内容' },
      { path: 'mimetype', data: 'application/epub+zip', store: true },
    ])
    const entries = readZip(zip)
    expect([...entries.keys()]).toEqual(['a.txt', '目录/第二章.md', 'mimetype'])
    expect(text(entries.get('a.txt')?.data)).toBe('hello')
    expect(text(entries.get('目录/第二章.md')?.data)).toBe('# 第二章\n正文内容')
    expect(entries.get('mimetype')?.method).toBe(0)
  })

  it('长内容走 deflate，store 的条目保留原文', () => {
    const long = '重复内容'.repeat(200)
    const entries = readZip(createZip([
      { path: 'long.txt', data: long },
      { path: 'stored.txt', data: long, store: true },
    ]))
    expect(entries.get('long.txt')?.method).toBe(8)
    expect(entries.get('stored.txt')?.method).toBe(0)
    expect(text(entries.get('long.txt')?.data)).toBe(long)
  })

  it('空条目也不会写坏包', () => {
    const zip = createZip([{ path: 'empty.txt', data: '' } satisfies ZipEntry])
    expect(text(readZip(zip).get('empty.txt')?.data)).toBe('')
  })
})

describe('markdownToXhtml', () => {
  it('转义 XML 特殊字符，避免阅读器解析失败', () => {
    expect(markdownToXhtml('林昭 & 师姐 <同行>')).toBe('<p>林昭 &amp; 师姐 &lt;同行&gt;</p>')
  })

  it('标题整体降一级，行内标记转成标签', () => {
    expect(markdownToXhtml('# 一\n\n## 二\n\n**粗** 与 *斜* 与 `码`')).toBe(
      '<h2>一</h2>\n<h3>二</h3>\n<p><strong>粗</strong> 与 <em>斜</em> 与 <code>码</code></p>',
    )
  })

  it('分隔线、引用与列表有对应块级标签', () => {
    expect(markdownToXhtml('---\n> 引文\n- 条目')).toBe(
      '<hr />\n<p class="quote">引文</p>\n<p class="list">· 条目</p>',
    )
  })
})

describe('buildEpub', () => {
  const options = {
    title: '试炼之始',
    author: '测试作者',
    chapters: [
      { title: '第1章 试炼之始', content: '# 第1章 试炼之始\n\n林昭站在山门之外。\n\n---\n\n他握紧了令牌。' },
      { title: '第2章 入山', content: '没有一级标题的正文。' },
    ],
    createdAt: new Date('2026-10-01T00:00:00Z'),
  }

  it('第一个条目必须是未压缩的 mimetype', () => {
    const entries = readZip(buildEpub(options))
    expect([...entries.keys()][0]).toBe('mimetype')
    expect(entries.get('mimetype')?.method).toBe(0)
    expect(text(entries.get('mimetype')?.data)).toBe('application/epub+zip')
  })

  it('必备文件齐全，container 指向 content.opf', () => {
    const entries = readZip(buildEpub(options))
    const required = [
      'META-INF/container.xml',
      'OEBPS/content.opf',
      'OEBPS/nav.xhtml',
      'OEBPS/toc.ncx',
      'OEBPS/style.css',
      'OEBPS/chapter-1.xhtml',
      'OEBPS/chapter-2.xhtml',
    ]
    for (const name of required) {
      expect(entries.has(name), name).toBe(true)
    }
    expect(text(entries.get('META-INF/container.xml')?.data)).toContain('full-path="OEBPS/content.opf"')
  })

  it('书里带标题、作者、目录与两章正文', () => {
    const entries = readZip(buildEpub(options))
    const opf = text(entries.get('OEBPS/content.opf')?.data)
    expect(opf).toContain('<dc:title>试炼之始</dc:title>')
    expect(opf).toContain('<dc:creator>测试作者</dc:creator>')
    expect(opf).toContain('href="chapter-1.xhtml"')
    expect(opf).toContain('idref="ch2"')

    const nav = text(entries.get('OEBPS/nav.xhtml')?.data)
    expect(nav).toContain('第1章 试炼之始</a>')
    expect(nav).toContain('第2章 入山</a>')
  })

  it('正文里的一级标题提到章名，不在正文里重复', () => {
    const entries = readZip(buildEpub(options))
    const chapter = text(entries.get('OEBPS/chapter-1.xhtml')?.data)
    expect(chapter).toContain('<h1>第1章 试炼之始</h1>')
    expect(chapter).not.toContain('<h2>第1章 试炼之始</h2>')
    expect(chapter).toContain('<p>林昭站在山门之外。</p>')
    expect(chapter).toContain('<p>他握紧了令牌。</p>')
  })

  it('没有一级标题的章节用蓝图标题兜底', () => {
    const entries = readZip(buildEpub(options))
    const chapter = text(entries.get('OEBPS/chapter-2.xhtml')?.data)
    expect(chapter).toContain('<h1>第2章 入山</h1>')
    expect(chapter).toContain('<p>没有一级标题的正文。</p>')
  })

  it('没有作者时不写 dc:creator，缺省语言是 zh', () => {
    const entries = readZip(buildEpub({ title: '无署名作品', chapters: options.chapters }))
    const opf = text(entries.get('OEBPS/content.opf')?.data)
    expect(opf).not.toContain('dc:creator')
    expect(opf).toContain('<dc:language>zh</dc:language>')
  })
})

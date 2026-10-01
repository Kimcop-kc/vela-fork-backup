/**
 * EPUB 3 打包（零依赖）
 *
 * 把已定稿的章节拼成一本标准 EPUB：
 *   mimetype（必须是第一个且不压缩）
 *   META-INF/container.xml
 *   OEBPS/content.opf / nav.xhtml / toc.ncx / style.css / chapter-N.xhtml
 *
 * 正文按「Markdown 风」的纯文本处理：标题、加粗、斜体、分隔线做基础转换，
 * 其余按段落输出并做 XML 转义 —— 只求阅读器里能正常显示，不做完整 Markdown 实现。
 */

import { createZip, type ZipEntry } from './zip-writer'

export interface EpubChapter {
  /** 章节标题 */
  title: string
  /** 章节正文（Markdown 风纯文本） */
  content: string
}

export interface EpubOptions {
  title: string
  author?: string
  language?: string
  description?: string
  /** 唯一标识；缺省时按书名生成 */
  identifier?: string
  chapters: EpubChapter[]
  /** 打包时间（测试时固定用） */
  createdAt?: Date
}

/** XML 文本转义 */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内标记：**加粗** / *斜体* / `代码` */
function inlineToXhtml(text: string): string {
  return escapeXml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
}

/** 章节正文 → XHTML 片段 */
export function markdownToXhtml(text: string): string {
  const blocks: string[] = []
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (/^-{3,}$/.test(line)) {
      blocks.push('<hr />')
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      // 章名已经用 h1，正文里的标题整体降一级
      const level = Math.min(heading[1].length + 1, 6)
      blocks.push(`<h${level}>${inlineToXhtml(heading[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      blocks.push(`<p class="quote">${inlineToXhtml(line.replace(/^>\s?/, ''))}</p>`)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      blocks.push(`<p class="list">${inlineToXhtml(line.replace(/^[-*]\s+/, '· '))}</p>`)
      continue
    }
    blocks.push(`<p>${inlineToXhtml(line)}</p>`)
  }
  return blocks.join('\n')
}

/** 抽出正文里的首个一级标题当章名，并从正文里去掉它 */
function splitChapterTitle(content: string, fallback: string): { title: string; body: string } {
  const lines = content.split(/\r?\n/)
  const index = lines.findIndex(line => /^#\s+/.test(line.trim()))
  if (index < 0) return { title: fallback, body: content }
  const title = lines[index].trim().replace(/^#\s+/, '').trim() || fallback
  return { title, body: lines.filter((_, i) => i !== index).join('\n') }
}

/** 书名 → 稳定的 identifier 后缀 */
function slug(text: string): string {
  const trimmed = text.trim().slice(0, 60)
  return encodeURIComponent(trimmed).replace(/%/g, '') || 'vela-book'
}

const STYLE = `body { font-family: serif; line-height: 1.7; margin: 0 5%; }
h1 { font-size: 1.4em; margin: 1.2em 0 0.8em; text-align: center; }
h2 { font-size: 1.15em; margin: 1.1em 0 0.6em; }
p { margin: 0 0 0.9em; text-indent: 2em; }
p.quote { text-indent: 0; padding-left: 1em; border-left: 3px solid #ccc; color: #555; }
p.list { text-indent: 0; }
hr { border: none; border-top: 1px solid #ccc; margin: 1.4em 0; }
`

/** 生成一本 EPUB，返回完整字节 */
export function buildEpub(options: EpubOptions): Buffer {
  const createdAt = options.createdAt ?? new Date()
  const language = options.language || 'zh'
  const identifier = options.identifier || `urn:vela:${slug(options.title)}`
  const modified = createdAt.toISOString().replace(/\.\d{3}Z$/, 'Z')

  const chapters = options.chapters.map((chapter, index) => {
    const { title, body } = splitChapterTitle(chapter.content, chapter.title || `第 ${index + 1} 章`)
    return { title, body, fileName: `chapter-${index + 1}.xhtml` }
  })

  const entries: ZipEntry[] = [
    // OCF 规定 mimetype 必须是第一个条目且不压缩
    { path: 'mimetype', data: 'application/epub+zip', store: true },
    {
      path: 'META-INF/container.xml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`,
    },
    { path: 'OEBPS/style.css', data: STYLE },
    {
      path: 'OEBPS/nav.xhtml',
      data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${language}" lang="${language}">
<head><meta charset="utf-8"/><title>目录</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<nav epub:type="toc" id="toc"><h1>目录</h1>
<ol>
${chapters.map(ch => `<li><a href="${ch.fileName}">${escapeXml(ch.title)}</a></li>`).join('\n')}
</ol>
</nav>
</body>
</html>
`,
    },
    {
      path: 'OEBPS/toc.ncx',
      data: `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head>
    <meta name="dtb:uid" content="${escapeXml(identifier)}"/>
    <meta name="dtb:depth" content="1"/>
  </head>
  <docTitle><text>${escapeXml(options.title)}</text></docTitle>
  <navMap>
${chapters.map((ch, i) => `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">
      <navLabel><text>${escapeXml(ch.title)}</text></navLabel>
      <content src="${ch.fileName}"/>
    </navPoint>`).join('\n')}
  </navMap>
</ncx>
`,
    },
    {
      path: 'OEBPS/content.opf',
      data: `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid" xml:lang="${language}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(identifier)}</dc:identifier>
    <dc:title>${escapeXml(options.title)}</dc:title>
    <dc:language>${language}</dc:language>
${options.author ? `    <dc:creator>${escapeXml(options.author)}</dc:creator>\n` : ''}${options.description ? `    <dc:description>${escapeXml(options.description)}</dc:description>\n` : ''}    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
${chapters.map((ch, i) => `    <item id="ch${i + 1}" href="${ch.fileName}" media-type="application/xhtml+xml"/>`).join('\n')}
  </manifest>
  <spine toc="ncx">
${chapters.map((_, i) => `    <itemref idref="ch${i + 1}"/>`).join('\n')}
  </spine>
</package>
`,
    },
  ]

  for (const chapter of chapters) {
    entries.push({
      path: `OEBPS/${chapter.fileName}`,
      data: `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${language}" lang="${language}">
<head><meta charset="utf-8"/><title>${escapeXml(chapter.title)}</title><link rel="stylesheet" type="text/css" href="style.css"/></head>
<body>
<h1>${escapeXml(chapter.title)}</h1>
${markdownToXhtml(chapter.body)}
</body>
</html>
`,
    })
  }

  return createZip(entries, createdAt)
}

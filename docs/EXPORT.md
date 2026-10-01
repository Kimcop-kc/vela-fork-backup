# 导出与打包备份

入口有以下三处，打开的都是同一个「导出项目」对话框：

- 左侧「项目结构」顶部，项目名右侧的下载图标；
- 「正文章节」组标题右侧的下载图标；
- 「正文章节」组标题或任一章节行上点右键 → 「导出全书…」。

选好格式与目标目录后，Vela 会把**已定稿**的章节按章节蓝图顺序合成为一份完整作品。

## 一、支持的产物

| 格式 | 产物 | 说明 |
|------|------|------|
| EPUB 电子书 | `<书名>.epub` | 标准 EPUB 3，带目录，手机与阅读器通用；可填作者署名 |
| 合并 Markdown | `<书名>.md` | 全书合成一个文件，章与章之间用 `---` 分隔；可选插入故事大纲 |
| 分章 Markdown | `<书名>/` 目录 | 每章一个 `.md`，文件名形如 `003-第三章标题.md` |
| 纯文本 TXT | `<书名>.txt` | 去掉 Markdown 标记、自动补章标题，适合投稿或打印 |

另有独立的「同时打包项目备份（.zip）」开关，与格式选择无关，四个格式都能勾。

## 二、EPUB 里有什么

打包在主进程完成（`electron/utils/epub-builder.ts` + `electron/utils/zip-writer.ts`），
不依赖 jszip / archiver 之类的第三方库：

```
mimetype                    application/epub+zip（必须第一个条目且不压缩）
META-INF/container.xml      指向 OEBPS/content.opf
OEBPS/content.opf           书名、作者、语言、manifest、spine
OEBPS/nav.xhtml             EPUB 3 目录
OEBPS/toc.ncx               EPUB 2 兼容目录（老阅读器也能翻目录）
OEBPS/style.css             排版样式
OEBPS/chapter-N.xhtml       每章一个 XHTML
```

正文转换规则（见 `markdownToXhtml`）：

- `# 标题` → `<h2>`，`## 标题` → `<h3>`……整体降一级，`<h1>` 留给章名；
- 正文里第一个一级标题会被**提出来当章名**并从正文里移除，避免标题重复；
- `**粗**` / `*斜*` / `` `代码` `` → `<strong>` / `<em>` / `<code>`；
- `---` → `<hr />`，`> 引文` → 引用样式段落，`- 条目` → 列表样式段落；
- `&` `<` `>` `"` 一律转义，避免阅读器报 XML 解析错误。

## 三、备份包里有什么

打包成 `<书名>-backup.zip`（纯文本资料，不含数据库与向量库）：

```
README.md          备份说明（导出时间、格式、章节数）
project.json       小说配置、角色状态
project-core.json  故事架构（前提 / 角色图谱 / 世界观 / 情节大纲）
blueprints.json    章节蓝图
characters.json    角色卡
chapters/*.md      各章定稿正文
```

换机器时用同一份配置重建项目，再把 `chapters/` 里的正文贴回去即可继续写。

## 四、边界与约定

- **只导出已定稿章节**：草稿、修稿、审稿报告都不进产物。一章都没定稿时会直接报错，不会产出空文件。
- 章节顺序以**章节蓝图**为准，不按文件时间排序。
- 章名优先取蓝图标题；正文里有一级标题时以正文为准。
- Markdown / TXT 输出时，若某章正文首行没带标题，会自动补上蓝图标题，保证每章都有名字。
- 导出路径由用户选定的目录决定，主进程会校验最终路径仍在所选目录内（防路径穿越）。
- 导出不动项目数据，是只读操作；重复导出会覆盖同名产物。

## 五、相关代码

| 位置 | 职责 |
|------|------|
| `src/services/export-service.ts` | 收集章节、生成 Markdown/TXT、调用主进程出 EPUB 与备份包 |
| `src/components/dialogs/ExportDialog.tsx` | 导出对话框（格式、作者、备份开关） |
| `electron/controllers/export-controller.ts` | `novel:export-epub` / `novel:write-zip` 两个 IPC |
| `electron/utils/epub-builder.ts` | EPUB 3 组包 |
| `electron/utils/zip-writer.ts` | 零依赖 ZIP 打包器（store / deflate） |
| `electron/__tests__/epub-export.test.ts` | 按字节解包校验结构与 CRC |
| `src/services/__tests__/export-service.test.ts` | 导出服务单测：章节收集、TXT/MD 处理、备份条目、失败透出 |

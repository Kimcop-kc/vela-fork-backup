# 应用内 Skill 管理与调用

Skill 是 `SKILL.md` 形式的方法包（frontmatter + Markdown 方法正文）。这一轮把它从「只读列表」变成「能在软件里换、能在写作时调」。

## 一、存放范围与优先级

| 范围 | 路径 | 生效范围 |
|------|------|----------|
| 内置 | 随应用发布（`builtin://<name>`） | 全局兜底 |
| 用户级 | `~/.vela/skills/<name>/SKILL.md` | 对所有项目生效 |
| 项目级 | `<项目>/.vela/skills/<name>/SKILL.md` | 仅当前项目，覆盖同名用户级与内置 |

同名即覆盖：`skillRegistry.loadAll()` 按「内置 → 用户 → 项目」顺序注册，后者覆盖前者。

## 二、界面操作（Agent 面板 → 更多 → 技能列表）

- **新建**：填名称、选生效范围（用户级 / 项目级）、写 `SKILL.md`、保存。名称限制 `[A-Za-z0-9._-]`，禁止路径分隔符与 `..`。
- **编辑 / 替换**：点行尾铅笔图标。内置 Skill 只能「另存为覆盖」，保存后即用你的方法接管。
- **导入 SKILL.md**：直接从磁盘挑一个 `SKILL.md` 填入编辑器，再另存为某个 Skill。
- **复制到项目**：用户级 Skill 一键复制一份到项目级，改为项目专属。
- **删除**：仅限用户级 / 项目级；删除前二次确认，删除会移除磁盘上的 `<name>/SKILL.md`。
- **启用 / 停用**：停用后不再注册为 Agent 工具、不出现在 `/` 命令里，`getSkillContent()` 也会返回 `undefined`（相关功能回退到内置兜底方法）。
- **打开目录 / 重新加载**：外部改过 `~/.vela/skills/` 后，用「重新加载」让改动立刻生效。
- **导入分发**：点「导入」按钮，从 GitHub 仓库或 zip 包整包安装（含脚本与参考资料，见第六节）。

停用状态存于 `~/.vela/skills-state.json`（`{ "disabled": [...] }`），跨会话保留。

## 三、写章节时调用（草稿编辑器 → 技能）

- 只列出**已启用**的 Skill；停用的需要先在技能列表里启用。
- 没声明 `inputs` 的 Skill 显示一个「调用参数」输入框，内容替换方法正文里的 `${args}` / `$1`；
  声明了 `inputs` 的按 schema 生成表单（见第四节）。
- 目标文本是当前章节正文；**长章节按模型上下文预算自动切段**，逐段套用同一套方法后按顺序拼接，避免超出上下文。
- 结果流式输出到「AI 输出」面板，**不自动改写草稿**——是否采用由用户决定，保持「只观察、显式发起」的边界。
- 每次请求带 `purpose = Skill:<name>#<段号>`，模型调用统计里能看出 token 花在哪个 Skill 上。

## 四、参数化（inputs schema）

默认所有 Skill 共用一个自由参数输入框。在 frontmatter 声明 `inputs` 后，界面按 schema 自动生成表单，
Agent 也按同一份 schema 收集参数 —— 一份声明，两处生效。

```
---
name: my-skill
description: 一句话说明这个 Skill 做什么
inputs: [{"name":"topic","label":"主题","type":"text","required":true},{"name":"tone","label":"语气","type":"select","options":["克制","热烈"]}]
---
```

方法正文里用 `${字段名}` 取值：

```
请围绕 ${topic} 展开，语气保持 ${tone}。
```

字段属性：

| 属性 | 说明 |
|------|------|
| `name` | 必填，变量名。只保留 `[A-Za-z0-9_-]`，其余字符会被去掉 |
| `label` | 界面标签，缺省用 `name` |
| `type` | `text`（默认）/ `textarea` / `number` / `boolean` / `select` |
| `description` | 帮助文本；也是 Agent 看到的参数说明 |
| `placeholder` | 输入框占位符，缺省用 `description` |
| `required` | 必填；界面在执行前校验，未填时不发起调用 |
| `default` | 默认值，打开表单时填入 |
| `options` | `type: select` 的候选项，写 `["克制"]` 或 `[{"value":"calm","label":"克制"}]` |

约定与边界：

- `inputs` 的值必须是**单行 JSON** —— Vela 不额外引入 YAML 依赖，frontmatter 解析器只对 `[` / `{` 开头的值尝试 JSON。
- 结构化参数同时会被拼成一段 `标签: 值` 文本喂给 `${args}`，所以老写法仍然能拿到值。
- `select` 没写候选项时退化成文本框，避免界面出现空下拉。
- 没声明 `inputs` 的 Skill 行为完全不变。

## 五、Skill 流水线（草稿编辑器 → 流水线）

单个 Skill 解决一个问题；流水线把多个 Skill 串成一条链，一次跑完，
例如「连续性审稿 → 去 AI 味 → 文风仿写」。

- 入口：草稿编辑器工具栏 →「流水线」。弹窗里可以新建、编辑、排序、保存、删除、执行。
- 每一步默认**吃上一步的输出**，首步固定用本章正文；某一步可以把「输入」改成「本章正文」退回原文
  —— 例如最后一步「按文风仿写」要的是干净原文，而不是审稿报告。
- 执行时**逐步确认**：每步完成后工作流暂停，在下方任务面板点「继续」才进入下一步；
  对某一步的结果不满意可以直接取消，后面的步骤不会再跑。
- 引用到不存在或已停用的 Skill 会直接拦住执行；同一个 Skill 在链里出现多次只是提示，不拦。
- 流水线是**纯数据**（JSON），不含可执行代码：

| 范围 | 路径 |
|------|------|
| 用户级 | `~/.vela/pipelines/<name>.json` |
| 项目级 | `<项目>/.vela/pipelines/<name>.json` |

```json
{
  "name": "review-chain",
  "title": "审稿 → 去 AI 味 → 文风仿写",
  "steps": [
    { "skill": "review-continuity" },
    { "skill": "deai-zh", "values": { "level": "light" } },
    { "skill": "style-imitate", "input": "chapter" }
  ]
}
```

字段说明：`skill` 是 Skill 名（`metadata.name`）；`values` / `args` 是该步的参数，与第四节同一套 schema；
`input` 为 `chapter` 时用本章正文，缺省（或 `previous`）用上一步的输出。

因为只是数据，流水线可以手写、纳入版本管理、在项目之间复制。

## 六、Skill 分发（zip / GitHub 导入）

技能列表操作行的「导入」按钮支持两种来源，走同一套流程：**先检查、再安装**。

| 来源 | 输入 | 说明 |
|------|------|------|
| GitHub 仓库 | `https://github.com/owner/repo`、`/tree/分支/子目录` 或 `owner/repo` | 主进程下载 zipball 后解包；不写分支时取默认分支，依次尝试分支 → 标签 → 裸 ref |
| zip 压缩包 | 系统文件选择框挑一个 `.zip` | 包内可以是 `<skill>/SKILL.md`，也可以直接是 `SKILL.md` |

「检查」会把包解开、列出所有候选（名称、版本、描述、文件数、包内路径），选中一个后填安装名、
选安装范围（用户级 / 项目级）再点「安装」。同名 Skill 会先弹确认，确认后整目录覆盖。

安装的几点约定：

- **整目录安装**：`SKILL.md` 同目录下的脚本与参考资料一起落盘，`${SKILL_DIR}` 因此可以直接引用它们；
  `.git`、`__MACOSX`、`node_modules` 会被跳过。
- **名称归一**：安装时会改写 `SKILL.md` 的 frontmatter `name`，保证「目录名 == Skill 名」——
  注册中心以 frontmatter 的 name 作为身份，而读写删除按目录名走，两者不一致会导致编辑/删除找不到文件。
- **来源可追溯**：安装后在 Skill 目录下写一个 `.vela-source.json`，记录来源类型、仓库地址、分支、子目录、
  版本与导入时间；技能列表里对应 Skill 会多一个 `v版本号` 标签，悬停可看来源。
- **解包安全**：包内路径统一归一化，绝对路径与 `..` 穿越一律丢弃；单包上限 2000 个条目、解压后 64MB。

实现上：`electron/utils/zip-reader.ts`（零依赖 ZIP 读取）+ `electron/utils/skill-package.ts`（纯数据解析，
可单测）+ `electron/controllers/skill-controller.ts` 的 `skill:inspect-package` / `skill:install-package`。

## 七、边界

- 调用 Skill（含流水线）只产生文本结果，不写入草稿、不改动项目数据；要落盘必须再由用户显式发起修稿/合并流程。
- 删除与覆盖都经过二次确认；名称校验在渲染进程与主进程各做一次（防路径穿越）。
- 覆盖安装会先清空目标目录，手工改过的内容不会保留；想留下改动就先「复制到项目」再改项目级那份。
- 导入需要联网（仅 GitHub 来源）；下载失败会在对话框里直接报错，不会写坏已有 Skill。

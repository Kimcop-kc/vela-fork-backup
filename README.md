<div align="center">

# 🌌 Vela — AI Novel Writing IDE / AI 小说创作 IDE

**把「世界观 → 大纲 → 正文 → 重写 → 精修 → 审稿」整条小说写作流水线，装进一个本地运行的桌面 IDE。**

**An AI-powered novel writing IDE for web novel authors, indie writers and creative professionals — local-first, BYOK, GPL-3.0.**

[![Build](https://github.com/Kimcop-kc/vela/actions/workflows/build-windows.yml/badge.svg)](https://github.com/Kimcop-kc/vela/actions/workflows/build-windows.yml)
[![Release](https://img.shields.io/github/v/release/Kimcop-kc/vela?color=blue&label=release)](https://github.com/Kimcop-kc/vela/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Kimcop-kc/vela/total?color=green&label=downloads)](https://github.com/Kimcop-kc/vela/releases)
[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-yellow.svg)](https://opensource.org/licenses/GPL-3.0)
[![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)](#-安装与使用--installation)

### ⬇️ [**点此下载最新版 Vela**](https://github.com/Kimcop-kc/vela/releases/latest) — macOS（Apple 芯片 / Intel）· Windows x64

[🚀 安装与使用](#-安装与使用--installation) • [✨ 核心特性](#-核心特性--key-features) • [⚙️ 模型配置](#️-模型配置--model-configuration) • [❓ 常见问题](#-常见问题--faq) • [📝 更新日志](CHANGELOG.md) • [💬 反馈与联系](#-反馈与联系--contact) • [☕ 打赏支持](#-如果觉得好用可以打赏我)

</div>

> 💡 **写小说不想折腾 Key？** 试试 [Fluxion AI](https://fluxionai.space/register?source=github&campaign=vela&promo=VELA) —— 一个入口接入并管理全球主流 AI 模型，OpenAI 兼容、开箱即用，**注册即送 $3 API 额度**。👉 [立即领取](https://fluxionai.space/register?source=github&campaign=vela&promo=VELA)

---

> **Vela** 是一款开源、隐私优先、本地优先的 AI 写作 IDE，专为**长篇小说创作 (Novel Writing)**、**网文写手 (Web Fiction)**与**创意写作 (Creative Writing)** 而生。它将大语言模型驱动的全流程工作流（大纲生成、章节起草、智能重写、自动审阅）与本地 RAG 知识库深度融合，为作者提供 IDE 级别的沉浸式创作体验——所有数据和模型调用都运行在您自己的计算机上，使用您自己的 API Key (BYOK)。

### 为什么选择 Vela？

- 🧬 **不是聊天框，是一条流水线**：世界观 → 大纲 → 细纲 → 正文 → 重写 → 精修 → 审稿，每个环节都在应用里点得到，不用在几个工具之间来回复制粘贴。
- 🧠 **百万字设定记得住**：本地向量检索 (RAG) 会按当前章节的语义自动召回相关设定，写到几百章也不容易人设崩塌、伏笔断裂。
- 🔒 **稿子不出本机**：工程文件、知识库、对话记录都存你自己的电脑；只有你主动点击生成时，内容才会发给你自己配置的模型服务商。
- 🖥️ **IDE 级手感**：可拖拽四分屏（文件树 / 编辑器 / AI 面板 / 底部面板）、深色主题、全局快捷键，像写代码一样写小说。

<!-- SEO: Vela is an open-source, privacy-first, local-first AI writing IDE purpose-built for novel writing, fiction writing, web novel creation, and long-form creative writing. It deeply integrates LLM-powered workflows with a local RAG knowledge base, giving authors an IDE-level creative experience — all running on your own machine with your own API keys (BYOK). -->

---

## 🎨 界面预览 / Screenshots

|<img src="public/screenshot/1.png" width="800" alt="Vela AI Novel Writing IDE - Main Editor Interface"/>|
|:---:|
|*沉浸式写作空间：编辑器 + AI 助手并排布局，支持 JetBrains/VSCode 级窗口管理*|
|*Immersive writing workspace with side-by-side AI panel, IDE-grade window management*|

|<img src="public/screenshot/2.png" width="800" alt="Vela AI Writing Workflow - Outline and Chapter Generation"/>|
|:---:|
|*全自动小说创作工作流：从世界观到正文的端到端 AI 管线*|
|*End-to-end AI novel writing pipeline: from worldbuilding to chapter generation*|

<details>
<summary><b>点击查看更多截图 / More Screenshots 📸</b></summary>
<br>

<img src="public/screenshot/3.png" width="800" alt="Vela AI Writer - Character Management and World Building"/>
<br/><br/>
<img src="public/screenshot/4.png" width="800" alt="Vela Novel IDE - AI Rewrite and Refinement Pipeline"/>
<br/><br/>
<img src="public/screenshot/5.png" width="800" alt="Vela Writing Tool - Local RAG Knowledge Base Search"/>
<br/><br/>
<img src="public/screenshot/6.png" width="800" alt="Vela Creative Writing IDE - Dark Theme Full View"/>

</details>

---

## ✨ 核心特性 / Key Features

Vela is not just another chat-based text editor — it is a **production-grade novel writing engine** that deeply integrates LLM capabilities, long-context retrieval (RAG), and automated pipelines for fiction authoring.

Vela 不是又一个带对话框的文本编辑器——它是一套深度融合了**大语言模型能力、长文本上下文检索 (RAG)、自动化创作管线**的专业级小说写作引擎。

### 🧬 AI 小说创作全流程 / AI-Powered Novel Writing Pipeline

| 能力 / Capability | 说明 / Description |
|---|---|
| 🌍 世界观与设定管理 (Worldbuilding) | 自定义全局世界观背景、核心剧情主轴、角色人设档案（含跨章节动态状态追踪） |
| 📋 自动大纲与细纲生成 (Auto Outline) | AI 一键生成「结构骨架 → 章节细纲 → 场景/情绪/节奏段落要求」，支持三幕式、英雄之旅等多种叙事结构 |
| ✍️ 流式章节正文生成 (Chapter Drafting) | 单章流式打字机生成，精准响应前文上下文与预设提纲，随时可中止 |
| 🔄 AI 智能重写 (Rewrite) | 支持选中段落局部重写或整章全局重写，保持人设与剧情一致性 |
| ✨ 语病与错别字精修 (Refine) | AI 自动检测语法错误、错别字、逻辑漏洞，输出精修建议 |
| 📝 剧情自评审阅 (Review) | AI 以读者/编辑视角对章节进行质量自评，指出节奏、人物弧光、伏笔等问题 |
| 🔁 三重后期管线 (Post-Process) | Rewrite → Refine → Review 三级串联闭环，确保每章高质量出稿 |

### 🧠 百万字级本地知识库 / Million-Word Local RAG Knowledge Base

| 能力 / Capability | 说明 / Description |
|---|---|
| 📂 海量设定导入 (Bulk Import) | 一键导入数百万字的参考小说、世界观文档、角色设定集 |
| 🔍 语义向量检索 (Vector Search) | 写作时根据当前章节语义自动召回最相关的设定切片 (Chunk)，告别人设崩塌与设定遗忘 |
| 🔒 纯本地存储 (Local-Only) | 内置 SQLite + 轻量向量引擎，所有数据存储在您的本地计算机，断网依然可用 |

### 🔌 极致可扩展架构 / Extensible Architecture

| 能力 / Capability | 说明 / Description |
|---|---|
| 🤖 自带模型 BYOK (Bring Your Own Key) | 原生兼容 OpenAI、DeepSeek、Gemini、Claude、Ollama (本地离线)、智谱 GLM 等。支持智能分流：用 DeepSeek 写大纲，用 Claude 润色，用本地模型做隐私审查 |
| 🔗 MCP 协议 (Model Context Protocol) | 原生集成 MCP 协议，随时外挂自定义工具服务器，扩展 AI 能力边界 |
| 📊 用量统计 (Usage Analytics) | 内置 LLM 调用量、Token 消耗、成本趋势的完整统计面板 |

### 🛠️ 极客级生产力 UI / IDE-Grade Productivity UI

| 能力 / Capability | 说明 / Description |
|---|---|
| 🖥️ 可拖拽分屏布局 (Resizable Panels) | 文件树 + 编辑器 + AI 面板 + 底部面板，像 VSCode/JetBrains 一样灵活组合 |
| 🌙 沉浸深色主题 (Dark Theme) | 极致优化的暗色模式，自定义悬浮标题栏与状态栏微交互 |
| ⌨️ 快捷键体系 (Keyboard Shortcuts) | 全局快捷键：Cmd+N 新建、Cmd+O 打开、Cmd+=/- 缩放 |
| 📦 跨平台 (Cross-Platform) | macOS (dmg) / Windows (nsis) 已提供预编译安装包；Linux (AppImage) 配置已就绪，可自行构建 |

---

## 🚀 安装与使用 / Installation

### 系统要求 / Requirements

| 项目 | 要求 |
|---|---|
| macOS | macOS 12 或更高（Apple 芯片与 Intel 芯片均支持） |
| Windows | Windows 10 / 11 (x64) |
| 内存 | 建议 8GB 以上（本地向量检索会占用一定内存） |
| 磁盘 | 约 1GB 安装空间，另有小说工程与知识库占用 |
| 网络 | 需要能访问你配置的模型服务商；使用 Ollama 等本地模型时可完全离线 |

### 方式一：直接下载 / Direct Download

前往 [Releases](https://github.com/Kimcop-kc/vela/releases/latest) 下载对应操作系统的最新版本：

| 平台 | 安装包 | 说明 |
|---|---|---|
| macOS（Apple 芯片 M1/M2/M3/M4） | `Vela-<版本>-macOS-arm64-Installer.dmg` | Apple 芯片 Mac 使用 |
| macOS（Intel） | `Vela-<版本>-macOS-x64-Installer.dmg` | Intel 芯片 Mac 使用 |
| Windows x64 | `Vela-<版本>-Windows-x64-Setup.exe` | 安装版，可自选安装目录 |
| Windows x64 | `Vela-<版本>-Windows-x64-Portable.exe` | 免安装版，双击即用 |

> 不确定自己是哪种 Mac？点屏幕左上角苹果菜单 → 「关于本机」，看「芯片」一栏是 Apple M 系列还是 Intel。

#### 🍎 macOS 安装说明（重要）

macOS 安装包**没有购买 Apple 开发者签名与公证**，首次打开时系统一定会拦截，这是正常的，按下面步骤做一次即可：

1. **先确认自己的芯片**：点屏幕左上角苹果菜单 → 「关于本机」，看「芯片」或「处理器」一栏：
   - Apple M1 / M2 / M3 / M4 → 下载 `macOS-arm64` 那个安装包
   - Intel → 下载 `macOS-x64` 那个安装包
2. 双击下载好的 `.dmg`，把 **Vela** 图标拖进「应用程序」文件夹。
3. **首次启动不要双击**：打开「应用程序」文件夹，**右键点 Vela（或按住 Control 再点）→ 选「打开」**，弹窗里再点一次「打开」。这样可以直接放行。
4. 如果提示「**"Vela" 已损坏，无法打开**」或「无法验证开发者」，打开「终端」（启动台里搜索 "终端" / Terminal），粘贴执行下面这一行：

   ```bash
   sudo xattr -dr com.apple.quarantine /Applications/Vela.app
   ```

   回车后输入开机密码（终端里输入密码不显示任何字符，正常输入完回车即可），然后再打开 Vela。
5. 或者更简单的办法：在拦截弹窗上点「好」，然后打开「**系统设置 → 隐私与安全性**」，拉到最下面找到关于 Vela 的提示，点「**仍要打开**」。

> 以上操作**只需要做一次**，之后就能像普通应用一样双击启动。

#### 🪟 Windows 安装说明

安装包同样没有购买代码签名。如果打开时出现蓝色的「Windows 已保护你的电脑」提示，点「**更多信息 → 仍要运行**」即可。

- **Setup 版**：按向导安装，可自选安装目录，开始菜单里会有 Vela 图标。
- **Portable 版**：免安装，双击 exe 直接运行，适合放在 U 盘里。

### 方式二：源码构建 / Build from Source

```bash
# 环境要求：Node.js >= 20（推荐 LTS 版本）

# 1. 克隆项目
git clone https://github.com/Kimcop-kc/vela.git
cd vela

# 2. 安装依赖（会为 Electron 重新编译 better-sqlite3 等原生模块，耐心等几分钟）
npm install

# 3. 启动开发模式（热更新）
npm run dev

# 4. 打包当前平台的安装包，产物在 release/<版本号>/ 目录下
npm run build
```

> **Note**：需要系统具备编译原生模块的前置工具（macOS: Xcode Command Line Tools；Windows: Visual Studio Build Tools）。
> 如果启动时报 `NODE_MODULE_VERSION` 相关错误，说明原生模块和 Electron 版本没对齐，执行 `npm run rebuild` 后重试。

---

## ⚙️ 模型配置 / Model Configuration

Vela 支持接入多种主流 LLM 服务商，以下是快速配置步骤：

1. 打开应用 → 点击左下角 **⚙️ 设置**
2. 进入 **「模型配置」** 页面
3. 点击 **「新增模型」**：
   - 选择服务商：OpenAI / DeepSeek / Gemini / Ollama / 智谱 / 自定义
   - 填入 `API Key` 和 `Base URL`（如使用代理）
   - 为不同任务（写作 / 润色 / Embedding 检索）指派推荐模型
4. **开始创作！** 🎉

**支持的 LLM 服务商 / Supported LLM Providers:**

`OpenAI` · `DeepSeek` · `Google Gemini` · `Anthropic Claude` · `Ollama (Local)` · `智谱 GLM (Zhipu)` · `MiniMax` · `SiliconFlow` · `Fluxion AI (推荐渠道)` · `Any OpenAI-compatible API`

> 💡 **推荐渠道**：如果没有官方 Key 或想降低成本，可使用 [Fluxion AI](https://fluxionai.space/register?source=github&campaign=vela&promo=VELA)（OpenAI 兼容），在上方第 3 步中选择「自定义 / OpenAI 兼容」，填入 Fluxion AI 的 `Base URL` + `API Key` 即可。注册即送 **$3** 额度。

---

<span id="fluxion-ai"></span>

## 🌟 推荐渠道：Fluxion AI — 一个入口，接入并管理全球主流 AI 模型

Fluxion AI 面向个人开发者、技术团队与企业，通过统一 API 接入并管理全球主流 AI 模型；通过多线路动态调度提升可用性，模型表现、响应时间与费用透明可查。使用 Fable 5.1 时，相较 Claude 官方 API 费用，Fluxion AI 最高可节省约 90%。

- ✅ **统一 OpenAI-Compatible API**，完美适配 Vela，开箱即用
- 🔀 **多线路动态调度**，可用性更高
- 📊 **模型表现、响应时间与费用透明可查**
- 🎁 **立即访问并注册，即可获得 $3 API 额度**

👉 **专属链接：[立即注册领取 $3 额度](https://fluxionai.space/register?source=github&campaign=vela&promo=VELA)**

<a href="https://fluxionai.space/register?source=github&campaign=vela&promo=VELA" target="_blank">
  <img src="https://drive.google.com/thumbnail?id=1nABI15ra_qGKoccMZbJpeMyl6iEFijKe&sz=w1000" width="800" alt="Fluxion AI — 一个入口，接入并管理全球主流 AI 模型"/>
</a>

> 封面原图：[Google Drive 查看](https://drive.google.com/file/d/1nABI15ra_qGKoccMZbJpeMyl6iEFijKe/view?usp=sharing)

---

## 🏗️ 技术架构 / Tech Stack

| 层级 / Layer | 技术 / Technology |
|---|---|
| **UI 框架** | React 19 + TypeScript 6 + Zustand |
| **样式** | Tailwind CSS v4 + Radix UI + Lucide Icons |
| **桌面端** | Electron 41 + Vite 8 |
| **本地存储** | better-sqlite3 (关系型) + LanceDB (本地向量检索 RAG) |
| **IPC 通信** | 强类型频道契约 (Type-safe IPC Channels) |
| **AI 集成** | OpenAI-compatible + Gemini Protocol + MCP |
| **构建分发** | electron-builder（GitHub Actions 自动构建 macOS / Windows 安装包） |

---

## ❓ 常见问题 / FAQ

<details>
<summary><b>macOS 提示「已损坏，无法打开」怎么办？</b></summary>
<br>

这是安装包没有 Apple 开发者签名导致的，不是文件真的坏了。先试 **右键点 Vela → 打开**；如果仍然被拦，打开「终端」执行：

```bash
sudo xattr -dr com.apple.quarantine /Applications/Vela.app
```

详细步骤见上方 [macOS 安装说明](#-macos-安装说明重要)。

</details>

<details>
<summary><b>我的稿子会被上传吗？</b></summary>
<br>

不会。Vela 本身没有服务器，小说工程、设定、知识库、对话记录都存在你自己的电脑上。只有当你主动点击生成、重写、审阅等按钮时，相关的那部分文本才会发送到**你自己配置的**模型服务商。如果你用 Ollama 等本地模型，整个过程可以完全不联网。

</details>

<details>
<summary><b>需要花钱吗？</b></summary>
<br>

Vela 应用本身免费开源（GPL-3.0），不收取任何费用。唯一的开销是你自己调用的模型 API 费用——可以用 DeepSeek、智谱等性价比很高的模型，也可以完全用 Ollama 本地模型做到零成本。

</details>

<details>
<summary><b>我的数据存在哪里？怎么备份？</b></summary>
<br>

- **小说工程**：保存在你创建/选择项目时指定的那个文件夹里，直接复制整个文件夹即可备份。
- **应用配置、对话记录、日志**：保存在用户目录下的 `.vela` 文件夹（macOS: `~/.vela`，Windows: `C:\Users\<你的用户名>\.vela`）。

升级版本不会清空这些数据，覆盖安装即可。

</details>

<details>
<summary><b>怎么升级到新版本？</b></summary>
<br>

到 [Releases](https://github.com/Kimcop-kc/vela/releases/latest) 下载最新安装包，直接覆盖安装即可，稿子和配置都会保留。想看这次改了什么，可以点开对应 Release 页面的说明。

</details>

<details>
<summary><b>支持哪些平台？有 Linux 版吗？</b></summary>
<br>

目前官方提供 **macOS（Apple 芯片 / Intel）** 与 **Windows x64** 的预编译安装包，由 GitHub Actions 自动构建。Linux 的 AppImage 打包配置已经写好，有需要可以按「源码构建」自行打包。

</details>

---

## 🙋‍♂️ 参与贡献 / Contributing

我们欢迎来自社区的代码贡献，包括但不限于：
- 🐛 Bug 修复
- 🤖 新 AI 服务商适配
- 🎨 UI/UX 改进
- 🌐 国际化 (i18n) 翻译
- 📖 文档完善

> 有想法或想做大改动，欢迎先到 [Issues](https://github.com/Kimcop-kc/vela/issues) 提出来讨论，避免方向冲突。

---

## 💬 反馈与联系 / Contact

用 Vela 遇到问题、有想法，或者只是想聊聊写作，都欢迎找我：

- 🐛 **Bug 反馈 / 功能建议**：优先提到 [Issues](https://github.com/Kimcop-kc/vela/issues)，方便追踪和沉淀，其他人也能搜到。
- 💬 **微信 / QQ**：扫码添加，加好友时备注一下「Vela」，方便我优先处理。

| 微信 WeChat | QQ |
|:---:|:---:|
| <img src="docs/images/contact-wechat.png" width="200" alt="微信二维码"/> | <img src="docs/images/contact-qq.png" width="200" alt="QQ 二维码"/> |
| 扫码加微信 | 扫码加 QQ |

### ☕ 如果觉得好用，可以打赏我

Vela 一直在免费更新，如果它确实帮你省了时间、多写了字，欢迎扫码打赏 —— 这是最实在的支持 ❤️

<img src="docs/images/reward-kk.png" width="220" alt="微信赞赏码"/>

---

## 📄 开源协议 / License

本项目采用 [GPL-3.0 License](LICENSE) 开源。您可以自由地运行、研究、分享和修改代码，但基于此修改分发的新软件**必须同样遵循 GPL-3.0 协议开源**。

如需闭源商用授权，请联系项目作者。

---

<div align="center">

⭐ **如果 Vela 对你的写作有帮助，欢迎在右上角点个 Star —— 这是对开源项目最实在的支持。** ⭐

[⬇️ 下载最新版](https://github.com/Kimcop-kc/vela/releases/latest) · [🐛 反馈问题](https://github.com/Kimcop-kc/vela/issues) · [💡 功能建议](https://github.com/Kimcop-kc/vela/issues) · [📝 更新日志](CHANGELOG.md)

**由 [Kimcop-kc](https://github.com/Kimcop-kc) 维护 · 基于 Vela 开源项目二次开发**

*Vela — Your AI-powered novel writing companion. Write smarter, not harder.*

*Vela — 你的 AI 小说创作伙伴。让写作更智能，而非更辛苦。*

</div>

<!-- 
  SEO Keywords (GitHub indexed): 
  AI novel writing, AI writer, novel writing tool, fiction writing software, 
  web novel, 网文写作, AI小说, 小说创作工具, creative writing IDE, 
  AI story generator, novel outline generator, RAG knowledge base,
  LLM writing assistant, Electron writing app, open source writing tool,
  DeepSeek writing, Claude writing, Ollama writing, BYOK AI,
  AI 写作助手, 网文生成器, 小说大纲生成, AI创作, 长篇小说写作
-->
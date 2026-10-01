# 本地开发与源码运行

## 依赖安装

```bash
npm install
```

安装完成后会自动执行 `postinstall`（`electron-builder install-app-deps`），
把 `better-sqlite3` 等原生模块按 **Electron 的 ABI** 重新编译。
这一步是必须的：npm 默认按系统 Node 的 ABI 安装原生模块，直接用 Electron 启动会报

```
The module '...\better_sqlite3.node' was compiled against a different Node.js version
using NODE_MODULE_VERSION <Node 的 ABI>. This version of Node.js requires
NODE_MODULE_VERSION <Electron 的 ABI>.
```

如果 `postinstall` 没有执行（例如用了 `--ignore-scripts`），手动补一次即可：

```bash
npm run rebuild
```

## 启动开发实例

```bash
npm run dev
```

## 原生模块 ABI 说明

同一份 `better-sqlite3` 二进制不能同时满足 Node 与 Electron：

* `npm run dev` / 打包产物 → 需要 Electron ABI（`npm run rebuild` 后的状态）
* `vitest`（跑在系统 Node 上）→ 需要 Node ABI

因此 `electron/__tests__` 下依赖数据库的用例在不同 ABI 下会失败，这是环境差异而不是代码缺陷。
先用 `npm run rebuild` 跑通应用，需要跑数据库相关单测时再临时执行
`npm rebuild better-sqlite3` 切回 Node ABI。

## 长输出任务的续写机制

章节蓝图、章节要点、角色卡、逆向推演这类任务的目标输出天然很长，容易撞上模型输出上限。
相关处理集中在 `src/services/workflows/segmented-generation.ts`：

* `resolveGenerationBudgets` / `resolveChunkBudget` —— 按模型上限推导单次请求的输入/输出预算；
* `splitTextByTokenBudget` / `halveText` / `chunkArray` —— 把超长输入或条目按预算切段；
* `generateWithContinuation` —— 单次输出被截断时，保留已产出内容并让模型从断点续写，最多 3 轮；
* `buildSegmentDirective` / `buildContinuationDirective` —— 分段与续写的提示词片段。

命令侧统一通过 `BaseWorkflowCommand.callLLMWithContinuation()` 调用，不再各自打补丁。

## 模型调用统计

统计由主进程统一记录（`electron/llm/call-log.ts`），写入项目库的 `llm_calls` 表，
覆盖工作流命令、Agent 循环、写作工具与章节彩排等全部入口。
渲染进程只负责透传 `purpose`（用途）与展示，不再自行写库，避免重复计数或漏记。

## 多模型管理

模型池与「用途绑定」的设计、归类规则、回退链与接入点见
[`docs/MODEL_MANAGEMENT.md`](./MODEL_MANAGEMENT.md)。核心结论：

* 归类与回退链只有一份实现（`src/shared/purpose-routing.ts`），渲染进程与主进程共用；
* `purpose` 字符串既是统计维度，也是路由依据，新增命令自带类名即可落进对应用途；
* 未绑定的用途回落到默认模型，老配置行为不变。

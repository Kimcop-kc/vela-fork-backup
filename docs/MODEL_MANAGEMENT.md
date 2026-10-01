# 多模型管理（模型池 + 用途绑定）

## 用户流程

1. 在「设置 → AI 生成模型 / 向量模型」里**先导入模型**，形成模型池（可编辑、可停用）。
2. 再在同一个页面的「用途绑定」里，为每个用途**从已导入的模型里挑选**一个模型。
3. 未绑定的用途回落到默认模型，因此老配置（只设一个默认模型）行为不变。

模型卡片右侧的开关用于「停用」：配置保留，但不再参与用途路由，也不会出现在用途下拉框里。
用途行右侧的「生效：××」实时显示该用途最终使用的模型，避免界面与实际调用不一致。

## 用途类别

| 类别 | 覆盖的环节（示例） | 归类关键词 |
|------|--------------------|------------|
| 正文生成 | 章节蓝图、正文写作、故事架构、Agent 循环、文风分析、Skill 调用 | 默认（未命中其它关键词时） |
| 精修审稿 | 去 AI 味改写、精修、定稿整理、定性审稿、正文改写 | refine / revise / review / deai / polish / finalize / rewrite / consistency / audit |
| 摘要记忆 | 章节要点、角色卡更新、逆向推演、导入原书、梗概 | summary / notes / cards / memory / extract / import / infer / anal / synopsis |
| 向量嵌入 | 知识库导入与检索的 embedding | embedding / embed / vector / kb_ / knowledge |

归类逻辑在 `src/shared/purpose-routing.ts` 的 `categorizePurpose()`：按关键词短路匹配，
命中不到按「正文生成」处理。某个环节想换个类别，只要改这里的关键词表即可。

## 回退链

`pickModelIdForCategory()` 决定每个用途最终用哪个模型，渲染进程与主进程共用：

* 通用用途：**用途绑定 → 默认生成模型 → 能力标签匹配的模型 → 模型池第一个可用模型**；
* 向量用途：**用途绑定 → 默认向量模型 → 声明了向量能力的模型 → 默认生成模型**（保留旧行为兜底）。

停用的模型在所有环节都会被跳过。`llm:generate` / `llm:generate-stream` 在主进程也会再解析一次：
请求里的 `modelId` 找不到（模型被删除）时按同一条链兜底，不会直接失败。

## 存储

* `~/.vela/models.json` —— 模型池（新增可选字段 `enabled`，缺省视为启用）。
* `~/.vela/config.json` ——
  * `defaultModelId` / `defaultEmbeddingModelId`：默认生成 / 向量模型；
  * `purposeModels`：用途 → 模型 id 的绑定表，例如
    `{ "generation": "id-a", "refinement": "id-b", "summary": "id-c", "embedding": "id-d" }`；
    删除某个键表示解除绑定（该用途回落到默认模型）。

## IPC

| 通道 | 说明 |
|------|------|
| `llm:get-purpose-models` | 读取用途绑定表 |
| `llm:set-purpose-model` | 绑定 / 解除绑定（`modelId: null` 即解除） |

## 代码位置

* `src/shared/purpose-routing.ts` —— 用途归类、能力过滤、回退链（唯一真源）。
* `src/stores/llm-store.ts` —— `purposeModels` 状态、`setPurposeModel` / `resolveModelId` / `modelForPurpose`；
  `generate` / `generateStream` 在未显式指定模型时按用途解析。
* `src/components/settings/PurposeBindingPanel.tsx` —— 用途绑定面板。
* `electron/controllers/llm-controller.ts` —— 用途绑定通道 + 主进程侧兜底解析。
* `electron/controllers/kb-controller.ts` —— 知识库向量化同样按用途绑定选模型。

## 已接入用途路由的调用点

工作流命令默认用「命令类名」当 purpose（`BaseWorkflowCommand` 兜底），因此新增命令无需额外改动
就会落进对应类别；以下位置还会显式标注用途或按用途取 token 预算：

* `directory.command.ts` —— 章节蓝图批次大小按「正文生成」模型的上限计算；
* `finalize-chapter.command.ts` —— 章节要点 / 角色卡显式标注 `chapter_notes` / `character_cards`（摘要记忆），
  切段预算也按该用途的模型上限推导；
* `import-novel.command.ts` / `architecture-workflow.ts` / `qualitative-review.command.ts` /
  `deai-revise.command.ts` / `compile-style-guide.command.ts` / `invoke-skill.command.ts` —— 按用途取模型上限；
* `agent-store.ts` / `story-content.tool.ts` —— 会话未显式选模型时按用途解析；
* `NovelConfigEditor.tsx` / `GenerateConfigDialog.tsx` / `ChapterCreationDialog.tsx` —— 「是否已配置模型」的
  前置校验改为按用途解析，只要该用途有可用模型（含用途绑定）就允许发起。

## 测试

`src/services/__tests__/purpose-routing.test.ts` 覆盖用途归类、回退链、停用模型跳过与
「store 把用途绑定结果交给主进程」的行为。

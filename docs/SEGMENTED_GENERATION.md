# 分段生成（Segmented Generation）

> 相关代码：`src/services/workflows/segmented-generation.ts`
> 单测：`src/services/__tests__/segmented-generation.test.ts`

## 背景

章节蓝图、章节要点、角色卡更新、逆向推演等任务的目标输出很长。若把全部输入塞进一次 Prompt
并期望模型一次输出全部结果，就会撞上模型上下文/输出上限，表现为：

- 返回的 JSON 被截断，解析失败或字段大面积缺失；
- 后半段正文的要点、后续章节的蓝图、部分角色的状态直接丢失；
- 旧实现用 `slice(0, 5000)`、`slice(0, 6000)` 硬截断输入，静默丢信息。

分段生成的思路：**不再要求一次输出完整结果**，而是按 token 预算切成多段，逐段生成后再合并，
输出残缺时自动缩小范围重试。

## 模块能力

| 能力 | 函数 | 说明 |
|------|------|------|
| 预算 | `resolveGenerationBudgets(modelMaxTokens)` | 由模型 `maxTokens` 推导单次输入预算（2.5 倍保守估算，夹在 4000–48000） |
| 切分 | `splitTextByTokenBudget` / `splitItemsByTokenBudget` / `chunkArray` | 按「段落 → 句末 → 硬切」逐级降级切分；条目/角色卡按预算或条数分组 |
| 合并 | `mergeByKey` / `mergeFilled` / `mergeChapterNotes` | 按主键合并分段结果，冲突策略支持 `first`（取初次登场）/ `last`（取最新状态）/ `richest`（取信息量最大） |
| 指令 | `buildSegmentDirective` / `buildResumeDirective` / `buildTruncatedContinueDirective` / `buildCharacterFilterDirective` | 明确告知模型「本次只处理第 i/N 段，禁止脑补其他分段」，并在重试时贴回上一轮结尾 |
| 解析 | `parseLooseJson` / `extractJsonFragment` | 剥离代码块、跳过前导解释，优先取「以文本结尾收束」的完整 JSON；输出被截断时返回 `null` 而不是抛错 |

## 各任务的分段策略

| 任务 | 分段维度 | 合并策略 |
|------|----------|----------|
| `chapter_blueprint` / `chapter_blueprint_chunk`（章节蓝图） | 按 token 预算计算单批章节数；输出残缺（空结果/断号）时批次对半缩小并贴回结尾重试 | 逐批落库，游标只推进到已校验的最后一章，不允许跳号 |
| `generate_chapter_notes`（章节要点） | 章节正文按 token 预算切段 | `mergeChapterNotes`：小节归并、条目去重、角色表按角色名合并（保留全部描述） |
| `update_character_cards`（角色卡更新） | 双向分段：正文切段 × 角色卡分批（并注入角色过滤指令） | `mergeByKey`，后段覆盖前段（更接近章末状态） |
| `extract_initial_characters`（提取角色卡） | 角色图谱按 token 预算切段 | `mergeByKey` 取 `first`（初次登场信息优先）；单段失败不放弃整体 |
| `infer_novel_config` / `infer_novel_config_with_vectors`（逆向推演配置） | 首章/最新章/四类向量片段按预算切组，逐组推演 | `mergeFilled(..., 'richest')` 合并描述性字段，角色卡按名字去重 |
| `infer_single_chapter_blueprint`（单章蓝图推演） | 单章正文按预算切段，逐段提取事件 | 事件摘录汇总后追加一次「合并为整章蓝图」调用 |

## 使用约定

- Prompt 正文一律使用 `{{变量}}` 占位；分段/续写说明由 `segmented-generation.ts` 的指令函数追加，文案统一走 i18n（`commands.segmented.*`、`commands.importNovel.*`）。
- 单次调用的输出上限通过 `callLLM(..., { maxTokens })` 显式传入，避免依赖各 Provider 的隐式默认值。
- 只有「输出残缺」才重试；取消、项目切换、模板缺失等致命错误直接抛出，不做降级。
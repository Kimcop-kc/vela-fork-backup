# 定性审稿（Qualitative Review）

## 1. 要解决的问题

连续性审查过去只能给出「通过 / 失败 + 问题列表」，用户拿到的是一份判定结果：
既看不出这条结论依据了哪些既定事实，也看不出它在正文里的位置，
更糟的是判定本身会把章节写成「不合格」状态。

定性审稿把这件事换一个做法：**只记录可追溯的创作反馈，不下判定**。

## 2. 三个设计边界

| 边界 | 含义 | 落到代码 |
|------|------|----------|
| 只观察 | 产物是 `observation`，不是判决 | `src/services/review/types.ts` 里没有任何 verdict 字段 |
| 只标记 | AI 痕迹只标注「可修订位置」，不动正文 | `src/services/review/ai-trace-detector.ts` 是纯函数 |
| 显式发起 | 改名、改稿必须由用户或 Agent 主动选择条目 | `buildRevisionBrief` / `buildAiTraceBrief` |

审稿产物不会把章节改写成「通过/失败」状态，也不会因为一次模型失败就变成「审稿失败」：
模型不可用时，本地确定性检测（规则观察 + AI 痕迹）依旧照常产出。

## 3. 观察维度

| 维度 | 关注点 |
|------|--------|
| `character-memory` | 角色记忆：谁知道什么、认知边界有没有被破坏 |
| `prop-continuity` | 物资连续性：道具、钱财、装备、伤势是否凭空出现/消失 |
| `foreshadowing` | 伏笔回收：埋的线有没有被遗忘，回收是否自然 |
| `outline-deviation` | 大纲偏离：本章推进是否偏离蓝图目标 |
| `pacing` | 叙事节奏：信息密度、场景切换、张弛是否失衡 |
| `emotional-arc` | 情感弧线：情绪变化是否有铺垫与递进 |

观察强度只有三档，且都是「阅读优先级」而非判定：
`note`（记录）/ `watch`（值得留意）/ `concern`（建议优先关注）。

## 4. 数据结构

```ts
interface QualitativeReview {
  chapterNumber: number
  chapterTitle: string
  observations: ReviewObservation[]   // 六维度观察
  aiTraces: AiTraceFinding[]          // 内置 AI 痕迹标记
  context: { timelineEvents, characterStates, openPlotLines, knownFacts }
  stats: { characters, paragraphs, sentences, dialogueRatio }
  generatedAt: string
}
```

单条观察携带：

- `id`：由「维度 + 标题」哈希得出，多轮审稿之间保持稳定，便于追踪同一条反馈的演化；
- `evidence[]`：`quote` + 1 基 `start/end` 偏移（定位失败记为 `-1`，只保留引文，绝不猜测位置）；
- `suggestion?`：写成「可以怎么改」，不是「必须改」；
- `origin`：`llm`（模型观察）或 `rule`（本地确定性规则）。

## 5. AI 痕迹检测

三类痕迹，全部走确定性算法：

| 类型 | 判定依据 | 指标 |
|------|----------|------|
| `high-frequency-word` | 2–4 字 n-gram 重复次数与密度同时超标 | `perKiloChars` |
| `monotonous-sentence` | 句长变异系数过低，或连续同构开头 | `lengthVariation` / `consecutiveSameStart` |
| `over-summary` | 段尾/章尾出现总结式旁白 | `cueHits` / `abstractNouns` |

阈值集中在 `DEFAULT_AI_TRACE_THRESHOLDS`，公开、可审计、可通过
`detectAiTraces(text, { thresholds })` 覆盖。含对白的句子不会被当作总结式旁白。

`OVER_SUMMARY_CUES` / `ABSTRACT_NOUNS` **只用于标记**，永远不会被用来自动替换或删除正文。

## 6. 显式发起修订

```ts
// 用户勾选若干观察后
const brief = buildRevisionBrief(selectedObservations, draftContent)
startWorkflow(createRefineFromReviewWorkflow({ ..., reviewReport: brief }), false)

// 用户点击「去 AI 味」后
startWorkflow(createDeaiReviseWorkflow({ chapterNumber, chapterTitle, draftPath, draftContent }), false)
```

两条路径都只生成**待审阅修订**（`pending` 修稿 + diff 页签），不会自动替换原稿。

## 7. 入口与存储

- 草稿编辑器工具栏 →「定性审稿」（`createQualitativeReviewWorkflow`）；
- 审稿报告页签（`ReviewReport.tsx`）按维度分组渲染观察、单列 AI 痕迹区，
  支持勾选条目发起修稿、以及一键「去 AI 味」；
- 审稿产物以**结构化 JSON** 写入 `reviews` 表的 `content` 字段（markdown 只作渲染，不承担数据职责）。

## 8. 长章节处理

章节正文按 token 预算分段送给模型逐段观察，再按 `id` 合并去重
（`qualitative-review.command.ts`），避免一次请求超出上下文导致观察缺失。

## 9. 测试

`src/services/__tests__/review.test.ts` 覆盖：证据回帖与偏移换算、定位失败处理、
三类痕迹检测、阈值可覆盖、观察归一化与稳定 id、以及「产物里没有通过/失败语义」。

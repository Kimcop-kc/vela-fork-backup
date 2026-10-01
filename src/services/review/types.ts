/**
 * 定性审稿（Qualitative Review）类型定义
 *
 * 设计约束（重要）：
 *   1. observation 是「可追溯的创作反馈」，不是判定结果。
 *      因此本模块的所有类型都不含 verdict / passed / blocked 之类的字段，
 *      审稿产物永远不会把章节改写成「通过 / 失败」状态。
 *   2. 审稿只负责「记录 + 标注可修订位置」。是否修订、如何修订，
 *      必须由用户或 Agent 显式发起（参见 buildRevisionBrief）。
 *   3. 去 AI 味的语义改写能力由可替换的 Skill 提供，本模块不做任何自动改稿。
 */

/** 审稿观察维度 —— 连续性审查关注的六个方面 */
export type ObservationDimension =
  /** 角色记忆：角色是否知道/不知道某件事，认知边界是否被破坏 */
  | 'character-memory'
  /** 物资连续性：道具、钱财、装备、伤势等是否凭空出现或消失 */
  | 'prop-continuity'
  /** 伏笔回收：埋设的伏笔是否被遗忘，回收是否自然 */
  | 'foreshadowing'
  /** 大纲偏离：本章推进是否偏离蓝图设定的目标 */
  | 'outline-deviation'
  /** 叙事节奏：信息密度、场景切换、张弛是否失衡 */
  | 'pacing'
  /** 情感弧线：角色情绪变化是否有铺垫与递进 */
  | 'emotional-arc'

/** 全部观察维度（供 UI 分组、渲染顺序使用） */
export const OBSERVATION_DIMENSIONS: ObservationDimension[] = [
  'character-memory',
  'prop-continuity',
  'foreshadowing',
  'outline-deviation',
  'pacing',
  'emotional-arc',
]

/**
 * 观察强度 —— 仅表示「建议的阅读优先级」，不是通过/失败判定。
 * note = 记录一下；watch = 值得留意；concern = 可能影响读者理解。
 */
export type ObservationSeverity = 'note' | 'watch' | 'concern'

/**
 * 文本证据位置。
 * start/end 为相对「被审正文」的字符偏移（1 基），无法定位时为 -1。
 */
export interface ObservationEvidence {
  /** 原文片段（用于展示与定位） */
  quote: string
  /** 起始字符偏移（1 基；无法定位为 -1） */
  start: number
  /** 结束字符偏移（1 基，不含；无法定位为 -1） */
  end: number
  /** 证据出处，例如「第 12 章」；无则为空串 */
  source: string
}

/** 单条审稿观察 */
export interface ReviewObservation {
  /** 稳定 id，便于追踪同一条观察在多轮审稿之间的变化 */
  id: string
  dimension: ObservationDimension
  severity: ObservationSeverity
  /** 一句话标题 */
  title: string
  /** 具体描述：观察到什么、为什么值得注意 */
  detail: string
  /** 支撑该观察的原文证据（可能为空数组） */
  evidence: ObservationEvidence[]
  /** 可选建议：写成「可以怎么改」，而不是「必须改」 */
  suggestion?: string
  /** 关联章节号 */
  relatedChapters: number[]
  /** 产生该观察的来源：llm=模型观察，rule=本地确定性检测 */
  origin: 'llm' | 'rule'
}

/** 内置 AI 痕迹检测的种类 */
export type AiTraceKind =
  /** 高频词：同一词/短语在短篇幅内反复出现 */
  | 'high-frequency-word'
  /** 句式单调：句长高度均匀，或连续同构开头 */
  | 'monotonous-sentence'
  /** 过度总结：段尾/章尾的抽象总结式旁白 */
  | 'over-summary'

/** 一条 AI 痕迹检测结果 —— 指向一个「可修订位置」 */
export interface AiTraceFinding {
  id: string
  kind: AiTraceKind
  /** 主要可修订位置起始偏移（相对被审正文，1 基） */
  start: number
  /** 可修订位置结束偏移（1 基，不含） */
  end: number
  /** 命中位置的原文片段 */
  quote: string
  /**
   * 全部命中位置。高频词会有多处命中，逐处列出便于编辑器批量定位；
   * 其余类型与 start/end 一致。
   */
  occurrences: Array<{ start: number; end: number }>
  /** 现象描述 */
  message: string
  /** 量化指标，用于「可追溯」地说明为什么标记 */
  metric: AiTraceMetric
  /**
   * 修订方向提示（一句话）。
   * 注意：这里只给方向，真正的语义改写由 Skill 在用户显式调用时完成。
   */
  hint: string
}

/** AI 痕迹的量化指标 */
export interface AiTraceMetric {
  /** 指标名（i18n key 后缀，见 commands.aiTrace.metric.*） */
  label: string
  /** 指标数值 */
  value: number
  /** 触发阈值 */
  threshold: number
}

/** 本地确定性检测使用的阈值（公开、可审计、可覆盖） */
export interface AiTraceThresholds {
  /** 高频词最少出现次数 */
  minWordRepeats: number
  /** 高频词判定：出现次数 / 正文千字数 */
  maxWordDensityPerKilo: number
  /** 句式单调：最少句子数 */
  minSentencesForRhythm: number
  /** 句式单调：句长变异系数上限（越低越单调） */
  maxLengthVariation: number
  /** 连续同构开头的最少句数 */
  minConsecutiveSameStart: number
  /** 过度总结：段落最少数量（低于该值不做段尾检测） */
  minParagraphsForSummary: number
}

/** 审稿产物：观察 + AI 痕迹，二者都只是「反馈」 */
export interface QualitativeReview {
  chapterNumber: number
  chapterTitle: string
  /** 连续性等维度的观察 */
  observations: ReviewObservation[]
  /** 内置 AI 痕迹检测结果 */
  aiTraces: AiTraceFinding[]
  /** 参与比对的上下文规模，便于追溯本次审稿依据了多少既定事实 */
  context: {
    timelineEvents: number
    characterStates: number
    openPlotLines: number
    knownFacts: number
  }
  /** 正文统计，便于对照 */
  stats: {
    characters: number
    paragraphs: number
    sentences: number
    dialogueRatio: number
  }
  generatedAt: string
}

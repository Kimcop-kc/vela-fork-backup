/**
 * 文风仿写（Style Imitation）类型定义
 *
 * 目标：把一段参考文本编译成「有证据 + 可执行」的文风指南。
 *   - 有证据：每条规则都必须附参考文本里的原文片段（含字符偏移），
 *     无法给出证据的规则会被丢弃，不进入指南。
 *   - 可执行：规则写成祈使句式的写法指令，可以直接作为生成约束使用。
 */

/** 文风规则的类别 */
export type StyleRuleCategory =
  /** 用词倾向：偏好词汇、高频表达、忌用词 */
  | 'lexicon'
  /** 句式与句长 */
  | 'syntax'
  /** 段落与节奏 */
  | 'rhythm'
  /** 对话与叙述配比 */
  | 'dialogue'
  /** 标点习惯 */
  | 'punctuation'
  /** 意象与修辞 */
  | 'imagery'
  /** 叙述视角与人称 */
  | 'voice'

/** 全部类别（UI 渲染顺序） */
export const STYLE_RULE_CATEGORIES: StyleRuleCategory[] = [
  'voice',
  'syntax',
  'rhythm',
  'dialogue',
  'lexicon',
  'imagery',
  'punctuation',
]

/** 参考文本中的证据片段 */
export interface StyleEvidence {
  /** 原文片段 */
  quote: string
  /** 起始字符偏移（1 基；无法定位为 -1） */
  start: number
  /** 结束字符偏移（1 基，不含；无法定位为 -1） */
  end: number
}

/** 一条可执行的文风规则 */
export interface StyleRule {
  id: string
  category: StyleRuleCategory
  /** 可执行指令（祈使句，可直接作为生成约束） */
  statement: string
  /** 支撑该规则的参考文本证据（至少 1 条） */
  evidence: StyleEvidence[]
  /** 量化依据 */
  metric?: { label: string; value: number }
  /** 置信度：metric=由量化分析直接得出，llm=由模型归纳 */
  confidence: 'high' | 'medium' | 'low'
  origin: 'metric' | 'llm'
  /** 来源 Skill 名（可追溯由哪个 Skill 编译） */
  skillName?: string
}

/** 参考文本的量化特征 */
export interface StyleMetrics {
  characters: number
  sentences: number
  paragraphs: number
  /** 平均句长（净字数） */
  averageSentenceLength: number
  /** 句长变异系数，越大越长 short 交错 */
  sentenceLengthVariation: number
  /** 对话占比（0-1） */
  dialogueRatio: number
  /** 平均段落长度（净字数） */
  averageParagraphLength: number
  /** 用词多样性：不同 2-gram 数 / 全部 2-gram 数 */
  lexicalDiversity: number
  /** 标点习惯（按每千字频次排序） */
  punctuationProfile: Array<{ mark: string; count: number; perKiloChars: number }>
  /** 高频特征表达 */
  frequentExpressions: Array<{ text: string; count: number }>
  /** 代表性样本句 */
  signatureSamples: {
    shortest: StyleEvidence | null
    longest: StyleEvidence | null
    dialogue: StyleEvidence | null
  }
}

/** 文风指南 */
export interface StyleGuide {
  source: { title: string; characters: number }
  metrics: StyleMetrics
  rules: StyleRule[]
  /** 编译时使用的 Skill 名 */
  skillName: string
  generatedAt: string
}
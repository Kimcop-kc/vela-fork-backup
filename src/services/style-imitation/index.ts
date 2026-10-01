/**
 * 文风仿写 —— 统一门面
 *
 * 把参考文本编译成「有证据的可执行文风指南」：
 *   1. measureStyle：确定性量化分析（每一步都能指回原文）；
 *   2. buildStyleGuidePrompt：把「激活的 Skill 提供的语义方法」+ 量化特征 + 参考文本
 *      组装成编译用的 Prompt（超长参考文本按 token 预算分段）；
 *   3. compileStyleGuide：把量化规则与模型归纳的规则合并成 StyleGuide。
 *
 * Skill 可替换：编译方法来自被激活的 Skill 内容；
 * 用户把自己的 SKILL.md 放在 ~/.vela/skills/style-imitation/ 即可整体替换分析方法，
 * 而不需要改代码。
 */
export * from './types'
export { measureStyle } from './style-metrics'
export {
  anchorEvidence,
  deriveMetricRules,
  mergeRules,
  normalizeCategory,
  parseLlmRules,
  referenceLength,
  renderStyleGuide,
  styleRuleId,
  summarizeGuide,
  type RawStyleRule,
} from './style-guide'

import { buildSegmentDirective, splitTextByTokenBudget } from '../workflows/segmented-generation'
import { getPromptTemplate } from '../prompt-templates'
import { BasePromptBuilder } from '../prompts/prompt-builder'
import i18n from '../../i18n'
import { measureStyle } from './style-metrics'
import {
  deriveMetricRules,
  mergeRules,
  parseLlmRules,
} from './style-guide'
import type { StyleGuide, StyleMetrics } from './types'

/** 默认的仿写 Skill 名（可被用户/项目同名 Skill 替换） */
export const DEFAULT_STYLE_SKILL_NAME = 'style-imitation'

/** Skill 缺失时使用的内置兜底方法（保证功能不因 Skill 未加载而失效） */
export const FALLBACK_STYLE_METHOD = [
  '阅读参考文本，归纳作者稳定重复的写法，而不是概述剧情。',
  '关注：叙述视角与人称、句长与断句习惯、对话与叙述的配比、常用意象与修辞、标点偏好、情绪推进方式。',
  '每一条结论都必须能从参考文本中引用一段原文作为证据；找不到证据的结论不要写。',
  '把结论写成可直接执行的写作指令（祈使句），避免“文笔优美”这类无法执行的空话。',
].join('\n')

/** 把量化特征渲染成可读文本，注入 Prompt 作为客观依据 */
export function renderStyleMetrics(metrics: StyleMetrics): string {
  const lines: string[] = []
  lines.push(`净字数：${metrics.characters}`)
  lines.push(`句子数：${metrics.sentences}，段落数：${metrics.paragraphs}`)
  lines.push(`平均句长：${metrics.averageSentenceLength} 字，句长变异系数：${metrics.sentenceLengthVariation}`)
  lines.push(`平均段落长度：${metrics.averageParagraphLength} 字`)
  lines.push(`对话占比：${Math.round(metrics.dialogueRatio * 100)}%`)
  lines.push(`用词多样性（不同 2-gram / 全部 2-gram）：${metrics.lexicalDiversity}`)
  if (metrics.punctuationProfile.length > 0) {
    lines.push(`标点频次（每千字）：${metrics.punctuationProfile.map(item => `${item.mark} ${item.perKiloChars}`).join('，')}`)
  }
  if (metrics.frequentExpressions.length > 0) {
    lines.push(`高频表达：${metrics.frequentExpressions.map(item => `${item.text}(×${item.count})`).join('，')}`)
  }
  if (metrics.signatureSamples.shortest) lines.push(`最短句样例：${metrics.signatureSamples.shortest.quote}`)
  if (metrics.signatureSamples.longest) lines.push(`最长句样例：${metrics.signatureSamples.longest.quote}`)
  return lines.join('\n')
}

/**
 * 按 token 预算切分参考文本。
 * 复用分段生成能力：参考文本很长时逐段归纳，最后合并，避免一次请求超出上下文。
 */
export function splitStyleReference(referenceText: string, inputBudget: number): string[] {
  return splitTextByTokenBudget(referenceText, Math.max(500, inputBudget))
}

/** 编译文风指南的参数 */
export interface CompileStyleGuideParams {
  referenceText: string
  /** 参考文本来源标题（书名人名等），用于报告溯源 */
  sourceTitle: string
  /** 模型返回的原始规则（按分段编译时传入合并后的数组） */
  rawLlmRules?: unknown
  /** 编译时使用的 Skill 名 */
  skillName?: string
}

/**
 * 合成文风指南。
 *
 * 量化规则永远存在（确定性），模型规则作为补充。
 * 两者都遵守「无证据不入指南」的约束。
 */
export function compileStyleGuide(params: CompileStyleGuideParams): StyleGuide {
  const metrics = measureStyle(params.referenceText)
  const skillName = params.skillName || DEFAULT_STYLE_SKILL_NAME
  const metricRules = deriveMetricRules(metrics, params.referenceText)
  const llm = params.rawLlmRules === undefined
    ? { rules: [], skipped: 0 }
    : parseLlmRules(params.rawLlmRules, params.referenceText, skillName)

  return {
    source: { title: params.sourceTitle, characters: metrics.characters },
    metrics,
    rules: mergeRules(metricRules, llm.rules),
    skillName,
    generatedAt: new Date().toISOString(),
  }
}

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, { ns: 'commands', ...opts })

/** 编译文风指南的 Prompt 参数 */
export interface BuildStyleGuidePromptParams {
  referenceText: string
  metrics: StyleMetrics
  /** 被激活的 Skill 内容（语义方法）；缺省时使用内置兜底方法 */
  skillContent?: string
  /** 分段编译信息（参考文本很长时逐段归纳） */
  segment?: { index: number; total: number }
}

/**
 * 组装编译用的 Prompt。
 *
 * 语义方法来自「被激活的 Skill」：用户替换 Skill 即整体替换分析方法，
 * 代码只负责把量化证据与参考文本喂进去。
 */
export function buildStyleGuidePrompt(params: BuildStyleGuidePromptParams): string {
  const template = getPromptTemplate('style_imitation')
  if (!template) throw new Error(t('styleGuide.templateMissing'))

  const builder = new BasePromptBuilder(template).withVariables({
    skill_method: params.skillContent?.trim() || FALLBACK_STYLE_METHOD,
    style_metrics: renderStyleMetrics(params.metrics),
    reference_text: params.referenceText,
  })

  let prompt = builder.build()
  if (params.segment && params.segment.total > 1) {
    prompt += buildSegmentDirective(params.segment.index, params.segment.total, t('styleGuide.segmentHint'))
  }
  return prompt
}

/** 取值风指南任务的 systemRole（模板自带，缺失时回退） */
export function styleGuideSystemRole(): string {
  return getPromptTemplate('style_imitation')?.systemRole || t('styleGuide.defaultSystemRole')
}

/**
 * 主进程侧的 LLM 调用统计
 *
 * 放在主进程而不是渲染进程，是为了覆盖所有入口：工作流命令、Agent 循环、
 * 写作工具、章节彩排都经由 llm:generate / llm:generate-stream，统一在这里记录，
 * 避免「有的调用统计得到、有的统计不到」导致面板长期显示 0。
 */
import { LLMHistoryRepository } from '../repositories/llm-repository'
import type { ModelProfile, TokenUsage } from '../../src/shared/ipc-channels'

/** 无 usage 时的粗略估算：CJK 字符按 1 token，其余按 0.25 token */
export function estimateTokensByText(text: string): number {
  if (!text) return 0
  let tokens = 0
  for (const char of text) {
    tokens += (char.codePointAt(0) ?? 0) > 0x2e80 ? 1 : 0.25
  }
  return Math.round(tokens)
}

/** 把消息数组拼成用于估算的请求文本 */
export function joinMessages(messages: Array<{ content?: string }> | undefined): string {
  if (!messages || messages.length === 0) return ''
  return messages.map(message => message.content ?? '').join('\n')
}

export interface CallLogInput {
  model?: ModelProfile | null
  modelId: string
  purpose?: string
  promptText: string
  completionText: string
  usage?: TokenUsage
  startedAt: number
  success: boolean
  errorMessage?: string
}

/** 写入一次调用记录；统计失败不影响生成流程 */
export function recordLLMCall(input: CallLogInput): void {
  try {
    const usage = input.usage && input.usage.totalTokens > 0
      ? input.usage
      : (() => {
          const promptTokens = estimateTokensByText(input.promptText)
          const completionTokens = estimateTokensByText(input.completionText)
          return { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens }
        })()
    LLMHistoryRepository.logCall({
      modelId: input.modelId,
      modelName: input.model?.name || input.modelId,
      purpose: input.purpose || 'unknown',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      durationMs: Date.now() - input.startedAt,
      success: input.success,
      errorMessage: input.errorMessage ?? '',
    })
  } catch (error) {
    console.error('[llm] 调用统计写入失败:', error)
  }
}

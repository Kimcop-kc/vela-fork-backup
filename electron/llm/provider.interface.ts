import { ModelProfile, LLMCompletionMeta } from '../../src/shared/ipc-channels'

export type { LLMCompletionMeta }

export interface LLMGenerateOptions {
  temperature: number
  maxTokens: number
  responseFormat?: { type: string }
  thinking?: boolean
}

export interface LLMStreamOptions extends LLMGenerateOptions {
  signal: AbortSignal
  onChunk: (chunk: string) => void
  onDone: (fullText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }, meta?: LLMCompletionMeta) => void
  onError: (error: string) => void
  /**
   * 输出被长度上限截断时的回调：携带已产出的部分内容，由调用方决定续写还是报错。
   * 不提供时回退到 onError，保持既有行为不变。
   */
  onTruncated?: (partialText: string, usage?: { promptTokens: number; completionTokens: number; totalTokens: number }, meta?: LLMCompletionMeta) => void
}

export interface LLMResponse {
  success: boolean
  content: string
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number }
  error?: string
  /** 输出被长度上限截断：content 为已产出的部分内容，可续写补齐 */
  truncated?: boolean
}

export interface ILLMProvider {
  /** 非流式生成 */
  generate(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMGenerateOptions
  ): Promise<LLMResponse>

  /** 流式生成 */
  generateStream(
    model: ModelProfile,
    messages: Array<{ role: string; content: string }>,
    opts: LLMStreamOptions
  ): Promise<void>
}

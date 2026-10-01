import type { WorkflowContext, StepCallbacks } from '../../../stores/workflow-store'
import { useLLMStore } from '../../../stores/llm-store'
import { globalEventBus, EventPayloadMap } from '../../../shared/event-bus'
import type { BasePromptBuilder } from '../../prompts/prompt-builder'
import i18n from '../../../i18n'
import { buildContinuationDirective, generateWithContinuation } from '../segmented-generation'

export interface CommandExecuteParams {
  step: unknown
  context: WorkflowContext
  callbacks: StepCallbacks
}

/**
 * 工作流执行环节的抽象基类 (Command Pattern)
 * 将原本混乱的 workflow 闭包拆分为可独立测试、状态解耦的命令单元。
 */
export abstract class BaseWorkflowCommand<TResult = string> {
  
  /** 抽象执行入口 */
  abstract execute(params: CommandExecuteParams): Promise<TResult>

  /** 获取 LLM 大模型连接代理（支持取消） */
  protected async callLLM(
    prompt: string, 
    systemPrompt: string, 
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string },
    context?: WorkflowContext
  ): Promise<string> {
    const llmStore = useLLMStore.getState()
    // 按用途解析模型（用途绑定 → 默认模型 → 模型池），只有完全没有可用模型才报错
    if (!llmStore.resolveModelId(options?.purpose)) throw new Error(i18n.t('base.noDefaultModel', { ns: 'commands' }))

    callbacks.setProgress(10)

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      // 取消监听：轮询 context.cancelled，主动中断 LLM 流
      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      llmStore.generateStream(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        {
          onChunk: (chunk) => {
            // 取消后不再追加输出
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text) => {
            cleanup()
            // 取消后不 resolve，让 reject 生效
            if (context?.cancelled) {
              reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
              return
            }
            callbacks.setProgress(90)
            const raw = text || fullContent
            const cleaned = this.stripThinkingTags(raw)
            resolve(cleaned)
          },
          onError: (err) => {
            cleanup()
            reject(new Error(err || i18n.t('base.streamFailed', { ns: 'commands' })))
          }
        },
        undefined,
        // 未显式指定用途时，用命令类名兜底，保证统计面板能区分「token 花在哪个环节」
        { ...options, purpose: options?.purpose ?? this.constructor.name }
      ).then(reqId => {
        streamRequestId = reqId
        // 如果在 generateStream 返回前已经取消
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 使用 Builder 的 systemRole + prompt 一键调用 LLM
   * 角色定位由模板自带，command 不再需要硬编码 system message
   */
  protected async callLLMWithBuilder(
    builder: BasePromptBuilder,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string },
    context?: WorkflowContext
  ): Promise<string> {
    return this.callLLM(builder.build(), builder.getSystemRole(), callbacks, options, context)
  }

  /**
   * 单轮流式生成：返回本轮文本，以及是否撞上模型输出长度上限。
   *
   * 截断时不再丢弃已产出的内容（主进程通过 onTruncated 送回来），
   * 上层可以据此续写拼接，而不是整段重试。
   */
  private generateStreamOnce(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    callbacks: StepCallbacks,
    options: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string } | undefined,
    context: WorkflowContext | undefined,
  ): Promise<{ text: string; truncated: boolean }> {
    const llmStore = useLLMStore.getState()
    if (!llmStore.resolveModelId(options?.purpose)) {
      return Promise.reject(new Error(i18n.t('base.noDefaultModel', { ns: 'commands' })))
    }

    return new Promise((resolve, reject) => {
      let fullContent = ''
      let streamRequestId = ''

      let cancelCheckTimer: ReturnType<typeof setInterval> | null = null
      if (context) {
        cancelCheckTimer = setInterval(() => {
          if (context.cancelled && streamRequestId) {
            clearInterval(cancelCheckTimer!)
            cancelCheckTimer = null
            llmStore.cancelGeneration(streamRequestId).catch(() => {})
            reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
          }
        }, 200)
      }

      const cleanup = () => {
        if (cancelCheckTimer) {
          clearInterval(cancelCheckTimer)
          cancelCheckTimer = null
        }
      }

      const finish = (text: string, truncated: boolean) => {
        cleanup()
        // 取消后不 resolve，让 reject 生效
        if (context?.cancelled) {
          reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
          return
        }
        callbacks.setProgress(90)
        resolve({ text: this.stripThinkingTags(text || fullContent), truncated })
      }

      llmStore.generateStream(
        messages,
        {
          onChunk: (chunk) => {
            if (context?.cancelled) return
            fullContent += chunk
            callbacks.appendText(chunk)
          },
          onDone: (text) => finish(text, false),
          onTruncated: (partial) => finish(partial, true),
          onError: (err) => {
            cleanup()
            reject(new Error(err || i18n.t('base.streamFailed', { ns: 'commands' })))
          },
        },
        undefined,
        { ...options, purpose: options?.purpose ?? this.constructor.name },
      ).then(reqId => {
        streamRequestId = reqId
        if (context?.cancelled) {
          llmStore.cancelGeneration(reqId).catch(() => {})
          cleanup()
          reject(new Error(i18n.t('base.workflowCancelled', { ns: 'commands' })))
        }
      }).catch(err => {
        cleanup()
        reject(err)
      })
    })
  }

  /**
   * 带「截断续写」的 LLM 调用。
   *
   * 与 callLLM 的区别：模型输出撞上长度上限时不再整段失败，而是保留已产出的内容，
   * 把结尾片段作为 assistant 消息回传，要求模型从断点继续；最多续写 maxRounds 轮后
   * 拼成一份完整结果。适合章节蓝图、章节要点、角色卡、逆向推演这类「输出天然很长」的任务。
   */
  protected async callLLMWithContinuation(
    prompt: string,
    systemPrompt: string,
    callbacks: StepCallbacks,
    options?: { responseFormat?: { type: string }; thinking?: boolean; maxTokens?: number; purpose?: string; maxRounds?: number },
    context?: WorkflowContext
  ): Promise<string> {
    const purpose = options?.purpose ?? this.constructor.name
    const outcome = await generateWithContinuation(
      async (ctx) => {
        const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ]
        if (ctx.round > 0) {
          // 把上一轮的结尾作为 assistant 消息回传，再追加续写指令，模型只需补写剩余内容
          callbacks.log(i18n.t('segmented.continuationLog', { ns: 'commands', round: ctx.round }))
          messages.push({ role: 'assistant', content: ctx.tail })
          messages.push({ role: 'user', content: buildContinuationDirective(ctx.round) })
        }
        return this.generateStreamOnce(messages, callbacks, { ...options, purpose }, context)
      },
      {
        maxRounds: options?.maxRounds,
        isCancelled: () => context?.cancelled === true,
      },
    )

    if (outcome.rounds > 1 && outcome.truncated) {
      callbacks.log(i18n.t('segmented.continuationExhaustedLog', { ns: 'commands', rounds: outcome.rounds }))
    } else if (outcome.rounds > 1) {
      callbacks.log(i18n.t('segmented.continuationDoneLog', { ns: 'commands', rounds: outcome.rounds, length: outcome.text.length }))
    }
    return outcome.text
  }

  /**
   * 去除 DeepSeek 等模型的 <think> 标签，保证落盘纯净
   */
  protected stripThinkingTags(text: string): string {
    return text.replace(/<think>[\s\S]*?(?:<\/think>|$)/gi, '').trim()
  }

  /**
   * 全局容错 JSON 解析器
   * 自动剥离 Markdown ```json 代码块并处理尾随逗号等常见大模型幻觉
   */
  protected parseJSON<T>(text: string): T {
    try {
      // 1. 剥离 Markdown 块
      let cleanText = text.replace(/```json?\n?/gi, '').replace(/```\n?/gi, '').trim()
      // 2. 如果存在前序引导语，截取第一把括号到最后一把括号
      const firstBrace = cleanText.indexOf('{')
      const firstBracket = cleanText.indexOf('[')
      const lastBrace = cleanText.lastIndexOf('}')
      const lastBracket = cleanText.lastIndexOf(']')

      if (firstBrace !== -1 && lastBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        cleanText = cleanText.substring(firstBrace, lastBrace + 1)
      } else if (firstBracket !== -1 && lastBracket !== -1) {
        cleanText = cleanText.substring(firstBracket, lastBracket + 1)
      }
      
      return JSON.parse(cleanText) as T
    } catch {
      // JSON 解析失败最常见的原因是「输出被长度上限截断」：把可识别的提示一并带上，
      // 让上层能按「缩小范围重试」处理，而不是把整步判定为失败。
      throw new Error(`${i18n.t('base.jsonParseError', { ns: 'commands', tail: text.slice(-100) })} ${i18n.t('segmented.outputIncomplete', { ns: 'commands' })}`)
    }
  }

  /**
   * 解耦的事件驱动：通知 UI 层去更新资产树，而无需去 import Zustand Store
   */
  protected notifyRefresh(resources: EventPayloadMap['REFRESH_RESOURCE']['resources']) {
    globalEventBus.emit('REFRESH_RESOURCE', { resources })
  }
}

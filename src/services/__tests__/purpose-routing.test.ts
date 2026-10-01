/**
 * 多模型管理：用途归类 + 模型回退链测试。
 *
 * 覆盖点：
 * 1. 具体调用用途（章节要点 / 精修命令 / 向量化）归类正确；
 * 2. 回退链：用途绑定 → 默认模型 → 能力匹配 → 模型池；
 * 3. 停用的模型不参与路由；
 * 4. store 在未显式指定模型时按用途解析，并把它传给主进程。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  categorizePurpose, modelsForCategory, pickModelIdForCategory, isModelEnabled,
} from '../../shared/purpose-routing'
import { useLLMStore } from '../../stores/llm-store'
import { ipc } from '../ipc-client'
import type { ModelProfile } from '../../shared/ipc-channels'

const model = (id: string, purposes: ModelProfile['purposes'], enabled = true): ModelProfile => ({
  id, name: id, provider: 'openai', protocol: 'openai', modelName: id, apiKey: 'k',
  baseUrl: 'https://api.openai.com', temperature: 0.7, maxTokens: 4096, purposes, enabled,
})

describe('categorizePurpose 把调用用途归类到可绑定的用途', () => {
  it('按关键词识别精修 / 审稿类用途', () => {
    expect(categorizePurpose('deai_revise')).toBe('refinement')
    expect(categorizePurpose('qualitative_review')).toBe('refinement')
    expect(categorizePurpose('chapter_finalize')).toBe('refinement')
    expect(categorizePurpose('RefineDraftCommand')).toBe('refinement')
    expect(categorizePurpose('FinalizeChapterCommand')).toBe('refinement')
  })

  it('按关键词识别摘要 / 记忆类用途（章节要点、角色卡、逆向推演）', () => {
    expect(categorizePurpose('chapter_notes')).toBe('summary')
    expect(categorizePurpose('character_cards')).toBe('summary')
    expect(categorizePurpose('infer_novel_config')).toBe('summary')
  })

  it('按关键词识别向量用途', () => {
    expect(categorizePurpose('embedding')).toBe('embedding')
    expect(categorizePurpose('kb_import')).toBe('embedding')
  })

  it('其余情况归为正文生成', () => {
    expect(categorizePurpose(undefined)).toBe('generation')
    expect(categorizePurpose('chapter_blueprint')).toBe('generation')
    expect(categorizePurpose('agent_loop')).toBe('generation')
    expect(categorizePurpose('GenerateDraftCommand')).toBe('generation')
  })
})

describe('pickModelIdForCategory 的模型回退链', () => {
  const pool = [model('a', ['generation']), model('b', ['generation', 'refinement']), model('e', ['embedding'])]

  it('用途绑定优先于默认模型', () => {
    expect(pickModelIdForCategory('generation', { models: pool, bindings: { generation: 'b' }, defaultModelId: 'a' })).toBe('b')
  })

  it('未绑定时使用默认模型', () => {
    expect(pickModelIdForCategory('refinement', { models: pool, bindings: {}, defaultModelId: 'a' })).toBe('a')
  })

  it('没有默认模型时按能力标签挑选可用模型', () => {
    expect(pickModelIdForCategory('refinement', { models: pool, bindings: {}, defaultModelId: null })).toBe('b')
  })

  it('停用的模型不参与路由（绑定与默认都会被跳过）', () => {
    const paused = [model('a', ['generation'], false), model('b', ['generation'])]
    expect(pickModelIdForCategory('generation', { models: paused, bindings: { generation: 'a' }, defaultModelId: 'a' })).toBe('b')
    expect(isModelEnabled(model('x', ['generation'], false))).toBe(false)
  })

  it('向量用途优先挑向量模型，实在没有才退回默认模型', () => {
    expect(pickModelIdForCategory('embedding', { models: pool, bindings: {}, defaultModelId: 'a' })).toBe('e')
    expect(pickModelIdForCategory('embedding', { models: [model('a', ['generation'])], bindings: {}, defaultModelId: 'a' })).toBe('a')
    expect(pickModelIdForCategory('embedding', { models: [], bindings: {}, defaultModelId: null })).toBeNull()
  })

  it('modelsForCategory 只保留能力匹配且启用的模型', () => {
    expect(modelsForCategory([...pool, model('c', ['refinement'], false)], 'refinement').map((m) => m.id)).toEqual(['b'])
  })
})

describe('llm-store 按用途解析并传递模型', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    useLLMStore.setState({
      models: [model('gen', ['generation']), model('polish', ['refinement']), model('cheap', ['summary'])],
      defaultModelId: 'gen',
      defaultEmbeddingModelId: null,
      purposeModels: { refinement: 'polish' },
    })
  })

  it('resolveModelId / modelForPurpose 跟随用途绑定', () => {
    expect(useLLMStore.getState().resolveModelId('deai_revise')).toBe('polish')
    expect(useLLMStore.getState().resolveModelId('chapter_blueprint')).toBe('gen')
  })

  it('未绑定的用途回落到默认模型；没有默认模型时才按能力标签挑', () => {
    expect(useLLMStore.getState().modelForPurpose('chapter_notes')?.id).toBe('gen')
    useLLMStore.setState({ defaultModelId: null })
    expect(useLLMStore.getState().modelForPurpose('chapter_notes')?.id).toBe('cheap')
  })

  it('generate 未显式指定模型时把用途绑定结果交给主进程', async () => {
    const invoke = vi.spyOn(ipc, 'invoke').mockResolvedValue({ success: true, content: 'ok' } as never)
    await useLLMStore.getState().generate([{ role: 'user', content: 'hi' }], undefined, { purpose: 'deai_revise' })
    expect(invoke).toHaveBeenCalledWith('llm:generate', expect.objectContaining({ modelId: 'polish', purpose: 'deai_revise' }))
  })
})

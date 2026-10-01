/**
 * 用途路由（Purpose Routing）
 *
 * 一部小说的生成会经过很多环节（蓝图、正文、精修、审稿、摘要、向量……），
 * 它们理想的模型并不相同。设置页里用户先「导入模型」形成模型池，再为每个用途类别
 * 挑选模型；未绑定时回落到全局默认模型，最后才回落到模型池里第一个可用模型。
 *
 * 渲染进程与主进程共用这里的归类与回退链，保证「界面显示的模型」就是「实际调用的模型」。
 */
import type { ModelProfile, LLMPurposeCategory } from './ipc-channels'

/** 可以单独绑定模型的用途类别 */
export type PurposeCategory = LLMPurposeCategory

export const PURPOSE_CATEGORIES: readonly PurposeCategory[] = ['generation', 'refinement', 'summary', 'embedding']

/** 用途类别 → 设置页 i18n key（settings.models.purpose.*），供各面板共用 */
export const PURPOSE_CATEGORY_LABEL_KEY: Record<PurposeCategory, string> = {
  generation: 'models.purpose.generation',
  refinement: 'models.purpose.refinement',
  summary: 'models.purpose.summary',
  embedding: 'models.purpose.embedding',
}

/** 用途类别 → 模型 id 的绑定表（持久化在 ~/.vela/config.json 的 purposeModels） */
export type PurposeModelBindings = Partial<Record<PurposeCategory, string | null>>

/**
 * 归类关键词表，按顺序短路匹配。命中不到时按「正文生成」处理——它是最常见的调用。
 * 关键词针对既有 purpose 取值（`chapter_notes`、`RefineDraftCommand`、`agent_loop` 等）挑选。
 */
const CATEGORY_KEYWORDS: Array<{ category: PurposeCategory; words: readonly string[] }> = [
  { category: 'embedding', words: ['embedding', 'embed', 'vector', 'kb_', 'knowledge'] },
  {
    category: 'summary',
    words: ['summary', 'summarise', 'summarize', 'notes', 'cards', 'character_card', 'memory', 'extract', 'import', 'infer', 'analy', 'synopsis'],
  },
  {
    category: 'refinement',
    words: ['refine', 'revise', 'revision', 'review', 'deai', 'polish', 'finalize', 'rewrite', 'consistency', 'audit'],
  },
]

/** 把具体调用用途（如 `chapter_notes` / `RefineDraftCommand`）归类到一个可绑定的用途类别 */
export function categorizePurpose(purpose?: string): PurposeCategory {
  const raw = (purpose ?? '').toLowerCase()
  if (!raw) return 'generation'
  for (const { category, words } of CATEGORY_KEYWORDS) {
    if (words.some((word) => raw.includes(word))) return category
  }
  return 'generation'
}

/** 模型是否启用（未写该字段视为启用，兼容旧配置） */
export function isModelEnabled(model: Pick<ModelProfile, 'enabled'>): boolean {
  return model.enabled !== false
}

/** 模型池里能胜任该用途的模型（能力标签匹配且未被停用），供设置页下拉框使用 */
export function modelsForCategory(models: ModelProfile[], category: PurposeCategory): ModelProfile[] {
  return models.filter((m) => isModelEnabled(m) && (m.purposes ?? []).includes(category))
}

export interface ModelPoolLookup {
  models: ModelProfile[]
  bindings?: PurposeModelBindings | null
  defaultModelId?: string | null
  defaultEmbeddingModelId?: string | null
}

/**
 * 按用途挑选模型 id：用途绑定 → 默认模型 → 能力标签匹配 → 模型池第一个可用模型。
 * 返回 null 表示当前没有可用模型（例如只绑定了向量用途却没导入向量模型）。
 */
export function pickModelIdForCategory(category: PurposeCategory, lookup: ModelPoolLookup): string | null {
  const pool = lookup.models.filter(isModelEnabled)
  const find = (id?: string | null) => (id ? pool.find((m) => m.id === id) : undefined)

  const bound = find(lookup.bindings?.[category])
  if (bound) return bound.id

  if (category === 'embedding') {
    // 向量用途：默认向量模型 → 声明了向量能力的模型 → 默认生成模型（兼容旧行为）
    const embeddingDefault = find(lookup.defaultEmbeddingModelId)
    if (embeddingDefault) return embeddingDefault.id
    const capableEmbedding = pool.find((m) => (m.purposes ?? []).includes('embedding'))
    if (capableEmbedding) return capableEmbedding.id
    return find(lookup.defaultModelId)?.id ?? null
  }

  const fallback = find(lookup.defaultModelId)
  if (fallback) return fallback.id

  const capable = pool.find((m) => (m.purposes ?? []).includes(category))
  if (capable) return capable.id

  return pool[0]?.id ?? null
}

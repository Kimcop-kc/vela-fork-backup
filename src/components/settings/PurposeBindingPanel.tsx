/**
 * 用途绑定面板（多模型管理）
 *
 * 使用顺序：先在下方「模型池」导入模型，再在这里为每个用途挑选模型。
 * 未绑定的用途回落到默认模型；下拉框只列出「能力标签匹配 + 已启用」的模型，
 * 右侧实时显示该用途最终生效的模型，避免界面与实际调用不一致。
 */
import { useTranslation } from 'react-i18next'
import type { LLMPurposeCategory } from '../../shared/ipc-channels'
import { pickModelIdForCategory, modelsForCategory, PURPOSE_CATEGORY_LABEL_KEY } from '../../shared/purpose-routing'
import { useLLMStore } from '../../stores/llm-store'
import { NativeSelect } from '../ui/NativeSelect'

export default function PurposeBindingPanel({ purposes }: { purposes: readonly LLMPurposeCategory[] }) {
  const { t } = useTranslation('settings')
  const models = useLLMStore(s => s.models)
  const purposeModels = useLLMStore(s => s.purposeModels)
  const defaultModelId = useLLMStore(s => s.defaultModelId)
  const defaultEmbeddingModelId = useLLMStore(s => s.defaultEmbeddingModelId)
  const setPurposeModel = useLLMStore(s => s.setPurposeModel)

  const label = (model: { name: string; modelName: string }) => model.name || model.modelName

  return (
    <div
      className="rounded-xl p-4 space-y-3"
      style={{ border: '1px solid var(--color-border)', backgroundColor: 'var(--color-panel)' }}
    >
      <div>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--color-text)' }}>
          {t('models.purposeTitle')}
        </h3>
        <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
          {t('models.purposeHint')}
        </p>
      </div>

      {models.length === 0 ? (
        <p className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
          {t('models.purposeEmptyPool')}
        </p>
      ) : (
        <div className="space-y-2">
          {purposes.map((category) => {
            const candidates = modelsForCategory(models, category)
            const boundId = purposeModels[category]
            const boundModel = boundId ? models.find((m) => m.id === boundId) : undefined
            // 绑定的模型被停用（或已失效）后不再出现在候选里，补一个占位选项说明现状
            const boundUnavailable = !!boundId && !candidates.some((m) => m.id === boundId)
            const effectiveId = pickModelIdForCategory(category, {
              models,
              bindings: purposeModels,
              defaultModelId,
              defaultEmbeddingModelId,
            })
            const effective = models.find((m) => m.id === effectiveId)
            return (
              <div key={category} className="flex items-center gap-3">
                <span className="w-20 flex-shrink-0 text-xs font-medium" style={{ color: 'var(--color-text)' }}>
                  {t(PURPOSE_CATEGORY_LABEL_KEY[category])}
                </span>
                <NativeSelect
                  aria-label={t(PURPOSE_CATEGORY_LABEL_KEY[category])}
                  className="max-w-[220px]"
                  value={purposeModels[category] ?? ''}
                  onChange={(e) => { void setPurposeModel(category, e.target.value || null) }}
                >
                  <option value="">{t('models.purposeFollowDefault')}</option>
                  {candidates.map((m) => (
                    <option key={m.id} value={m.id}>{label(m)}</option>
                  ))}
                  {boundUnavailable && (
                    <option value={boundId as string}>
                      {boundModel
                        ? `${label(boundModel)} · ${t('models.disabled')}`
                        : t('models.purposeBoundMissing')}
                    </option>
                  )}
                </NativeSelect>
                <span className="text-xs truncate flex-1" style={{ color: 'var(--color-text-muted)' }}>
                  {effective
                    ? t('models.purposeEffective', { name: label(effective) })
                    : t('models.purposeNoModel')}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

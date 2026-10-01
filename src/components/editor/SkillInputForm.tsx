import { useTranslation } from 'react-i18next'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import { skillInputLabel, skillInputType, type SkillInputField } from '../../services/agent/skill-inputs'

interface SkillInputFormProps {
  /** Skill 声明的参数 schema */
  fields: SkillInputField[]
  /** 当前参数值（统一按字符串存，boolean 用 'true' / 'false'） */
  values: Record<string, string>
  onChange: (name: string, value: string) => void
  /** 紧凑模式：流水线里每步参数挤在一起时用，去掉了分组标题、间距更小 */
  compact?: boolean
  /** 是否显示分组标题 */
  showHeading?: boolean
}

/**
 * 按 Skill 的 inputs schema 渲染参数表单
 *
 * 「写章节时调用 Skill」和「Skill 流水线」共用这一份渲染逻辑，
 * 保证同一个 Skill 在两处看到的表单完全一致。
 */
export default function SkillInputForm({
  fields,
  values,
  onChange,
  compact = false,
  showHeading = true,
}: SkillInputFormProps) {
  const { t } = useTranslation('editors')
  if (fields.length === 0) return null

  return (
    <div className={compact ? 'space-y-2' : 'space-y-3'}>
      {showHeading && (
        <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
          {t('draftEditor.skillInvokeInputs')}
        </div>
      )}
      {fields.map(field => {
        const type = skillInputType(field)
        const value = values[field.name] ?? ''
        const placeholder = field.placeholder ?? field.description ?? ''
        return (
          <div key={field.name}>
            <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
              {skillInputLabel(field)}
              {field.required && <span style={{ color: 'var(--color-error, #ef4444)' }}> *</span>}
            </label>
            {type === 'textarea' ? (
              <Textarea
                value={value}
                rows={4}
                placeholder={placeholder}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            ) : type === 'boolean' ? (
              <label className="flex items-center gap-2 text-xs cursor-pointer select-none" style={{ color: 'var(--color-text-secondary)' }}>
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(e) => onChange(field.name, e.target.checked ? 'true' : 'false')}
                />
                <span>{field.description ?? t('draftEditor.skillInvokeBoolToggle')}</span>
              </label>
            ) : type === 'select' ? (
              <NativeSelect value={value} onChange={(e) => onChange(field.name, e.target.value)}>
                <option value="">{t('draftEditor.skillInvokeSelectPlaceholder')}</option>
                {(field.options ?? []).map(option => (
                  <option key={option.value} value={option.value}>{option.label ?? option.value}</option>
                ))}
              </NativeSelect>
            ) : (
              <Input
                type={type === 'number' ? 'number' : 'text'}
                value={value}
                placeholder={placeholder}
                onChange={(e) => onChange(field.name, e.target.value)}
              />
            )}
            {field.description && type !== 'boolean' && (
              <p className="text-[0.68rem] mt-1" style={{ color: 'var(--color-text-muted)' }}>
                {field.description}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}

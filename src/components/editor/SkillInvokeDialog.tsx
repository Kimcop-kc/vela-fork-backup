import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Sparkles, Puzzle } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import { skillRegistry, type LoadedSkill } from '../../services/agent/skill-registry'
import {
  defaultSkillValues,
  missingRequiredSkillValues,
  skillInputLabel,
  type SkillInputField,
} from '../../services/agent/skill-inputs'
import SkillInputForm from './SkillInputForm'

interface SkillInvokeDialogProps {
  open: boolean
  onClose: () => void
  /**
   * 确认执行。
   *
   * values 是按 Skill 的 inputs schema 收集到的结构化参数；
   * args 是自由文本，只有未声明 schema 的老 Skill 才会用到。
   */
  onRun: (skill: LoadedSkill, args: string, values: Record<string, string>) => void
}

/**
 * 写作时调用 Skill
 *
 * 只列出「已启用的」Skill；停用的 Skill 需要先到 Agent 面板的「技能列表」里启用。
 * Skill 声明了 inputs 时按 schema 生成表单，否则退回单个自由参数输入框。
 */
export default function SkillInvokeDialog({ open, onClose, onRun }: SkillInvokeDialogProps) {
  const { t } = useTranslation('editors')
  const [selected, setSelected] = useState('')
  const [args, setArgs] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [error, setError] = useState('')
  /** 当前 values 是按哪个 Skill 的 schema 生成的 */
  const [formFor, setFormFor] = useState('')

  // 每次渲染都直接读取已启用列表，避免用到过期的列表
  const options: LoadedSkill[] = open ? skillRegistry.listEnabled() : []
  // 之前选中的 Skill 被停用/删除时，回退到第一个可用的
  const selectedName = options.some(s => s.metadata.name === selected)
    ? selected
    : options[0]?.metadata.name ?? ''

  const skill = options.find(s => s.metadata.name === selectedName) ?? null
  const fields: SkillInputField[] = skill?.metadata.inputs ?? []

  // 换 Skill（含刚打开时回退到第一个）就按新 schema 重置表单。
  // 这里在渲染期派生而不是放进 useEffect：effect 里同步 setState 会触发级联渲染。
  if (open && selectedName && formFor !== selectedName) {
    setFormFor(selectedName)
    setValues(defaultSkillValues(fields))
    setError('')
  }

  const setValue = (name: string, value: string) => {
    setValues(prev => ({ ...prev, [name]: value }))
  }

  const handleRun = () => {
    if (!skill) return
    const missing = missingRequiredSkillValues(fields, values)
    if (missing.length > 0) {
      setError(t('draftEditor.skillInvokeRequired', { field: missing.map(skillInputLabel).join(' / ') }))
      return
    }
    setError('')
    onRun(skill, args.trim(), values)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[440px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Puzzle size={15} className="text-[var(--color-accent)]" />
            {t('draftEditor.skillInvokeDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('draftEditor.skillInvokeDialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 space-y-3">
          <div>
            <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
              {t('draftEditor.skillInvokeSelect')}
            </label>
            {options.length === 0 ? (
              <div className="text-xs" style={{ color: 'var(--color-text-muted)' }}>
                {t('draftEditor.skillInvokeEmpty')}
              </div>
            ) : (
              <NativeSelect value={selectedName} onChange={(e) => setSelected(e.target.value)}>
                {options.map(s => (
                  <option key={s.metadata.name} value={s.metadata.name}>
                    {s.metadata.displayName ?? s.metadata.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </div>

          {fields.length > 0 ? (
            <SkillInputForm fields={fields} values={values} onChange={setValue} />
          ) : (
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('draftEditor.skillInvokeArgs')}
              </label>
              <Input
                value={args}
                onChange={(e) => setArgs(e.target.value)}
                placeholder={t('draftEditor.skillInvokeArgsPlaceholder')}
              />
            </div>
          )}

          {error && (
            <p className="text-[0.7rem]" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>
          )}

          <p className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {t('draftEditor.skillInvokeHint')}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('draftEditor.cancel')}</Button>
          <Button variant="ai" onClick={handleRun} disabled={options.length === 0}>
            <Sparkles size={12} />
            {t('draftEditor.skillInvokeRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

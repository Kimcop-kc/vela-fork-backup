import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Save, Trash2, Upload, CopyPlus } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { Textarea } from '../../ui/Textarea'
import { NativeSelect } from '../../ui/NativeSelect'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import {
  buildSkillTemplate, copySkillFile, deleteSkillFile, importSkillFile,
  readSkillFile, writeSkillFile, type SkillScope,
} from '../../../services/skill-service'
import type { LoadedSkill } from '../../../services/agent/skill-registry'

interface SkillEditorDialogProps {
  open: boolean
  /** 待编辑的 Skill；null 表示新建 */
  skill: LoadedSkill | null
  onClose: () => void
  /** 保存 / 删除 / 复制成功后回调（用于重新加载 Skill 列表） */
  onChanged: () => void
}

/**
 * 应用内 Skill 编辑器
 *
 * 支持新建、编辑替换（写入 SKILL.md）、从磁盘导入、删除、复制到项目级。
 * 内置 Skill 只能「另存为覆盖」：保存到用户级或项目级后即替换内置方法。
 */
export default function SkillEditorDialog({ open, skill, onClose, onChanged }: SkillEditorDialogProps) {
  const { t } = useTranslation('panels')
  const isBuiltin = skill?.source === 'builtin'
  const isNew = !skill

  const [name, setName] = useState('')
  const [scope, setScope] = useState<SkillScope>('user')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)

  // 每次打开时初始化表单
  useEffect(() => {
    if (!open) return
    const targetName = skill?.metadata.name ?? ''
    const targetScope: SkillScope = skill && (skill.source === 'user' || skill.source === 'project')
      ? skill.source
      : 'user'
    setName(targetName)
    setScope(targetScope)

    if (!skill) {
      setContent(buildSkillTemplate('my-skill'))
      return
    }
    if (isBuiltin) {
      // 内置 Skill：预填一份可覆盖的模板，用户保存后即替换内置方法
      setContent([
        '---',
        `name: ${targetName}`,
        `display_name: ${skill.metadata.displayName ?? targetName}`,
        `description: ${skill.metadata.description}`,
        'version: 1.0.0',
        'user-invocable: true',
        '---',
        '',
        skill.content,
        '',
      ].join('\n'))
      return
    }
    // 用户级 / 项目级：读取磁盘原文（含 frontmatter）
    let cancelled = false
    readSkillFile(targetName, targetScope).then(result => {
      if (cancelled) return
      setContent(result.success ? result.content : skill.content)
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, skill?.metadata.name, skill?.source])

  const handleImport = async () => {
    const imported = await importSkillFile()
    if (!imported) return
    setContent(imported.content)
    if (isNew) setName(imported.name.toLowerCase().replace(/[^a-z0-9._-]/g, '-'))
  }

  const handleSave = async () => {
    if (!name.trim()) {
      toast.error(t('agent.skillEditor.nameRequired'))
      return
    }
    setBusy(true)
    try {
      const result = await writeSkillFile(name.trim(), content, scope)
      if (!result.success) {
        toast.error(t('agent.skillEditor.saveFailed', { error: result.error ?? '' }))
        return
      }
      toast.success(t('agent.skillEditor.saveSuccess', { path: result.filePath ?? '' }))
      onChanged()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async () => {
    if (!skill || isBuiltin) return
    const ok = await confirm(t('agent.skillEditor.deleteConfirm', { name: skill.metadata.name }), { danger: true })
    if (!ok) return
    setBusy(true)
    try {
      const result = await deleteSkillFile(skill.metadata.name, scope)
      if (!result.success) {
        toast.error(t('agent.skillEditor.deleteFailed', { error: result.error ?? '' }))
        return
      }
      toast.success(t('agent.skillEditor.deleteSuccess'))
      onChanged()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const handleCopyToProject = async () => {
    if (!skill) return
    setBusy(true)
    try {
      const result = await copySkillFile(skill.metadata.name, 'user', 'project')
      if (!result.success) {
        toast.error(t('agent.skillEditor.copyFailed', { error: result.error ?? '' }))
        return
      }
      toast.success(t('agent.skillEditor.copySuccess'))
      onChanged()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{isNew ? t('agent.skillEditor.createTitle') : t('agent.skillEditor.editTitle', { name: skill?.metadata.name ?? '' })}</DialogTitle>
          <DialogDescription>{t('agent.skillEditor.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 space-y-3">
          <div className="flex items-end gap-2">
            <div className="flex-1 min-w-0">
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('agent.skillEditor.nameLabel')}
              </label>
              <Input
                value={name}
                disabled={!isNew}
                onChange={(e) => setName(e.target.value)}
                placeholder="my-skill"
              />
            </div>
            <div className="w-[150px] flex-shrink-0">
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('agent.skillEditor.scopeLabel')}
              </label>
              <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as SkillScope)}>
                <option value="user">{t('agent.userScope')} ~/.vela/skills/</option>
                <option value="project">{t('agent.projectScope')} .vela/skills/</option>
              </NativeSelect>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {t('agent.skillEditor.contentLabel')}
              </label>
              <Button variant="outline" size="sm" onClick={handleImport} disabled={busy}>
                <Upload size={11} />
                {t('agent.skillEditor.importFile')}
              </Button>
            </div>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={16}
              className="font-mono text-[0.72rem]"
              spellCheck={false}
            />
            <p className="mt-1 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
              {t('agent.skillEditor.contentHint')}
            </p>
          </div>
        </div>

        <DialogFooter className="justify-between">
          <div className="flex items-center gap-2">
            {!isNew && !isBuiltin && (
              <Button variant="outline" onClick={handleDelete} disabled={busy}>
                <Trash2 size={11} />
                {t('agent.skillEditor.delete')}
              </Button>
            )}
            {skill?.source === 'user' && (
              <Button variant="outline" onClick={handleCopyToProject} disabled={busy}>
                <CopyPlus size={11} />
                {t('agent.skillEditor.copyToProject')}
              </Button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={busy}>
              {t('agent.skillEditor.cancel')}
            </Button>
            <Button variant="ai" onClick={handleSave} disabled={busy}>
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
              {t('agent.skillEditor.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

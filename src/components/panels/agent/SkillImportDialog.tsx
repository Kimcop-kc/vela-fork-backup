import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Download, FileArchive, GitBranch, Loader2, Search } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../../ui/Dialog'
import { Button } from '../../ui/Button'
import { Input } from '../../ui/Input'
import { NativeSelect } from '../../ui/NativeSelect'
import { confirm } from '../../ui/Confirm'
import { toast } from '../../ui/Toast'
import { inspectSkillPackage, installSkillPackage, type SkillScope } from '../../../services/skill-service'
import type { SkillPackageCandidate, SkillPackageSource } from '../../../shared/ipc-channels'
import { cn } from '../../../lib/utils'

interface SkillImportDialogProps {
  open: boolean
  onClose: () => void
  /** 安装成功后的回调（重新加载 Skill 列表） */
  onImported: () => void | Promise<void>
}

/**
 * Skill 分发：从 GitHub 仓库或 zip 导入整包 Skill
 *
 * 两步走 —— 先「检查」把包解开列出候选（含版本、描述、文件数），
 * 再选一个装到用户级或项目级；同名时先问一句再覆盖。
 */
export default function SkillImportDialog({ open, onClose, onImported }: SkillImportDialogProps) {
  const { t } = useTranslation('panels')
  const [kind, setKind] = useState<'github' | 'zip'>('github')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState('')
  const [source, setSource] = useState<SkillPackageSource | null>(null)
  const [candidates, setCandidates] = useState<SkillPackageCandidate[]>([])
  // 用 null 表示「还没选」：候选目录在包根时是空串，空串不能当作未选中
  const [selectedDir, setSelectedDir] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<SkillScope>('user')

  // 每次打开都从干净状态开始，避免看到上一次的残留结果
  useEffect(() => {
    if (!open) return
    setBusy(false)
    setToken('')
    setSource(null)
    setCandidates([])
    setSelectedDir(null)
    setName('')
  }, [open])

  const selected = candidates.find(candidate => candidate.dir === selectedDir)

  /** 检查包：zip 会弹系统文件选择框，GitHub 直接下载 */
  const handleInspect = async () => {
    setBusy(true)
    try {
      const result = await inspectSkillPackage(kind === 'zip' ? { kind: 'zip' } : { kind: 'github', url: url.trim() })
      if (result.cancelled) return
      if (!result.success || !result.token || !result.candidates?.length) {
        toast.error(result.error ?? t('agent.skillImport.inspectFailed'))
        return
      }
      setToken(result.token)
      setSource(result.source ?? null)
      setCandidates(result.candidates)
      setSelectedDir(result.candidates[0].dir)
      setName(result.candidates[0].name)
    } finally {
      setBusy(false)
    }
  }

  /** 安装：同名先确认再覆盖 */
  const handleInstall = async () => {
    if (!token || selectedDir === null) return
    setBusy(true)
    try {
      const payload = { token, dir: selectedDir, scope, name: name.trim() || undefined }
      let result = await installSkillPackage(payload)
      if (!result.success && result.code === 'exists') {
        setBusy(false)
        const ok = await confirm(t('agent.skillImport.overwriteConfirm', { name: name.trim() || selected?.name }), { danger: true })
        if (!ok) return
        setBusy(true)
        result = await installSkillPackage({ ...payload, overwrite: true })
      }
      if (!result.success) {
        toast.error(result.error ?? t('agent.skillImport.installFailed'))
        return
      }
      toast.success(t('agent.skillImport.installed', { name: result.name ?? '', count: result.fileCount ?? 0 }))
      await onImported()
      onClose()
    } finally {
      setBusy(false)
    }
  }

  const TABS: Array<{ value: 'github' | 'zip'; label: string; icon: React.ReactNode }> = [
    { value: 'github', label: t('agent.skillImport.tabGithub'), icon: <GitBranch size={13} /> },
    { value: 'zip', label: t('agent.skillImport.tabZip'), icon: <FileArchive size={13} /> },
  ]

  return (
    <Dialog open={open} onOpenChange={(v) => !v && !busy && onClose()}>
      <DialogContent className="max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={15} className="text-[var(--color-accent)]" />
            {t('agent.skillImport.title')}
          </DialogTitle>
          <DialogDescription>{t('agent.skillImport.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 space-y-3">
          {/* 来源类型 */}
          <div className="flex items-center gap-1.5">
            {TABS.map(tab => (
              <Button
                key={tab.value}
                variant={kind === tab.value ? 'default' : 'outline'}
                size="sm"
                disabled={busy}
                onClick={() => { setKind(tab.value); setCandidates([]); setSource(null); setToken('') }}
              >
                {tab.icon}
                {tab.label}
              </Button>
            ))}
          </div>

          {/* 来源输入 */}
          {kind === 'github' ? (
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('agent.skillImport.urlLabel')}
              </label>
              <div className="flex items-center gap-2">
                <Input
                  value={url}
                  placeholder={t('agent.skillImport.urlPlaceholder')}
                  disabled={busy}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleInspect() }}
                />
                <Button variant="outline" onClick={handleInspect} disabled={busy || !url.trim()}>
                  {busy ? <Loader2 size={12} className="animate-spin" /> : <Search size={12} />}
                  {busy ? t('agent.skillImport.inspecting') : t('agent.skillImport.inspect')}
                </Button>
              </div>
              <p className="mt-1 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                {t('agent.skillImport.urlHint')}
              </p>
            </div>
          ) : (
            <div>
              <Button variant="outline" onClick={handleInspect} disabled={busy}>
                {busy ? <Loader2 size={12} className="animate-spin" /> : <FileArchive size={12} />}
                {busy ? t('agent.skillImport.inspecting') : t('agent.skillImport.pickZip')}
              </Button>
              <p className="mt-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                {t('agent.skillImport.zipHint')}
              </p>
            </div>
          )}

          {/* 包内候选 */}
          {source && (
            <div className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
              {t('agent.skillImport.sourceLabel', { label: source.label })}
              {source.ref ? ` @ ${source.ref}` : ''}
              {source.subdir ? ` / ${source.subdir}` : ''}
            </div>
          )}

          {candidates.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {t('agent.skillImport.candidates', { count: candidates.length })}
              </div>
              <div className="max-h-[180px] overflow-y-auto space-y-1">
                {candidates.map(candidate => (
                  <div
                    key={candidate.dir || '__root__'}
                    onClick={() => { setSelectedDir(candidate.dir); setName(candidate.name) }}
                    className={cn(
                      'px-2.5 py-2 rounded-lg cursor-pointer border text-xs transition-colors',
                      candidate.dir === selectedDir
                        ? 'bg-[var(--color-active)] border-[var(--color-accent)]'
                        : 'bg-[var(--color-panel)] border-[var(--color-border)] hover:bg-[var(--color-hover)]',
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium truncate" style={{ color: 'var(--color-text)' }}>
                        {candidate.displayName ?? candidate.name}
                      </span>
                      {candidate.version && (
                        <span className="text-[0.6rem] px-1 rounded flex-shrink-0"
                          style={{ backgroundColor: 'rgba(59,130,246,0.12)', color: '#3b82f6' }}>
                          v{candidate.version}
                        </span>
                      )}
                      <span className="ml-auto text-[0.62rem] flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                        {t('agent.skillImport.fileCount', { count: candidate.fileCount })}
                      </span>
                    </div>
                    {candidate.description && (
                      <div className="truncate mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                        {candidate.description}
                      </div>
                    )}
                    <div className="text-[0.62rem] mt-0.5 font-mono truncate" style={{ color: 'var(--color-text-muted)' }}>
                      {candidate.dir || '.'}/SKILL.md
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 安装位置与名称 */}
          {token && (
            <div className="flex items-end gap-2">
              <div className="flex-1 min-w-0">
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('agent.skillImport.installName')}
                </label>
                <Input value={name} disabled={busy} onChange={(e) => setName(e.target.value)} placeholder="my-skill" />
              </div>
              <div className="w-[150px] flex-shrink-0">
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('agent.skillImport.scopeLabel')}
                </label>
                <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as SkillScope)} disabled={busy}>
                  <option value="user">{t('agent.userScope')} ~/.vela/skills/</option>
                  <option value="project">{t('agent.projectScope')} .vela/skills/</option>
                </NativeSelect>
              </div>
            </div>
          )}
        </div>

        <DialogFooter className="justify-end">
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t('agent.skillImport.cancel')}
          </Button>
          <Button variant="ai" onClick={handleInstall} disabled={busy || !token || selectedDir === null}>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Download size={12} />}
            {busy ? t('agent.skillImport.installing') : t('agent.skillImport.install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

import { useState } from 'react'
import { BookOpen, Download, FileText, Files, Type } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { exportNovel, type ExportFormat } from '../../services/export-service'
import { ipc } from '../../services/ipc-client'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { cn } from '../../lib/utils'

interface Props {
  isOpen: boolean
  onClose: () => void
}

/** 导出对话框 — 使用 shadcn/ui */
export default function ExportDialog({ isOpen, onClose }: Props) {
  const { t } = useTranslation('dialogs')
  const currentProject = useProjectStore(s => s.currentProject)
  const [format, setFormat] = useState<ExportFormat>('merged-md')
  const [includeOutline, setIncludeOutline] = useState(true)
  const [author, setAuthor] = useState('')
  const [backup, setBackup] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ success: boolean; path?: string; backupPath?: string; error?: string } | null>(null)

  const handleExport = async () => {
    if (!currentProject) return
    const dir = await ipc.invoke('dialog:select-folder')
    if (!dir) return

    setExporting(true)
    setResult(null)
    const res = await exportNovel({ format, outputDir: dir, includeOutline, author, backup })
    setResult(res)
    setExporting(false)
  }

  const FORMAT_OPTIONS: Array<{ value: ExportFormat; label: string; desc: string; icon: React.ReactNode }> = [
    { value: 'epub', label: t('export.formatEpub'), desc: t('export.formatEpubDesc'), icon: <BookOpen size={18} /> },
    { value: 'merged-md', label: t('export.formatMergedMd'), desc: t('export.formatMergedMdDesc'), icon: <FileText size={18} /> },
    { value: 'split-md', label: t('export.formatSplitMd'), desc: t('export.formatSplitMdDesc'), icon: <Files size={18} /> },
    { value: 'txt', label: t('export.formatTxt'), desc: t('export.formatTxtDesc'), icon: <Type size={18} /> },
  ]

  return (
    <Dialog open={isOpen} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download size={16} className="text-[var(--color-accent)]" />
            {t('export.title')}
          </DialogTitle>
          <DialogDescription>{t('export.description')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-4 space-y-3">
          {/* 格式选择 */}
          <div className="space-y-2">
            {FORMAT_OPTIONS.map((opt) => (
              <div
                key={opt.value}
                onClick={() => setFormat(opt.value)}
                className={cn(
                  'flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors border',
                  format === opt.value
                    ? 'bg-[var(--color-active)] border-[var(--color-accent)]'
                    : 'bg-[var(--color-panel)] border-[var(--color-border)] hover:bg-[var(--color-hover)]'
                )}
              >
                <div className={cn(
                  'transition-colors',
                  format === opt.value ? 'text-[var(--color-accent)]' : 'text-[var(--color-text-secondary)]'
                )}>
                  {opt.icon}
                </div>
                <div>
                  <div className="text-xs font-medium text-[var(--color-text)]">{opt.label}</div>
                  <div className="text-xs text-[var(--color-text-muted)]">{opt.desc}</div>
                </div>
              </div>
            ))}
          </div>

          {/* EPUB 作者署名 */}
          {format === 'epub' && (
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('export.authorLabel')}
              </label>
              <Input
                value={author}
                placeholder={t('export.authorPlaceholder')}
                onChange={(e) => setAuthor(e.target.value)}
              />
            </div>
          )}

          {/* 选项 */}
          {format === 'merged-md' && (
            <label className="flex items-center gap-2 text-xs cursor-pointer text-[var(--color-text-secondary)]">
              <input type="checkbox" checked={includeOutline} onChange={(e) => setIncludeOutline(e.target.checked)} />
              {t('export.includeOutline')}
            </label>
          )}

          <label className="flex items-start gap-2 text-xs cursor-pointer text-[var(--color-text-secondary)]">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={backup}
              onChange={(e) => setBackup(e.target.checked)}
            />
            <span>
              {t('export.backup')}
              <span className="block text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                {t('export.backupDesc')}
              </span>
            </span>
          </label>

          {/* 结果 */}
          {result && (
            <div className={cn(
              'p-3 rounded-lg text-xs',
              result.success ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'
            )}>
              {result.success ? t('export.exported', { path: result.path }) : t('export.exportError', { error: result.error })}
              {result.success && result.backupPath && (
                <div className="mt-1">{t('export.exportedBackup', { path: result.backupPath })}</div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="justify-end">
          <Button variant="default" onClick={handleExport} disabled={exporting}>
            <Download size={13} />
            {exporting ? t('export.exporting') : t('export.selectAndExport')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

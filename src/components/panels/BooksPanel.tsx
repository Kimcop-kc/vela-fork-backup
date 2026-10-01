/**
 * BooksPanel — 拆书知识库侧栏
 *
 * 导入参考小说 → 自动按章拆分 → 写入本地知识库（LanceDB）；
 * 这里负责导入、列出与选择要查看的书，正文区由 BooksOverview 展示。
 */
import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { BookMarked, Trash2, Upload } from 'lucide-react'
import { useLayoutStore } from '../../stores/layout-store'
import { useProjectStore } from '../../stores/project-store'
import { Button } from '../ui/Button'
import { IconBtn } from '../ui/IconBtn'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import { globalEventBus } from '../../shared/event-bus'
import {
  deconstructBook, listBooks, removeBook, selectBookFiles, type BookRecord,
} from '../../services/book-service'

export default function BooksPanel() {
  const { t } = useTranslation('panels')
  const currentProject = useProjectStore(s => s.currentProject)
  const selectedBookId = useLayoutStore(s => s.selectedBookId)
  const setSelectedBookId = useLayoutStore(s => s.setSelectedBookId)
  const [books, setBooks] = useState<BookRecord[]>([])
  const [importing, setImporting] = useState(false)
  const projectPath = currentProject?.path ?? null

  const reload = useCallback(async () => {
    if (!projectPath) {
      setBooks([])
      return
    }
    try {
      setBooks(await listBooks())
    } catch {
      // 忽略：读取失败时保持上一次列表
    }
  }, [projectPath])

  useEffect(() => { void reload() }, [reload])

  /** 知识库/文件树刷新时同步刷新拆书列表 */
  useEffect(() => {
    const unsubscribe = globalEventBus.on('REFRESH_RESOURCE', (payload: { resources: string[] }) => {
      if (payload.resources.includes('all')) void reload()
    })
    return unsubscribe
  }, [reload])

  /** 导入参考小说并拆书入库 */
  const handleImport = async () => {
    if (!projectPath) {
      toast.error(t('books.noProject'))
      return
    }
    const files = await selectBookFiles()
    if (!files || files.length === 0) return

    setImporting(true)
    try {
      let okCount = 0
      let lastBookId: string | null = null
      for (const file of files) {
        const result = await deconstructBook(file)
        if (result.success && result.book) {
          okCount++
          lastBookId = result.book.id
        } else {
          toast.error(t('books.importFailed', {
            name: file.split(/[\\/]/).pop() ?? file,
            error: result.error ?? '',
          }))
        }
      }
      if (okCount > 0) {
        toast.success(t('books.importDone', { count: okCount }))
        await reload()
        if (lastBookId) setSelectedBookId(lastBookId)
        // 让知识库面板同步看到新入库的章节
        globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
      }
    } finally {
      setImporting(false)
    }
  }

  /** 删除一本拆书 */
  const handleRemove = async (book: BookRecord) => {
    const ok = await confirm(t('books.removeConfirm', { name: book.name }), { danger: true })
    if (!ok) return
    const result = await removeBook(book.id)
    if (!result.success) {
      toast.error(t('books.removeFailed', { error: result.error ?? '' }))
      return
    }
    toast.success(t('books.removeDone', { count: result.removedChapters }))
    if (selectedBookId === book.id) setSelectedBookId(null)
    await reload()
    globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
  }

  return (
    <div className="px-2 py-1.5">
      <Button
        variant="outline"
        size="sm"
        className="w-full justify-center"
        onClick={() => { void handleImport() }}
        disabled={importing || !currentProject}
      >
        <Upload size={11} />
        {importing ? t('books.importing') : t('books.import')}
      </Button>

      <p className="mt-1.5 text-[0.68rem] leading-relaxed" style={{ color: 'var(--color-text-muted)' }}>
        {t('books.importHint')}
      </p>

      {books.length === 0 ? (
        <div className="mt-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{t('books.empty')}</div>
          <div className="text-[0.68rem] opacity-60">{t('books.emptyHint')}</div>
        </div>
      ) : (
        <div className="mt-2 space-y-0.5">
          {books.map(book => {
            const active = book.id === selectedBookId
            return (
              <div
                key={book.id}
                className="group flex items-center gap-1.5 px-1.5 py-1 rounded cursor-pointer text-xs"
                style={{
                  backgroundColor: active ? 'var(--color-hover)' : 'transparent',
                  color: active ? 'var(--color-text)' : 'var(--color-text-secondary)',
                }}
                onClick={() => setSelectedBookId(book.id)}
              >
                <BookMarked size={12} className="flex-shrink-0" style={{ color: 'var(--color-accent)', opacity: active ? 1 : 0.7 }} />
                <div className="flex-1 min-w-0">
                  <div className="truncate font-medium">{book.name}</div>
                  <div className="text-[0.65rem] truncate" style={{ color: 'var(--color-text-muted)' }}>
                    {t('books.metaLine', { chapters: book.chapterCount, words: book.wordCount })}
                  </div>
                </div>
                <IconBtn
                  title={t('books.remove')}
                  size={18}
                  onClick={() => { void handleRemove(book) }}
                >
                  <Trash2 size={11} />
                </IconBtn>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

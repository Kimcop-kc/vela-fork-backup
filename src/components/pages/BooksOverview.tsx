/**
 * BooksOverview — 拆书知识库正文区
 *
 * 展示选中的拆书：章节清单 + 「本书范围内」检索。
 * 拆书内容与普通知识库共用 LanceDB，检索结果按书名前缀过滤即为本书范围。
 */
import { useCallback, useEffect, useState } from 'react'
import { BookMarked, ChevronDown, ChevronRight, Copy, Loader2, Search, ScrollText, Trash2, Upload } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { EmptyState } from '../ui/EmptyState'
import { confirm } from '../ui/Confirm'
import { toast } from '../ui/Toast'
import { useLayoutStore } from '../../stores/layout-store'
import { useEditorStore } from '../../stores/editor-store'
import { useProjectStore } from '../../stores/project-store'
import { globalEventBus } from '../../shared/event-bus'
import {
  bookFileNamePrefix, deconstructBook, listBooks, removeBook, searchKnowledgeBase,
  getChapterText, selectBookFiles, type BookChapterEntry, type BookRecord,
} from '../../services/book-service'

export default function BooksOverview() {
  const { t } = useTranslation('pages', { keyPrefix: 'booksOverview' })
  // 打开「小说配置」页签时要用 panels 命名空间的标题（带 keyPrefix 的 t 不能跨命名空间查）
  const { t: tPanels } = useTranslation('panels')
  const currentProject = useProjectStore(s => s.currentProject)
  const selectedBookId = useLayoutStore(s => s.selectedBookId)
  const setSelectedBookId = useLayoutStore(s => s.setSelectedBookId)
  const sendToStyleAnalysis = useLayoutStore(s => s.sendToStyleAnalysis)

  const [books, setBooks] = useState<BookRecord[]>([])
  const [importing, setImporting] = useState(false)
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<Array<{ text: string; score: number; fileName: string }>>([])
  // 章节正文懒加载：展开时按 docId 取回整章内容
  const [openChapterId, setOpenChapterId] = useState<string | null>(null)
  const [chapterTexts, setChapterTexts] = useState<Record<string, string>>({})
  const [loadingChapterId, setLoadingChapterId] = useState<string | null>(null)
  const projectPath = currentProject?.path ?? null

  const book = books.find(b => b.id === selectedBookId) ?? null

  const reload = useCallback(async () => {
    if (!projectPath) {
      setBooks([])
      return
    }
    try {
      setBooks(await listBooks())
    } catch {
      // 忽略
    }
  }, [projectPath])

  useEffect(() => { void reload() }, [reload])

  // 没有选中书时自动选第一本
  useEffect(() => {
    if (!selectedBookId && books.length > 0) setSelectedBookId(books[0].id)
  }, [books, selectedBookId, setSelectedBookId])

  useEffect(() => {
    const unsubscribe = globalEventBus.on('REFRESH_RESOURCE', (payload: { resources: string[] }) => {
      if (payload.resources.includes('all')) void reload()
    })
    return unsubscribe
  }, [reload])

  // 在本书范围内检索
  const handleSearch = async () => {
    if (!book || !query.trim()) return
    setSearching(true)
    try {
      const all = await searchKnowledgeBase(query.trim(), 8)
      const prefix = bookFileNamePrefix(book.name)
      setResults(all.filter(r => r.fileName.startsWith(prefix)))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const handleImport = async () => {
    if (!projectPath) return
    const files = await selectBookFiles()
    if (!files || files.length === 0) return
    setImporting(true)
    try {
      for (const file of files) {
        const result = await deconstructBook(file)
        if (result.success && result.book) {
          toast.success(t('importDone', { name: result.book.name, chapters: result.book.chapterCount }))
          setSelectedBookId(result.book.id)
        } else {
          toast.error(t('importFailed', { error: result.error ?? '' }))
        }
      }
      await reload()
      globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
    } finally {
      setImporting(false)
    }
  }

  const handleRemove = async () => {
    if (!book) return
    const ok = await confirm(t('removeConfirm', { name: book.name }), { danger: true })
    if (!ok) return
    const result = await removeBook(book.id)
    if (!result.success) {
      toast.error(t('removeFailed', { error: result.error ?? '' }))
      return
    }
    toast.success(t('removeDone', { count: result.removedChapters }))
    setSelectedBookId(null)
    setResults([])
    setOpenChapterId(null)
    setChapterTexts({})
    await reload()
    globalEventBus.emit('REFRESH_RESOURCE', { resources: ['all'] })
  }

  /** 取回章节正文；已读过的直接走缓存 */
  const ensureChapterText = useCallback(async (chapter: BookChapterEntry): Promise<string | null> => {
    const cached = chapterTexts[chapter.docId]
    if (cached !== undefined) return cached
    setLoadingChapterId(chapter.docId)
    try {
      const result = await getChapterText(chapter.docId)
      if (result.success && result.text) {
        setChapterTexts(prev => ({ ...prev, [chapter.docId]: result.text as string }))
        return result.text
      }
      toast.error(t('loadChapterFailed', { error: result.error ?? '' }))
      return null
    } catch (error) {
      toast.error(t('loadChapterFailed', { error: String(error) }))
      return null
    } finally {
      setLoadingChapterId(null)
    }
  }, [chapterTexts, t])

  const handleToggleChapter = async (chapter: BookChapterEntry) => {
    if (openChapterId === chapter.docId) {
      setOpenChapterId(null)
      return
    }
    setOpenChapterId(chapter.docId)
    if (chapterTexts[chapter.docId] === undefined) await ensureChapterText(chapter)
  }

  const handleCopyChapter = async (chapter: BookChapterEntry) => {
    const text = await ensureChapterText(chapter)
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('chapterCopied'))
    } catch {
      toast.error(t('copyFailed'))
    }
  }

  /** 把这一章送去文风分析：切到项目视图 → 打开小说配置 → 预填文风指南弹框 */
  const handleUseAsStyleReference = async (chapter: BookChapterEntry) => {
    if (!book) return
    const text = await ensureChapterText(chapter)
    if (!text) return
    await useEditorStore.getState().openFile({
      id: 'config',
      name: tPanels('editorArea.configTab'),
      type: 'config',
    })
    sendToStyleAnalysis({ source: book.name + ' · ' + chapter.title, text })
    toast.success(t('styleReferenceSent'))
  }

  if (!currentProject) {
    return (
      <div className="h-full flex items-center justify-center" style={{ backgroundColor: 'var(--color-bg)' }}>
        <EmptyState icon={<BookMarked size={22} />} message={t('openProjectFirst')} opacity={0.5} />
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col overflow-hidden" style={{ backgroundColor: 'var(--color-bg)' }}>
      {/* 顶部工具栏 */}
      <div
        className="flex items-center justify-between gap-2 px-3 h-9 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--color-border)', backgroundColor: 'var(--color-editor-bg)' }}
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <BookMarked size={13} style={{ color: 'var(--color-accent)' }} />
          <span className="text-xs font-medium truncate" style={{ color: 'var(--color-text-secondary)' }}>
            {t('title')}
          </span>
          {book && (
            <span className="text-[0.68rem] truncate" style={{ color: 'var(--color-text-muted)' }}>
              {t('bookStats', { chapters: book.chapterCount, words: book.wordCount })}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <Button variant="outline" size="sm" onClick={() => { void handleImport() }} disabled={importing}>
            <Upload size={11} />
            {importing ? t('importing') : t('import')}
          </Button>
          {book && (
            <Button variant="outline" size="sm" onClick={() => { void handleRemove() }}>
              <Trash2 size={11} />
              {t('remove')}
            </Button>
          )}
        </div>
      </div>

      {!book ? (
        <div className="flex-1 flex items-center justify-center">
          <EmptyState
            icon={<BookMarked size={22} />}
            message={`${t('empty')} — ${t('emptyHint')}`}
            opacity={0.5}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {/* 书籍信息 */}
          <div className="text-[0.7rem] space-y-0.5" style={{ color: 'var(--color-text-muted)' }}>
            <div>{t('source', { path: book.sourcePath })}</div>
            <div>{book.vectorized ? t('vectorized') : t('fulltextOnly')}</div>
          </div>

          {/* 本书检索 */}
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch() }}
              placeholder={t('searchPlaceholder')}
            />
            <Button variant="outline" size="sm" onClick={() => { void handleSearch() }} disabled={searching || !query.trim()}>
              <Search size={11} />
              {t('search')}
            </Button>
          </div>

          {results.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                {t('searchResults', { count: results.length })}
              </div>
              {results.map((r, i) => (
                <div
                  key={`${r.fileName}-${i}`}
                  className="rounded p-2 text-[0.72rem] leading-relaxed"
                  style={{ backgroundColor: 'var(--color-panel)', border: '1px solid var(--color-border)' }}
                >
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-medium truncate" style={{ color: 'var(--color-text-secondary)' }}>{r.fileName}</span>
                    <span className="text-[0.65rem] ml-auto flex-shrink-0" style={{ color: 'var(--color-text-muted)' }}>
                      {t('score', { score: Math.round((r.score ?? 0) * 100) })}
                    </span>
                  </div>
                  <div style={{ color: 'var(--color-text)' }}>{r.text}</div>
                </div>
              ))}
            </div>
          )}

          {/* 章节清单 */}
          <div>
            <div className="text-xs font-medium mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
              {t('chapterList', { count: book.chapters.length })}
            </div>
            <div className="rounded overflow-hidden" style={{ border: '1px solid var(--color-border)' }}>
              {book.chapters.map((chapter, index) => {
                const expanded = openChapterId === chapter.docId
                const loading = loadingChapterId === chapter.docId
                const text = chapterTexts[chapter.docId]
                return (
                  <div
                    key={chapter.docId}
                    style={{
                      backgroundColor: index % 2 === 0 ? 'var(--color-panel)' : 'transparent',
                      borderTop: index === 0 ? 'none' : '1px solid var(--color-border)',
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => { void handleToggleChapter(chapter) }}
                      className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left"
                    >
                      {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                      <span className="w-10 flex-shrink-0 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                        {chapter.number}
                      </span>
                      <span className="flex-1 truncate" style={{ color: 'var(--color-text)' }}>{chapter.title}</span>
                      <span className="text-[0.65rem] flex-shrink-0 tabular-nums" style={{ color: 'var(--color-text-muted)' }}>
                        {chapter.wordCount}
                      </span>
                    </button>
                    {expanded && (
                      <div className="px-2.5 pb-2 space-y-1.5">
                        <div className="flex items-center gap-1.5">
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={loading}
                            onClick={() => { void handleCopyChapter(chapter) }}
                          >
                            <Copy size={11} />
                            {t('copyChapter')}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={loading}
                            onClick={() => { void handleUseAsStyleReference(chapter) }}
                          >
                            <ScrollText size={11} />
                            {t('useAsStyleReference')}
                          </Button>
                        </div>
                        <div
                          className="rounded px-2 py-1.5 text-[0.72rem] leading-relaxed whitespace-pre-wrap max-h-64 overflow-y-auto"
                          style={{
                            backgroundColor: 'var(--color-bg)',
                            border: '1px solid var(--color-border)',
                            color: 'var(--color-text)',
                          }}
                        >
                          {loading
                            ? (
                              <span className="inline-flex items-center gap-1.5" style={{ color: 'var(--color-text-muted)' }}>
                                <Loader2 size={11} className="animate-spin" />
                                {t('loadingChapter')}
                              </span>
                            )
                            : (text ?? '')}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

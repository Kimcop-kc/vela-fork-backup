/**
 * 文风指南查看器
 *
 * 只读展示「按仿写 Skill 编译」的文风指南：
 *   - 每条规则都附参考文本证据，避免出现无法溯源的风格要求；
 *   - 写入项目文风设定由编译工作流显式完成，这里不提供隐式改动入口。
 */
import { useTranslation } from 'react-i18next'
import { ScrollText } from 'lucide-react'

interface Props {
  /** 指南 Markdown 正文 */
  content: string
  /** 参考文本来源标题 */
  sourceTitle?: string
}

export default function StyleGuideView({ content, sourceTitle }: Props) {
  const { t } = useTranslation('editors')

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-4">
        <div className="flex items-center gap-1.5 mb-3 pb-3 border-b border-[var(--color-border)]">
          <ScrollText size={15} className="text-[var(--color-accent)]" />
          <h3 className="text-base font-bold text-[var(--color-text)]">{t('styleGuideView.title')}</h3>
          {sourceTitle && (
            <span className="text-xs ml-auto" style={{ color: 'var(--color-text-muted)' }}>
              {t('styleGuideView.source', { title: sourceTitle })}
            </span>
          )}
        </div>
        <p className="text-xs mb-3" style={{ color: 'var(--color-text-muted)' }}>
          {t('styleGuideView.hint')}
        </p>
        <pre className="text-xs whitespace-pre-wrap leading-6 rounded-md p-3 border border-[var(--color-border)] text-[var(--color-text-secondary)]" style={{ backgroundColor: 'var(--color-bg-elevated)' }}>
          {content}
        </pre>
      </div>
    </div>
  )
}

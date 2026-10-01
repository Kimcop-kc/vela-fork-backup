import { Plus, MoreHorizontal, X, Server, Sparkles, ChevronRight, BookOpenCheck, Pencil, FolderOpen, RefreshCw, Download } from 'lucide-react'
import StoryRevisionHistory from './StoryRevisionHistory'
import { useProjectStore } from '../../../stores/project-store'
import { useTranslation } from 'react-i18next'
import { useAgentStore } from '../../../stores/agent-store'
import { useLayoutStore } from '../../../stores/layout-store'
import { useMCPStore } from '../../../stores/mcp-store'
import { skillRegistry, type LoadedSkill } from '../../../services/agent/skill-registry'
import { openSkillDir } from '../../../services/skill-service'
import { useCallback, useEffect, useRef, useState } from 'react'
import { confirm } from '../../ui/Confirm'
import { Button } from '../../ui/Button'
import { IconBtn } from '../../ui/IconBtn'
import { MenuItem } from '../../ui/MenuItem'
import { Switch } from '../../ui/Switch'
import { toast } from '../../ui/Toast'
import SkillEditorDialog from './SkillEditorDialog'
import SkillImportDialog from './SkillImportDialog'
import { useOutsideClick } from '../../../hooks/useOutsideClick'

/**
 * Agent 面板顶部工具栏
 */
export default function AgentHeader() {
  const { t } = useTranslation('panels')
  const projectPath = useProjectStore(s => s.currentProject?.path)
  const showStoryHistory = useAgentStore(s => s.showStoryHistory)
  const setShowStoryHistory = useAgentStore(s => s.setShowStoryHistory)
  const { createConversation, toggleHistory, showHistory, getActiveConversation } = useAgentStore()
  const toggleAIPanel = useLayoutStore(s => s.toggleAIPanel)
  const [showMore, setShowMore] = useState(false)
  const [subView, setSubView] = useState<'main' | 'mcp' | 'skills'>('main')
  /** Skill 编辑器：editingSkill 为 null 表示新建 */
  const [editingSkill, setEditingSkill] = useState<LoadedSkill | null>(null)
  const [showSkillEditor, setShowSkillEditor] = useState(false)
  /** Skill 导入（zip / GitHub）对话框 */
  const [showSkillImport, setShowSkillImport] = useState(false)
  const moreRef = useRef<HTMLDivElement>(null)

  // 点击外部关闭更多菜单
  useOutsideClick(moreRef, () => { setShowMore(false); setSubView('main') }, showMore)

  // MCP 状态
  const { servers: mcpServers, tools: mcpTools } = useMCPStore()
  const connectedCount = mcpServers.filter(s => s.status === 'connected').length

  // Skill 列表（订阅注册中心变更：启用/停用或改动磁盘后自动刷新）
  const [skills, setSkills] = useState<LoadedSkill[]>(() => skillRegistry.listAll())
  const refreshSkills = useCallback(() => { setSkills(skillRegistry.listAll()) }, [])
  useEffect(() => skillRegistry.subscribe(refreshSkills), [refreshSkills])

  /** 重新加载磁盘上的 Skill（外部改过 ~/.vela/skills/ 后） */
  const reloadSkills = useCallback(async () => {
    await skillRegistry.reload()
    refreshSkills()
  }, [refreshSkills])

  /** 新建会话 */
  const handleNew = () => {
    createConversation()
  }

  /** 关闭 AI 面板 */
  const handleClose = () => {
    toggleAIPanel()
  }

  // 当前会话为空（无消息）时禁止新建
  const activeConv = getActiveConversation()
  const isCurrentEmpty = !activeConv || activeConv.messages.filter(m => m.role !== 'system').length === 0

  return (
    <div
      className="no-select flex items-center justify-between gap-1.5 px-2 flex-shrink-0"
      style={{
        height: 'var(--height-panel-header)',
        borderBottom: '1px solid var(--color-border)',
      }}
    >
      {/* 标题 */}
      <div
        className="flex min-w-0 items-center overflow-hidden text-ellipsis whitespace-nowrap gap-1"
        style={{ color: 'var(--color-text-secondary)', fontSize: '0.75rem', fontWeight: 500 }}
      >
        AGENT
      </div>

      {/* 右侧工具按钮组 */}
      <div className="flex items-center gap-1.5 px-0.5 flex-shrink-0">
        <span data-tour="revision-history" className="inline-flex"><IconBtn title={t('storyRevision.history')} disabled={!projectPath} onClick={() => setShowStoryHistory(true)} size={18}><BookOpenCheck size={14} /></IconBtn></span>
        {showStoryHistory && <StoryRevisionHistory key={projectPath} />}

        {/* 新建对话按钮 */}
        <IconBtn
          title={isCurrentEmpty ? t('agent.emptyConversationHint') : t('agent.newConversation')}
          disabled={isCurrentEmpty}
          onClick={handleNew}
          size={18}
        >
          <Plus size={13} strokeWidth={1.5} />
        </IconBtn>

        {/* 历史记录按钮 */}
        <IconBtn
          title={t('agent.historyConversation')}
          onClick={toggleHistory}
          active={showHistory}
          size={18}
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width={15}
            height={15}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M12 7v5l4 2" />
          </svg>
        </IconBtn>

        {/* 更多菜单 */}
        <div className="relative" ref={moreRef}>
          <IconBtn
            title={t('agent.moreOptions')}
            onClick={() => { setShowMore(v => !v); setSubView('main') }}
            active={showMore}
            size={18}
          >
            <MoreHorizontal size={15} strokeWidth={1.5} />
          </IconBtn>

          {/* 更多菜单下拉 */}
          {showMore && (
            <div
              className="absolute right-0 top-full mt-1 z-50 py-1 rounded-lg shadow-lg"
              style={{
                width: subView === 'main' ? 200 : 260,
                backgroundColor: 'var(--color-sidebar)',
                border: '1px solid var(--color-border)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
                transition: 'width 0.15s ease',
              }}
            >
              {/* ===== 主菜单视图 ===== */}
              {subView === 'main' && (
                <>
                  <MenuItem
                    label={t('agent.mcpServers')}
                    icon={<Server size={13} />}
                    shortcut={connectedCount > 0 ? t('agent.onlineCount', { connected: connectedCount, total: mcpServers.length }) : ''}
                    onClick={() => setSubView('mcp')}
                  />
                  <MenuItem
                    label={t('agent.skillList')}
                    icon={<Sparkles size={13} />}
                    shortcut={skills.length > 0 ? t('agent.skillCount', { count: skills.length }) : ''}
                    onClick={() => setSubView('skills')}
                  />
                  <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '4px 0' }} />
                  <MenuItem
                    label={t('agent.clearAllConversations')}
                    danger
                    onClick={async () => {
                      setShowMore(false)
                      const ok = await confirm(t('agent.confirmClearMessage'), {
                        title: t('agent.confirmClearTitle'),
                        confirmText: t('agent.confirmClearBtn'),
                        danger: true,
                      })
                      if (ok) useAgentStore.getState().clearAll()
                    }}
                  />
                </>
              )}

              {/* ===== MCP 子视图 ===== */}
              {subView === 'mcp' && (
                <MCPSubView
                  servers={mcpServers}
                  toolCount={mcpTools.length}
                  onBack={() => setSubView('main')}
                />
              )}

              {/* ===== Skill 子视图 ===== */}
              {subView === 'skills' && (
                <SkillSubView
                  skills={skills}
                  onBack={() => setSubView('main')}
                  onReload={reloadSkills}
                  onEdit={(skill) => { setEditingSkill(skill); setShowSkillEditor(true) }}
                  onImport={() => setShowSkillImport(true)}
                />
              )}

            </div>
          )}
        </div>

        {/*
          Skill 编辑器与导入对话框必须挂在下拉菜单外面：
          它们渲染在 portal 里，点对话框会被 useOutsideClick 判成「点了菜单外面」，
          菜单一关，挂在菜单里的对话框就跟着被卸载。
        */}
        {showSkillEditor && (
          <SkillEditorDialog
            open={showSkillEditor}
            skill={editingSkill}
            onClose={() => setShowSkillEditor(false)}
            onChanged={refreshSkills}
          />
        )}

        {showSkillImport && (
          <SkillImportDialog
            open={showSkillImport}
            onClose={() => setShowSkillImport(false)}
            onImported={reloadSkills}
          />
        )}

        {/* 关闭面板按钮 */}
        <IconBtn title={t('agent.closeAgentPanel')} onClick={handleClose} size={18}>
          <X size={15} strokeWidth={1.5} />
        </IconBtn>
      </div>
    </div>
  )
}

// ===== MCP 子视图 =====

function MCPSubView({
  servers,
  toolCount,
  onBack,
}: {
  servers: { id: string; name: string; status: string; toolCount: number; error?: string }[]
  toolCount: number
  onBack: () => void
}) {
  const { t } = useTranslation('panels')
  const connectedCount = servers.filter(s => s.status === 'connected').length

  return (
    <>
      {/* 返回按钮 */}
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{t('agent.mcpServers')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {t('agent.onlineCount', { connected: connectedCount, total: servers.length })}
        </span>
      </button>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {/* 服务器列表 */}
      {servers.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{t('agent.noMcpServers')}</div>
          <div className="text-[0.68rem] opacity-60">
            {t('agent.mcpConfigHint')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[200px] overflow-y-auto">
          {servers.map(server => (
            <div
              key={server.id}
              className="flex items-center gap-2 px-3 py-1.5 text-xs"
            >
              {/* 状态灯 */}
              <span
                className="flex-shrink-0 w-1.5 h-1.5 rounded-full"
                style={{
                  backgroundColor:
                    server.status === 'connected' ? '#22c55e'
                    : server.status === 'connecting' ? '#f59e0b'
                    : server.status === 'error' ? '#ef4444'
                    : 'var(--color-text-muted)',
                }}
              />
              <span
                className="flex-1 truncate font-medium"
                style={{ color: 'var(--color-text)' }}
              >
                {server.name}
              </span>
              {server.status === 'connected' && server.toolCount > 0 && (
                <span className="text-[0.65rem] opacity-50 flex-shrink-0">
                  {server.toolCount} tools
                </span>
              )}
              {server.status === 'error' && (
                <span className="text-[0.65rem] text-red-400 truncate max-w-[80px]" title={server.error}>
                  {t('agent.error')}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 底部统计 */}
      {toolCount > 0 && (
        <>
          <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
          <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
            {t('agent.mcpToolsRegistered', { count: toolCount })}
          </div>
        </>
      )}
    </>
  )
}

// ===== Skill 子视图 =====

function SkillSubView({
  skills,
  onBack,
  onReload,
  onEdit,
  onImport,
}: {
  skills: LoadedSkill[]
  onBack: () => void
  /** 重新加载磁盘上的 Skill */
  onReload: () => Promise<void>
  /** 打开编辑器；传 null 表示新建 */
  onEdit: (skill: LoadedSkill | null) => void
  /** 打开「从 zip / GitHub 导入」对话框 */
  onImport: () => void
}) {
  const { t } = useTranslation('panels')
  const [togglingName, setTogglingName] = useState<string | null>(null)

  /** 来源徽章颜色 */
  const sourceBadge = (source: string) => {
    switch (source) {
      case 'builtin': return { bg: 'rgba(59,130,246,0.12)', color: '#3b82f6', label: t('agent.builtin') }
      case 'user': return { bg: 'rgba(168,85,247,0.12)', color: '#a855f7', label: t('agent.userScope') }
      case 'project': return { bg: 'rgba(34,197,94,0.12)', color: '#22c55e', label: t('agent.projectScope') }
      default: return { bg: 'var(--color-hover)', color: 'var(--color-text-muted)', label: source }
    }
  }

  /** 启用 / 停用：停用后不再注册为 Agent 工具，也不参与 / 调用与技能方法替换 */
  const toggleEnabled = async (skill: LoadedSkill) => {
    setTogglingName(skill.metadata.name)
    try {
      const label = skill.metadata.displayName ?? skill.metadata.name
      await skillRegistry.setEnabled(skill.metadata.name, !skill.enabled)
      if (skill.enabled) toast.info(t('agent.skillDisabledToast', { name: label }))
      else toast.success(t('agent.skillEnabledToast', { name: label }))
    } finally {
      setTogglingName(null)
    }
  }

  const enabledCount = skills.filter(s => s.enabled).length

  return (
    <>
      {/* 返回按钮 */}
      <button
        onClick={onBack}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 text-xs transition-colors"
        style={{ color: 'var(--color-text-secondary)' }}
        onMouseEnter={e => (e.currentTarget.style.backgroundColor = 'var(--color-hover)')}
        onMouseLeave={e => (e.currentTarget.style.backgroundColor = 'transparent')}
      >
        <ChevronRight size={12} style={{ transform: 'rotate(180deg)' }} />
        <span className="font-medium">{t('agent.skillList')}</span>
        <span className="ml-auto text-[0.68rem] opacity-50">
          {t('agent.skillEnabledCount', { enabled: enabledCount, total: skills.length })}
        </span>
      </button>

      {/* 操作行：新建 / 导入 / 打开目录 / 重新加载 */}
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <Button variant="outline" size="sm" onClick={() => onEdit(null)} title={t('agent.skillNewHint')}>
          <Plus size={11} />
          {t('agent.skillNew')}
        </Button>
        <Button variant="outline" size="sm" onClick={onImport} title={t('agent.skillImportEntryHint')}>
          <Download size={11} />
          {t('agent.skillImportEntry')}
        </Button>
        <IconBtn title={t('agent.skillOpenDirHint')} size={18} onClick={() => { void openSkillDir('user') }}>
          <FolderOpen size={11} />
        </IconBtn>
        <IconBtn title={t('agent.skillReloadHint')} size={18} onClick={() => { void onReload() }}>
          <RefreshCw size={11} />
        </IconBtn>
      </div>

      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />

      {/* Skill 列表 */}
      {skills.length === 0 ? (
        <div className="px-3 py-3 text-xs text-center" style={{ color: 'var(--color-text-muted)' }}>
          <div className="mb-1">{t('agent.noAvailableSkills')}</div>
          <div className="text-[0.68rem] opacity-60">
            {t('agent.skillsDirHint')}
          </div>
        </div>
      ) : (
        <div className="py-1 max-h-[240px] overflow-y-auto">
          {skills.map(skill => {
            const badge = sourceBadge(skill.source)
            const origin = skill.metadata.origin
            const version = skill.metadata.version ?? origin?.version ?? ''
            const importedAt = origin?.importedAt ? origin.importedAt.slice(0, 10) : ''
            const originTip = origin
              ? `${t('agent.skillOrigin')}: ${origin.label ?? origin.kind ?? ''}${origin.url ? ` · ${origin.url}` : ''}${importedAt ? ` · ${importedAt}` : ''}`
              : undefined
            return (
              <div
                key={skill.metadata.name}
                className="flex items-center gap-2 px-3 py-1.5 text-xs"
              >
                <Sparkles
                  size={12}
                  className="flex-shrink-0"
                  style={{ color: 'var(--color-accent)', opacity: skill.enabled ? 1 : 0.35 }}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="font-medium truncate"
                      style={{ color: 'var(--color-text)', opacity: skill.enabled ? 1 : 0.5 }}
                    >
                      {skill.metadata.displayName ?? skill.metadata.name}
                    </span>
                    <span
                      className="text-[0.6rem] px-1 py-0 rounded flex-shrink-0"
                      style={{ backgroundColor: badge.bg, color: badge.color }}
                    >
                      {badge.label}
                    </span>
                    {version && (
                      <span
                        className="text-[0.6rem] px-1 py-0 rounded flex-shrink-0 font-mono"
                        style={{ backgroundColor: 'var(--color-hover)', color: 'var(--color-text-muted)' }}
                        title={originTip}
                      >
                        v{version}
                      </span>
                    )}
                  </div>
                  <div
                    className="text-[0.68rem] truncate mt-0.5"
                    style={{ color: 'var(--color-text-muted)' }}
                  >
                    {skill.metadata.description}
                  </div>
                </div>

                {/* 编辑 / 替换 */}
                <IconBtn title={t('agent.skillEdit')} size={18} onClick={() => onEdit(skill)}>
                  <Pencil size={11} />
                </IconBtn>

                {/* 启用 / 停用 */}
                <span title={skill.enabled ? t('agent.skillDisable') : t('agent.skillEnable')}>
                  <Switch
                    checked={skill.enabled}
                    disabled={togglingName === skill.metadata.name}
                    onCheckedChange={() => { void toggleEnabled(skill) }}
                    aria-label={skill.metadata.name}
                    className="scale-75 origin-right"
                  />
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 底部提示 */}
      <div style={{ height: 1, backgroundColor: 'var(--color-border)', margin: '2px 0' }} />
      <div className="px-3 py-1.5 text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
        {t('agent.skillSlashHint')}
      </div>
    </>
  )
}

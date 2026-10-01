import { useEffect } from 'react'
import { Panel, Group as PanelGroup, Separator as PanelResizeHandle } from 'react-resizable-panels'
import { useTranslation } from 'react-i18next'
import { useThemeStore } from './stores/theme-store'
import { useLayoutStore } from './stores/layout-store'
import { useLLMStore } from './stores/llm-store'
import { useProjectStore } from './stores/project-store'
import { useMCPStore } from './stores/mcp-store'
import { useWorkflowStore } from './stores/workflow-store'
import { ipc } from './services/ipc-client'
import TitleBar from './components/layout/TitleBar'
import StatusBar from './components/layout/StatusBar'
import LeftToolWindowBar from './components/layout/LeftToolWindowBar'
import RightToolWindowBar from './components/layout/RightToolWindowBar'
import Sidebar from './components/panels/Sidebar'
import EditorArea from './components/panels/EditorArea'
import AIPanel from './components/panels/AIPanel'
import AIOutputPanel from './components/panels/AIOutputPanel'
import BottomPanel from './components/panels/BottomPanel'
import NewProjectDialog from './components/dialogs/NewProjectDialog'
import ImportNovelDialog from './components/dialogs/ImportNovelDialog'
import ChapterCreationDialog from './components/dialogs/ChapterCreationDialog'
import ExportDialog from './components/dialogs/ExportDialog'
import SettingsModal from './components/settings/SettingsModal'
import { ErrorBoundary } from './components/ErrorBoundary'
import { actionToast } from './components/ui/ActionToast'
import { globalEventBus } from './shared/event-bus'
import FeatureTour from './components/onboarding/FeatureTour'

/**
 * Vela 主应用组件
 * 使用 react-resizable-panels 实现可拖拽调整大小的四区布局
 */
export default function App() {
  const { t } = useTranslation('common')
  const initTheme = useThemeStore((s) => s.initTheme)
  const sidebarOpen = useLayoutStore(s => s.sidebarOpen)
  const aiPanelOpen = useLayoutStore(s => s.aiPanelOpen)
  const rightView = useLayoutStore(s => s.rightView)
  const bottomPanelOpen = useLayoutStore(s => s.bottomPanelOpen)
  const bottomDock = useLayoutStore(s => s.bottomDock)
  const settingsOpen = useLayoutStore(s => s.settingsOpen)
  const closeSettings = useLayoutStore(s => s.closeSettings)
  const newProjectOpen = useLayoutStore(s => s.newProjectOpen)
  const closeNewProject = useLayoutStore(s => s.closeNewProject)
  const exportOpen = useLayoutStore(s => s.exportOpen)
  const closeExport = useLayoutStore(s => s.closeExport)
  const importNovelOpen = useLayoutStore(s => s.importNovelOpen)
  const closeImportNovel = useLayoutStore(s => s.closeImportNovel)
  const chapterCreationOpen = useLayoutStore(s => s.chapterCreationOpen)
  const chapterCreationPrefill = useLayoutStore(s => s.chapterCreationPrefill)
  const closeChapterCreation = useLayoutStore(s => s.closeChapterCreation)
  const initLLM = useLLMStore((s) => s.init)
  const loadRecentProjects = useProjectStore((s) => s.loadRecentProjects)

  // 初始化：主题 + LLM 模型 + 最近项目 + 缩放级别
  useEffect(() => {
    initTheme()
    initLLM()
    loadRecentProjects()
    // 加载全局自定义提示词覆盖（此前 loadCustomPrompts 从未被调用，导致全局覆盖重启即失效）
    import('./services/prompt-templates').then(({ loadCustomPrompts }) => loadCustomPrompts()).catch(e => console.warn('[Prompts] 加载全局覆盖失败:', e))
    // 初始化 MCP Store
    useMCPStore.getState().init().catch(e => console.warn('[MCP] 初始化失败:', e))
    if (ipc.isElectron) {
      const savedZoom = localStorage.getItem('vela-zoom-level')
      if (savedZoom) ipc.setZoomLevel(parseFloat(savedZoom))
    }
    // 初始化 ProjectService — 注册全局事件监听（生命周期与 App 一致）
    import('./services/project-service').then(({ initProjectService }) => {
      initProjectService()
    }).catch(e => console.warn('[ProjectService] 初始化失败:', e))

    // C) 工作流完成时弹出 ActionToast 通知（不依赖任何面板状态）
    const unsubActionToast = globalEventBus.on('WORKFLOW_COMPLETE', () => {
      const { history } = useWorkflowStore.getState()
      const latest = history.find(r => r.status === 'completed')
      if (!latest) return
      const shortTitle = latest.title.replace(/^[^\s]+\s/, '')
      actionToast.workflowComplete(
        `✅ 「${shortTitle}」${t('completed')}`,
        () => useLayoutStore.getState().openRightPanel('ai-output')
      )
    })

    return () => {
      // App 卸载时销毁 ProjectService（开发环境 HMR 时会触发）
      import('./services/project-service').then(({ disposeProjectService }) => {
        disposeProjectService()
      }).catch(() => {})
      unsubActionToast()
    }
  }, [initTheme, initLLM, loadRecentProjects])

  // 全局快捷键: Cmd+N 新建项目，Cmd+O 打开项目
  // 注意：Cmd+=/- 缩放已由 TitleBar.tsx 统一处理，此处不重复注册
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        useLayoutStore.getState().openNewProject()
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault()
        const folder = await ipc.invoke('dialog:select-folder')
        if (folder) {
          useProjectStore.getState().openProject(folder)
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  // 底部工具窗口的停靠位置：宿主侧栏被收起时自动回退成「底部全宽」，避免面板消失
  const dockSide = bottomPanelOpen && sidebarOpen && bottomDock === 'sidebar'
  const dockAgent = bottomPanelOpen && aiPanelOpen && bottomDock === 'agent'
  const dockFull = bottomPanelOpen && !dockSide && !dockAgent

  return (
    <div className="flex flex-col w-full h-full overflow-hidden">
      {/* 标题栏 */}
      <TitleBar />

      {/*
        主体：flex 行 = LeftBar | PanelGroup | RightBar

        底部工具窗口（任务 / 日志 / 模型调用）默认停靠在「项目结构」侧栏下方，
        也可切到 Agent 面板下方，或铺满底部全宽 —— 不再遮挡中间的编辑区。
      */}
      <div className="flex flex-1 overflow-hidden">

        {/* 左侧工具窗口栏（全高） */}
        <LeftToolWindowBar />

        {/* 纵向 PanelGroup：仅当底部面板选择「底部全宽」停靠时才出现下层 */}
        <PanelGroup orientation="vertical" className="flex-1">

          {/* 上层：侧边栏 | 编辑区 | AI 面板（水平分割） */}
          <Panel id="top" defaultSize={dockFull ? 72 : 100} minSize={30}>
            <PanelGroup orientation="horizontal" className="flex-1 h-full">

              {/* 左侧边栏（底部面板停靠此列时，内部再上下分割） */}
              {sidebarOpen && (
                <>
                  <Panel id="sidebar" defaultSize={20} minSize={10}>
                    <PanelGroup orientation="vertical" className="flex-1 h-full">
                      <Panel id="sidebar-main" defaultSize={62} minSize={20}>
                        <ErrorBoundary fallbackLabel={t('sidebarRenderError')}>
                          <Sidebar />
                        </ErrorBoundary>
                      </Panel>
                      {dockSide && (
                        <>
                          <PanelResizeHandle />
                          <Panel id="bottom-docked-sidebar" defaultSize={38} minSize={15}>
                            <BottomPanel />
                          </Panel>
                        </>
                      )}
                    </PanelGroup>
                  </Panel>
                  <PanelResizeHandle />
                </>
              )}

              {/* 编辑区 */}
              <Panel id="editor" defaultSize={60} minSize={10}>
                <ErrorBoundary fallbackLabel={t('editorRenderError')}>
                  <EditorArea onNewProject={() => useLayoutStore.getState().openNewProject()} />
                </ErrorBoundary>
              </Panel>

              {/* 右侧面板（Agent 对话 / AI 输出；底部面板停靠此列时上下分割） */}
              {aiPanelOpen && (
                <>
                  <PanelResizeHandle />
                  <Panel id="ai-panel" defaultSize={20} minSize={10}>
                    <PanelGroup orientation="vertical" className="flex-1 h-full">
                      <Panel id="ai-main" defaultSize={62} minSize={20}>
                        <ErrorBoundary fallbackLabel={t('aiPanelRenderError')}>
                          {rightView === 'ai-output' ? <AIOutputPanel /> : <AIPanel />}
                        </ErrorBoundary>
                      </Panel>
                      {dockAgent && (
                        <>
                          <PanelResizeHandle />
                          <Panel id="bottom-docked-agent" defaultSize={38} minSize={15}>
                            <BottomPanel />
                          </Panel>
                        </>
                      )}
                    </PanelGroup>
                  </Panel>
                </>
              )}
            </PanelGroup>
          </Panel>

          {/* 下层：底部面板铺满全宽（仅「横跨底部全宽」停靠时渲染） */}
          {dockFull && (
            <>
              <PanelResizeHandle />
              <Panel id="bottom" defaultSize={28} minSize={8}>
                <BottomPanel />
              </Panel>
            </>
          )}
        </PanelGroup>

        {/* 右侧工具窗口栏（全高） */}
        <RightToolWindowBar />
      </div>


      {/* 状态栏（全宽） */}
      <StatusBar />

      {/* 全局对话框 — 由 layout-store 控制开关，不再依赖 window.dispatchEvent */}
      <NewProjectDialog
        open={newProjectOpen}
        onClose={closeNewProject}
      />
      <ImportNovelDialog
        open={importNovelOpen}
        onClose={closeImportNovel}
      />
      <ChapterCreationDialog
        isOpen={chapterCreationOpen}
        prefill={chapterCreationPrefill}
        onClose={closeChapterCreation}
      />
      <ExportDialog
        isOpen={exportOpen}
        onClose={closeExport}
      />
      {/* 全屏设置弹窗 */}
      <SettingsModal
        open={settingsOpen}
        onClose={closeSettings}
      />
      <FeatureTour />

    </div>
  )
}

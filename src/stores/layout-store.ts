import { create } from 'zustand'

/** 左侧活动栏的视图类型 */
export type SidebarView = 'home' | 'project' | 'knowledge' | 'books' | 'characters' | 'settings'

/** 下方工具窗口 Tab */
export type BottomTab = 'tasks' | 'log' | 'models'

/** 底部工具窗口的停靠位置：项目结构侧栏下方 / Agent 面板下方 / 底部全宽 */
export type BottomDock = 'sidebar' | 'agent' | 'full'

/** 右侧面板视图类型 */
export type RightView = 'agent' | 'ai-output'

/** 章节创建对话框的预填参数 */
export type ChapterCreationPrefill = Record<string, unknown> | null

interface LayoutState {
  // ===== 侧边栏 =====
  sidebarOpen: boolean
  sidebarView: SidebarView
  sidebarWidth: number

  // ===== AI 对话面板 =====
  aiPanelOpen: boolean
  aiPanelWidth: number
  /** 右侧面板当前视图：Agent 对话 / AI 输出 */
  rightView: RightView

  // ===== 底部面板 =====
  bottomPanelOpen: boolean
  bottomTab: BottomTab
  bottomPanelHeight: number
  /** 底部面板停靠位置（默认停靠在「项目结构」侧栏下方，避免遮挡中间的编辑区） */
  bottomDock: BottomDock

  // ===== 全局弹窗状态（替代 window.dispatchEvent 事件总线）=====
  /** 设置弹窗是否打开 */
  settingsOpen: boolean
  /** 新建项目对话框是否打开 */
  newProjectOpen: boolean
  /** 导出对话框是否打开 */
  exportOpen: boolean
  /** 导入小说对话框是否打开 */
  importNovelOpen: boolean
  /** 章节创建对话框是否打开 */
  chapterCreationOpen: boolean
  /** 章节创建对话框的预填参数 */
  chapterCreationPrefill: ChapterCreationPrefill

  /** 拆书视图当前选中的拆书档案 id */
  selectedBookId: string | null

  /** 由拆书等来源送入文风分析的参考文本（待「小说配置」页消费后清空） */
  styleReferencePrefill: { source: string; text: string } | null

  // ===== Actions =====
  toggleSidebar: () => void
  setSidebarView: (view: SidebarView) => void
  /** 切换拆书视图的当前书籍 */
  setSelectedBookId: (id: string | null) => void
  /** 把一段参考文本送到文风分析弹框（自动切到项目视图） */
  sendToStyleAnalysis: (payload: { source: string; text: string }) => void
  /** 取走并清空待处理的参考文本 */
  takeStyleReference: () => { source: string; text: string } | null
  setSidebarWidth: (width: number) => void
  toggleAIPanel: () => void
  setAIPanelOpen: (open: boolean) => void
  setAIPanelWidth: (width: number) => void
  setRightView: (view: RightView) => void
  /** 打开右侧面板并切换到指定视图 */
  openRightPanel: (view: RightView) => void
  toggleBottomPanel: () => void
  setBottomTab: (tab: BottomTab) => void
  setBottomPanelHeight: (height: number) => void
  openBottomTab: (tab: BottomTab) => void
  /** 设置底部面板停靠位置（同时确保面板展开） */
  setBottomDock: (dock: BottomDock) => void

  // ===== 全局弹窗 Actions =====
  openSettings: () => void
  closeSettings: () => void
  openNewProject: () => void
  closeNewProject: () => void
  openExport: () => void
  closeExport: () => void
  openImportNovel: () => void
  closeImportNovel: () => void
  openChapterCreation: (prefill?: ChapterCreationPrefill) => void
  closeChapterCreation: () => void
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  // 默认值
  sidebarOpen: true,
  sidebarView: 'project',
  sidebarWidth: 260,

  aiPanelOpen: true,
  aiPanelWidth: 320,
  rightView: 'agent',

  bottomPanelOpen: true,
  bottomTab: 'tasks',
  bottomPanelHeight: 200,
  bottomDock: 'sidebar',

  // 全局弹窗默认关闭
  settingsOpen: false,
  newProjectOpen: false,
  exportOpen: false,
  importNovelOpen: false,
  chapterCreationOpen: false,
  chapterCreationPrefill: null,
  selectedBookId: null,
  styleReferencePrefill: null,

  // Actions
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  setSidebarView: (view) =>
    set((s) => ({
      sidebarView: view,
      sidebarOpen: s.sidebarView === view ? !s.sidebarOpen : true,
    })),
  setSidebarWidth: (width) => set({ sidebarWidth: Math.max(200, Math.min(500, width)) }),
  setSelectedBookId: (id) => set({ selectedBookId: id }),
  sendToStyleAnalysis: (payload) => set({
    styleReferencePrefill: payload,
    sidebarView: 'project',
    sidebarOpen: true,
  }),
  takeStyleReference: () => {
    const pending = get().styleReferencePrefill
    if (pending) set({ styleReferencePrefill: null })
    return pending
  },

  toggleAIPanel: () => set((s) => ({ aiPanelOpen: !s.aiPanelOpen })),
  setAIPanelOpen: (open) => set({ aiPanelOpen: open }),
  setAIPanelWidth: (width) => set({ aiPanelWidth: Math.max(260, Math.min(600, width)) }),
  setRightView: (view) => set({ rightView: view }),
  openRightPanel: (view) => set({ aiPanelOpen: true, rightView: view }),

  toggleBottomPanel: () => set((s) => ({ bottomPanelOpen: !s.bottomPanelOpen })),
  setBottomTab: (tab) =>
    set((s) => ({
      bottomTab: tab,
      bottomPanelOpen: s.bottomTab === tab ? !s.bottomPanelOpen : true,
    })),
  setBottomPanelHeight: (height) => set({ bottomPanelHeight: Math.max(100, Math.min(500, height)) }),
  openBottomTab: (tab) => set({ bottomPanelOpen: true, bottomTab: tab }),
  setBottomDock: (dock) => set({ bottomDock: dock, bottomPanelOpen: true }),

  // 全局弹窗 Actions
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openNewProject: () => set({ newProjectOpen: true }),
  closeNewProject: () => set({ newProjectOpen: false }),
  openExport: () => set({ exportOpen: true }),
  closeExport: () => set({ exportOpen: false }),
  openImportNovel: () => set({ importNovelOpen: true }),
  closeImportNovel: () => set({ importNovelOpen: false }),
  openChapterCreation: (prefill = null) => set({ chapterCreationOpen: true, chapterCreationPrefill: prefill }),
  closeChapterCreation: () => set({ chapterCreationOpen: false, chapterCreationPrefill: null }),
}))

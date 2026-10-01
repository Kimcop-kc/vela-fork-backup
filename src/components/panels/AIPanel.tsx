import { useEffect } from 'react'
import { useLLMStore } from '../../stores/llm-store'
import { useProjectStore } from '../../stores/project-store'
import { skillRegistry } from '../../services/agent/skill-registry'
import AgentHeader from './agent/AgentHeader'
import AgentConversation from './agent/AgentConversation'

/**
 * 右侧 AI Agent 面板
 * 重构后采用多会话管理架构，参考 Antigravity agent-side-panel 设计
 * - 顶部：AgentHeader（新建/历史/更多/关闭）
 * - 主体：AgentConversation（空状态/对话/历史三态）
 */
export default function AIPanel() {
  // 确保 LLM store 已初始化
  const init = useLLMStore(s => s.init)
  const loaded = useLLMStore(s => s.loaded)
  useEffect(() => {
    if (!loaded) init()
  }, [init, loaded])

  // 确保 Skill 已加载：技能列表与斜杠命令不应依赖「新建对话」触发。
  // 项目级 Skill 在 <项目>/.vela/skills 下，所以项目一换就得重扫一遍。
  const projectPath = useProjectStore(s => s.currentProject?.path ?? '')
  useEffect(() => {
    skillRegistry.loadAll().catch(e => console.warn('[Skills] 加载失败:', e))
  }, [projectPath])

  return (
    <div
      className="w-full h-full flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--color-sidebar)',
        borderLeft: '1px solid var(--color-border)',
      }}
    >
      {/* 顶部工具栏 */}
      <AgentHeader />

      {/* 主对话区：占满剩余高度 */}
      <div className="flex-1 overflow-hidden">
        <AgentConversation />
      </div>
    </div>
  )
}

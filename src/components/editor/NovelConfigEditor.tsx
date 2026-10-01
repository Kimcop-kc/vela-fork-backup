import { useEffect, useState, useRef } from 'react'
import { Save, Sparkles, Info, Loader2, ScrollText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProjectStore } from '../../stores/project-store'
import { useLayoutStore } from '../../stores/layout-store'
import { useLLMStore } from '../../stores/llm-store'
import { useWorkflowStore } from '../../stores/workflow-store'
import type { NovelConfig } from '../../shared/ipc-channels'
import type { GeneratableField } from '../../services/workflows/commands/generate-field.command'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { Textarea } from '../ui/Textarea'
import { NativeSelect } from '../ui/NativeSelect'
import GenerateConfigDialog from '../dialogs/GenerateConfigDialog'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from '../ui/Dialog'

/** Genre options with i18n labels (values kept in Chinese for backward compatibility) */
const GENRE_OPTIONS = [
  { value: '玄幻', labelKey: 'novelConfig.genres.xuanhuan' },
  { value: '仙侠', labelKey: 'novelConfig.genres.xianxia' },
  { value: '都市', labelKey: 'novelConfig.genres.urban' },
  { value: '科幻', labelKey: 'novelConfig.genres.scifi' },
  { value: '历史', labelKey: 'novelConfig.genres.history' },
  { value: '军事', labelKey: 'novelConfig.genres.military' },
  { value: '游戏', labelKey: 'novelConfig.genres.gaming' },
  { value: '末世', labelKey: 'novelConfig.genres.apocalypse' },
  { value: '悬疑', labelKey: 'novelConfig.genres.mystery' },
  { value: '灵异', labelKey: 'novelConfig.genres.paranormal' },
  { value: '言情', labelKey: 'novelConfig.genres.romance' },
  { value: '古言', labelKey: 'novelConfig.genres.historicalRomance' },
  { value: '现言', labelKey: 'novelConfig.genres.modernRomance' },
  { value: '奇幻', labelKey: 'novelConfig.genres.fantasy' },
  { value: '武侠', labelKey: 'novelConfig.genres.wuxia' },
  { value: '轻小说', labelKey: 'novelConfig.genres.lightNovel' },
  { value: '同人', labelKey: 'novelConfig.genres.fanfic' },
  { value: '职场', labelKey: 'novelConfig.genres.workplace' },
] as const

/** 小说配置编辑器 — Tab 内的可视化配置面板 */
export default function NovelConfigEditor() {
  const { t } = useTranslation('editors')
  // ✅ 用 selector 精确订阅：只有 currentProject 变化时才重新渲染
  //    不订阅 fileTree、recentProjects 等无关字段
  const currentProject = useProjectStore(s => s.currentProject)
  const updateNovelConfig = useProjectStore(s => s.updateNovelConfig)
  const saveProject = useProjectStore(s => s.saveProject)
  // 按用途解析模型：只要「生成」用途有可用模型（含用途绑定）就允许触发
  const resolveModelId = useLLMStore(s => s.resolveModelId)
  // ✅ addLog 用 getState() 命令式调用，不订阅 workflow store
  //    避免 AI 流式生成时 globalLogs 高频更新导致本组件被动重渲染
  const addLog = useWorkflowStore.getState().addLog
  const [saving, setSaving] = useState(false)
  const [showGenerateConfig, setShowGenerateConfig] = useState(false)
  // 文风指南编译弹框状态
  const [showStyleGuide, setShowStyleGuide] = useState(false)
  const [referenceText, setReferenceText] = useState('')
  const [sourceTitle, setSourceTitle] = useState('')
  const [applyGuide, setApplyGuide] = useState(true)
  const [compiling, setCompiling] = useState(false)

  // 拆书等来源送入的参考文本：收到后直接打开文风指南弹框并预填
  const styleReferencePrefill = useLayoutStore(s => s.styleReferencePrefill)
  const takeStyleReference = useLayoutStore(s => s.takeStyleReference)
  useEffect(() => {
    if (!styleReferencePrefill) return
    setSourceTitle(styleReferencePrefill.source)
    setReferenceText(styleReferencePrefill.text)
    setShowStyleGuide(true)
    takeStyleReference()
  }, [styleReferencePrefill, takeStyleReference])

  // 各区块的独立生成状态
  const [generatingField, setGeneratingField] = useState<GeneratableField | null>(null)

  // 直接从 Store 读取配置 — 单一数据源，无需 local state 镜像
  const config = currentProject?.novelConfig ?? null

  if (!config) return (
    <div className="h-full flex items-center justify-center" style={{ color: 'var(--color-text-muted)' }}>
      <span className="text-sm opacity-50">{t('novelConfig.loadingConfig')}</span>
    </div>
  )

  // 直接写 Store — 消除双向同步风险
  const update = <K extends keyof NovelConfig>(key: K, value: NovelConfig[K]) => {
    updateNovelConfig({ [key]: value })
  }

  /** 保存配置 — Store 已是最新数据，仅需持久化到磁盘 */
  const handleSave = async () => {
    if (!config || saving) return
    setSaving(true)
    try {
      await saveProject()
      addLog('info', `📝 ${t('novelConfig.messages.configSaved')}`)
    } catch (error) {
      console.error('[NovelConfigEditor] Save failed:', error)
      addLog('error', `${t('novelConfig.messages.saveFailed')}: ${error}`)
    } finally {
      setSaving(false)
    }
  }

  /** AI 生成配置 — 打开弹框 */
  const handleAIGenerate = () => {
    if (!resolveModelId('generate_global_config')) {
      addLog('error', `⚠️ ${t('novelConfig.messages.noAIModel')}`)
      return
    }
    setShowGenerateConfig(true)
  }

  /**
   * 从参考文本编译文风指南。
   *
   * 归纳方法由「被激活的仿写 Skill」提供；是否写入项目文风设定，
   * 由弹框里的勾选项显式决定，不会在后台悄悄覆盖文风。
   */
  const handleCompileStyleGuide = async () => {
    if (compiling) return
    if (!resolveModelId('compile_style_guide')) {
      addLog('error', `⚠️ ${t('novelConfig.messages.noAIModel')}`)
      return
    }
    const reference = referenceText.trim()
    if (reference.length < 200) {
      addLog('error', `⚠️ ${t('novelConfig.styleGuide.tooShort')}`)
      return
    }
    setCompiling(true)
    try {
      const { createCompileStyleGuideWorkflow } = await import('../../services/workflows/chapter-workflow')
      useWorkflowStore.getState().startWorkflow(createCompileStyleGuideWorkflow({
        referenceText: reference,
        sourceTitle: sourceTitle.trim() || t('novelConfig.writingStyle'),
        applyToProject: applyGuide,
      }), false)
      setShowStyleGuide(false)
    } catch (e) {
      addLog('error', `⚠️ ${t('novelConfig.styleGuide.startFailed', { error: e })}`)
    } finally {
      setCompiling(false)
    }
  }

  /** 单字段 AI 生成 */
  const handleFieldGenerate = async (fieldKey: GeneratableField) => {
    if (!resolveModelId('generate_field')) {
      addLog('error', `⚠️ ${t('novelConfig.messages.noAIModel')}`)
      return
    }
    if (generatingField) return // 防止并发

    setGeneratingField(fieldKey)
    try {
      const { GenerateFieldCommand } = await import('../../services/workflows/commands/generate-field.command')
      const cmd = new GenerateFieldCommand(fieldKey)
      await cmd.execute({
        step: { id: '', commandId: '', name: '', params: {} },
        context: { data: {}, cancelled: false },
        callbacks: {
          log: (msg: string) => useWorkflowStore.getState().addLog('info', msg),
          setProgress: () => { },
          appendText: () => { },
        },
      })
    } catch (e) {
      addLog('error', `${t('novelConfig.messages.generateFailed')}: ${e}`)
    } finally {
      setGeneratingField(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-6">
        {/* 头部 */}
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-lg font-bold" style={{ color: 'var(--color-text)' }}>
              {t('novelConfig.title')}
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--color-text-muted)' }}>
              {t('novelConfig.description')}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ai" onClick={handleAIGenerate}>
              <Sparkles size={13} /> {t('novelConfig.aiFillConfig')}
            </Button>
            <Button variant="outline" onClick={handleSave} disabled={saving}>
              <Save size={13} /> {saving ? t('novelConfig.saving') : t('novelConfig.save')}
            </Button>
          </div>
        </div>

        {/* 配置表单 */}
        <div className="space-y-5">
          {/* 基本信息 */}
          <Section title={t('novelConfig.basicInfo')} t={t}>
            <div className="grid grid-cols-3 gap-4">
              <Field label={t('novelConfig.genre')}>
                <NativeSelect value={config.genre} onChange={(e) => update('genre', e.target.value)}>
                  {GENRE_OPTIONS.map((g) => (
                    <option key={g.value} value={g.value}>{t(g.labelKey)}</option>
                  ))}
                </NativeSelect>
              </Field>
              <Field label={t('novelConfig.subGenre')}>
                <Input value={config.subGenre} onChange={(e) => update('subGenre', e.target.value)} placeholder={t('novelConfig.subGenrePlaceholder')} />
              </Field>
              <Field label={t('novelConfig.targetAudience')}>
                <NativeSelect value={config.targetAudience} onChange={(e) => update('targetAudience', e.target.value)}>
                  <option value="男频">{t('novelConfig.male')}</option>
                  <option value="女频">{t('novelConfig.female')}</option>
                  <option value="双性向">{t('novelConfig.both')}</option>
                  <option value="全龄">{t('novelConfig.allAges')}</option>
                </NativeSelect>
              </Field>
            </div>
            <div className="grid grid-cols-4 gap-4 mt-4">
              <Field label={t('novelConfig.plotStructure')} tipItems={[
                t('novelConfig.plotStructureTips.three_act'),
                t('novelConfig.plotStructureTips.heros_journey'),
                t('novelConfig.plotStructureTips.save_the_cat'),
                t('novelConfig.plotStructureTips.kishotenketsu'),
                t('novelConfig.plotStructureTips.multi_thread'),
                t('novelConfig.plotStructureTips.freeform'),
              ]}>
                <NativeSelect value={config.plotStructure || 'three_act'} onChange={(e) => update('plotStructure', e.target.value as NovelConfig['plotStructure'])}>
                  <option value="three_act">{t('novelConfig.plotStructureOptions.three_act')}</option>
                  <option value="heros_journey">{t('novelConfig.plotStructureOptions.heros_journey')}</option>
                  <option value="save_the_cat">{t('novelConfig.plotStructureOptions.save_the_cat')}</option>
                  <option value="kishotenketsu">{t('novelConfig.plotStructureOptions.kishotenketsu')}</option>
                  <option value="multi_thread">{t('novelConfig.plotStructureOptions.multi_thread')}</option>
                  <option value="freeform">{t('novelConfig.plotStructureOptions.freeform')}</option>
                </NativeSelect>
              </Field>
              <Field label={t('novelConfig.narrativePOV')} tipItems={[
                t('novelConfig.narrativePOVTips.first_person'),
                t('novelConfig.narrativePOVTips.third_limited'),
                t('novelConfig.narrativePOVTips.third_omniscient'),
                t('novelConfig.narrativePOVTips.multi_pov'),
              ]}>
                <NativeSelect value={config.narrativePOV || 'third_limited'} onChange={(e) => update('narrativePOV', e.target.value as NovelConfig['narrativePOV'])}>
                  <option value="first_person">{t('novelConfig.narrativePOVOptions.first_person')}</option>
                  <option value="third_limited">{t('novelConfig.narrativePOVOptions.third_limited')}</option>
                  <option value="third_omniscient">{t('novelConfig.narrativePOVOptions.third_omniscient')}</option>
                  <option value="multi_pov">{t('novelConfig.narrativePOVOptions.multi_pov')}</option>
                </NativeSelect>
              </Field>
              <Field label={t('novelConfig.totalChapters')}>
                <Input
                  type="number"
                  value={config.totalChapters}
                  onChange={(e) => update('totalChapters', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.totalChapters)
                    if (!v || v < 1) update('totalChapters', 100)
                  }}
                  placeholder="100"
                  min={1}
                />
              </Field>
              <Field label={t('novelConfig.wordsPerChapter')}>
                <Input
                  type="number"
                  value={config.wordsPerChapter}
                  onChange={(e) => update('wordsPerChapter', (e.target.value === '' ? '' : parseInt(e.target.value)) as number)}
                  onBlur={() => {
                    const v = Number(config.wordsPerChapter)
                    if (!v || v < 100) update('wordsPerChapter', 3000)
                  }}
                  placeholder="3000"
                  min={100}
                />
              </Field>
            </div>
          </Section>

          {/* 核心大纲 */}
          <Section
            title={t('novelConfig.coreOutline')}
            desc={t('novelConfig.coreOutlineDesc')}
            aiFieldKey="coreOutline"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea value={config.coreOutline} onChange={(e) => update('coreOutline', e.target.value)} placeholder={t('novelConfig.coreOutlinePlaceholder')} rows={4} />
          </Section>

          {/* 世界观设定 */}
          <Section
            title={t('novelConfig.worldSetting')}
            desc={t('novelConfig.worldSettingDesc')}
            aiFieldKey="worldSetting"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea value={config.worldSetting} onChange={(e) => update('worldSetting', e.target.value)} placeholder={t('novelConfig.worldSettingPlaceholder')} rows={4} />
          </Section>

          {/* 金手指 */}
          <Section
            title={t('novelConfig.goldenFinger')}
            desc={t('novelConfig.goldenFingerDesc')}
            aiFieldKey="goldenFinger"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea value={config.goldenFinger} onChange={(e) => update('goldenFinger', e.target.value)} placeholder={t('novelConfig.goldenFingerPlaceholder')} rows={3} />
          </Section>

          {/* 主角人设 */}
          <Section
            title={t('novelConfig.protagonistProfile')}
            desc={t('novelConfig.protagonistProfileDesc')}
            aiFieldKey="protagonistProfile"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea value={config.protagonistProfile} onChange={(e) => update('protagonistProfile', e.target.value)} placeholder={t('novelConfig.protagonistProfilePlaceholder')} rows={4} />
          </Section>

          {/* 全局写作要求 */}
          <Section
            title={t('novelConfig.globalGuidance')}
            desc={t('novelConfig.globalGuidanceDesc')}
            aiFieldKey="globalGuidance"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea
              value={config.globalGuidance}
              onChange={(e) => update('globalGuidance', e.target.value)}
              placeholder={t('novelConfig.globalGuidancePlaceholder')}
              rows={6}
            />
          </Section>

          {/* 文风配置 */}
          <Section
            title={t('novelConfig.writingStyle')}
            desc={t('novelConfig.writingStyleDesc')}
            aiFieldKey="writingStyle"
            generatingField={generatingField}
            onAIGenerate={handleFieldGenerate}
            t={t}
          >
            <Textarea
              value={config.writingStyle || ''}
              onChange={(e) => update('writingStyle', e.target.value)}
              placeholder={t('novelConfig.writingStylePlaceholder')}
              rows={6}
            />
            <div className="mt-2">
              <Button variant="outline" size="sm" onClick={() => setShowStyleGuide(true)}>
                <ScrollText size={11} />
                {t('novelConfig.styleGuide.button')}
              </Button>
            </div>
          </Section>

          {/* 参考作品 */}
          <Section title={t('novelConfig.referenceWorks')} desc={t('novelConfig.referenceWorksDesc')} t={t}>
            <Textarea value={config.referenceWorks || ''} onChange={(e) => update('referenceWorks', e.target.value)} placeholder={t('novelConfig.referenceWorksPlaceholder')} rows={2} />
          </Section>
        </div>
      </div>

      {/* AI 生成配置弹框 */}
      <GenerateConfigDialog
        isOpen={showGenerateConfig}
        onClose={() => setShowGenerateConfig(false)}
        onGenerated={(parsed) => {
          // 直接写 Store，组件自动重新渲染
          updateNovelConfig(parsed)
        }}
      />

      {/* 文风指南编译弹框：参考文本 → 有证据的可执行文风指南 */}
      <Dialog open={showStyleGuide} onOpenChange={(v) => !v && setShowStyleGuide(false)}>
        <DialogContent className="max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ScrollText size={15} className="text-[var(--color-accent)]" />
              {t('novelConfig.styleGuide.title')}
            </DialogTitle>
            <DialogDescription>{t('novelConfig.styleGuide.description')}</DialogDescription>
          </DialogHeader>
          <div className="px-5 py-2 space-y-3">
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('novelConfig.styleGuide.sourceLabel')}
              </label>
              <Input
                value={sourceTitle}
                onChange={(e) => setSourceTitle(e.target.value)}
                placeholder={t('novelConfig.styleGuide.sourcePlaceholder')}
              />
            </div>
            <div>
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('novelConfig.styleGuide.referenceLabel')}
              </label>
              <Textarea
                value={referenceText}
                onChange={(e) => setReferenceText(e.target.value)}
                placeholder={t('novelConfig.styleGuide.referencePlaceholder')}
                rows={8}
              />
            </div>
            <label className="flex items-start gap-2 cursor-pointer select-none text-xs" style={{ color: 'var(--color-text-secondary)' }}>
              <input
                type="checkbox"
                className="mt-0.5"
                checked={applyGuide}
                onChange={(e) => setApplyGuide(e.target.checked)}
              />
              <span>
                {t('novelConfig.styleGuide.applyLabel')}
                <span className="block mt-0.5" style={{ color: 'var(--color-text-muted)' }}>
                  {t('novelConfig.styleGuide.applyHint')}
                </span>
              </span>
            </label>
            <p className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
              {t('novelConfig.styleGuide.skillNote')}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowStyleGuide(false)}>
              {t('novelConfig.styleGuide.cancel')}
            </Button>
            <Button variant="ai" onClick={handleCompileStyleGuide} disabled={compiling}>
              {compiling ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
              {t('novelConfig.styleGuide.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/** 表单分组 — 支持右上角 AI 生成按钮 */
function Section({
  title,
  desc,
  children,
  aiFieldKey,
  generatingField,
  onAIGenerate,
  t,
}: {
  title: string
  desc?: string
  children: React.ReactNode
  /** 对应 NovelConfig 中的字段 key，传入则显示 AI 生成按钮 */
  aiFieldKey?: GeneratableField
  /** 当前正在生成的字段（全局共享状态，防止并发） */
  generatingField?: GeneratableField | null
  /** AI 生成回调 */
  onAIGenerate?: (fieldKey: GeneratableField) => void
  /** i18n translation function */
  t: (key: string, options?: Record<string, unknown>) => string
}) {
  const isGenerating = aiFieldKey != null && generatingField === aiFieldKey
  const isAnyGenerating = generatingField != null
  const showAIButton = aiFieldKey != null && onAIGenerate != null

  return (
    <div className="p-4 rounded-xl bg-[var(--color-sidebar)] border border-[var(--color-border)]">
      <div className="flex items-start justify-between mb-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
          {desc && <p className="text-xs mt-0.5" style={{ color: 'var(--color-text-muted)' }}>{desc}</p>}
        </div>
        {showAIButton && (
          <Button
            variant="ai"
            size="sm"
            onClick={() => onAIGenerate(aiFieldKey)}
            disabled={isAnyGenerating}
            className="flex-shrink-0 ml-3"
            title={isGenerating ? t('novelConfig.section.generating') : t('novelConfig.section.aiGenerateFor', { title })}
          >
            {isGenerating
              ? <Loader2 size={11} className="animate-spin" />
              : <Sparkles size={11} />
            }
            {isGenerating ? t('novelConfig.section.generatingShort') : t('novelConfig.section.aiGenerate')}
          </Button>
        )}
      </div>
      {children}
    </div>
  )
}

/** 表单字段 */
function Field({ label, tipItems, children }: { label: string; tipItems?: string[]; children: React.ReactNode }) {
  const [showTip, setShowTip] = useState(false)
  const tipRef = useRef<HTMLDivElement>(null)

  return (
    <div>
      <label className="text-xs mb-1 flex items-center gap-1 font-medium text-[var(--color-text-muted)]">
        {label}
        {tipItems && tipItems.length > 0 && (
          <span
            style={{ position: 'relative', display: 'inline-flex' }}
            onMouseEnter={() => setShowTip(true)}
            onMouseLeave={() => setShowTip(false)}
          >
            <Info size={11} style={{ opacity: 0.5 }} />
            {showTip && (
              <div
                ref={tipRef}
                style={{
                  position: 'absolute',
                  bottom: '100%',
                  left: '50%',
                  transform: 'translateX(-50%)',
                  marginBottom: 6,
                  padding: '8px 12px',
                  borderRadius: 8,
                  fontSize: 11,
                  lineHeight: 1.6,
                  whiteSpace: 'pre-line',
                  color: 'var(--color-text)',
                  background: 'var(--color-bg-elevated, var(--color-sidebar))',
                  border: '1px solid var(--color-border)',
                  boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
                  zIndex: 9999,
                  width: 260,
                  pointerEvents: 'none',
                }}
              >
                {tipItems.map((item, i) => {
                  // Handle both Chinese "：" and English ":" separators
                  const separator = item.includes('：') ? '：' : ': '
                  const parts = item.split(separator)
                  const title = parts[0]
                  const rest = parts.slice(1).join(separator)
                  return (
                    <div key={i} style={{ paddingLeft: 0 }}>
                      <span style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{title}</span>
                      {separator + rest}
                    </div>
                  )
                })}
              </div>
            )}
          </span>
        )}
      </label>
      {children}
    </div>
  )
}

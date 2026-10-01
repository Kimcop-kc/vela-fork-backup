import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ArrowDown, ArrowUp, Layers, Plus, Save, Sparkles, Trash2 } from 'lucide-react'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../ui/Dialog'
import { Button } from '../ui/Button'
import { Input } from '../ui/Input'
import { NativeSelect } from '../ui/NativeSelect'
import { toast } from '../ui/Toast'
import { confirm } from '../ui/Confirm'
import { ipc } from '../../services/ipc-client'
import { skillRegistry, type LoadedSkill } from '../../services/agent/skill-registry'
import {
  createPipelineStep,
  isValidPipelineName,
  movePipelineStep,
  normalizeSkillPipeline,
  pipelineStepDefaultValues,
  pipelineStepInput,
  validateSkillPipeline,
  type SkillPipeline,
  type SkillPipelineIssue,
  type SkillPipelineScope,
  type SkillPipelineStep,
} from '../../services/agent/skill-pipeline'
import SkillInputForm from './SkillInputForm'

/** 已保存的流水线列表项（与 skill:list-pipelines 的返回一致） */
interface PipelineSummary {
  name: string
  scope: SkillPipelineScope
  filePath: string
  title: string
  stepCount: number
}

interface SkillPipelineDialogProps {
  open: boolean
  onClose: () => void
  /** 执行整条流水线（由 DraftEditor 启动工作流，逐步确认） */
  onRun: (pipeline: SkillPipeline) => void
}

const NEW_PIPELINE_NAME = 'my-pipeline'

/**
 * Skill 流水线编辑器
 *
 * 把多个 Skill 串成一条链（例如「连续性审稿 → 去 AI 味 → 文风仿写」），
 * 一次跑完，步与步之间暂停等待人工确认。
 * 流水线本身是纯数据，存在 ~/.vela/pipelines/ 或 <项目>/.vela/pipelines/ 下。
 */
export default function SkillPipelineDialog({ open, onClose, onRun }: SkillPipelineDialogProps) {
  const { t } = useTranslation('editors')
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([])
  /** 当前编辑的是磁盘上的哪条流水线；空串表示还没保存过 */
  const [activeName, setActiveName] = useState('')
  const [scope, setScope] = useState<SkillPipelineScope>('project')
  const [editing, setEditing] = useState<SkillPipeline | null>(null)
  const [addSkill, setAddSkill] = useState('')
  const [error, setError] = useState('')

  // 打开时重新读一遍磁盘，避免用到过期的列表。
  // 只做异步加载，不在 effect 里同步 setState（会触发级联渲染）。
  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      try {
        const list = await ipc.invoke('skill:list-pipelines')
        if (!alive) return
        setPipelines(list)
        setError('')
        const first = list[0]
        if (!first) {
          setActiveName('')
          setScope('project')
          setEditing({ name: NEW_PIPELINE_NAME, steps: [] })
          return
        }
        const file = await ipc.invoke('skill:read-pipeline', first.name, first.scope)
        if (!alive) return
        setActiveName(first.name)
        setScope(first.scope)
        setEditing(file.success ? parsePipeline(file.content) : null)
      } catch {
        if (alive) setPipelines([])
      }
    })()
    return () => { alive = false }
  }, [open])

  // 每次渲染直接读注册表，保证拿到的 Skill 列表是最新的
  const skills: LoadedSkill[] = open ? skillRegistry.listAll() : []
  const skillInfos = skills.map(s => ({
    name: s.metadata.name,
    title: s.metadata.displayName ?? s.metadata.name,
    enabled: s.enabled,
    inputs: s.metadata.inputs,
  }))
  const skillTitle = (name: string) => skillInfos.find(s => s.name === name)?.title ?? name
  const fieldsOf = (name: string) => skills.find(s => s.metadata.name === name)?.metadata.inputs ?? []

  const issues = editing
    ? validateSkillPipeline(editing, skillInfos)
    : [{ code: 'empty' as const, severity: 'error' as const }]
  const blocking = issues.filter(issue => issue.severity === 'error')
  const warnings = issues.filter(issue => issue.severity === 'warning')

  /** 把校验结果翻成人话 */
  const issueText = (issue: SkillPipelineIssue) => {
    const step = (issue.index ?? 0) + 1
    const skill = skillTitle(issue.skill ?? '')
    switch (issue.code) {
      case 'unknown-skill':
        return t('draftEditor.skillPipelineIssueUnknownSkill', { index: step, skill })
      case 'disabled-skill':
        return t('draftEditor.skillPipelineIssueDisabledSkill', { index: step, skill })
      case 'duplicate-skill':
        return t('draftEditor.skillPipelineIssueDuplicateSkill', { index: step, skill })
      case 'missing-field':
        return t('draftEditor.skillPipelineIssueMissingField', { index: step, field: issue.field })
      case 'invalid-name':
        return t('draftEditor.skillPipelineIssueInvalidName')
      default:
        return t('draftEditor.skillPipelineIssueEmpty')
    }
  }

  const updateStep = (index: number, patch: Partial<SkillPipelineStep>) => {
    setEditing(prev => prev
      ? { ...prev, steps: prev.steps.map((s, i) => (i === index ? { ...s, ...patch } : s)) }
      : prev)
  }

  /** 换 Skill 时按新 schema 重置参数，避免把上一个 Skill 的参数带过去 */
  const changeStepSkill = (index: number, name: string) => {
    updateStep(index, {
      skill: name,
      args: undefined,
      values: pipelineStepDefaultValues(fieldsOf(name)),
      input: undefined,
    })
  }

  const addStep = () => {
    if (!addSkill) return
    setEditing(prev => prev
      ? {
        ...prev,
        steps: [...prev.steps, { ...createPipelineStep(addSkill), values: pipelineStepDefaultValues(fieldsOf(addSkill)) }],
      }
      : prev)
  }

  const removeStep = (index: number) => {
    setEditing(prev => prev ? { ...prev, steps: prev.steps.filter((_, i) => i !== index) } : prev)
  }

  const moveStep = (index: number, delta: number) => {
    setEditing(prev => prev ? { ...prev, steps: movePipelineStep(prev.steps, index, index + delta) } : prev)
  }

  const selectPipeline = async (name: string) => {
    const summary = pipelines.find(p => p.name === name && p.scope === scope) ?? pipelines.find(p => p.name === name)
    if (!summary) return
    try {
      const file = await ipc.invoke('skill:read-pipeline', summary.name, summary.scope)
      setActiveName(summary.name)
      setScope(summary.scope)
      setEditing(file.success ? parsePipeline(file.content) : null)
      setError('')
    } catch (e) {
      setError(t('draftEditor.skillPipelineSaveFailed', { error: String(e) }))
    }
  }

  const handleNew = () => {
    setActiveName('')
    setEditing({ name: NEW_PIPELINE_NAME, steps: [] })
    setError('')
  }

  const handleSave = async () => {
    if (!editing) return
    if (!isValidPipelineName(editing.name)) {
      setError(issueText({ code: 'invalid-name', severity: 'error' }))
      return
    }
    if (editing.steps.length === 0) {
      setError(issueText({ code: 'empty', severity: 'error' }))
      return
    }
    try {
      // 过一遍归一化再落盘：空 values、非法 input 这类冗余不会写进文件
      const normalized = normalizeSkillPipeline({ ...editing, scope, updatedAt: new Date().toISOString() })
      if (!normalized) {
        setError(issueText({ code: 'empty', severity: 'error' }))
        return
      }
      const payload = JSON.stringify(normalized, null, 2)
      const result = await ipc.invoke('skill:write-pipeline', editing.name, payload, scope)
      if (!result.success) {
        setError(t('draftEditor.skillPipelineSaveFailed', { error: result.error ?? '' }))
        return
      }
      setPipelines(await ipc.invoke('skill:list-pipelines'))
      setActiveName(editing.name)
      setError('')
      toast.success(t('draftEditor.skillPipelineSaved', { name: editing.name }))
    } catch (e) {
      setError(t('draftEditor.skillPipelineSaveFailed', { error: String(e) }))
    }
  }

  const handleDelete = async () => {
    if (!editing || !activeName) return
    const ok = await confirm(t('draftEditor.skillPipelineDeleteConfirmText', { name: activeName }), {
      title: t('draftEditor.skillPipelineDeleteConfirmTitle'),
      confirmText: t('draftEditor.skillPipelineDelete'),
      danger: true,
    })
    if (!ok) return
    const result = await ipc.invoke('skill:delete-pipeline', activeName, scope)
    if (!result.success) {
      setError(t('draftEditor.skillPipelineSaveFailed', { error: result.error ?? '' }))
      return
    }
    const list = await ipc.invoke('skill:list-pipelines')
    setPipelines(list)
    const first = list[0]
    if (first) await selectPipeline(first.name)
    else handleNew()
  }

  const handleRun = () => {
    if (!editing) return
    if (blocking.length > 0) {
      setError(issueText(blocking[0]))
      return
    }
    setError('')
    onRun(editing)
    onClose()
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-[560px] max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Layers size={15} className="text-[var(--color-accent)]" />
            {t('draftEditor.skillPipelineDialogTitle')}
          </DialogTitle>
          <DialogDescription>{t('draftEditor.skillPipelineDialogDesc')}</DialogDescription>
        </DialogHeader>

        <div className="px-5 py-2 space-y-3">
          {/* 已保存的流水线 */}
          <div className="flex items-end gap-2">
            <div className="flex-1">
              <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                {t('draftEditor.skillPipelineList')}
              </label>
              <NativeSelect
                value={activeName}
                onChange={(e) => { void selectPipeline(e.target.value) }}
                disabled={pipelines.length === 0}
              >
                {pipelines.length === 0 && <option value="">{t('draftEditor.skillPipelineEmpty')}</option>}
                {pipelines.map(p => (
                  <option key={`${p.scope}:${p.name}`} value={p.name}>
                    {p.title || p.name}（{p.stepCount} {t('draftEditor.skillPipelineStepUnit')}）
                  </option>
                ))}
              </NativeSelect>
            </div>
            <Button variant="outline" size="sm" onClick={handleNew}>
              <Plus size={12} />
              {t('draftEditor.skillPipelineNew')}
            </Button>
          </div>

          {editing && (
            <>
              <div className="flex gap-2">
                <div className="flex-1">
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('draftEditor.skillPipelineName')}
                  </label>
                  <Input
                    value={editing.name}
                    placeholder={t('draftEditor.skillPipelineNamePlaceholder')}
                    onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                    {t('draftEditor.skillPipelineTitleLabel')}
                  </label>
                  <Input
                    value={editing.title ?? ''}
                    placeholder={t('draftEditor.skillPipelineTitlePlaceholder')}
                    onChange={(e) => setEditing({ ...editing, title: e.target.value })}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('draftEditor.skillPipelineScope')}
                </label>
                <NativeSelect value={scope} onChange={(e) => setScope(e.target.value as SkillPipelineScope)}>
                  <option value="project">{t('draftEditor.skillPipelineScopeProject')}</option>
                  <option value="user">{t('draftEditor.skillPipelineScopeUser')}</option>
                </NativeSelect>
              </div>

              {/* 步骤列表 */}
              <div className="space-y-2">
                <div className="text-xs font-medium" style={{ color: 'var(--color-text-secondary)' }}>
                  {t('draftEditor.skillPipelineSteps')}
                </div>
                {editing.steps.length === 0 && (
                  <p className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                    {t('draftEditor.skillPipelineNoSteps')}
                  </p>
                )}
                {editing.steps.map((step, index) => {
                  const fields = fieldsOf(step.skill)
                  return (
                    <div
                      key={`${step.skill}-${index}`}
                      className="rounded-md border p-2 space-y-2"
                      style={{ borderColor: 'var(--color-border)' }}
                    >
                      <div className="flex items-center gap-1.5">
                        <span className="text-[0.7rem] tabular-nums w-4" style={{ color: 'var(--color-text-muted)' }}>
                          {index + 1}
                        </span>
                        <NativeSelect
                          className="flex-1"
                          value={step.skill}
                          onChange={(e) => changeStepSkill(index, e.target.value)}
                        >
                          {skills.map(s => (
                            <option key={s.metadata.name} value={s.metadata.name}>
                              {(s.metadata.displayName ?? s.metadata.name) + (s.enabled ? '' : `（${t('draftEditor.skillPipelineDisabledTag')}）`)}
                            </option>
                          ))}
                        </NativeSelect>
                        <button
                          type="button"
                          title={t('draftEditor.skillPipelineMoveUp')}
                          disabled={index === 0}
                          onClick={() => moveStep(index, -1)}
                          className="p-1 rounded disabled:opacity-30"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          <ArrowUp size={12} />
                        </button>
                        <button
                          type="button"
                          title={t('draftEditor.skillPipelineMoveDown')}
                          disabled={index === editing.steps.length - 1}
                          onClick={() => moveStep(index, 1)}
                          className="p-1 rounded disabled:opacity-30"
                          style={{ color: 'var(--color-text-secondary)' }}
                        >
                          <ArrowDown size={12} />
                        </button>
                        <button
                          type="button"
                          title={t('draftEditor.skillPipelineRemoveStep')}
                          onClick={() => removeStep(index)}
                          className="p-1 rounded"
                          style={{ color: 'var(--color-text-muted)' }}
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[0.68rem]" style={{ color: 'var(--color-text-muted)' }}>
                          {t('draftEditor.skillPipelineInputLabel')}
                        </span>
                        {index === 0 ? (
                          <span className="text-[0.68rem]" style={{ color: 'var(--color-text-secondary)' }}>
                            {t('draftEditor.skillPipelineInputChapter')}
                          </span>
                        ) : (
                          <NativeSelect
                            className="flex-1"
                            value={pipelineStepInput(editing.steps, index)}
                            onChange={(e) => updateStep(index, { input: e.target.value as 'chapter' | 'previous' })}
                          >
                            <option value="previous">{t('draftEditor.skillPipelineInputPrevious')}</option>
                            <option value="chapter">{t('draftEditor.skillPipelineInputChapter')}</option>
                          </NativeSelect>
                        )}
                      </div>

                      {fields.length > 0 ? (
                        <SkillInputForm
                          fields={fields}
                          values={step.values ?? {}}
                          onChange={(name, value) => updateStep(index, { values: { ...(step.values ?? {}), [name]: value } })}
                          compact
                          showHeading={false}
                        />
                      ) : (
                        <Input
                          value={step.args ?? ''}
                          placeholder={t('draftEditor.skillInvokeArgsPlaceholder')}
                          onChange={(e) => updateStep(index, { args: e.target.value })}
                        />
                      )}
                    </div>
                  )
                })}
              </div>

              {/* 添加一步 */}
              {skills.length === 0 ? (
                <p className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
                  {t('draftEditor.skillPipelineNoSkills')}
                </p>
              ) : (
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <label className="text-xs font-medium block mb-1.5" style={{ color: 'var(--color-text-secondary)' }}>
                      {t('draftEditor.skillPipelineAddStep')}
                    </label>
                    <NativeSelect value={addSkill} onChange={(e) => setAddSkill(e.target.value)}>
                      <option value="">{t('draftEditor.skillPipelineAddSkillPlaceholder')}</option>
                      {skills.map(s => (
                        <option key={s.metadata.name} value={s.metadata.name}>
                          {(s.metadata.displayName ?? s.metadata.name) + (s.enabled ? '' : `（${t('draftEditor.skillPipelineDisabledTag')}）`)}
                        </option>
                      ))}
                    </NativeSelect>
                  </div>
                  <Button variant="outline" size="sm" onClick={addStep} disabled={!addSkill}>
                    <Plus size={12} />
                    {t('draftEditor.skillPipelineAdd')}
                  </Button>
                </div>
              )}
            </>
          )}

          {error && (
            <p className="text-[0.7rem]" style={{ color: 'var(--color-error, #ef4444)' }}>{error}</p>
          )}
          {blocking.length > 0 && (
            <p className="text-[0.7rem]" style={{ color: 'var(--color-error, #ef4444)' }}>
              {blocking.map(issueText).join('；')}
            </p>
          )}
          {warnings.length > 0 && (
            <p className="text-[0.7rem]" style={{ color: 'var(--color-warning, #f59e0b)' }}>
              {warnings.map(issueText).join('；')}
            </p>
          )}

          <p className="text-[0.7rem]" style={{ color: 'var(--color-text-muted)' }}>
            {t('draftEditor.skillPipelineRunHint')}
          </p>
        </div>

        <DialogFooter>
          {activeName && (
            <Button variant="outline" onClick={() => { void handleDelete() }}>
              <Trash2 size={12} />
              {t('draftEditor.skillPipelineDelete')}
            </Button>
          )}
          <Button variant="outline" onClick={() => { void handleSave() }} disabled={!editing}>
            <Save size={12} />
            {t('draftEditor.skillPipelineSave')}
          </Button>
          <Button variant="ai" onClick={handleRun} disabled={!editing || blocking.length > 0}>
            <Sparkles size={12} />
            {t('draftEditor.skillPipelineRun')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** 读盘内容坏了就当没有，避免整个弹窗炸掉 */
function parsePipeline(content: string): SkillPipeline | null {
  try {
    return normalizeSkillPipeline(JSON.parse(content))
  } catch {
    return null
  }
}

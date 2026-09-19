import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import './Backlog.css'
import './Flow.css'
import FlowRewriteModal, { RewriteIcon } from './FlowRewriteModal'
import type { BasePerformers } from './Performers'
import { plural } from './plural'
import { VsCodeIcon } from './VsCodeIcon'

export type FlowStep = {
  title: string
  executor: string
  output: string
  skip: string | null
  /** Описание шага пунктами — как в файле. Панель его не показывает, а переносит при записи. */
  description: string | null
}

export type BaseFlow = {
  base: string
  project: string
  steps: FlowStep[]
  activeTasks: number
  version: string | null
  error: string | null
  /** Значки шагов, выбранные оператором: название шага — значок. Их помнит панель, а не файл флоу. */
  icons: Record<string, string>
}

export type StepPreset = FlowStep & { id: string }

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; flows: BaseFlow[] }

// Шаг в форме: key держит шаг на месте при перестановке, исполнитель разложен на выбор и имя субагента.
type DraftStep = {
  key: number
  title: string
  kind: 'оркестратор' | 'оператор' | 'субагент'
  agent: string
  output: string
  skip: string
  description: string | null
  icon: string
}

type Notice = { kind: 'done' | 'error'; text: string } | null

const kinds: DraftStep['kind'][] = ['оркестратор', 'оператор', 'субагент']

let nextKey = 1

function toDraft(step: FlowStep, icon = ''): DraftStep {
  const executor = step.executor.trim()
  const known = executor === 'оркестратор' || executor === 'оператор'
  return {
    key: nextKey++,
    title: step.title,
    kind: known ? executor : 'субагент',
    agent: known ? '' : executor,
    output: step.output,
    skip: step.skip ?? '',
    description: step.description,
    icon,
  }
}

function toStep(draft: DraftStep): FlowStep {
  return {
    title: draft.title.trim(),
    executor: draft.kind === 'субагент' ? draft.agent.trim() : draft.kind,
    output: draft.output.trim(),
    skip: draft.skip.trim() || null,
    description: draft.description,
  }
}

/** Значки шагов для записи: название шага — значок. Шаг без своего значка в запись не идёт. */
function toIcons(draft: DraftStep[]): Record<string, string> {
  const icons: Record<string, string> = {}
  for (const step of draft) {
    const title = step.title.trim()
    if (title && step.icon) icons[title] = step.icon
  }
  return icons
}

/** Что мешает записать шаг в форме кита; пустой список — шаг годится. */
function stepErrors(draft: DraftStep) {
  const errors: string[] = []
  if (!draft.title.trim()) errors.push('нет названия')
  if (draft.kind === 'субагент' && !draft.agent.trim()) errors.push('не указано имя субагента')
  if (!draft.output.trim()) errors.push('не указан выход')
  return errors
}

// Номер пункта описания «3.2.1.»: номер шага — первое число.
const pointNumber = /^([ \t]*)\d+(?=(?:\.\d+)+\.)/gm

/** Номер шага в пунктах описания — текущий: после перестановки файл запишет его так же. */
function renumber(description: string, number: number) {
  return description.replace(pointNumber, `$1${number}`)
}

/** Перестановка, добавление и удаление сдвигают номера шагов — пункты их описаний идут следом. */
function renumbered(draft: DraftStep[]): DraftStep[] {
  return draft.map((step, index) => {
    const description = step.description === null ? null : renumber(step.description, index + 1)
    return description === step.description ? step : { ...step, description }
  })
}

const sameStep = (a: FlowStep, b: FlowStep) =>
  a.title === b.title &&
  a.executor === b.executor &&
  a.output === b.output &&
  (a.skip ?? null) === (b.skip ?? null) &&
  (a.description ?? null) === (b.description ?? null)

const sameIcons = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** Правки, которых нет в файле базы: по ним видно, что флоу стоит сохранить. */
const changed = (flow: BaseFlow, draft: DraftStep[]) => {
  const steps = draft.map(toStep)
  return (
    steps.length !== flow.steps.length ||
    steps.some((step, index) => !sameStep(step, flow.steps[index])) ||
    !sameIcons(toIcons(draft), flow.icons ?? {})
  )
}

/** Шаг зовёт субагента, которого на диске нет: пока имя пустое, это просто незаполненный шаг. */
const missingPerformer = (step: DraftStep, known: string[]) =>
  step.kind === 'субагент' && step.agent.trim().length > 0 && !known.includes(step.agent.trim())

const invalidLabels: Record<string, string> = {
  'empty-title': 'нет названия',
  'empty-executor': 'не указан исполнитель',
  'empty-output': 'не указан выход',
  'line-break': 'перевод строки в поле',
}

/**
 * rewriteFor — база просьбы, к которой вернулся оператор: окно переписывания открывается сразу на ней.
 * onPerformers — переход в раздел «Исполнители»: оттуда заводят того, кого шаг не нашёл.
 */
export default function Flow({
  rewriteFor = null,
  onPerformers,
}: { rewriteFor?: string | null; onPerformers?: () => void } = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(rewriteFor)
  const [presets, setPresets] = useState<StepPreset[]>([])
  // Заведённые исполнители: из них шагу выбирают субагента, и по ним видно, кого на диске нет.
  const [performers, setPerformers] = useState<BasePerformers[]>([])
  // Правки поверх прочитанного файла: ключ — база и её отпечаток, поэтому правки чужого
  // или перечитанного флоу не всплывают.
  const [edits, setEdits] = useState<{ key: string; steps: DraftStep[] } | null>(null)
  // Какой шаг открыт в сайдбаре: key шага, а не место — место меняется перетаскиванием.
  const [opened, setOpened] = useState<number | null>(null)
  // Какое окно открыто поверх схемы: описание шага, выбор нового шага или переписывание флоу агентом.
  const [modal, setModal] = useState<'description' | 'add' | 'rewrite' | null>(rewriteFor ? 'rewrite' : null)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const loadFlows = useCallback(() => {
    fetch('/api/flow')
      .then((response) => {
        if (!response.ok) throw new Error(`Флоу не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseFlow[]>
      })
      .then(
        (flows) => {
          setLoad({ kind: 'loaded', flows })
          // Выбранная база могла уйти из списка — тогда показывается первая.
          setSelected((current) => (flows.some((f) => f.base === current) ? current : (flows[0]?.base ?? null)))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [])

  // Флоу читается при открытии раздела и кнопкой «Обновить», как бэклог.
  useEffect(loadFlows, [loadFlows])

  useEffect(() => {
    fetch('/api/presets')
      .then((response) => (response.ok ? (response.json() as Promise<StepPreset[]>) : []))
      .then(setPresets, () => setPresets([]))
  }, [])

  useEffect(() => {
    fetch('/api/performers')
      .then((response) => (response.ok ? (response.json() as Promise<BasePerformers[]>) : []))
      .then(setPerformers, () => setPerformers([]))
  }, [])

  const flows = load.kind === 'loaded' ? load.flows : []
  const flow = flows.find((f) => f.base === selected) ?? null
  // Шаг зовёт исполнителя именем; здесь — ровно те, кого раздел «Исполнители» показывает у проекта:
  // файл у исполнителя один на машину, и выбирать из чего-то ещё шагу незачем.
  const known = flow
    ? (performers.find((p) => p.base === flow.base)?.performers.map((p) => p.name) ?? [])
    : []

  // Шаги базы кладутся в форму: править их можно сразу, отдельного режима правки нет.
  const flowKey = flow ? `${flow.base}@${flow.version ?? ''}` : ''
  const saved = useMemo(
    () => (flow ? flow.steps.map((step) => toDraft(step, flow.icons?.[step.title] ?? '')) : []),
    [flowKey], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const draft = edits?.key === flowKey ? edits.steps : saved
  const setDraft = (steps: DraftStep[]) => setEdits({ key: flowKey, steps })

  const dirty = flow !== null && changed(flow, draft)

  const refresh = useCallback(() => {
    setNotice(null)
    setLoad({ kind: 'loading' })
    loadFlows()
  }, [loadFlows])

  async function openInVsCode(base: string) {
    setNotice(null)
    try {
      const response = await fetch('/api/flow/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base }),
      })
      if (!response.ok) setNotice({ kind: 'error', text: 'Не удалось открыть флоу в VS Code' })
    } catch {
      setNotice({ kind: 'error', text: 'Не удалось открыть флоу в VS Code: нет связи с API' })
    }
  }

  async function save(target: BaseFlow, steps: DraftStep[]) {
    setConfirming(false)
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: target.base,
          version: target.version,
          steps: steps.map(toStep),
          icons: toIcons(steps),
        }),
      })
      if (response.ok) {
        setNotice({ kind: 'done', text: 'Флоу сохранён и закоммичен в базу' })
        loadFlows()
        return
      }
      const body = (await response.json().catch(() => null)) as {
        problem?: string
        step?: number
        detail?: string
      } | null
      setNotice({ kind: 'error', text: saveError(response.status, body) })
    } catch {
      setNotice({ kind: 'error', text: 'Флоу не сохранён: нет связи с API' })
    } finally {
      setSaving(false)
    }
  }

  async function saveAsPreset(step: FlowStep) {
    try {
      const response = await fetch('/api/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(step),
      })
      if (!response.ok) throw new Error()
      const preset = (await response.json()) as StepPreset
      setPresets((current) => (current.some((p) => p.id === preset.id) ? current : [...current, preset]))
    } catch {
      setNotice({ kind: 'error', text: 'Пресет не сохранён' })
    }
  }

  async function removePreset(preset: StepPreset) {
    try {
      const response = await fetch(`/api/presets/${encodeURIComponent(preset.id)}`, { method: 'DELETE' })
      if (!response.ok && response.status !== 404) throw new Error()
      setPresets((current) => current.filter((p) => p.id !== preset.id))
    } catch {
      setNotice({ kind: 'error', text: 'Пресет не удалён' })
    }
  }

  const update = (index: number, patch: Partial<DraftStep>) =>
    setDraft(draft.map((step, i) => (i === index ? { ...step, ...patch } : step)))

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= draft.length) return
    const next = [...draft]
    const [step] = next.splice(from, 1)
    next.splice(to, 0, step)
    setDraft(renumbered(next))
  }

  const openedIndex = draft.findIndex((step) => step.key === opened)
  const firstBad = draft.findIndex((step) => stepErrors(step).length > 0)
  const editable = flow !== null && !flow.error

  return (
    <>
      <div className="content-head">
        {/* Название проекта стоит на чипе: над схемой его не повторяют — замечание оператора. */}
        <h2>Флоу</h2>
        <div className="head-end flow-actions">
          {dirty && <span className="flow-dirty">есть несохранённые правки</span>}
          {firstBad >= 0 && (
            <span className="flow-blocked">
              Не сохранить: шаг {firstBad + 1} — {stepErrors(draft[firstBad]).join(', ')}
            </span>
          )}
          <button
            type="button"
            className="bases-btn"
            onClick={refresh}
            // Обновление перечитает файл базы: незаписанные правки оно бы стёрло молча.
            disabled={load.kind === 'loading' || dirty}
          >
            <RefreshIcon />
            Обновить
          </button>
          {editable && (
            <>
              <button
                type="button"
                className="bases-btn"
                // Пока правки не сохранены, переписывать нечего: агент работает с файлом базы.
                disabled={dirty}
                title={dirty ? 'Сначала сохраните или отмените свои правки' : undefined}
                onClick={() => {
                  setNotice(null)
                  setModal('rewrite')
                }}
              >
                <RewriteIcon />
                Переписать с {AGENT_NAME}
              </button>
              <button type="button" className="btn-code" onClick={() => void openInVsCode(flow.base)}>
                <VsCodeIcon />
                Открыть в VS Code
              </button>
              {dirty && (
                <button
                  type="button"
                  className="bases-btn"
                  disabled={saving}
                  onClick={() => {
                    setNotice(null)
                    setEdits(null)
                    setOpened(null)
                  }}
                >
                  Отменить правки
                </button>
              )}
              <button
                type="button"
                className="bases-btn bases-btn-primary"
                disabled={saving || !dirty || firstBad >= 0}
                onClick={() => (flow.activeTasks > 0 ? setConfirming(true) : void save(flow, draft))}
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </>
          )}
        </div>
      </div>

      {load.kind === 'loading' && <p className="message text-sec">Загрузка флоу…</p>}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}
      {notice && (
        <p className={`message ${notice.kind === 'done' ? 'flow-done' : 'warning-text'}`} role="status">
          {notice.text}
        </p>
      )}

      {load.kind === 'loaded' && flows.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}

      {load.kind === 'loaded' && flows.length > 1 && (
        <div className="filter-bar" role="group" aria-label="Проекты">
          {flows.map((f) => (
            <button
              key={f.base}
              type="button"
              className={`chip ${f.base === selected ? 'active' : ''}`}
              aria-pressed={f.base === selected}
              // Правка идёт по флоу одной базы: пока она не записана, проект не переключается.
              disabled={dirty}
              onClick={() => setSelected(f.base)}
            >
              {f.project}
            </button>
          ))}
        </div>
      )}

      {flow && (
        <section className="flow-canvas" aria-label={flow.project}>
          {flow.error && (
            <p className="backlog-note warning-text">
              {flow.error === 'В базе нет flow.md'
                ? 'В базе нет файла флоу. Агент не начнёт задачу на этом проекте, пока флоу не записан.'
                : flow.error}
            </p>
          )}

          {editable && (
            <>
              <div className="flow-scroll">
              <div className="flow-chain">
                {draft.length === 0 && (
                  <p className="backlog-note text-sec">
                    Во флоу пока нет шагов. Агент не начнёт задачу на этом проекте, пока шаги не записаны.
                  </p>
                )}
                {draft.map((step, index) => (
                  <StepNode
                    key={step.key}
                    step={step}
                    missing={missingPerformer(step, known)}
                    number={index + 1}
                    opened={step.key === opened}
                    onOpen={() => setOpened(step.key)}
                    onMove={move}
                    index={index}
                    last={index === draft.length - 1}
                  />
                ))}
                {draft.length > 0 && <FlowArrow />}
                <button
                  type="button"
                  className="flow-node flow-node-add"
                  onClick={() => setModal('add')}
                >
                  <PlusIcon />
                  <span className="flow-node-title">Добавить шаг</span>
                </button>
              </div>
              </div>

              {openedIndex >= 0 && (
                <StepDrawer
                  step={draft[openedIndex]}
                  known={known}
                  onPerformers={onPerformers}
                  number={openedIndex + 1}
                  isPreset={presets.some((preset) => sameStep(preset, toStep(draft[openedIndex])))}
                  onChange={(patch) => update(openedIndex, patch)}
                  onClose={() => setOpened(null)}
                  onSaveAsPreset={() => void saveAsPreset(toStep(draft[openedIndex]))}
                  onEditDescription={() => setModal('description')}
                  onDelete={() => {
                    setDraft(renumbered(draft.filter((_, i) => i !== openedIndex)))
                    setOpened(null)
                  }}
                />
              )}

              {modal === 'description' && openedIndex >= 0 && (
                <DescriptionEditor
                  title={draft[openedIndex].title}
                  description={draft[openedIndex].description}
                  onCancel={() => setModal(null)}
                  onDone={(description) => {
                    update(openedIndex, { description })
                    setModal(null)
                  }}
                />
              )}

              {modal === 'rewrite' && (
                <FlowRewriteModal
                  base={flow.base}
                  project={flow.project}
                  steps={flow.steps}
                  version={flow.version}
                  onClose={() => setModal(null)}
                  onApply={(steps) => {
                    // Переписанное ложится в правки схемы: записывает его та же кнопка «Сохранить».
                    setDraft(renumbered(steps.map((step) => toDraft(step, flow.icons?.[step.title] ?? ''))))
                    setOpened(null)
                    setModal(null)
                    setNotice({ kind: 'done', text: `Правки ${AGENT_NAME} в схеме — их ещё нужно сохранить` })
                  }}
                />
              )}

              {modal === 'add' && (
                <AddStep
                  presets={presets}
                  onCancel={() => setModal(null)}
                  onAdd={(step) => {
                    const added = toDraft(step)
                    setDraft(renumbered([...draft, added]))
                    setOpened(added.key)
                    setModal(null)
                  }}
                  onRemovePreset={(preset) => void removePreset(preset)}
                />
              )}
            </>
          )}
        </section>
      )}

      {confirming && flow && (
        <ConfirmSave flow={flow} onCancel={() => setConfirming(false)} onConfirm={() => void save(flow, draft)} />
      )}
    </>
  )
}

function saveError(status: number, body: { problem?: string; step?: number; detail?: string } | null) {
  if (status === 409)
    return 'Флоу не сохранён: файл флоу изменился в базе, пока вы его правили. Отмените правки и обновите флоу.'
  if (status === 400 && body?.step)
    return `Флоу не сохранён: шаг ${body.step} — ${invalidLabels[body.detail ?? ''] ?? 'не в форме кита'}`
  if (status === 502 && body?.problem === 'not-committed')
    return `Флоу не сохранён: коммит в базу не прошёл, файл оставлен как был.${body.detail ? ` ${body.detail}` : ''}`
  if (status === 404) return 'Флоу не сохранён: файл флоу базы не найден'
  return 'Флоу не сохранён'
}

const executorOf = (step: DraftStep) => (step.kind === 'субагент' ? `субагент ${step.agent}`.trim() : step.kind)

const executorKind = (step: DraftStep) =>
  step.kind === 'оркестратор' ? 'orchestrator' : step.kind === 'оператор' ? 'operator' : 'agent'

/** Блок шага на схеме: без номера — по решению оператора, — со значком, названием и исполнителем. */
function StepNode({
  step,
  missing,
  number,
  index,
  last,
  opened,
  onOpen,
  onMove,
}: {
  step: DraftStep
  missing: boolean
  number: number
  index: number
  last: boolean
  opened: boolean
  onOpen: () => void
  onMove: (from: number, to: number) => void
}) {
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  const errors = stepErrors(step)

  return (
    <>
      {number > 1 && <FlowArrow />}
      <div className="flow-node-row">
      <button
        type="button"
        className={`flow-node ${opened ? 'opened' : ''} ${dragging ? 'dragging' : ''} ${over ? 'drop-target' : ''} ${
          errors.length > 0 ? 'invalid' : ''
        }`}
        aria-label={`Шаг ${number}: ${step.title.trim() || 'без названия'}`}
        aria-current={opened}
        draggable
        onClick={onOpen}
        onDragStart={(event: DragEvent) => {
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', String(index))
          setDragging(true)
        }}
        onDragEnd={() => {
          setDragging(false)
          setOver(false)
        }}
        onDragOver={(event: DragEvent) => {
          event.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(event: DragEvent) => {
          event.preventDefault()
          setOver(false)
          const from = Number(event.dataTransfer.getData('text/plain'))
          if (Number.isInteger(from)) onMove(from, index)
        }}
      >
        <span className="flow-grip" aria-hidden="true">
          <GripIcon />
        </span>
        {step.skip.trim() && (
          <span className="flow-node-skip" title="есть условие пропуска" aria-hidden="true">
            <SkipIcon />
          </span>
        )}
        {/* Исполнителя шагу не хватает: сессия дойдёт до него и спросит оператора. */}
        {missing && (
          <span
            className="flow-node-missing"
            aria-label={`Исполнителя ${step.agent.trim()} нет на диске`}
          >
            <MissingIcon />
          </span>
        )}
        <span className={`flow-node-mark flow-mark-${executorKind(step)}`} aria-hidden="true">
          <StepIcon icon={step.icon} kind={executorKind(step)} />
        </span>
        <span className="flow-node-title">{step.title.trim() || 'без названия'}</span>
        <span className="flow-node-executor">{executorOf(step) || 'субагент'}</span>
      </button>
      {/* Клавиатурой шаг двигается кнопками: перетаскивание ей недоступно. */}
      <span className="flow-node-keys">
        <IconButton label={`Шаг ${number} выше`} disabled={number === 1} onClick={() => onMove(index, index - 1)}>
          <ChevronUpIcon />
        </IconButton>
        <IconButton label={`Шаг ${number} ниже`} disabled={last} onClick={() => onMove(index, index + 1)}>
          <ChevronDownIcon />
        </IconButton>
      </span>
      </div>
    </>
  )
}

/**
 * Имя субагента: выбор из заведённых, потому что шаг зовёт его именно по имени. Чужое имя
 * вписывается пунктом «вписать имя…» — флоу правят и руками, и панель не должна этому мешать.
 */
function PerformerField({
  step,
  known,
  onChange,
  onPerformers,
}: {
  step: DraftStep
  known: string[]
  onChange: (patch: Partial<DraftStep>) => void
  onPerformers?: () => void
}) {
  const agent = step.agent.trim()
  const missing = missingPerformer(step, known)
  // Ручной ввод включает сам оператор; список исполнителей приезжает после первого показа сайдбара.
  const [typing, setTyping] = useState(false)

  if (typing || known.length === 0) {
    return (
      <div className="flow-field">
        <span>имя субагента</span>
        <input
          className="flow-input mono"
          aria-label="Имя субагента"
          placeholder="имя субагента"
          aria-invalid={!agent}
          value={step.agent}
          onChange={(event) => onChange({ agent: event.target.value })}
        />
        {known.length > 0 && (
          <button type="button" className="flow-link" onClick={() => setTyping(false)}>
            выбрать из заведённых
          </button>
        )}
        {missing && <MissingNote agent={agent} onPerformers={onPerformers} />}
      </div>
    )
  }

  return (
    <div className="flow-field">
      <span>имя субагента</span>
      <select
        className="flow-input mono"
        aria-label="Имя субагента"
        aria-invalid={!agent}
        value={agent}
        onChange={(event) => {
          if (event.target.value === CUSTOM_AGENT) {
            setTyping(true)
            return
          }
          onChange({ agent: event.target.value })
        }}
      >
        {agent === '' && <option value="">выберите исполнителя</option>}
        {missing && <option value={agent}>{agent} — на диске нет</option>}
        {known.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
        <option value={CUSTOM_AGENT}>вписать имя…</option>
      </select>
      {missing && <MissingNote agent={agent} onPerformers={onPerformers} />}
    </div>
  )
}

/** Пункт «вписать имя…»: именем субагента такая строка быть не может — только строчная латиница. */
const CUSTOM_AGENT = '__custom__'

/** Исполнитель, которого шагу не хватает, — не ошибка файла: сессия дойдёт до шага и спросит оператора. */
function MissingNote({ agent, onPerformers }: { agent: string; onPerformers?: () => void }) {
  return (
    <p className="flow-missing" role="status">
      Исполнитель <span className="mono">{agent}</span> на диске не найден. Сессия дойдёт до шага
      и спросит вас, а сама за него работать не станет.
      {onPerformers && (
        <button type="button" className="flow-link" onClick={onPerformers}>
          Завести исполнителя
        </button>
      )}
    </p>
  )
}

function FlowArrow() {
  return (
    <span className="flow-arrow" aria-hidden="true">
      <svg viewBox="0 0 12 32" fill="none">
        <path d="M6 0 V23" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 31 L2.5 23 h7 z" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

/** Сайдбар шага: поля правятся сразу, а файл флоу записывается кнопкой «Сохранить» в шапке. */
function StepDrawer({
  step,
  known,
  onPerformers,
  number,
  isPreset,
  onChange,
  onClose,
  onSaveAsPreset,
  onEditDescription,
  onDelete,
}: {
  step: DraftStep
  known: string[]
  onPerformers?: () => void
  number: number
  isPreset: boolean
  onChange: (patch: Partial<DraftStep>) => void
  onClose: () => void
  onSaveAsPreset: () => void
  onEditDescription: () => void
  onDelete: () => void
}) {
  const errors = stepErrors(step)
  const title = step.title.trim() || 'без названия'

  return (
    <aside
      className="flow-drawer"
      aria-label={`Шаг ${number}: ${title}`}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
    >
      <div className="flow-drawer-head">
        <span className={`flow-node-mark flow-mark-${executorKind(step)}`} aria-hidden="true">
          <StepIcon icon={step.icon} kind={executorKind(step)} />
        </span>
        <div className="flow-drawer-name">
          <h3>{title}</h3>
          <span className="flow-node-executor">{executorOf(step) || 'субагент'}</span>
        </div>
        <IconButton label="Закрыть сайдбар" onClick={onClose}>
          <CloseIcon />
        </IconButton>
      </div>

      <div className="flow-drawer-body">
        <label className="flow-field">
          <span>название</span>
          <input
            className="flow-input"
            aria-label="Название шага"
            placeholder="Название шага"
            aria-invalid={!step.title.trim()}
            value={step.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>

        <div className="flow-field">
          <span>значок</span>
          <IconPicker step={step} onPick={(icon) => onChange({ icon })} />
        </div>

        <label className="flow-field">
          <span>исполнитель</span>
          <select
            className="flow-input"
            aria-label="Исполнитель шага"
            value={step.kind}
            onChange={(event) => onChange({ kind: event.target.value as DraftStep['kind'] })}
          >
            {kinds.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>

        {step.kind === 'субагент' && (
          <PerformerField step={step} known={known} onChange={onChange} onPerformers={onPerformers} />
        )}

        <label className="flow-field">
          <span>выход</span>
          <textarea
            className="flow-input"
            aria-label="Выход шага"
            placeholder="что предъявить: коммит, строка в памяти, вывод прогона"
            aria-invalid={!step.output.trim()}
            rows={3}
            value={step.output}
            onChange={(event) => onChange({ output: event.target.value })}
          />
        </label>

        <label className="flow-field">
          <span>пропуск</span>
          <input
            className="flow-input"
            aria-label="Пропуск шага"
            placeholder="нет — шаг проходится всегда"
            value={step.skip}
            onChange={(event) => onChange({ skip: event.target.value })}
          />
        </label>

        <div className="flow-field">
          <span>описание</span>
          {/* Кнопка показывает лишь наличие описания: без него та же надпись, но пунктиром. */}
          <button
            type="button"
            className={`bases-btn flow-description-btn ${step.description ? '' : 'flow-description-empty'}`}
            title={step.description ? 'Описание есть — править' : 'Описания нет — добавить'}
            onClick={onEditDescription}
          >
            <FileTextIcon />
            Редактировать описание
          </button>
        </div>

        {errors.length > 0 && <p className="flow-step-error">Шаг не сохранить: {errors.join(', ')}.</p>}
      </div>

      <div className="flow-drawer-foot">
        <button
          type="button"
          className="bases-btn"
          disabled={errors.length > 0 || isPreset}
          aria-pressed={isPreset}
          onClick={onSaveAsPreset}
        >
          <BookmarkIcon />
          {isPreset ? 'Шаг в пресетах' : 'В пресеты'}
        </button>
        <button type="button" className="bases-btn bases-btn-danger flow-drawer-delete" onClick={onDelete}>
          <TrashIcon />
          Удалить шаг
        </button>
      </div>
    </aside>
  )
}

/** Описание шага правится текстом в окне, а не полем сайдбара — решение оператора. */
function DescriptionEditor({
  title,
  description,
  onCancel,
  onDone,
}: {
  title: string
  description: string | null
  onCancel: () => void
  onDone: (description: string | null) => void
}) {
  const [text, setText] = useState(description ?? '')
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => field.current?.focus(), [])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="flow-confirm flow-description"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-description-title"
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <h3 id="flow-description-title">Описание шага «{title.trim() || 'без названия'}»</h3>
        <textarea
          ref={field}
          className="flow-input flow-description-text"
          aria-label="Описание шага"
          rows={16}
          spellCheck={false}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="flow-confirm-actions">
          <button type="button" className="bases-btn" onClick={onCancel}>
            Отмена
          </button>
          <button
            type="button"
            className="bases-btn bases-btn-primary"
            onClick={() => onDone(text.replace(/\r\n/g, '\n').trim() ? text.replace(/\r\n/g, '\n') : null)}
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

/** Значки на выбор; те же имена знает API, и чужого значка он не запомнит. */
const stepIcons: { id: string; label: string; icon: ReactNode }[] = [
  { id: 'target', label: 'цель', icon: <TargetIcon /> },
  { id: 'branch', label: 'ветка', icon: <BranchIcon /> },
  { id: 'code', label: 'код', icon: <CodeIcon /> },
  { id: 'check', label: 'проверка', icon: <CheckIcon /> },
  { id: 'base', label: 'база', icon: <DatabaseIcon /> },
]

function StepIcon({ icon, kind }: { icon: string; kind: string }) {
  const chosen = stepIcons.find((one) => one.id === icon)
  if (chosen) return chosen.icon
  return kind === 'operator' ? <OperatorIcon /> : kind === 'agent' ? <AgentIcon /> : <OrchestratorIcon />
}

/** Список значков: в нём сами значки, а не их названия — решение оператора. */
function IconPicker({ step, onPick }: { step: DraftStep; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const pick = (icon: string) => {
    onPick(icon)
    setOpen(false)
  }

  return (
    <div className="flow-icons" ref={box} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="flow-icon-toggle"
        aria-label="Значок шага"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`flow-node-mark flow-mark-${executorKind(step)}`} aria-hidden="true">
          <StepIcon icon={step.icon} kind={executorKind(step)} />
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="flow-icon-menu" role="group" aria-label="Значки шага">
          <button
            type="button"
            className="flow-icon-btn"
            aria-label="Значок по исполнителю"
            title="по исполнителю"
            aria-pressed={!step.icon}
            onClick={() => pick('')}
          >
            <StepIcon icon="" kind={executorKind(step)} />
          </button>
          {stepIcons.map((one) => (
            <button
              key={one.id}
              type="button"
              className="flow-icon-btn"
              aria-label={`Значок «${one.label}»`}
              title={one.label}
              aria-pressed={step.icon === one.id}
              onClick={() => pick(one.id)}
            >
              {one.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const emptyStep: FlowStep = { title: '', executor: 'оркестратор', output: '', skip: null, description: null }

/** Новый шаг выбирается своим окном: пустой шаг или шаг из пресетов оператора. */
function AddStep({
  presets,
  onAdd,
  onCancel,
  onRemovePreset,
}: {
  presets: StepPreset[]
  onAdd: (step: FlowStep) => void
  onCancel: () => void
  onRemovePreset: (preset: StepPreset) => void
}) {
  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="flow-confirm flow-add"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-add-title"
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <h3 id="flow-add-title">Добавить шаг</h3>
        <div className="flow-presets" role="group" aria-label="Пресеты шагов">
          <button type="button" className="flow-preset" onClick={() => onAdd(emptyStep)}>
            <span className="flow-preset-title">Пустой шаг</span>
            <span className="text-sec">всё заполнить самому</span>
          </button>
          <div className="flow-presets-label">Пресеты</div>
          {presets.length === 0 && (
            <p className="flow-presets-empty text-ter">
              Пресетов пока нет. Шаг сохраняется в пресеты кнопкой в сайдбаре шага.
            </p>
          )}
          {presets.map((preset) => (
            <div className="flow-preset-row" key={preset.id}>
              <button type="button" className="flow-preset" onClick={() => onAdd(preset)}>
                <span className="flow-preset-head">
                  <span className="flow-preset-title">{preset.title}</span>
                  <ExecutorBadge executor={preset.executor} />
                </span>
                <span className="text-sec">
                  выход: {preset.output}
                  {preset.skip ? ` · пропуск: ${preset.skip}` : ''}
                </span>
              </button>
              <IconButton label={`Удалить пресет ${preset.title}`} danger onClick={() => onRemovePreset(preset)}>
                <CloseIcon />
              </IconButton>
            </div>
          ))}
        </div>
        <div className="flow-confirm-actions">
          <button type="button" className="bases-btn" onClick={onCancel}>
            Отмена
          </button>
        </div>
      </div>
    </div>
  )
}

function ExecutorBadge({ executor }: { executor: string }) {
  const kind = executor === 'оркестратор' ? 'orchestrator' : executor === 'оператор' ? 'operator' : 'agent'
  return (
    <span className={`flow-executor flow-executor-${kind}`}>
      {kind === 'agent' ? `субагент ${executor}` : executor}
    </span>
  )
}

function ConfirmSave({ flow, onCancel, onConfirm }: { flow: BaseFlow; onCancel: () => void; onConfirm: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => confirm.current?.focus(), [])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="flow-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-confirm-title"
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <h3 id="flow-confirm-title">Сохранить флоу {flow.project}?</h3>
        <p className="text-sec">
          Файл флоу в базе будет переписан и закоммичен отдельным коммитом. Следующая задача на проекте пойдёт уже по
          новому флоу.
        </p>
        <p className="flow-confirm-warning">
          На проекте {plural(flow.activeTasks, 'задача', 'задачи', 'задач')} в работе. Они дойдут по старым шагам —
          новый флоу их не меняет.
        </p>
        <div className="flow-confirm-actions">
          <button type="button" className="bases-btn" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="bases-btn bases-btn-primary" ref={confirm} onClick={onConfirm}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  label,
  disabled = false,
  pressed,
  danger = false,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  pressed?: boolean
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`flow-icon-btn ${danger ? 'danger' : ''}`}
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  )
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function BookmarkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

function MissingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 21 19 H3 z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </svg>
  )
}

function SkipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

function FileTextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function OrchestratorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.6" r="1.2" />
      <path d="M9 13h.01" />
      <path d="M15 13h.01" />
      <path d="M9 17h6" />
    </svg>
  )
}

function OperatorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <polyline points="17 11 19 13 23 9" />
    </svg>
  )
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  )
}

export function FlowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <line x1="6" y1="7" x2="6" y2="17" />
      <path d="M6 12h10" />
    </svg>
  )
}

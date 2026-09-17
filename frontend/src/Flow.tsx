import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import './Backlog.css'
import './Flow.css'
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
}

export type StepPreset = FlowStep & { id: string }

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; flows: BaseFlow[] }

// Шаг в форме: key держит строку формы на месте при перестановке, исполнитель разложен на выбор и имя субагента.
type DraftStep = {
  key: number
  title: string
  kind: 'оркестратор' | 'оператор' | 'субагент'
  agent: string
  output: string
  skip: string
  description: string | null
}

type Notice = { kind: 'done' | 'error'; text: string } | null

const kinds: DraftStep['kind'][] = ['оркестратор', 'оператор', 'субагент']

let nextKey = 1

function toDraft(step: FlowStep): DraftStep {
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

/** Что мешает записать шаг в форме кита; пустой список — шаг годится. */
function stepErrors(draft: DraftStep) {
  const errors: string[] = []
  if (!draft.title.trim()) errors.push('нет названия')
  if (draft.kind === 'субагент' && !draft.agent.trim()) errors.push('не указано имя субагента')
  if (!draft.output.trim()) errors.push('не указан выход')
  return errors
}

const sameStep = (a: FlowStep, b: FlowStep) =>
  a.title === b.title &&
  a.executor === b.executor &&
  a.output === b.output &&
  (a.skip ?? null) === (b.skip ?? null) &&
  (a.description ?? null) === (b.description ?? null)

const invalidLabels: Record<string, string> = {
  'empty-title': 'нет названия',
  'empty-executor': 'не указан исполнитель',
  'empty-output': 'не указан выход',
  'line-break': 'перевод строки в поле',
}

export default function Flow() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(null)
  const [presets, setPresets] = useState<StepPreset[]>([])
  const [draft, setDraft] = useState<DraftStep[] | null>(null)
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

  const refresh = useCallback(() => {
    setNotice(null)
    setLoad({ kind: 'loading' })
    loadFlows()
  }, [loadFlows])

  const flows = load.kind === 'loaded' ? load.flows : []
  const flow = flows.find((f) => f.base === selected) ?? null

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
        body: JSON.stringify({ base: target.base, version: target.version, steps: steps.map(toStep) }),
      })
      if (response.ok) {
        setDraft(null)
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

  const editing = draft !== null

  return (
    <>
      <div className="content-head">
        <h2>{editing ? 'Правка флоу' : 'Флоу'}</h2>
        {editing && flow && <span className="sub">{flow.project}</span>}
        <div className="head-end flow-actions">
          {editing && flow ? (
            <EditActions
              draft={draft}
              saving={saving}
              onCancel={() => {
                setDraft(null)
                setNotice(null)
              }}
              onSave={() => (flow.activeTasks > 0 ? setConfirming(true) : void save(flow, draft))}
            />
          ) : (
            <>
              <button type="button" className="bases-btn" onClick={refresh} disabled={load.kind === 'loading'}>
                <RefreshIcon />
                Обновить
              </button>
              {flow && !flow.error && (
                <>
                  <button type="button" className="btn-code" onClick={() => void openInVsCode(flow.base)}>
                    <VsCodeIcon />
                    Открыть в VS Code
                  </button>
                  <button
                    type="button"
                    className="bases-btn"
                    onClick={() => {
                      setNotice(null)
                      setDraft(flow.steps.map(toDraft))
                    }}
                  >
                    <PencilIcon />
                    Править
                  </button>
                </>
              )}
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
              // Правка идёт по флоу одной базы: пока она открыта, проект не переключается.
              disabled={editing}
              onClick={() => setSelected(f.base)}
            >
              {f.project}
            </button>
          ))}
        </div>
      )}

      {flow && (
        <section className="flow-list" aria-label={flow.project}>

          {flow.error && (
            <p className="backlog-note warning-text">
              {flow.error === 'В базе нет flow.md'
                ? 'В базе нет файла флоу. Агент не начнёт задачу на этом проекте, пока флоу не записан.'
                : flow.error}
            </p>
          )}

          {!flow.error && !editing && flow.steps.length === 0 && (
            <p className="backlog-note text-sec">
              Во флоу пока нет шагов. Агент не начнёт задачу на этом проекте, пока шаги не записаны.
            </p>
          )}

          {!flow.error && !editing && flow.steps.map((step, index) => <StepCard key={index} step={step} number={index + 1} />)}

          {editing && (
            <FlowForm
              draft={draft}
              presets={presets}
              onChange={setDraft}
              onSaveAsPreset={(step) => void saveAsPreset(step)}
              onRemovePreset={(preset) => void removePreset(preset)}
            />
          )}
        </section>
      )}

      {confirming && flow && draft && (
        <ConfirmSave
          flow={flow}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void save(flow, draft)}
        />
      )}
    </>
  )
}

function saveError(status: number, body: { problem?: string; step?: number; detail?: string } | null) {
  if (status === 409)
    return 'Флоу не сохранён: файл флоу изменился в базе, пока вы его правили. Отмените правку и обновите флоу.'
  if (status === 400 && body?.step)
    return `Флоу не сохранён: шаг ${body.step} — ${invalidLabels[body.detail ?? ''] ?? 'не в форме кита'}`
  if (status === 502 && body?.problem === 'not-committed')
    return `Флоу не сохранён: коммит в базу не прошёл, файл оставлен как был.${body.detail ? ` ${body.detail}` : ''}`
  if (status === 404) return 'Флоу не сохранён: файл флоу базы не найден'
  return 'Флоу не сохранён'
}

function EditActions({
  draft,
  saving,
  onCancel,
  onSave,
}: {
  draft: DraftStep[]
  saving: boolean
  onCancel: () => void
  onSave: () => void
}) {
  const firstBad = draft.findIndex((step) => stepErrors(step).length > 0)
  return (
    <>
      {firstBad >= 0 && (
        <span className="flow-blocked">
          Не сохранить: шаг {firstBad + 1} — {stepErrors(draft[firstBad]).join(', ')}
        </span>
      )}
      <button type="button" className="bases-btn" onClick={onCancel} disabled={saving}>
        Отмена
      </button>
      <button type="button" className="bases-btn bases-btn-primary" onClick={onSave} disabled={saving || firstBad >= 0}>
        {saving ? 'Сохранение…' : 'Сохранить'}
      </button>
    </>
  )
}

function StepCard({ step, number }: { step: FlowStep; number: number }) {
  return (
    <article className="flow-step" aria-label={`Шаг ${number}: ${step.title}`}>
      <div className="flow-step-head">
        <span className="entry-num">{number}</span>
        <span className="flow-step-title">{step.title}</span>
        <ExecutorBadge executor={step.executor} />
      </div>
      <dl className="flow-keys">
        <dt>выход</dt>
        <dd>{step.output}</dd>
        <dt>пропуск</dt>
        <dd className={step.skip ? '' : 'text-ter'}>{step.skip ?? 'нет — шаг проходится всегда'}</dd>
      </dl>
    </article>
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

function FlowForm({
  draft,
  presets,
  onChange,
  onSaveAsPreset,
  onRemovePreset,
}: {
  draft: DraftStep[]
  presets: StepPreset[]
  onChange: (steps: DraftStep[]) => void
  onSaveAsPreset: (step: FlowStep) => void
  onRemovePreset: (preset: StepPreset) => void
}) {
  const [dragged, setDragged] = useState<number | null>(null)
  const [over, setOver] = useState<number | null>(null)

  const update = (index: number, patch: Partial<DraftStep>) =>
    onChange(draft.map((step, i) => (i === index ? { ...step, ...patch } : step)))

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= draft.length) return
    const next = [...draft]
    const [step] = next.splice(from, 1)
    next.splice(to, 0, step)
    onChange(next)
  }

  const endDrag = () => {
    setDragged(null)
    setOver(null)
  }

  return (
    <>
      <p className="flow-hint text-ter">
        Описания шагов здесь не показываются: при сохранении они остаются как были, у шага из пресета — берутся из
        пресета. Прочитать и поправить описание — «Открыть в VS Code».
      </p>
      {draft.map((step, index) => {
        const errors = stepErrors(step)
        const asStep = toStep(step)
        const isPreset = presets.some((preset) => sameStep(preset, asStep))
        const number = index + 1
        return (
          <article
            key={step.key}
            className={`flow-step flow-form ${over === index && dragged !== index ? 'drop-target' : ''} ${
              dragged === index ? 'dragging' : ''
            }`}
            aria-label={`Шаг ${number}`}
            onDragOver={(event: DragEvent) => {
              if (dragged === null) return
              event.preventDefault()
              if (over !== index) setOver(index)
            }}
            onDrop={(event: DragEvent) => {
              if (dragged === null) return
              event.preventDefault()
              move(dragged, index)
              endDrag()
            }}
          >
            <div className="flow-step-head">
              <span
                className="flow-grip"
                draggable
                title="Перетащить шаг"
                aria-hidden="true"
                onDragStart={(event: DragEvent) => {
                  event.dataTransfer.effectAllowed = 'move'
                  event.dataTransfer.setData('text/plain', String(index))
                  setDragged(index)
                }}
                onDragEnd={endDrag}
              >
                <GripIcon />
              </span>
              <span className="entry-num">{number}</span>
              <input
                className="flow-input flow-title-input"
                aria-label={`Название шага ${number}`}
                placeholder="Название шага"
                aria-invalid={!step.title.trim()}
                value={step.title}
                onChange={(event) => update(index, { title: event.target.value })}
              />
              <IconButton label={`Шаг ${number} выше`} disabled={index === 0} onClick={() => move(index, index - 1)}>
                <ChevronUpIcon />
              </IconButton>
              <IconButton
                label={`Шаг ${number} ниже`}
                disabled={index === draft.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ChevronDownIcon />
              </IconButton>
              <IconButton
                label={`Сохранить шаг ${number} как пресет`}
                pressed={isPreset}
                disabled={errors.length > 0 || isPreset}
                onClick={() => onSaveAsPreset(asStep)}
              >
                <BookmarkIcon />
              </IconButton>
              <IconButton
                label={`Удалить шаг ${number}`}
                danger
                onClick={() => onChange(draft.filter((_, i) => i !== index))}
              >
                <TrashIcon />
              </IconButton>
            </div>
            <div className="flow-fields">
              <label className="flow-field">
                <span>исполнитель</span>
                <span className="flow-executor-field">
                  <select
                    className="flow-input"
                    aria-label={`Исполнитель шага ${number}`}
                    value={step.kind}
                    onChange={(event) => update(index, { kind: event.target.value as DraftStep['kind'] })}
                  >
                    {kinds.map((kind) => (
                      <option key={kind} value={kind}>
                        {kind}
                      </option>
                    ))}
                  </select>
                  {step.kind === 'субагент' && (
                    <input
                      className="flow-input mono"
                      aria-label={`Имя субагента шага ${number}`}
                      placeholder="имя субагента"
                      aria-invalid={!step.agent.trim()}
                      value={step.agent}
                      onChange={(event) => update(index, { agent: event.target.value })}
                    />
                  )}
                </span>
              </label>
              <label className="flow-field">
                <span>пропуск</span>
                <input
                  className="flow-input"
                  aria-label={`Пропуск шага ${number}`}
                  placeholder="нет — шаг проходится всегда"
                  value={step.skip}
                  onChange={(event) => update(index, { skip: event.target.value })}
                />
              </label>
              <label className="flow-field flow-field-wide">
                <span>выход</span>
                <input
                  className="flow-input"
                  aria-label={`Выход шага ${number}`}
                  placeholder="что предъявить: коммит, строка в памяти, вывод прогона"
                  aria-invalid={!step.output.trim()}
                  value={step.output}
                  onChange={(event) => update(index, { output: event.target.value })}
                />
              </label>
            </div>
            {errors.length > 0 && <p className="flow-step-error">Шаг не сохранить: {errors.join(', ')}.</p>}
          </article>
        )
      })}
      <AddStep
        presets={presets}
        onAdd={(step) => onChange([...draft, toDraft(step)])}
        onRemovePreset={onRemovePreset}
      />
    </>
  )
}

const emptyStep: FlowStep = { title: '', executor: 'оркестратор', output: '', skip: null, description: null }

function AddStep({
  presets,
  onAdd,
  onRemovePreset,
}: {
  presets: StepPreset[]
  onAdd: (step: FlowStep) => void
  onRemovePreset: (preset: StepPreset) => void
}) {
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

  const add = (step: FlowStep) => {
    onAdd(step)
    setOpen(false)
  }

  return (
    <div className="flow-add" ref={box} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button type="button" className="bases-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        <PlusIcon />
        Добавить шаг
      </button>
      {open && (
        <div className="flow-presets" role="group" aria-label="Пресеты шагов">
          <button type="button" className="flow-preset" onClick={() => add(emptyStep)}>
            <span className="flow-preset-title">Пустой шаг</span>
            <span className="text-sec">всё заполнить самому</span>
          </button>
          <div className="flow-presets-label">Пресеты</div>
          {presets.length === 0 && (
            <p className="flow-presets-empty text-ter">
              Пресетов пока нет. Шаг сохраняется в пресеты кнопкой-закладкой у шага.
            </p>
          )}
          {presets.map((preset) => (
            <div className="flow-preset-row" key={preset.id}>
              <button type="button" className="flow-preset" onClick={() => add(preset)}>
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
      )}
    </div>
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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import type { FlowStage } from './Flow'
import { useAgentRequest } from './agentRequest'
import { stageChanges, type RewrittenStage, type StageChange, type StageFieldName } from './flowChanges'
import './Modal.css'
import './AskModal.css'
import './FlowRewriteModal.css'

export type RewriteEvent =
  | { type: 'step'; text: string }
  | { type: 'rewritten'; text: string; stages: RewrittenStage[]; durationMs?: number }
  | { type: 'error'; text: string; output?: string }

type Props = {
  base: string
  project: string
  /** Стадии раздела такими, какими их видно, с несохранёнными правками: их агент и получает. */
  stages: FlowStage[]
  /** Значок стадии — тот же, что на карточке вкладки «Стадии». */
  mark: (title: string) => ReactNode
  /** Строка о сценариях, которые заденет правка стадии; null — стадия стоит не больше чем в одном. */
  scope: (title: string) => string | null
  onApply: (stages: RewrittenStage[]) => void
  onClose: () => void
}

const examples = [
  'Заведи стадию документации после мержа',
  'Пропускай приёмку, если задача не меняет вида панели',
  'Пусть ревью смотрит ещё и тесты',
]

const fieldLabels: Record<StageFieldName, string> = {
  title: 'название',
  executor: 'исполнитель',
  output: 'выход',
  skip: 'пропуск',
  helpers: 'помощники',
  description: 'описание',
}

const kindLabels: Record<StageChange['kind'], string> = {
  added: 'добавлена',
  changed: 'изменена',
  same: 'без правок',
}

const norm = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase()

export default function FlowRewriteModal({ base, project, stages, mark, scope, onApply, onClose }: Props) {
  const [wish, setWish] = useState('')
  // Стадии контекста — по названию: список раздела на время окна не меняется.
  const [context, setContext] = useState<string[]>([])
  const [picking, setPicking] = useState(false)
  // Описание стадии читается своим окном поверх разбора: в карточке стоит только кнопка.
  const [description, setDescription] = useState<{ title: string; text: string } | null>(null)
  // Просьба живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу с начала.
  const { asked, steps: agentSteps, outcome, running, startedAt, failure, restoring, start, forget, setFailure } =
    useAgentRequest<RewriteEvent>('flow')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (description) setDescription(null)
      else if (picking) setPicking(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, description, picking])

  const contextStages = context
    .map((title) => stages.find((stage) => norm(stage.title) === norm(title)))
    .filter((stage): stage is FlowStage => stage !== undefined)

  const rewrite = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      setPicking(false)
      const started = await start('/api/flow/rewrite', {
        base,
        wish: text.trim(),
        stages: contextStages,
        titles: stages.map((stage) => stage.title),
      })
      if (started.ok) return
      setFailure(
        started.status === 404
          ? 'Базы нет в списке панели или на диске'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла просьбу',
      )
    },
    [base, start, setFailure, contextStages, stages],
  )

  const rewritten = outcome?.type === 'rewritten' ? outcome : null
  const error = failure ?? (outcome?.type === 'error' ? outcome.text : null)
  const output = outcome?.type === 'error' ? (outcome.output ?? null) : null
  const phase: 'restoring' | 'idle' | 'running' | 'rewritten' | 'failed' = restoring
    ? 'restoring'
    : running
      ? 'running'
      : error
        ? 'failed'
        : rewritten
          ? 'rewritten'
          : 'idle'
  const shown = asked || wish.trim()
  // Прежний вид стадии берётся из раздела: окно, открытое заново, контекста не помнит, но стадии видит.
  const changes = rewritten ? stageChanges(stages, rewritten.stages, contextStages) : []
  const changed = changes.filter((change) => change.kind !== 'same')
  const untouched = changes.filter((change) => change.kind === 'same')

  async function apply() {
    const taken = rewritten?.stages.filter((one) =>
      changed.some((change) => change.stage === one.stage),
    )
    await forget()
    onApply(taken ?? [])
  }

  async function close() {
    if (phase === 'rewritten' || phase === 'failed') await forget()
    onClose()
  }

  const toggle = (title: string) =>
    setContext((now) => (now.includes(title) ? now.filter((one) => one !== title) : [...now, title]))

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal-wizard ask-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Переписать с ${AGENT_NAME}`}
      >
        <div className="ask-head">
          <div className="ask-title">
            <RewriteIcon />
            <h2>Переписать с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          {/* Проект берётся из раздела: правки лягут в тот флоу, который оператор перед собой видит. */}
          <div className="ask-bases">
            <span className="chip active">{project}</span>
          </div>
        </div>

        <div className="ask-body">
          {phase === 'restoring' && <p className="modal-message">Загрузка…</p>}
          {phase === 'idle' && (
            <>
              <div className="rewrite-composer">
                <label htmlFor="flow-wish" className="visually-hidden">
                  Что поменять в стадиях
                </label>
                <textarea
                  id="flow-wish"
                  className="custom-textarea ask-textarea"
                  autoFocus
                  value={wish}
                  placeholder="Скажите своими словами, что поменять в стадиях или какую стадию завести"
                  onChange={(e) => setWish(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void rewrite(wish)
                  }}
                />
                <div className="rewrite-composer-bar" aria-label="Стадии к просьбе">
                  <button
                    type="button"
                    className={`rewrite-context-btn ${picking ? 'open' : ''}`}
                    aria-expanded={picking}
                    aria-haspopup="listbox"
                    onClick={() => setPicking((now) => !now)}
                  >
                    <PlusIcon />
                    Стадии
                  </button>
                  {contextStages.map((stage) => (
                    <span key={stage.title} className="rewrite-token">
                      {mark(stage.title)}
                      {stage.title}
                      <button
                        type="button"
                        className="rewrite-token-remove"
                        aria-label={`Убрать «${stage.title}»`}
                        onClick={() => toggle(stage.title)}
                      >
                        <CloseIcon />
                      </button>
                    </span>
                  ))}
                </div>
                {picking && (
                  <StagePicker
                    stages={stages}
                    chosen={context}
                    mark={mark}
                    onToggle={toggle}
                    onClose={() => setPicking(false)}
                  />
                )}
              </div>
              {!wish && !picking && (
                <div className="ask-examples">
                  <div className="ask-examples-title">Например</div>
                  {examples.map((example) => (
                    <button key={example} type="button" className="ask-example" onClick={() => setWish(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {shown && phase !== 'idle' && phase !== 'restoring' && (
            <div className="ask-asked rewrite-asked">
              <div className="rewrite-asked-row">
                <span className="ask-asked-label">Просьба</span>
                <span className="ask-asked-text">{shown}</span>
              </div>
              {contextStages.length > 0 && (
                <div className="rewrite-context-line" aria-label="Стадии к просьбе">
                  {contextStages.map((stage) => (
                    <span key={stage.title} className="rewrite-token fixed">
                      {mark(stage.title)}
                      {stage.title}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {phase === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} {contextStages.length > 0 ? 'переписывает стадии' : 'пишет стадию'}…
                </span>
                {startedAt !== null && <Elapsed since={startedAt} />}
              </div>
              {agentSteps.length > 0 && (
                <ol className="ask-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                  {agentSteps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          )}

          {rewritten && phase === 'rewritten' && (
            <div className="rewrite-changes" aria-label="Что изменилось в стадиях">
              {changed.length === 0 && <p className="modal-message">Стадии не изменились: ответ совпал с прежними.</p>}
              {changed.map((change) => (
                <Change
                  key={`${change.kind}-${change.of}-${change.title}`}
                  change={change}
                  scope={change.of === null ? null : scope(change.of)}
                  onDescription={setDescription}
                />
              ))}
              {untouched.length > 0 && (
                <div className="rewrite-untouched">
                  <span className="rewrite-mark">{kindLabels.same}</span>
                  <span className="rewrite-untouched-titles">{untouched.map((c) => c.title).join(' · ')}</span>
                  {rewritten.durationMs !== undefined && (
                    <span className="ask-duration">{formatDuration(rewritten.durationMs)}</span>
                  )}
                </div>
              )}
              {untouched.length === 0 && rewritten.durationMs !== undefined && (
                <div className="rewrite-meta">
                  <span className="ask-duration">{formatDuration(rewritten.durationMs)}</span>
                </div>
              )}
            </div>
          )}

          {phase === 'failed' && (
            <div className="ask-error" role="alert">
              <strong>{AGENT_NAME} не переписал стадии</strong>
              <span>{error}. Стадии в базе не менялись.</span>
              {output && <pre>{output}</pre>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          {/* Не подсказка, а состояние: пока правки не сохранены, стадии базы прежние. */}
          {phase === 'rewritten' && (
            <span className="ask-hint">
              <LockIcon />
              Стадии в базе не записаны: правки лягут в черновик, сохранит их кнопка «Сохранить»
            </span>
          )}
          <div className="footer-right">
            {phase === 'idle' && (
              <button type="button" className="btn btn-primary" disabled={!wish.trim()} onClick={() => void rewrite(wish)}>
                {contextStages.length > 0 ? 'Переписать' : 'Написать стадию'}
              </button>
            )}
            {phase === 'running' && (
              <button type="button" className="btn" onClick={() => void forget()}>
                Отменить
              </button>
            )}
            {rewritten && phase === 'rewritten' && (
              <>
                <button type="button" className="btn" onClick={() => void close()}>
                  Отказаться
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={changed.length === 0}
                  onClick={() => void apply()}
                >
                  Принять правки
                </button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setWish(shown)
                    void forget()
                  }}
                >
                  Изменить просьбу
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void rewrite(shown)}>
                  Попросить снова
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {description && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDescription(null)}>
          <div
            className="flow-confirm flow-description"
            role="dialog"
            aria-modal="true"
            aria-label={`Описание стадии «${description.title}»`}
          >
            <h3>Описание стадии «{description.title}»</h3>
            <pre className="rewrite-description-text">{description.text}</pre>
            <div className="flow-confirm-actions">
              <button type="button" className="bases-btn" onClick={() => setDescription(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Список стадий проекта под кнопкой «Стадии»: поиск по названию, галочка добавляет стадию в просьбу. */
function StagePicker({
  stages,
  chosen,
  mark,
  onToggle,
  onClose,
}: {
  stages: FlowStage[]
  chosen: string[]
  mark: (title: string) => ReactNode
  onToggle: (title: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  // Щелчок мимо списка его закрывает, как меню; кнопка «Стадии» закрывает его сама.
  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      const target = event.target as Element
      if (box.current?.contains(target) || target.closest?.('.rewrite-context-btn')) return
      onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  const found = stages.filter((stage) => norm(stage.title).includes(norm(query)))

  return (
    <div className="rewrite-picker" ref={box}>
      <label className="rewrite-picker-search">
        <SearchIcon />
        <span className="visually-hidden">Найти стадию</span>
        <input autoFocus value={query} placeholder="Найти стадию" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="rewrite-picker-list" role="listbox" aria-label="Стадии проекта" aria-multiselectable="true">
        {found.length === 0 && <p className="rewrite-picker-empty">Стадий с таким названием нет</p>}
        {found.map((stage) => {
          const on = chosen.includes(stage.title)
          return (
            <div
              key={stage.title}
              role="option"
              aria-selected={on}
              tabIndex={0}
              className="rewrite-picker-row"
              onClick={() => onToggle(stage.title)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onToggle(stage.title)
                }
              }}
            >
              <span className={`rewrite-check ${on ? 'on' : ''}`} aria-hidden="true">
                {on && <CheckIcon />}
              </span>
              {mark(stage.title)}
              <span className="rewrite-picker-title">{stage.title}</span>
              <span className="flow-stage-badge">{stage.executor || 'субагент'}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Change({
  change,
  scope,
  onDescription,
}: {
  change: StageChange
  scope: string | null
  onDescription: (description: { title: string; text: string }) => void
}) {
  const stage = change.stage
  const descriptionChange = change.fields.find((field) => field.field === 'description')
  const keys = change.fields.filter((field) => field.field !== 'description')

  return (
    <div className={`rewrite-change rewrite-${change.kind}`}>
      <div className="rewrite-change-head">
        <span className="rewrite-mark">{kindLabels[change.kind]}</span>
        <span className="rewrite-change-title">{change.title}</span>
      </div>
      {change.kind === 'changed' && scope && <p className="rewrite-scope">{scope}</p>}

      {change.kind === 'added' && (
        <dl className="rewrite-fields">
          <dt>исполнитель</dt>
          <dd>{stage.executor}</dd>
          <dt>выход</dt>
          <dd>{stage.output}</dd>
          {stage.skip && (
            <>
              <dt>пропуск</dt>
              <dd>{stage.skip}</dd>
            </>
          )}
          {stage.helpers && stage.helpers.length > 0 && (
            <>
              <dt>помощники</dt>
              <dd>{stage.helpers.join(', ')}</dd>
            </>
          )}
          {stage.description && (
            <>
              <dt>описание</dt>
              <dd>
                <DescriptionButton title={change.title} text={stage.description} onOpen={onDescription} />
              </dd>
            </>
          )}
        </dl>
      )}

      {change.kind === 'changed' && (
        <dl className="rewrite-fields">
          {keys.map((field) => (
            <div key={field.field} className="rewrite-field">
              <dt>{fieldLabels[field.field]}</dt>
              <dd>
                <span className={`rewrite-was ${field.before === null ? 'rewrite-none' : ''}`}>{field.before ?? 'нет'}</span>
                {field.after !== null ? (
                  <span className="rewrite-now">{field.after}</span>
                ) : (
                  <span className="rewrite-now rewrite-none">нет</span>
                )}
              </dd>
            </div>
          ))}
          {descriptionChange && (
            <div className="rewrite-field">
              <dt>{fieldLabels.description}</dt>
              <dd>
                {descriptionChange.after !== null ? (
                  <DescriptionButton title={change.title} text={descriptionChange.after} onOpen={onDescription} changed />
                ) : (
                  <span className="rewrite-now rewrite-none">описание убрано</span>
                )}
              </dd>
            </div>
          )}
        </dl>
      )}
    </div>
  )
}

/** Описание в разборе не пересказывается: кнопка открывает его текст окном. */
function DescriptionButton({
  title,
  text,
  changed = false,
  onOpen,
}: {
  title: string
  text: string
  changed?: boolean
  onOpen: (description: { title: string; text: string }) => void
}) {
  return (
    <span className="rewrite-description">
      <button type="button" className="bases-btn flow-description-btn" onClick={() => onOpen({ title, text })}>
        <FileTextIcon />
        Открыть описание
      </button>
      {changed && <span className="rewrite-description-mark">изменено</span>}
    </span>
  )
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="ask-elapsed" aria-label="Прошло времени">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
}

export function RewriteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="2.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="15.5" width="16" height="6" rx="1.5" />
      <path d="M12 8.5v7" />
      <path d="M9.5 13l2.5 2.5 2.5-2.5" />
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="16.5" y1="16.5" x2="21" y2="21" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="5 12.5 10 17.5 19 7" />
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

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

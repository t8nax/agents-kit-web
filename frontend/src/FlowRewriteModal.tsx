import { Fragment, useCallback, useEffect, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { useAgentRequest } from './agentRequest'
import type { FlowStep } from './Flow'
import { flowChanges, type FlowChange, type FlowFieldName } from './flowChanges'
import './AskModal.css'
import './FlowRewriteModal.css'

export type RewriteEvent =
  | { type: 'step'; text: string }
  | { type: 'rewritten'; text: string; steps: FlowStep[]; version?: string; durationMs?: number }
  | { type: 'error'; text: string; output?: string; problem?: string; step?: number }

type Props = {
  base: string
  project: string
  /** Приставка проекта: имена исполнителей и здесь видны без неё — как на схеме рядом. */
  /** Шаги флоу, какими их сейчас видит раздел: с ними сравнивается переписанное. */
  steps: FlowStep[]
  /** Отпечаток файла, с которого читал раздел: агент переписывал его же. */
  version: string | null
  onApply: (steps: FlowStep[]) => void
  onClose: () => void
}

const examples = [
  'Проверку e2e делай только тогда, когда правили вёрстку',
  'Раздели «Реализацию» на работу и прогон проверок',
  'Опиши в «Мерже», что делать, когда dev ушёл вперёд',
]

const fieldLabels: Record<FlowFieldName, string> = {
  executor: 'исполнитель',
  output: 'выход',
  skip: 'пропуск',
  description: 'описание',
  returns: 'возврат',
  helpers: 'помощники',
}

const kindLabels: Record<FlowChange['kind'], string> = {
  added: 'добавлен',
  changed: 'изменён',
  moved: 'переставлен',
  removed: 'удалён',
  same: 'без правок',
}

export default function FlowRewriteModal({ base, project, steps, version, onApply, onClose }: Props) {
  const [wish, setWish] = useState('')
  // Описание шага читается своим окном поверх разбора: в строке шага стоит только кнопка.
  const [description, setDescription] = useState<{ title: string; text: string } | null>(null)
  // Просьба живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу с начала.
  const { asked, steps: agentSteps, outcome, running, startedAt, failure, restoring, start, forget, setFailure } =
    useAgentRequest<RewriteEvent>('flow')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (description) setDescription(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, description])

  const rewrite = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      const started = await start('/api/flow/rewrite', { base, wish: text.trim() })
      if (started.ok) return
      setFailure(
        started.status === 404
          ? 'Базы нет в списке панели или на диске'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла просьбу',
      )
    },
    [base, start, setFailure],
  )

  const rewritten = outcome?.type === 'rewritten' ? outcome : null
  // Раздел мог перечитать флоу, пока агент работал: правки поверх него стёрли бы чужие молча.
  const stale =
    rewritten !== null && version !== null && rewritten.version !== undefined && rewritten.version !== version
  const error =
    failure ??
    (stale
      ? `Флоу базы изменился, пока ${AGENT_NAME} его переписывал`
      : outcome?.type === 'error'
        ? outcome.text
        : null)
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
  const changes = rewritten && !stale ? flowChanges(steps, rewritten.steps) : []
  const changed = changes.filter((change) => change.kind !== 'same')
  const untouched = changes.filter((change) => change.kind === 'same')

  async function apply(next: FlowStep[]) {
    await forget()
    onApply(next)
  }

  async function close() {
    if (phase === 'rewritten' || phase === 'failed') await forget()
    onClose()
  }

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard ask-modal" role="dialog" aria-modal="true" aria-label="Переписать флоу">
        <div className="ask-head">
          <div className="ask-title">
            <RewriteIcon />
            <h2>Переписать флоу</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
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
              <label htmlFor="flow-wish" className="visually-hidden">
                Что поменять во флоу
              </label>
              <textarea
                id="flow-wish"
                className="custom-textarea ask-textarea"
                autoFocus
                value={wish}
                placeholder="Скажите своими словами, что поменять во флоу: добавить шаг, убрать его, переписать выход или условие пропуска"
                onChange={(e) => setWish(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void rewrite(wish)
                }}
              />
              {!wish && (
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
            <div className="ask-asked">
              <span className="ask-asked-label">Просьба</span>
              <span className="ask-asked-text">{shown}</span>
            </div>
          )}

          {phase === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} переписывает флоу {project}…
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
            <div className="rewrite-changes" aria-label="Что изменилось во флоу">
              {changed.length === 0 && <p className="modal-message">Флоу не изменился: переписанный совпал с прежним.</p>}
              {changed.map((change) => (
                <Change
                  key={`${change.kind}-${change.title}-${change.at}-${change.from}`}
                  change={change}
                  onDescription={setDescription}
                />
              ))}
              {untouched.length > 0 && (
                <div className="rewrite-untouched">
                  <span className="rewrite-mark">{kindLabels.same}</span>
                  <span className="rewrite-untouched-titles">{untouched.map((c) => c.title).join(' · ')}</span>
                </div>
              )}
              {rewritten.durationMs !== undefined && (
                <div className="rewrite-meta">
                  <span className="ask-duration">{formatDuration(rewritten.durationMs)}</span>
                </div>
              )}
            </div>
          )}

          {phase === 'failed' && (
            <div className="ask-error" role="alert">
              <strong>{AGENT_NAME} не переписал флоу</strong>
              <span>{error}. Флоу базы не менялся.</span>
              {output && <pre>{output}</pre>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          {/* Не подсказка, а состояние: пока правки не сохранены, флоу базы прежний. */}
          {phase === 'rewritten' && (
            <span className="ask-hint">
              <LockIcon />
              Флоу базы не записан: правки лягут в схему, сохранит их кнопка «Сохранить»
            </span>
          )}
          <div className="footer-right">
            {phase === 'idle' && (
              <button type="button" className="btn btn-primary" disabled={!wish.trim()} onClick={() => void rewrite(wish)}>
                Переписать
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
                  onClick={() => void apply(rewritten.steps)}
                >
                  Взять правки в схему
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
            aria-label={`Описание шага «${description.title}»`}
          >
            <h3>Описание шага «{description.title}»</h3>
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

function Change({
  change,
  onDescription,
}: {
  change: FlowChange
  onDescription: (description: { title: string; text: string }) => void
}) {
  const step = change.step
  const descriptionChange = change.fields.find((field) => field.field === 'description')
  const keys = change.fields.filter((field) => field.field !== 'description')

  return (
    <div className={`rewrite-change rewrite-${change.kind}`}>
      <div className="rewrite-change-head">
        <span className="rewrite-mark">{kindLabels[change.kind]}</span>
        <span className="rewrite-change-title">{change.title}</span>
        {change.kind === 'moved' && <span className="rewrite-place">был {change.from + 1}-м, стал {change.at + 1}-м</span>}
        {change.kind === 'removed' && <span className="rewrite-place">был {change.from + 1}-м</span>}
      </div>

      {change.kind === 'added' && step && (
        <dl className="rewrite-fields">
          <dt>исполнитель</dt>
          <dd>{step.executor}</dd>
          <dt>выход</dt>
          <dd>{step.output}</dd>
          {step.skip && (
            <>
              <dt>пропуск</dt>
              <dd>{step.skip}</dd>
            </>
          )}
          {step.helpers && step.helpers.length > 0 && (
            <>
              <dt>помощники</dt>
              <dd>{step.helpers.join(', ')}</dd>
            </>
          )}
          {step.returns?.map((back) => (
            <Fragment key={`${back.condition}-${back.step}`}>
              <dt>возврат</dt>
              <dd>
                {back.condition} → {back.step}
              </dd>
            </Fragment>
          ))}
          {step.description && (
            <>
              <dt>описание</dt>
              <dd>
                <DescriptionButton title={change.title} text={step.description} onOpen={onDescription} />
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
                {field.before !== null && <span className="rewrite-was">{field.before}</span>}
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

/** Описание в разборе не пересказывается: кнопка открывает его текст окном — как в сайдбаре шага. */
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

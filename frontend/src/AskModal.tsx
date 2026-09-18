import { useEffect, useRef, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { Markdown } from './Markdown'
import { useAgentConversation, type AskEvent } from './agentConversation'
import './AskModal.css'

export type AskBase = { base: string; project: string }

export type { AskEvent }

type Bases = { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; bases: AskBase[] }

const examples = [
  'Что решено про запись панели в файлы баз?',
  'Что лежит в бэклоге про сессии агентов?',
  'Чем поставленная панель отличается от dev-запуска?',
]

/** Ход работы нынешней реплики: шаги, набежавшие после последнего вопроса оператора. */
function stepsOfTurn(events: AskEvent[]) {
  const steps: string[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'reply') break
    if (event.type === 'step') steps.unshift(event.text)
  }
  return steps
}

export default function AskModal({ onClose }: { onClose: () => void }) {
  const [bases, setBases] = useState<Bases>({ kind: 'loading' })
  const [base, setBase] = useState<string | null>(null)
  // Поле не трогали, пока text — null: тогда в нём стоит реплика, на которой агент сорвался.
  const [text, setText] = useState<string | null>(null)
  // Разговор живёт в панели: закрытое окно его не трогает, а открытое заново видит переписку с начала.
  const conversation = useAgentConversation()
  const { events, running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  // Подхваченный разговор показывает свою базу: спрашивали её, а не ту, что стояла первой в списке.
  const active = conversation.base ?? base
  const started = events.length > 0
  const value = text ?? retry ?? ''
  const steps = running ? stepsOfTurn(events) : []
  const talk = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch('/api/ask/bases')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AskBase[]>
      })
      .then(
        (list) => {
          setBases({ kind: 'loaded', bases: list })
          setBase((current) => current ?? list[0]?.base ?? null)
        },
        () => setBases({ kind: 'failed' }),
      )
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Переписка растёт вниз: свежая реплика и ответ видны без прокрутки руками.
  useEffect(() => {
    const box = talk.current
    if (box) box.scrollTop = box.scrollHeight
  }, [events, steps.length])

  async function submit() {
    const said = value.trim()
    if (!active || !said || running) return

    setText(null)
    const sent = started ? await send(said) : await start(active, said)
    if (sent.ok) return

    // Реплика не ушла — она возвращается в поле, чтобы отправить её ещё раз.
    setText(said)
    setFailure(
      sent.status === 404
        ? started
          ? 'Панель потеряла разговор: его больше нет в списке'
          : 'Базы нет в списке панели или на диске'
        : sent.status === 409
          ? `${AGENT_NAME} ещё отвечает на прошлую реплику`
          : sent.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла реплику',
    )
  }

  async function newTalk() {
    setText(null)
    await forget()
  }

  const project = bases.kind === 'loaded' ? (bases.bases.find((b) => b.base === active)?.project ?? '') : ''
  const loading = bases.kind === 'loading' || restoring

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal-wizard ask-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Разговор с ${AGENT_NAME}`}
      >
        <div className="ask-head">
          <div className="ask-title">
            <AskIcon />
            <h2>Разговор с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {bases.kind === 'loaded' && bases.bases.length > 0 && (
            <div className="ask-bases" role="group" aria-label="Проект">
              {bases.bases.map((b) => (
                <button
                  key={b.base}
                  type="button"
                  className={`chip ${b.base === active ? 'active' : ''}`}
                  aria-pressed={b.base === active}
                  title={b.base}
                  // База выбирается один раз на разговор: посреди переписки её не меняют.
                  disabled={started}
                  onClick={() => setBase(b.base)}
                >
                  {b.project}
                </button>
              ))}
              {started && <span className="ask-bases-hint">база разговора не меняется</span>}
            </div>
          )}
        </div>

        <div className="ask-body" ref={talk}>
          {loading && <p className="modal-message">Загрузка…</p>}
          {bases.kind === 'failed' && <p className="modal-message error-text">Нет связи с API</p>}
          {bases.kind === 'loaded' && bases.bases.length === 0 && (
            <p className="modal-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          )}

          {!loading && bases.kind === 'loaded' && bases.bases.length > 0 && !started && !value && (
            <div className="ask-examples">
              <div className="ask-examples-title">Например</div>
              {examples.map((example) => (
                <button key={example} type="button" className="ask-example" onClick={() => setText(example)}>
                  {example}
                </button>
              ))}
            </div>
          )}

          {events.map((event, i) => (
            <Said key={i} event={event} />
          ))}

          {running && (
            <div className="ask-waiting" role="status">
              <span className="ask-spinner" aria-hidden="true" />
              <span className="ask-waiting-text">
                {AGENT_NAME} читает базу {project}…
              </span>
              {startedAt !== null && <Elapsed since={startedAt} />}
            </div>
          )}
          {steps.length > 0 && (
            <ol className="ask-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
              {steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}

          {failure && (
            <div className="ask-error" role="alert">
              <strong>{AGENT_NAME} не ответил</strong>
              <span>{failure}. База не менялась.</span>
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <label htmlFor="ask-text" className="visually-hidden">
            {started ? 'Следующая реплика' : 'Вопрос'}
          </label>
          <textarea
            id="ask-text"
            className={`custom-textarea ask-textarea ${started ? 'ask-textarea-next' : ''}`}
            autoFocus
            value={value}
            disabled={running}
            placeholder={
              running
                ? `${AGENT_NAME} отвечает — реплика уйдёт, когда он закончит`
                : started
                  ? 'Спросите дальше: уточните, переспросите или поправьте'
                  : 'Спросите о проекте своими словами: почему принято решение, что известно про часть системы, что лежит в бэклоге по теме'
            }
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
            }}
          />
          <div className="ask-actions">
            <span className="ask-hint">
              <LockIcon />
              {AGENT_NAME} только читает базу и ничего в ней не меняет
            </span>
            <div className="footer-right">
              {running ? (
                <button type="button" className="btn" onClick={() => void stop()}>
                  Отменить
                </button>
              ) : (
                <>
                  {started && (
                    <button type="button" className="btn" onClick={() => void newTalk()}>
                      Новая переписка
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={!active || !value.trim()}
                    onClick={() => void submit()}
                  >
                    Отправить
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Одно событие переписки: реплика оператора, ответ агента, его сбой или слово панели о разговоре. */
function Said({ event }: { event: AskEvent }) {
  // Ход работы виден, пока идёт ответ, и отдельным списком: в переписке он не остаётся.
  if (event.type === 'step') return null

  if (event.type === 'reply') return <div className="ask-said">{event.text}</div>

  if (event.type === 'answer') {
    const files = event.files ?? []
    return (
      <div className="ask-answer">
        <Markdown className="ask-answer-text" text={event.text} />
        <div className="ask-answer-meta">
          {files.length > 0 ? (
            <>
              <span>Прочитано:</span>
              {files.map((file) => (
                <span key={file} className="ask-file">
                  {file}
                </span>
              ))}
            </>
          ) : (
            <span>Файлы базы не открывались</span>
          )}
          {event.durationMs !== undefined && (
            <span className="ask-duration">{formatDuration(event.durationMs)}</span>
          )}
        </div>
      </div>
    )
  }

  if (event.type === 'error') {
    return (
      <div className="ask-error" role="alert">
        <strong>{AGENT_NAME} не ответил</strong>
        <span>{event.text}. База не менялась, а разговор остался.</span>
        {event.output && <pre>{event.output}</pre>}
      </div>
    )
  }

  // note и stopped — слово самой панели о разговоре: ни ответ, ни сбой.
  return <p className="ask-note">{event.text}</p>
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

export function AskIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M9.5 8.5a2.5 2.5 0 0 1 4.8 1c0 1.5-2.3 2-2.3 3" />
      <line x1="12" y1="15" x2="12.01" y2="15" />
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

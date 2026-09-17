import { useCallback, useEffect, useRef, useState } from 'react'
import { Markdown } from './Markdown'
import './AskModal.css'

export type AskBase = { base: string; project: string }

export type AskEvent =
  | { type: 'step'; text: string }
  | { type: 'answer'; text: string; files?: string[]; durationMs?: number }
  | { type: 'error'; text: string; output?: string }

type Answer = { text: string; files: string[]; durationMs: number | null }

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | { kind: 'answered'; answer: Answer }
  | { kind: 'failed'; text: string; output: string | null }

type Bases = { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; bases: AskBase[] }

const examples = [
  'Что решено про запись панели в файлы баз?',
  'Что лежит в бэклоге про сессии агентов?',
  'Чем поставленная панель отличается от dev-запуска?',
]

export default function AskModal({ onClose }: { onClose: () => void }) {
  const [bases, setBases] = useState<Bases>({ kind: 'loading' })
  const [base, setBase] = useState<string | null>(null)
  const [question, setQuestion] = useState('')
  // Вопрос, на который идёт или пришёл ответ: поле могут править, пока агент думает над прежним текстом
  const [asked, setAsked] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [steps, setSteps] = useState<string[]>([])
  const running = useRef<AbortController | null>(null)

  useEffect(() => {
    fetch('/api/ask/bases')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<AskBase[]>
      })
      .then(
        (list) => {
          setBases({ kind: 'loaded', bases: list })
          setBase(list[0]?.base ?? null)
        },
        () => setBases({ kind: 'failed' }),
      )
  }, [])

  // Закрытое окно не ждёт ответа: запрос обрывается, и API останавливает агента
  useEffect(() => () => running.current?.abort(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ask = useCallback(
    async (text: string) => {
      if (!base || !text.trim()) return
      running.current?.abort()
      const controller = new AbortController()
      running.current = controller
      setAsked(text.trim())
      setSteps([])
      setPhase({ kind: 'running', startedAt: Date.now() })

      const finish = (next: Phase) => {
        if (running.current === controller) {
          running.current = null
          setPhase(next)
        }
      }

      try {
        const response = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base, question: text.trim() }),
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          finish({
            kind: 'failed',
            text: response.status === 404 ? 'Базы нет в списке панели или на диске' : 'Панель не приняла вопрос',
            output: null,
          })
          return
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line) as AskEvent
            if (event.type === 'step') {
              setSteps((prev) => [...prev, event.text])
            } else if (event.type === 'answer') {
              finish({
                kind: 'answered',
                answer: { text: event.text, files: event.files ?? [], durationMs: event.durationMs ?? null },
              })
              return
            } else {
              finish({ kind: 'failed', text: event.text, output: event.output ?? null })
              return
            }
          }
        }
        finish({ kind: 'failed', text: 'Ответ оборвался: API закрыл соединение без ответа агента', output: null })
      } catch (error) {
        if (controller.signal.aborted) return
        finish({
          kind: 'failed',
          text: error instanceof SyntaxError ? 'API прислал непонятный ответ' : 'Нет связи с API',
          output: null,
        })
      }
    },
    [base],
  )

  function cancel() {
    running.current?.abort()
    running.current = null
    setPhase({ kind: 'idle' })
  }

  function newQuestion() {
    setQuestion('')
    setAsked('')
    setSteps([])
    setPhase({ kind: 'idle' })
  }

  const project =
    bases.kind === 'loaded' ? (bases.bases.find((b) => b.base === base)?.project ?? '') : ''

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard ask-modal" role="dialog" aria-modal="true" aria-label="Вопрос по базе">
        <div className="ask-head">
          <div className="ask-title">
            <AskIcon />
            <h2>Вопрос по базе</h2>
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
                  className={`chip ${b.base === base ? 'active' : ''}`}
                  aria-pressed={b.base === base}
                  title={b.base}
                  disabled={phase.kind === 'running'}
                  onClick={() => setBase(b.base)}
                >
                  {b.project}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ask-body">
          {bases.kind === 'loading' && <p className="modal-message">Загрузка баз…</p>}
          {bases.kind === 'failed' && <p className="modal-message error-text">Нет связи с API</p>}
          {bases.kind === 'loaded' && bases.bases.length === 0 && (
            <p className="modal-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          )}

          {bases.kind === 'loaded' && bases.bases.length > 0 && phase.kind === 'idle' && (
            <>
              <label htmlFor="ask-question" className="visually-hidden">
                Вопрос
              </label>
              <textarea
                id="ask-question"
                className="custom-textarea ask-textarea"
                autoFocus
                value={question}
                placeholder="Спросите о проекте своими словами: почему принято решение, что известно про часть системы, что лежит в бэклоге по теме"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void ask(question)
                }}
              />
              {!question && (
                <div className="ask-examples">
                  <div className="ask-examples-title">Например</div>
                  {examples.map((example) => (
                    <button key={example} type="button" className="ask-example" onClick={() => setQuestion(example)}>
                      {example}
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {phase.kind !== 'idle' && (
            <div className="ask-asked">
              <span className="ask-asked-label">Вопрос</span>
              <span className="ask-asked-text">{asked}</span>
            </div>
          )}

          {phase.kind === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">Агент читает базу {project}…</span>
                <Elapsed since={phase.startedAt} />
              </div>
              {steps.length > 0 && (
                <ol className="ask-steps" aria-label="Ход работы агента">
                  {steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          )}

          {phase.kind === 'answered' && (
            <div className="ask-answer">
              <Markdown className="ask-answer-text" text={phase.answer.text} />
              <div className="ask-answer-meta">
                {phase.answer.files.length > 0 ? (
                  <>
                    <span>Прочитано:</span>
                    {phase.answer.files.map((file) => (
                      <span key={file} className="ask-file">
                        {file}
                      </span>
                    ))}
                  </>
                ) : (
                  <span>Файлы базы не открывались</span>
                )}
                {phase.answer.durationMs !== null && (
                  <span className="ask-duration">{formatDuration(phase.answer.durationMs)}</span>
                )}
              </div>
            </div>
          )}

          {phase.kind === 'failed' && (
            <div className="ask-error" role="alert">
              <strong>Агент не ответил</strong>
              <span>{phase.text}. База не менялась.</span>
              {phase.output && <pre>{phase.output}</pre>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <span className="ask-hint">
            <LockIcon />
            Агент только читает базу и ничего в ней не меняет
          </span>
          <div className="footer-right">
            {phase.kind === 'idle' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!base || !question.trim()}
                onClick={() => void ask(question)}
              >
                Спросить
              </button>
            )}
            {phase.kind === 'running' && (
              <button type="button" className="btn" onClick={cancel}>
                Отменить
              </button>
            )}
            {phase.kind === 'answered' && (
              <>
                <button type="button" className="btn" onClick={() => void ask(asked)}>
                  Спросить ещё раз
                </button>
                <button type="button" className="btn btn-primary" onClick={newQuestion}>
                  Новый вопрос
                </button>
              </>
            )}
            {phase.kind === 'failed' && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setQuestion(asked)
                    setPhase({ kind: 'idle' })
                  }}
                >
                  Изменить вопрос
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void ask(asked)}>
                  Спросить ещё раз
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
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

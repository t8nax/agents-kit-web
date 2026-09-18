import { useCallback, useEffect, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { Markdown } from './Markdown'
import { useAgentRequest } from './agentRequest'
import './AskModal.css'

export type AskBase = { base: string; project: string }

export type AskEvent =
  | { type: 'step'; text: string }
  | { type: 'answer'; text: string; files?: string[]; durationMs?: number }
  | { type: 'error'; text: string; output?: string }

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
  // Вопрос живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу с начала.
  const request = useAgentRequest<AskEvent>('ask')
  const { asked, steps, outcome, running, startedAt, failure, restoring, start, forget, setFailure } = request
  // Подхваченная просьба показывает свою базу: спрашивали её, а не ту, что стояла первой в списке.
  const active = request.base ?? base

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

  const ask = useCallback(
    async (text: string) => {
      if (!active || !text.trim()) return
      const started = await start('/api/ask', { base: active, question: text.trim() })
      if (started.ok) return
      setFailure(
        started.status === 404
          ? 'Базы нет в списке панели или на диске'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла вопрос',
      )
    },
    [active, start, setFailure],
  )

  const answer = outcome?.type === 'answer' ? outcome : null
  const error = failure ?? (outcome?.type === 'error' ? outcome.text : null)
  const output = outcome?.type === 'error' ? (outcome.output ?? null) : null
  const phase: 'restoring' | 'idle' | 'running' | 'answered' | 'failed' = restoring
    ? 'restoring'
    : running
      ? 'running'
      : error
        ? 'failed'
        : answer
          ? 'answered'
          : 'idle'
  const shown = asked || question

  async function newQuestion() {
    setQuestion('')
    await forget()
  }

  const project =
    bases.kind === 'loaded' ? (bases.bases.find((b) => b.base === active)?.project ?? '') : ''

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard ask-modal" role="dialog" aria-modal="true" aria-label={`Вопрос ${AGENT_NAME}`}>
        <div className="ask-head">
          <div className="ask-title">
            <AskIcon />
            <h2>Вопрос {AGENT_NAME}</h2>
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
                  disabled={phase === 'running'}
                  onClick={() => setBase(b.base)}
                >
                  {b.project}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="ask-body">
          {(bases.kind === 'loading' || phase === 'restoring') && <p className="modal-message">Загрузка…</p>}
          {bases.kind === 'failed' && <p className="modal-message error-text">Нет связи с API</p>}
          {bases.kind === 'loaded' && bases.bases.length === 0 && (
            <p className="modal-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          )}

          {bases.kind === 'loaded' && bases.bases.length > 0 && phase === 'idle' && (
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

          {shown && phase !== 'idle' && phase !== 'restoring' && (
            <div className="ask-asked">
              <span className="ask-asked-label">Вопрос</span>
              <span className="ask-asked-text">{shown}</span>
            </div>
          )}

          {phase === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} читает базу {project}…
                </span>
                {startedAt !== null && <Elapsed since={startedAt} />}
              </div>
              {steps.length > 0 && (
                <ol className="ask-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                  {steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          )}

          {answer && phase === 'answered' && (
            <div className="ask-answer">
              <Markdown className="ask-answer-text" text={answer.text} />
              <div className="ask-answer-meta">
                {(answer.files ?? []).length > 0 ? (
                  <>
                    <span>Прочитано:</span>
                    {(answer.files ?? []).map((file) => (
                      <span key={file} className="ask-file">
                        {file}
                      </span>
                    ))}
                  </>
                ) : (
                  <span>Файлы базы не открывались</span>
                )}
                {answer.durationMs !== undefined && (
                  <span className="ask-duration">{formatDuration(answer.durationMs)}</span>
                )}
              </div>
            </div>
          )}

          {phase === 'failed' && (
            <div className="ask-error" role="alert">
              <strong>{AGENT_NAME} не ответил</strong>
              <span>{error}. База не менялась.</span>
              {output && <pre>{output}</pre>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <span className="ask-hint">
            <LockIcon />
            {AGENT_NAME} только читает базу и ничего в ней не меняет
          </span>
          <div className="footer-right">
            {phase === 'idle' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!active || !question.trim()}
                onClick={() => void ask(question)}
              >
                Спросить
              </button>
            )}
            {phase === 'running' && (
              <button type="button" className="btn" onClick={() => void forget()}>
                Отменить
              </button>
            )}
            {phase === 'answered' && (
              <>
                <button type="button" className="btn" onClick={() => void ask(shown)}>
                  Спросить ещё раз
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void newQuestion()}>
                  Новый вопрос
                </button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setQuestion(shown)
                    void forget()
                  }}
                >
                  Изменить вопрос
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void ask(shown)}>
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

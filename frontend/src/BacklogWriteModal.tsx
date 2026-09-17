import { useCallback, useEffect, useRef, useState } from 'react'
import { InlineMarkdown, Markdown } from './Markdown'
import './AskModal.css'
import './BacklogWriteModal.css'

// Имя агента, который оформляет мысль оператора в записи бэклога, — выбор оператора.
export const AGENT_NAME = 'Чудо-юдо'

export type WriteBase = { base: string; project: string }

export type WrittenEntry = {
  number: string | null
  title: string
  text: string | null
}

export type WriteEvent =
  | { type: 'step'; text: string }
  | {
      type: 'written'
      text: string
      entries: WrittenEntry[]
      commit?: string
      durationMs?: number
    }
  | { type: 'error'; text: string; output?: string; entries?: WrittenEntry[] }

type Phase =
  | { kind: 'idle' }
  | { kind: 'running'; startedAt: number }
  | {
      kind: 'written'
      entries: WrittenEntry[]
      commit: string | null
      durationMs: number | null
    }
  | {
      kind: 'failed'
      text: string
      output: string | null
      entries: WrittenEntry[]
    }

type Props = {
  bases: WriteBase[]
  initialBase: string | null
  onClose: () => void
  // Записи появились в backlog.md базы — список бэклога перечитывается и отмечает их новыми.
  onEntries: (base: string, numbers: string[]) => void
}

export default function BacklogWriteModal({ bases, initialBase, onClose, onEntries }: Props) {
  const [base, setBase] = useState<string | null>(initialBase ?? bases[0]?.base ?? null)
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [steps, setSteps] = useState<string[]>([])
  const running = useRef<AbortController | null>(null)

  // Закрытое окно не ждёт агента: запрос обрывается, и API останавливает процесс
  useEffect(() => () => running.current?.abort(), [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const write = useCallback(async () => {
    if (!base || !text.trim()) return
    running.current?.abort()
    const controller = new AbortController()
    running.current = controller
    setSteps([])
    setPhase({ kind: 'running', startedAt: Date.now() })

    const finish = (next: Phase) => {
      if (running.current !== controller) return
      running.current = null
      setPhase(next)
      const entries = next.kind === 'written' || next.kind === 'failed' ? next.entries : []
      const numbers = entries.map((e) => e.number).filter((n): n is string => n !== null)
      if (numbers.length > 0) onEntries(base, numbers)
    }

    try {
      const response = await fetch('/api/backlog/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, text: text.trim() }),
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        finish({
          kind: 'failed',
          text: response.status === 404 ? 'Базы нет в списке панели или на диске' : 'Панель не приняла текст',
          output: null,
          entries: [],
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
          const event = JSON.parse(line) as WriteEvent
          if (event.type === 'step') {
            setSteps((prev) => [...prev, event.text])
          } else if (event.type === 'written') {
            finish({
              kind: 'written',
              entries: event.entries,
              commit: event.commit ?? null,
              durationMs: event.durationMs ?? null,
            })
            return
          } else {
            finish({
              kind: 'failed',
              text: event.text,
              output: event.output ?? null,
              entries: event.entries ?? [],
            })
            return
          }
        }
      }
      finish({
        kind: 'failed',
        text: 'Запись оборвалась: API закрыл соединение без итога',
        output: null,
        entries: [],
      })
    } catch (error) {
      if (controller.signal.aborted) return
      finish({
        kind: 'failed',
        text: error instanceof SyntaxError ? 'API прислал непонятный ответ' : 'Нет связи с API',
        output: null,
        entries: [],
      })
    }
  }, [base, text, onEntries])

  function cancel() {
    running.current?.abort()
    running.current = null
    setPhase({ kind: 'idle' })
  }

  function writeMore() {
    setText('')
    setSteps([])
    setPhase({ kind: 'idle' })
  }

  const project = bases.find((b) => b.base === base)?.project ?? ''

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard ask-modal" role="dialog" aria-modal="true" aria-label="Запись в бэклог">
        <div className="ask-head">
          <div className="ask-title">
            <WriteIcon />
            <h2>Запись в бэклог</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {bases.length > 1 && (
            <div className="ask-bases" role="group" aria-label="Проект">
              {bases.map((b) => (
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
          {phase.kind === 'idle' && (
            <>
              <label htmlFor="backlog-write-text" className="visually-hidden">
                Что записать
              </label>
              <textarea
                id="backlog-write-text"
                className="custom-textarea ask-textarea"
                autoFocus
                value={text}
                placeholder="Расскажите своими словами, что стоит сделать или решить: баг, пожелание, мысль на потом. Можно несколько сразу"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void write()
                }}
              />
              <p className="write-note">
                {AGENT_NAME} разложит текст на записи, найдёт подробности в базе и коде и выдаст номера. Ctrl+Enter —
                добавить.
              </p>
            </>
          )}

          {phase.kind !== 'idle' && phase.kind !== 'written' && (
            <div className="ask-asked">
              <span className="ask-asked-label">Текст</span>
              <span className="ask-asked-text">{text.trim()}</span>
            </div>
          )}

          {phase.kind === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} пишет в бэклог {project}…
                </span>
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

          {phase.kind === 'written' && (
            <>
              <div className="write-done" role="status">
                <CheckIcon />
                <span className="write-done-text">{writtenTitle(phase.entries.length)}</span>
                <span className="write-done-meta">
                  {[
                    phase.commit && `коммит ${phase.commit}`,
                    phase.durationMs !== null && formatDuration(phase.durationMs),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <WrittenEntries entries={phase.entries} />
            </>
          )}

          {phase.kind === 'failed' && (
            <>
              <div className="ask-error" role="alert">
                <strong>{AGENT_NAME} не записал</strong>
                <span>{phase.text}. Текст остался — его можно отправить снова.</span>
                {phase.output && <pre>{phase.output}</pre>}
              </div>
              {phase.entries.length > 0 && (
                <>
                  <p className="write-note">В бэклоге при этом появились записи:</p>
                  <WrittenEntries entries={phase.entries} />
                </>
              )}
            </>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <span className="ask-hint">
            <LockIcon />
            {AGENT_NAME} меняет в базе только backlog.md и сам его коммитит
          </span>
          <div className="footer-right">
            {phase.kind === 'idle' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!base || !text.trim()}
                onClick={() => void write()}
              >
                Добавить
              </button>
            )}
            {phase.kind === 'running' && (
              <button type="button" className="btn" onClick={cancel}>
                Отменить
              </button>
            )}
            {phase.kind === 'written' && (
              <>
                <button type="button" className="btn" onClick={writeMore}>
                  Записать ещё
                </button>
                <button type="button" className="btn btn-primary" onClick={onClose}>
                  К бэклогу
                </button>
              </>
            )}
            {phase.kind === 'failed' && (
              <>
                <button type="button" className="btn" onClick={() => setPhase({ kind: 'idle' })}>
                  Изменить текст
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void write()}>
                  Отправить снова
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function WrittenEntries({ entries }: { entries: WrittenEntry[] }) {
  return (
    <ul className="write-entries" aria-label="Новые записи">
      {entries.map((entry, i) => (
        <li key={entry.number ?? i} className="write-entry">
          <div className="write-entry-head">
            {entry.number && <span className="entry-num">{entry.number}</span>}
            <InlineMarkdown className="write-entry-title" text={entry.title} />
          </div>
          {entry.text ? (
            <Markdown className="write-entry-text" text={entry.text} />
          ) : (
            <p className="write-entry-text entry-no-text">Описания нет</p>
          )}
        </li>
      ))}
    </ul>
  )
}

function writtenTitle(count: number) {
  const mod10 = count % 10
  const mod100 = count % 100
  const word =
    mod10 === 1 && mod100 !== 11
      ? 'запись'
      : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)
        ? 'записи'
        : 'записей'
  return `Добавлено ${count} ${word}`
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

export function WriteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
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

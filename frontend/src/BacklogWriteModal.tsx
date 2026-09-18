import { useCallback, useEffect, useState } from 'react'
import { InlineMarkdown, Markdown } from './Markdown'
import { useAgentRequest } from './agentRequest'
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
  // Просьба живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу с начала.
  const { asked, steps, outcome, running, startedAt, failure, restoring, start, forget, setFailure } =
    useAgentRequest<WriteEvent>('backlog')

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const write = useCallback(
    async (what: string) => {
      if (!base || !what.trim()) return
      const started = await start('/api/backlog/write', { base, text: what.trim() })
      if (started.ok) return
      setFailure(
        started.status === 404
          ? 'Базы нет в списке панели или на диске'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла текст',
      )
    },
    [base, start, setFailure],
  )

  const written = outcome?.type === 'written' ? outcome : null
  const error = failure ?? (outcome?.type === 'error' ? outcome.text : null)
  const output = outcome?.type === 'error' ? (outcome.output ?? null) : null
  const entries = written?.entries ?? (outcome?.type === 'error' ? (outcome.entries ?? []) : [])
  const phase: 'restoring' | 'idle' | 'running' | 'written' | 'failed' = restoring
    ? 'restoring'
    : running
      ? 'running'
      : error
        ? 'failed'
        : written
          ? 'written'
          : 'idle'
  const shown = asked || text.trim()

  // Записи появились — список бэклога перечитывается и отмечает их новыми, даже если окно открыли заново.
  const numbers = entries
    .map((entry) => entry.number)
    .filter((number): number is string => number !== null)
    .join(' ')
  useEffect(() => {
    if (base && numbers) onEntries(base, numbers.split(' '))
  }, [base, numbers, onEntries])

  async function writeMore() {
    setText('')
    await forget()
  }

  async function close() {
    await forget()
    onClose()
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
          {phase === 'restoring' && <p className="modal-message">Загрузка…</p>}
          {phase === 'idle' && (
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
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void write(text)
                }}
              />
              <p className="write-note">
                {AGENT_NAME} разложит текст на записи, найдёт подробности в базе и коде и выдаст номера. Ctrl+Enter —
                добавить.
              </p>
            </>
          )}

          {shown && phase !== 'idle' && phase !== 'restoring' && phase !== 'written' && (
            <div className="ask-asked">
              <span className="ask-asked-label">Текст</span>
              <span className="ask-asked-text">{shown}</span>
            </div>
          )}

          {phase === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} пишет в бэклог {project}…
                </span>
                {startedAt !== null && <Elapsed since={startedAt} />}
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

          {written && phase === 'written' && (
            <>
              <div className="write-done" role="status">
                <CheckIcon />
                <span className="write-done-text">{writtenTitle(written.entries.length)}</span>
                <span className="write-done-meta">
                  {[
                    written.commit && `коммит ${written.commit}`,
                    written.durationMs !== undefined && formatDuration(written.durationMs),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              <WrittenEntries entries={written.entries} />
            </>
          )}

          {phase === 'failed' && (
            <>
              <div className="ask-error" role="alert">
                <strong>{AGENT_NAME} не записал</strong>
                <span>{error}. Текст остался — его можно отправить снова.</span>
                {output && <pre>{output}</pre>}
              </div>
              {entries.length > 0 && (
                <>
                  <p className="write-note">В бэклоге при этом появились записи:</p>
                  <WrittenEntries entries={entries} />
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
            {phase === 'idle' && (
              <button
                type="button"
                className="btn btn-primary"
                disabled={!base || !text.trim()}
                onClick={() => void write(text)}
              >
                Добавить
              </button>
            )}
            {phase === 'running' && (
              <button type="button" className="btn" onClick={() => void forget()}>
                Отменить
              </button>
            )}
            {phase === 'written' && (
              <>
                <button type="button" className="btn" onClick={() => void writeMore()}>
                  Записать ещё
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void close()}>
                  К бэклогу
                </button>
              </>
            )}
            {phase === 'failed' && (
              <>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setText(shown)
                    void forget()
                  }}
                >
                  Изменить текст
                </button>
                <button type="button" className="btn btn-primary" onClick={() => void write(shown)}>
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

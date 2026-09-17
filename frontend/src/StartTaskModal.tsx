import { useEffect, useState, type FormEvent } from 'react'
import type { WorkspaceRow } from './App'
import type { BacklogEntry, BaseBacklog } from './Backlog'
import './StartTaskModal.css'

type Props = {
  row: WorkspaceRow
  onClose: () => void
  onStarted: (session: string) => void
}

type Problem = 'copy-busy' | 'copy-starting' | 'record-unknown' | 'agent'

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; entries: BacklogEntry[] }

function failureOf(problem: Problem, message: string | null): string {
  switch (problem) {
    case 'copy-busy':
      return `В копии уже идёт задача${message ? ` «${message}»` : ''} — панель не запускает вторую.`
    case 'copy-starting':
      return 'В этой копии панель уже запустила задачу — агент ещё не завёл её память.'
    case 'record-unknown':
      return 'Этой записи больше нет в бэклоге: её взяли или удалили. Закройте окно и откройте заново.'
    default:
      return `Задача не запущена: агент не стартовал. ${message ?? ''}`.trim()
  }
}

/** Окно запуска задачи: копия уже выбрана строкой таблицы, оператор выбирает запись бэклога её проекта. */
export default function StartTaskModal({ row, onClose, onStarted }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [number, setNumber] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Бэклог читается на открытие окна: соседние сессии берут и дописывают записи прямо сейчас.
  useEffect(() => {
    let alive = true
    fetch('/api/backlog')
      .then((response) => {
        if (!response.ok) throw new Error(`Бэклог не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseBacklog[]>
      })
      .then(
        (backlogs) => {
          if (!alive) return
          const backlog = backlogs.find((b) => b.base === row.base)
          if (backlog?.error) {
            setLoad({ kind: 'failed', message: backlog.error })
            return
          }
          // Без номера запись не адресовать: запуск просит агента взять её по номеру.
          setLoad({ kind: 'loaded', entries: backlog?.entries.filter((e) => e.number) ?? [] })
        },
        (e: unknown) => {
          if (!alive) return
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          })
        },
      )
    return () => {
      alive = false
    }
  }, [row.base])

  async function start(event: FormEvent) {
    event.preventDefault()
    if (!number || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path, number }),
      })
      if (response.ok) {
        const body = (await response.json()) as { session: string }
        onStarted(body.session)
        return
      }
      if (response.status === 400) {
        const body = (await response.json()) as { problem: Problem; message: string | null }
        setFailure(failureOf(body.problem, body.message))
      } else if (response.status === 404) {
        setFailure('Этой базы или копии больше нет в списке панели.')
      } else {
        setFailure(`Задача не запущена: HTTP ${response.status}.`)
      }
    } catch {
      setFailure('Задача не запущена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="st-modal" role="dialog" aria-modal="true" aria-labelledby="st-title" onSubmit={start} noValidate>
        <div className="st-head">
          <h3 id="st-title">Взять задачу в работу</h3>
          <button type="button" className="btn btn-icon st-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="st-body">
          {failure && (
            <p className="st-failure" role="alert">
              {failure}
            </p>
          )}

          <div className="st-field">
            <span className="st-label">Рабочая копия</span>
            <span className="st-copy">{row.project}</span>
            <span className="mono text-ter st-sub">
              {row.path}
              {row.branch ? ` · ветка ${row.branch}` : ''}
            </span>
          </div>

          <fieldset className="st-field st-records">
            <legend className="st-label">Запись бэклога</legend>
            {load.kind === 'loading' && <p className="text-sec st-message">Бэклог читается…</p>}
            {load.kind === 'failed' && <p className="warning-text st-message">{load.message}</p>}
            {load.kind === 'loaded' && load.entries.length === 0 && (
              <p className="text-sec st-message">В бэклоге проекта нет записей с номером.</p>
            )}
            {load.kind === 'loaded' && load.entries.length > 0 && (
              <ul className="st-list">
                {load.entries.map((entry) => (
                  <li key={entry.number}>
                    <label className={`st-record ${entry.number === number ? 'is-on' : ''}`}>
                      <input
                        type="radio"
                        name="st-record"
                        className="visually-hidden"
                        checked={entry.number === number}
                        disabled={busy}
                        onChange={() => {
                          setNumber(entry.number)
                          setFailure(null)
                        }}
                      />
                      <span className="st-radio" aria-hidden="true" />
                      <span className="num-chip">{entry.number}</span>
                      <span className="st-record-title">{entry.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <p className="st-hint">
            Запись уйдёт из бэклога, и агент заведёт память задачи сам — панель бэклог не правит. Работает он в фоне,
            а вопросы задаёт в панели.
          </p>
        </div>

        <div className="st-footer">
          <div className="st-footer-end">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !number}>
              {busy ? 'Запускается…' : 'Взять в работу'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

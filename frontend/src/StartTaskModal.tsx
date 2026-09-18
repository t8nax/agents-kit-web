import { useEffect, useState, type FormEvent } from 'react'
import type { WorkspaceRow } from './App'
import type { BacklogEntry } from './Backlog'
import './StartTaskModal.css'

type Props = {
  base: string
  entry: BacklogEntry & { number: string }
  onClose: () => void
  /** Имя каталога копии, в которую ушла задача: им панель говорит, где она запустилась. */
  onStarted: (copy: string) => void
}

type Problem = 'copy-busy' | 'copy-starting' | 'record-unknown' | 'agent'

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; copies: WorkspaceRow[] }

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

/** Окно запуска задачи: запись выбрана в бэклоге, оператор выбирает свободную копию её проекта. */
export default function StartTaskModal({ base, entry, onClose, onStarted }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [path, setPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Копии читаются на открытие окна, а не берутся из раздела: соседняя задача занимает копию прямо сейчас.
  useEffect(() => {
    let alive = true
    fetch('/api/workspaces')
      .then((response) => {
        if (!response.ok) throw new Error(`Копии не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<WorkspaceRow[]>
      })
      .then(
        (rows) => {
          if (!alive) return
          setLoad({ kind: 'loaded', copies: freeCopies(rows, base) })
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
  }, [base])

  const copies = load.kind === 'loaded' ? load.copies : []
  const chosen = copies.find((row) => row.path === path) ?? null

  async function start(event: FormEvent) {
    event.preventDefault()
    if (!chosen || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, copy: chosen.path, number: entry.number }),
      })
      if (response.ok) {
        onStarted(copyName(chosen.path))
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
            <span className="st-label">Запись бэклога</span>
            <span className="st-record-line">
              <span className="num-chip">{entry.number}</span>
              <span className="st-record-title">{entry.title}</span>
            </span>
          </div>

          <fieldset className="st-field st-records">
            <legend className="st-label">Рабочая копия</legend>
            {load.kind === 'loading' && <p className="text-sec st-message">Копии читаются…</p>}
            {load.kind === 'failed' && <p className="warning-text st-message">{load.message}</p>}
            {load.kind === 'loaded' && copies.length === 0 && (
              <p className="text-sec st-message">Свободной копии у проекта сейчас нет — все заняты задачами.</p>
            )}
            {copies.length > 0 && (
              <ul className="st-list">
                {copies.map((row) => (
                  <li key={row.path}>
                    <label className={`st-record ${row.path === path ? 'is-on' : ''}`} title={row.path}>
                      <input
                        type="radio"
                        name="st-copy"
                        className="visually-hidden"
                        checked={row.path === path}
                        disabled={busy}
                        onChange={() => {
                          setPath(row.path)
                          setFailure(null)
                        }}
                      />
                      <span className="st-radio" aria-hidden="true" />
                      <span className="st-copy-text">
                        <span className="st-copy-name">{copyName(row.path)}</span>
                        <span className="st-copy-sub text-ter mono">
                          {row.branch ? `ветка ${row.branch}` : 'ветка неизвестна'}
                        </span>
                      </span>
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
            <button type="submit" className="btn btn-primary" disabled={busy || !chosen}>
              {busy ? 'Запускается…' : 'Взять в работу'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

/** Свободные копии базы: занятая задачей копия вторую не принимает, и запускать в неё нечего. */
export function freeCopies(rows: WorkspaceRow[], base: string) {
  return rows.filter((row) => row.base === base && row.error === null && row.status === 'free')
}

function copyName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

export function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="5 3 19 12 5 21 5 3" />
    </svg>
  )
}

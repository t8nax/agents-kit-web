import { useEffect, useState, type FormEvent } from 'react'
import type { WorkspaceRow } from './App'
import { plural } from './plural'
import type { SessionRow } from './Sessions'
import { splitTask } from './taskTitle'
import './NewSessionModal.css'

type Props = {
  /** Сессии перечня: по ним видно, сколько их уже идёт в копии. */
  sessions: SessionRow[]
  onClose: () => void
  onStarted: (session: string, terminal: boolean) => void
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; copies: WorkspaceRow[] }

/**
 * Окно запуска сессии не под задачу: оператор выбирает копию из списка баз панели и, если хочет, пишет,
 * с чего сессии начать. Занятость копии запуску не мешает — про идущую в ней задачу окно предупреждает,
 * а решает оператор.
 */
export default function NewSessionModal({ sessions, onClose, onStarted }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [path, setPath] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Копии читаются на открытие окна: раздел «Сессии» знает только те, где сессия уже идёт.
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
          // Копия, до которой панель не достучалась, сессию не примет
          const copies = rows.filter((row) => !row.error)
          setLoad({ kind: 'loaded', copies })
          setPath((chosen) => chosen ?? copies[0]?.path ?? null)
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
  }, [])

  const copies = load.kind === 'loaded' ? load.copies : []
  const chosen = copies.find((row) => row.path === path) ?? null

  async function start(event: FormEvent) {
    event.preventDefault()
    if (!chosen || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/sessions/new', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: chosen.base, copy: chosen.path, prompt: prompt.trim() || null }),
      })
      if (response.ok) {
        const body = (await response.json()) as { session: string; terminal: boolean }
        onStarted(body.session, body.terminal)
        return
      }
      if (response.status === 400) {
        const problem = (await response.json().catch(() => null)) as { message?: string } | null
        setFailure(`Сессия не запущена: агент не стартовал. ${problem?.message ?? ''}`.trim())
      } else if (response.status === 404) {
        setFailure('Этой базы или копии больше нет в списке панели.')
      } else {
        setFailure(`Сессия не запущена: HTTP ${response.status}.`)
      }
    } catch {
      setFailure('Сессия не запущена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="ns-modal" role="dialog" aria-modal="true" aria-labelledby="ns-title" onSubmit={start} noValidate>
        <div className="ns-head">
          <h3 id="ns-title">Новая сессия</h3>
          <button type="button" className="btn btn-icon ns-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="ns-body">
          {failure && (
            <p className="ns-failure" role="alert">
              {failure}
            </p>
          )}

          <fieldset className="ns-field ns-copies">
            <legend className="ns-label">Рабочая копия</legend>
            {load.kind === 'loading' && <p className="text-sec ns-message">Копии читаются…</p>}
            {load.kind === 'failed' && <p className="warning-text ns-message">{load.message}</p>}
            {load.kind === 'loaded' && copies.length === 0 && (
              <p className="text-sec ns-message">Ни одной рабочей копии в списке баз нет.</p>
            )}
            {copies.length > 0 && (
              <ul className="ns-list">
                {copies.map((row) => (
                  <li key={row.path}>
                    <label className={`ns-copy ${row.path === path ? 'is-on' : ''}`} title={row.path}>
                      <input
                        type="radio"
                        name="ns-copy"
                        className="visually-hidden"
                        checked={row.path === path}
                        disabled={busy}
                        onChange={() => {
                          setPath(row.path)
                          setFailure(null)
                        }}
                      />
                      <span className="ns-radio" aria-hidden="true" />
                      <span className="ns-copy-text">
                        <span className="ns-copy-head">
                          <span className="ns-copy-name">{copyName(row.path)}</span>
                          {/* В плашке только номер: заголовок задачи длинный, и целиком он в предупреждении ниже */}
                          {row.task && <span className="ns-task">идёт задача {splitTask(row.task, row.letters).number ?? row.task}</span>}
                        </span>
                        <span className="ns-copy-sub text-ter">{subtitle(row, sessions)}</span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <div className="ns-field">
            <label className="ns-label" htmlFor="ns-prompt">
              С чего начать — необязательно
            </label>
            <textarea
              id="ns-prompt"
              className="ns-prompt"
              rows={4}
              placeholder="Например: посмотри, почему падает e2e на sessions.spec.ts"
              value={prompt}
              disabled={busy}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          {chosen?.task && (
            <p className="ns-warning">
              В копии {copyName(chosen.path)} идёт задача {chosen.task}. Новая сессия её не прервёт, но будет править
              те же файлы — запускать её или нет, решаете вы.
            </p>
          )}
        </div>

        <div className="ns-footer">
          <div className="ns-footer-end">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !chosen}>
              {busy ? 'Запускается…' : 'Запустить'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

/** Чем копия занята помимо задачи: своя ветка и сколько сессий в ней уже идёт. */
function subtitle(row: WorkspaceRow, sessions: SessionRow[]) {
  const live = sessions.filter((session) => session.path === row.path).length
  const branch = row.branch ? `ветка ${row.branch}` : 'ветка неизвестна'
  return `${branch} · ${live === 0 ? 'сессий нет' : plural(live, 'сессия', 'сессии', 'сессий')}`
}

function copyName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

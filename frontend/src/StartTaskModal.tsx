import { useEffect, useState, type FormEvent } from 'react'
import type { WorkspaceRow } from './App'
import type { BacklogEntry } from './Backlog'
import { copyName, freeCopies } from './copies'
import type { BaseFlow, NamedFlow } from './Flow'
import './Modal.css'
import './StartTaskModal.css'

type Props = {
  base: string
  entry: BacklogEntry & { number: string }
  onClose: () => void
  /** Имя каталога копии, в которую ушла задача: им панель говорит, где она запустилась. */
  onStarted: (copy: string) => void
}

type Problem = 'copy-busy' | 'copy-starting' | 'record-unknown' | 'flow-unknown' | 'agent'

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; copies: WorkspaceRow[] }

type Flows = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; flows: NamedFlow[] }

function failureOf(problem: Problem, message: string | null): string {
  switch (problem) {
    case 'copy-busy':
      return `В копии уже идёт задача${message ? ` «${message}»` : ''} — панель не запускает вторую.`
    case 'copy-starting':
      return 'В этой копии панель уже запустила задачу — агент ещё не завёл её память.'
    case 'record-unknown':
      return 'Этой записи больше нет в бэклоге: её взяли или удалили. Закройте окно и откройте заново.'
    case 'flow-unknown':
      return 'Этого флоу в базе больше нет: его переименовали или удалили. Закройте окно и откройте заново.'
    default:
      return `Задача не запущена: агент не стартовал. ${message ?? ''}`.trim()
  }
}

/**
 * Окно запуска задачи: запись выбрана в бэклоге, оператор выбирает флоу, которым её вести, и свободную копию
 * её проекта. Выбор флоу виден всегда, даже при одном флоу, первым выбран первый — ответ оператора.
 */
export default function StartTaskModal({ base, entry, onClose, onStarted }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [path, setPath] = useState<string | null>(null)
  const [flows, setFlows] = useState<Flows>({ kind: 'loading' })
  const [flow, setFlow] = useState<string | null>(null)
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

  // Флоу базы читаются тоже на открытие окна: их правят из раздела «Флоу» и руками.
  useEffect(() => {
    let alive = true
    fetch('/api/flow')
      .then((response) => {
        if (!response.ok) throw new Error(`Флоу не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<BaseFlow[]>
      })
      .then(
        (all) => {
          if (!alive) return
          const own = all.find((f) => f.base === base)
          // Флоу базы не прочитан — это отказ чтения, а не «флоу нет»: запуск остаётся, флоу спросит сессия.
          if (own?.error) {
            setFlows({ kind: 'failed', message: `Флоу не прочитан: ${own.error}` })
            return
          }
          setFlows({ kind: 'loaded', flows: own?.flows ?? [] })
          setFlow(own?.flows[0]?.name ?? null)
        },
        (e: unknown) => {
          if (!alive) return
          setFlows({
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
  // Флоу не прочитались — задачу всё равно можно начать: сессия спросит флоу у оператора сама. Прочитались, а флоу
  // у проекта нет, — не начать: кит без флоу работу не ведёт.
  const flowReady = flow !== null || flows.kind === 'failed'

  async function start(event: FormEvent) {
    event.preventDefault()
    if (!chosen || !flowReady || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, copy: chosen.path, number: entry.number, flow }),
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
            <span className="st-entry">
              <span className="num-chip">{entry.number}</span>
              <span className="st-entry-title">{entry.title}</span>
            </span>
          </div>

          <fieldset className="st-field">
            <legend className="st-label">Флоу</legend>
            {flows.kind === 'loading' && <p className="text-sec st-message">Флоу читаются…</p>}
            {flows.kind === 'failed' && (
              <p className="warning-text st-message">{flows.message}. Сессия спросит флоу у вас сама.</p>
            )}
            {flows.kind === 'loaded' && flows.flows.length === 0 && (
              <p className="text-sec st-message">У проекта нет флоу — задачу не начать, пока его не завели.</p>
            )}
            {flows.kind === 'loaded' && flows.flows.length > 0 && (
              <ul className="st-list">
                {/* Два флоу с одним именем кит считает поломкой, но показать их надо оба — ключ по месту. */}
                {flows.flows.map((one, index) => (
                  <li key={index}>
                    <label className={`st-copy ${one.name === flow ? 'is-on' : ''}`}>
                      <input
                        type="radio"
                        name="st-flow"
                        className="visually-hidden"
                        checked={one.name === flow}
                        disabled={busy}
                        onChange={() => {
                          setFlow(one.name)
                          setFailure(null)
                        }}
                      />
                      <span className="st-radio" aria-hidden="true" />
                      <span className="st-copy-text">
                        <span className="st-copy-name">{one.name}</span>
                        {one.when && <span className="st-copy-sub text-ter">когда: {one.when}</span>}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>

          <fieldset className="st-field st-copies">
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
                    <label className={`st-copy ${row.path === path ? 'is-on' : ''}`} title={row.path}>
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
                        {/* Моноширинным идёт только имя ветки — как в строке таблицы копий */}
                        <span className="st-copy-sub text-ter">
                          {row.branch ? <>ветка <span className="mono">{row.branch}</span></> : 'ветка неизвестна'}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        </div>

        <div className="st-footer">
          <div className="st-footer-end">
            <button type="button" className="btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy || !chosen || !flowReady}>
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

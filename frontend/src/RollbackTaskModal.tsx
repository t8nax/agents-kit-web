import { useEffect, useState } from 'react'
import type { WorkspaceRow } from './App'
import { WarningIcon } from './Problems'
import { splitTask, splitTrackerTask } from './taskTitle'
import './Modal.css'
import './DeleteWorkspaceModal.css'
import './RollbackTaskModal.css'

type Source = 'backlog' | 'tracker' | 'none'
type Blocker = { kind: 'vscode' | 'terminal'; name: string | null }
type Plan = { task: string; source: Source; dirty: boolean; blockers: Blocker[] }

type Step = 'session' | 'backlog' | 'copy' | 'memory'
type StepState = 'pending' | 'running' | 'done' | 'failed'

type Props = {
  row: WorkspaceRow
  onClose: () => void
  onRolledBack: () => void
}

/**
 * Окно отката задачи по макету B-108, вариант Б: перечень того, что сделает откат, и галочки по ходу. Шаги идут
 * в том порядке, в каком их делает API: память задачи снимается последней, и откат, упавший посреди, можно
 * повторить — сделанные шаги проходят снова без изменений.
 */
export default function RollbackTaskModal({ row, onClose, onRolledBack }: Props) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [states, setStates] = useState<Partial<Record<Step, StepState>>>({})
  const [busy, setBusy] = useState(false)
  // Сессии, которые мешают откату: открытые до окна приходят с планом, открытые после — отказом шага
  const [blockers, setBlockers] = useState<Blocker[]>([])
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const query = `base=${encodeURIComponent(row.base)}&copy=${encodeURIComponent(row.path)}`
    fetch(`/api/tasks/rollback?${query}`)
      .then(async (response) => {
        if (!alive) return
        if (response.ok) {
          const loaded = (await response.json()) as Plan
          if (!alive) return
          setPlan(loaded)
          setBlockers(loaded.blockers)
        } else {
          setLoadError(response.status === 409 ? noTaskText : missingText(response.status))
        }
      })
      .catch(() => alive && setLoadError('Откат не подготовлен: нет связи с API.'))
    return () => {
      alive = false
    }
  }, [row.base, row.path])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const copy = copyName(row.path)
  const tracked = splitTrackerTask(row.task ?? plan?.task ?? '', row.tracker)
  const { number, title } = tracked.number ? tracked : splitTask(row.task ?? plan?.task ?? '', row.letters)
  const steps: Step[] = plan?.source === 'backlog' ? ['session', 'backlog', 'copy', 'memory'] : ['session', 'copy', 'memory']

  async function rollBack() {
    if (busy || !plan) return
    setBusy(true)
    setFailure(null)
    setStates({})
    try {
      for (const step of steps) {
        setStates((now) => ({ ...now, [step]: 'running' }))
        const problem = await run(step)
        if (problem) {
          setStates((now) => ({ ...now, [step]: 'failed' }))
          if (problem.blocked) setBlockers(problem.blocked)
          else setFailure(problem.text)
          return
        }
        setStates((now) => ({ ...now, [step]: 'done' }))
      }
      onRolledBack()
    } finally {
      setBusy(false)
    }
  }

  async function run(step: Step): Promise<{ text: string; blocked?: Blocker[] } | null> {
    try {
      const response = await fetch('/api/tasks/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path, step }),
      })
      if (response.ok) return null
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as { problem: string; message: string | null }
        if (body.problem === 'blocked') {
          const kinds = (body.message ?? '').split(', ').filter((k): k is Blocker['kind'] => k === 'vscode' || k === 'terminal')
          return { text: '', blocked: kinds.map((kind) => ({ kind, name: null })) }
        }
        if (body.problem === 'no-task') return { text: noTaskText }
        return { text: body.message ?? 'Панель не объяснила причину.' }
      }
      return { text: missingText(response.status) }
    } catch {
      return { text: 'Нет связи с API.' }
    }
  }

  const blocked = blockers.length > 0
  const kinds = [...new Set(blockers.map((b) => b.kind))]

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dw-modal" role="dialog" aria-modal="true" aria-labelledby="rb-title">
        <div className="dw-head">
          <span className="dw-head-icon" aria-hidden="true">
            <RollbackIcon />
          </span>
          <h3 id="rb-title">Откатить задачу</h3>
          <button type="button" className="dw-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dw-body">
          <div className="rb-text">
            <p className="dw-lead">
              Задача {number && <span className="dw-strong">{number}</span>} «{title}» в копии{' '}
              <span className="dw-strong">{copy}</span> проекта <span className="dw-strong">{row.project}</span> будет
              отменена:
            </p>
            {plan && (
              <ul className="rb-steps">
                {steps.map((step) => (
                  <li key={step} className={`rb-step rb-step-${states[step] ?? 'pending'}`} data-state={states[step] ?? 'pending'}>
                    <span className="rb-mark" aria-hidden="true">
                      <StepMark state={states[step]} started={busy || Object.keys(states).length > 0} />
                    </span>
                    <span>{stepText(step, number)}</span>
                  </li>
                ))}
              </ul>
            )}
            {plan?.source === 'tracker' && (
              <p className="rb-note">
                В трекере задача {number} останется без изменений: вернуть её в очередь или закрыть там нужно
                самостоятельно.
              </p>
            )}
          </div>

          {plan?.dirty && (
            <div className="rb-warning">
              <span className="rb-warning-title">
                <WarningIcon />
                Незакоммиченные правки будут потеряны
              </span>
              <p className="dw-error-text">
                В копии {copy} есть правки, не попавшие в коммит. После отката вернуть их не получится.
              </p>
            </div>
          )}

          {blocked && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                Откат невозможен
              </span>
              {kinds.map((kind) => (
                <p key={kind} className="dw-error-text">
                  {kind === 'vscode'
                    ? `В копии ${copy} открыта сессия задачи в VS Code — панель не может её погасить. Закройте её в VS Code и повторите откат.`
                    : `В копии ${copy} идёт сессия задачи в терминале — панель не может её погасить. Завершите её в терминале и повторите откат.`}
                </p>
              ))}
            </div>
          )}

          {(failure || loadError) && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                {failure ? 'Откат остановился' : 'Откат невозможен'}
              </span>
              <p className={failure ? 'mono dw-error-text' : 'dw-error-text'}>{failure ?? loadError}</p>
            </div>
          )}
        </div>

        <div className="dw-footer">
          <div className="dw-footer-end">
            <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="bases-btn dw-btn-danger"
              disabled={busy || !plan || blocked}
              onClick={() => void rollBack()}
            >
              {busy && <span className="dw-spinner" aria-hidden="true" />}
              {busy ? 'Откатывается…' : 'Откатить задачу'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

const noTaskText = 'Задачи в копии уже нет: её закрыли или откатили.'

function missingText(status: number) {
  return status === 404 ? 'Этой копии больше нет в таблице.' : `Панель ответила HTTP ${status}.`
}

function stepText(step: Step, number: string | null) {
  switch (step) {
    case 'session':
      return 'Сессия задачи будет погашена.'
    case 'backlog':
      return `Запись ${number} вернётся в конец бэклога тем же номером и текстом.`
    case 'copy':
      return 'Копия вернётся на прежнюю ветку, а ветка задачи будет удалена на компьютере. На GitHub ветка задачи останется.'
    default:
      return 'Память задачи будет снята с базы.'
  }
}

/** Точка до отката; по ходу — кольцо ждущего шага, спиннер идущего, галочка сделанного, крест упавшего. */
function StepMark({ state, started }: { state: StepState | undefined; started: boolean }) {
  if (state === 'done')
    return (
      <svg className="rb-check" viewBox="0 0 24 24">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    )
  if (state === 'running') return <span className="dw-spinner rb-spinner" />
  if (state === 'failed')
    return (
      <svg className="rb-cross" viewBox="0 0 24 24">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    )
  return <span className={started ? 'rb-ring' : 'rb-dot'} />
}

function copyName(path: string) {
  return path.split('\\').filter(Boolean).pop() ?? path
}

export function RollbackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="1 4 1 10 7 10" />
      <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
    </svg>
  )
}

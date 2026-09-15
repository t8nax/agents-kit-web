import { useCallback, useEffect, useState } from 'react'
import './App.css'
import BasesModal from './BasesModal'
import ReplyModal from './ReplyModal'

export type WorkspaceStatus = 'free' | 'in-work' | 'waiting'

export type WorkspaceRow = {
  project: string
  base: string
  path: string
  branch: string | null
  task: string | null
  flowStep: string | null
  progress: number | null
  status: WorkspaceStatus | null
  error: string | null
}

const statusLabels: Record<WorkspaceStatus, string> = {
  free: 'Свободна',
  'in-work': 'В работе',
  waiting: 'Ждёт оператора',
}

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'loaded'; rows: WorkspaceRow[] }

function App() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [replyTo, setReplyTo] = useState<WorkspaceRow | null>(null)
  const [basesOpen, setBasesOpen] = useState(false)

  const loadRows = useCallback(() => {
    fetch('/api/workspaces')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<WorkspaceRow[]>
      })
      .then((rows) => setState({ kind: 'loaded', rows }))
      .catch(() => setState({ kind: 'failed' }))
  }, [])

  useEffect(loadRows, [loadRows])

  const closeReply = useCallback(() => setReplyTo(null), [])
  const closeBases = useCallback(() => {
    setBasesOpen(false)
    loadRows()
  }, [loadRows])

  return (
    <>
      <header className="app-header">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <h3>agents-kit-web</h3>
        <button type="button" className="bases-btn header-btn" onClick={() => setBasesOpen(true)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <ellipse cx="12" cy="5" rx="9" ry="3" />
            <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
            <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
          </svg>
          Базы знаний
        </button>
      </header>
      <main className="main-content">
        {state.kind === 'failed' && <p className="message warning-text">Нет связи с API</p>}
        {state.kind === 'loaded' && <WorkspacesTable rows={state.rows} onReply={setReplyTo} />}
        {state.kind === 'loaded' && state.rows.length === 0 && (
          <p className="empty-message">Нет отслеживаемых баз или рабочих копий. Базы добавляются в окне «Базы знаний».</p>
        )}
      </main>
      {replyTo && <ReplyModal base={replyTo.base} copy={replyTo.path} onClose={closeReply} onAnswered={loadRows} />}
      {basesOpen && <BasesModal onClose={closeBases} />}
    </>
  )
}

function WorkspacesTable({ rows, onReply }: { rows: WorkspaceRow[]; onReply: (row: WorkspaceRow) => void }) {
  return (
    <table>
      <thead>
        <tr>
          <th>Проект и копия</th>
          <th>Задача</th>
          <th>Шаг флоу</th>
          <th>Прогресс</th>
          <th>Статус</th>
          <th>Проблемы</th>
          <th>
            <span className="visually-hidden">Действия</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.project}|${row.path}`}>
            <td>
              <div className="proj">{row.project}</div>
              <div className="mono text-sec sub">
                {row.branch ? `${row.branch} · ${row.path}` : row.path}
              </div>
            </td>
            {row.error ? (
              <td className="task-col" colSpan={4}>
                <span className="warning-text">
                  <WarningIcon />
                  {row.error}
                </span>
              </td>
            ) : (
              <>
                <td className={`task-col ${row.task ? '' : 'text-ter'}`}>{row.task ?? '—'}</td>
                <td className={row.flowStep ? '' : 'text-ter'}>{row.flowStep ?? '—'}</td>
                <td className={row.progress === null ? 'text-ter' : ''}>
                  {row.progress === null ? '—' : <Progress value={row.progress} waiting={row.status === 'waiting'} />}
                </td>
                <td>
                  {row.status && (
                    <span className={`status-badge status-${row.status}`}>{statusLabels[row.status]}</span>
                  )}
                </td>
              </>
            )}
            <td className="text-sec">-</td>
            <td>
              {row.status === 'waiting' && (
                <button type="button" className="action-btn-waiting" onClick={() => onReply(row)}>
                  Ответить
                </button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Progress({ value, waiting }: { value: number; waiting: boolean }) {
  return (
    <div className="progress-container">
      <div className="progress-track">
        <div className={`progress-fill ${waiting ? 'waiting' : ''}`} style={{ width: `${value}%` }} />
      </div>
      <span className="mono text-sec pct">{value}%</span>
    </div>
  )
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

export default App

import { useEffect, useState } from 'react'
import './App.css'

export type WorkspaceStatus = 'free' | 'in-work' | 'waiting'

export type WorkspaceRow = {
  project: string
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

  useEffect(() => {
    fetch('/api/workspaces')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<WorkspaceRow[]>
      })
      .then((rows) => setState({ kind: 'loaded', rows }))
      .catch(() => setState({ kind: 'failed' }))
  }, [])

  return (
    <>
      <header className="app-header">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <h3>agents-kit-web</h3>
      </header>
      <main className="main-content">
        {state.kind === 'failed' && <p className="message warning-text">Нет связи с API</p>}
        {state.kind === 'loaded' && <WorkspacesTable rows={state.rows} />}
      </main>
    </>
  )
}

function WorkspacesTable({ rows }: { rows: WorkspaceRow[] }) {
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

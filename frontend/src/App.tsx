import { useCallback, useEffect, useRef, useState } from 'react'
import './App.css'
import Backlog from './Backlog'
import BasesModal from './BasesModal'
import {
  notificationsActive,
  notifyStatusChange,
  useNotifications,
  type NotificationPermissionState,
} from './notifications'
import ReplyModal from './ReplyModal'
import { rowKey, statusChanges } from './statusChanges'

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

const refreshIntervalMs = 3000

// rows — последний удачно прочитанный список: сбой опроса его не стирает
type State = { rows: WorkspaceRow[] | null; failed: boolean }

type Section = 'workspaces' | 'backlog'

function App() {
  const [state, setState] = useState<State>({ rows: null, failed: false })
  const [section, setSection] = useState<Section>('workspaces')
  const [replyTo, setReplyTo] = useState<WorkspaceRow | null>(null)
  const [basesOpen, setBasesOpen] = useState(false)
  const lastRequest = useRef(0)
  const inFlight = useRef(0)
  // Прошлый удачный опрос — с ним сравнивается новый, чтобы найти смены статуса
  const polledRows = useRef<WorkspaceRow[] | null>(null)
  const notifications = useNotifications()

  const loadRows = useCallback(() => {
    const request = ++lastRequest.current
    inFlight.current++
    fetch('/api/workspaces')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<WorkspaceRow[]>
      })
      .then(
        (rows) => {
          if (request !== lastRequest.current) return
          statusChanges(polledRows.current, rows).forEach(notifyStatusChange)
          polledRows.current = rows
          setState({ rows, failed: false })
        },
        () => {
          if (request === lastRequest.current) setState((prev) => ({ ...prev, failed: true }))
        },
      )
      .finally(() => inFlight.current--)
  }, [])

  useEffect(() => {
    loadRows()
    const timer = setInterval(() => {
      if (inFlight.current > 0) return
      // Скрытая вкладка опрашивается только ради уведомлений
      if (document.visibilityState === 'hidden' && !notificationsActive()) return
      loadRows()
    }, refreshIntervalMs)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') loadRows()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [loadRows])

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
        <h3>Agents Kit Web</h3>
        <NotificationsControl
          permission={notifications.permission}
          muted={notifications.muted}
          onRequest={notifications.request}
          onToggle={notifications.setEnabled}
        />
      </header>
      <div className="app-body">
        <Sidebar
          section={section}
          waiting={state.rows?.filter((row) => row.status === 'waiting').length ?? 0}
          onSection={setSection}
          onBases={() => setBasesOpen(true)}
        />
        <main className="content">
          {section === 'workspaces' ? (
            <>
              <div className="content-head">
                <h2>Рабочие копии</h2>
              </div>
              {state.failed && <p className="message warning-text">Нет связи с API</p>}
              {state.rows && <WorkspacesTable rows={state.rows} onReply={setReplyTo} />}
              {state.rows?.length === 0 && (
                <p className="empty-message">
                  Нет отслеживаемых баз или рабочих копий. Базы добавляются в окне «Базы знаний».
                </p>
              )}
            </>
          ) : (
            <Backlog />
          )}
        </main>
      </div>
      {replyTo && <ReplyModal base={replyTo.base} copy={replyTo.path} onClose={closeReply} onAnswered={loadRows} />}
      {basesOpen && <BasesModal onClose={closeBases} />}
    </>
  )
}

function Sidebar({
  section,
  waiting,
  onSection,
  onBases,
}: {
  section: Section
  waiting: number
  onSection: (section: Section) => void
  onBases: () => void
}) {
  return (
    <nav className="sidebar" aria-label="Разделы панели">
      <div className="side-group">Панель</div>
      <button
        type="button"
        className={`side-item ${section === 'workspaces' ? 'active' : ''}`}
        aria-current={section === 'workspaces' ? 'page' : undefined}
        onClick={() => onSection('workspaces')}
      >
        <TableIcon />
        <span className="side-label">Рабочие копии</span>
        {waiting > 0 && <span className="side-count">{waiting} {waiting === 1 ? 'ждёт' : 'ждут'}</span>}
      </button>
      <button
        type="button"
        className={`side-item ${section === 'backlog' ? 'active' : ''}`}
        aria-current={section === 'backlog' ? 'page' : undefined}
        onClick={() => onSection('backlog')}
      >
        <ListIcon />
        <span className="side-label">Бэклог</span>
      </button>
      <button type="button" className="side-item side-bottom" onClick={onBases}>
        <BaseIcon />
        <span className="side-label">Базы знаний</span>
      </button>
    </nav>
  )
}

function TableIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="9" y1="10" x2="9" y2="20" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  )
}

function BaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  )
}

function NotificationsControl({
  permission,
  muted,
  onRequest,
  onToggle,
}: {
  permission: NotificationPermissionState
  muted: boolean
  onRequest: () => void
  onToggle: (enabled: boolean) => void
}) {
  if (permission === 'default') {
    return (
      <button type="button" className="bases-btn header-start" onClick={onRequest}>
        <BellIcon />
        Включить уведомления
      </button>
    )
  }
  if (permission === 'granted') {
    return (
      <button type="button" className="bases-btn header-start" onClick={() => onToggle(muted)}>
        {muted ? <BellOffIcon /> : <BellIcon />}
        {muted ? 'Включить уведомления' : 'Выключить уведомления'}
      </button>
    )
  }
  if (permission === 'denied') {
    return <span className="header-start header-note text-ter">Уведомления запрещены в браузере</span>
  }
  return <span className="header-start" />
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
    </svg>
  )
}

function BellOffIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
      <path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
      <path d="M18 8a6 6 0 0 0-9.33-5" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
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
          <tr key={rowKey(row)}>
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

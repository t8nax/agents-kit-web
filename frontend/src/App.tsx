import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './App.css'
import Backlog from './Backlog'
import { useCollapsedGroups } from './collapsedGroups'
import Flow, { FlowIcon } from './Flow'
import {
  notificationsActive,
  notifyStatusChange,
  useNotifications,
  type NotificationPermissionState,
} from './notifications'
import { plural } from './plural'
import Problems, { KitNotice, WarningIcon } from './Problems'
import ReplyModal from './ReplyModal'
import Settings from './Settings'
import { rowKey, statusChanges } from './statusChanges'
import { splitTask } from './taskTitle'
import { VsCodeIcon } from './VsCodeIcon'
import { useTheme } from './theme'

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
  /** Число проблем копии и её базы, когда problemsState — checked; иначе state говорит, почему числа нет. */
  problems?: number | null
  problemsState?: ProblemsState | null
}

export type ProblemsState = 'checked' | 'pending' | 'kit-not-set' | 'kit-not-found' | 'failed'

const problemsStateLabels: Record<Exclude<ProblemsState, 'checked'>, string> = {
  pending: 'проверяется',
  'kit-not-set': 'кит не задан',
  'kit-not-found': 'кит не найден',
  failed: 'сверка не выполнена',
}

const statusLabels: Record<WorkspaceStatus, string> = {
  free: 'Свободна',
  'in-work': 'В работе',
  waiting: 'Ждёт оператора',
}

const refreshIntervalMs = 3000

// rows — последний удачно прочитанный список: сбой опроса его не стирает
type State = { rows: WorkspaceRow[] | null; failed: boolean }

type Section = 'workspaces' | 'backlog' | 'flow' | 'problems' | 'settings'

function App() {
  const [state, setState] = useState<State>({ rows: null, failed: false })
  const [section, setSection] = useState<Section>('workspaces')
  const [replyTo, setReplyTo] = useState<WorkspaceRow | null>(null)
  const lastRequest = useRef(0)
  const inFlight = useRef(0)
  // Прошлый удачный опрос — с ним сравнивается новый, чтобы найти смены статуса
  const polledRows = useRef<WorkspaceRow[] | null>(null)
  const notifications = useNotifications()
  const theme = useTheme()

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
        <button type="button" className="bases-btn" onClick={theme.toggle}>
          {theme.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          {theme.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        </button>
      </header>
      <div className="app-body">
        <Sidebar
          section={section}
          waiting={state.rows?.filter((row) => row.status === 'waiting').length ?? 0}
          onSection={setSection}
        />
        <main className="content">
          {section === 'workspaces' ? (
            <>
              <div className="content-head">
                <h2>Рабочие копии</h2>
              </div>
              {state.failed && <p className="message warning-text">Нет связи с API</p>}
              {state.rows && (
                <WorkspacesTable
                  rows={state.rows}
                  onReply={setReplyTo}
                  onProblems={() => setSection('problems')}
                  onSettings={() => setSection('settings')}
                />
              )}
              {state.rows?.length === 0 && (
                <p className="empty-message">
                  Нет отслеживаемых баз или рабочих копий. Базы добавляются в разделе «Настройки».
                </p>
              )}
            </>
          ) : section === 'backlog' ? (
            <Backlog />
          ) : section === 'flow' ? (
            <Flow />
          ) : section === 'problems' ? (
            <Problems onSettings={() => setSection('settings')} />
          ) : (
            <Settings />
          )}
        </main>
      </div>
      {replyTo && <ReplyModal base={replyTo.base} copy={replyTo.path} onClose={closeReply} onAnswered={loadRows} />}
    </>
  )
}

function Sidebar({
  section,
  waiting,
  onSection,
}: {
  section: Section
  waiting: number
  onSection: (section: Section) => void
}) {
  // Сайдбар стоит полосой значков и разъезжается под мышью — своей кнопки у него нет
  const [expanded, setExpanded] = useState(false)
  const waitingLabel = waiting > 0 ? `${waiting} ${waiting === 1 ? 'ждёт' : 'ждут'}` : null

  return (
    <div className="sidebar-rail">
      <nav
        className={`sidebar ${expanded ? 'expanded' : ''}`}
        aria-label="Разделы панели"
        onMouseEnter={() => setExpanded(true)}
        onMouseLeave={() => setExpanded(false)}
        // Клавиатура ходит по разделам так же, как мышь: фокус разворачивает сайдбар
        onFocus={() => setExpanded(true)}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) setExpanded(false)
        }}
      >
        <div className="side-group">Панель</div>
        <SideItem
          label="Рабочие копии"
          note={waitingLabel}
          expanded={expanded}
          active={section === 'workspaces'}
          onClick={() => onSection('workspaces')}
        >
          <TableIcon />
        </SideItem>
        <SideItem
          label="Бэклог"
          expanded={expanded}
          active={section === 'backlog'}
          onClick={() => onSection('backlog')}
        >
          <ListIcon />
        </SideItem>
        <SideItem label="Флоу" expanded={expanded} active={section === 'flow'} onClick={() => onSection('flow')}>
          <FlowIcon />
        </SideItem>
        <SideItem
          label="Проблемы баз"
          expanded={expanded}
          active={section === 'problems'}
          onClick={() => onSection('problems')}
        >
          <WarningIcon />
        </SideItem>
        {/* Настройки — такой же раздел, как остальные: базы знаний и путь к киту живут на его странице */}
        <SideItem
          label="Настройки"
          expanded={expanded}
          active={section === 'settings'}
          onClick={() => onSection('settings')}
        >
          <GearIcon />
        </SideItem>
      </nav>
    </div>
  )
}

function SideItem({
  label,
  note = null,
  expanded,
  active = false,
  className = '',
  onClick,
  children,
}: {
  label: string
  note?: string | null
  expanded: boolean
  active?: boolean
  className?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className={`side-item ${active ? 'active' : ''} ${className}`}
      // Свёрнутая полоса оставляет от раздела один значок — название держится в имени кнопки
      aria-label={note ? `${label}, ${note}` : label}
      title={note ? `${label} — ${note}` : label}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      {children}
      {expanded && <span className="side-label">{label}</span>}
      {note && (expanded ? <span className="side-count">{note}</span> : <span className="side-dot" />)}
    </button>
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

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
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

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12.79A9 9 0 1 1 11.21 3a7 7 0 0 0 9.79 9.79z" />
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

// Номер записи бэклога стоит своей колонкой перед заголовком: в тексте задачи он терялся
function TaskCells({ task }: { task: string | null }) {
  if (task === null) {
    return (
      <>
        <td className="num-col text-ter">—</td>
        <td className="task-col text-ter">—</td>
      </>
    )
  }
  const { number, title } = splitTask(task)
  return (
    <>
      <td className={`num-col ${number ? '' : 'text-ter'}`}>
        {number ? <span className="num-chip">{number}</span> : '—'}
      </td>
      <td className="task-col">{title}</td>
    </>
  )
}

function WorkspacesTable({
  rows,
  onReply,
  onProblems,
  onSettings,
}: {
  rows: WorkspaceRow[]
  onReply: (row: WorkspaceRow) => void
  onProblems: () => void
  onSettings: () => void
}) {
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const groups = useCollapsedGroups()

  // Окно открывается не мгновенно, а таблица тем временем живёт своим опросом: кнопка ждёт ответа API.
  async function openInVsCode(row: WorkspaceRow) {
    setOpening(row.path)
    setOpenError(null)
    try {
      const response = await fetch('/api/workspace/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path }),
      })
      if (response.ok) return
      setOpenError(
        response.status === 404
          ? `Копия ${row.path} больше не числится за базой`
          : `Не удалось открыть VS Code на ${row.path}`,
      )
    } catch {
      setOpenError(`Не удалось открыть VS Code на ${row.path}: нет связи с API`)
    } finally {
      setOpening(null)
    }
  }

  // Без кита числа нет ни у одной строки: причина и дорога в настройки — одной плашкой над таблицей
  const kitState = rows.find((row) => row.problemsState === 'kit-not-set' || row.problemsState === 'kit-not-found')
    ?.problemsState

  return (
    <>
      {kitState && <KitNotice kit={kitState === 'kit-not-set' ? 'not-set' : 'not-found'} onSettings={onSettings} />}
      {openError && <p className="message warning-text">{openError}</p>}
      <table>
        <thead>
          <tr>
            <th>Копия</th>
            <th className="num-col">№</th>
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
        {groupByBase(rows).map((group) => {
          const collapsed = groups.isCollapsed(group.base)
          const waiting = group.rows.filter((row) => row.status === 'waiting').length
          return (
            <tbody key={group.base}>
              <tr className="group-row">
                <th scope="rowgroup" colSpan={columnCount}>
                  <div className="group-head">
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Развернуть' : 'Свернуть'} ${group.project}`}
                      title={collapsed ? 'Развернуть' : 'Свернуть'}
                      onClick={() => groups.toggle(group.base)}
                    >
                      <ChevronIcon />
                    </button>
                    <span className="group-name">{group.project}</span>
                    {collapsed && waiting > 0 && <span className="group-waiting-dot" aria-hidden="true" />}
                    <span className="group-meta">
                      {plural(group.rows.length, 'копия', 'копии', 'копий')}
                      {waiting > 0 && ` · ${waiting} ${waiting === 1 ? 'ждёт' : 'ждут'} оператора`}
                    </span>
                  </div>
                </th>
              </tr>
              {!collapsed && group.rows.map((row) => (
            <tr key={rowKey(row)}>
              <td title={row.path}>
                <div className="proj">{copyName(row.path)}</div>
                {row.branch && <div className="mono text-sec sub">{row.branch}</div>}
              </td>
              {row.error ? (
                <td className="task-col" colSpan={5}>
                  <span className="warning-text">
                    <WarningIcon />
                    {row.error}
                  </span>
                </td>
              ) : (
                <>
                  <TaskCells task={row.task} />
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
              <td>{!row.error && <ProblemsCell row={row} onProblems={onProblems} />}</td>
              <td>
                <div className="row-actions">
                  {row.status === 'waiting' && (
                    <button type="button" className="action-btn-waiting" onClick={() => onReply(row)}>
                      Ответить
                    </button>
                  )}
                  {/* Строке с ошибкой открывать нечего: копии на диске нет или её не прочитали. */}
                  {!row.error && (
                    <button
                      type="button"
                      className="action-btn-code"
                      disabled={opening === row.path}
                      aria-label={`Открыть ${row.path} в VS Code`}
                      title={`Открыть ${row.path} в VS Code`}
                      onClick={() => void openInVsCode(row)}
                    >
                      <VsCodeIcon />
                    </button>
                  )}
                </div>
              </td>
            </tr>
              ))}
            </tbody>
          )
        })}
      </table>
    </>
  )
}

const columnCount = 8

type WorkspaceGroup = { base: string; project: string; rows: WorkspaceRow[] }

// Группа — база копий; группы и копии в них идут в порядке, в каком их отдал API
function groupByBase(rows: WorkspaceRow[]): WorkspaceGroup[] {
  const groups = new Map<string, WorkspaceGroup>()
  for (const row of rows) {
    const group = groups.get(row.base)
    if (group) group.rows.push(row)
    else groups.set(row.base, { base: row.base, project: row.project, rows: [row] })
  }
  return [...groups.values()]
}

// Имя копии — последний каталог её пути
function copyName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
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

function ProblemsCell({ row, onProblems }: { row: WorkspaceRow; onProblems: () => void }) {
  const state = row.problemsState ?? null
  if (state === null || (state === 'checked' && !row.problems)) return <span className="text-sec">—</span>
  if (state !== 'checked') return <span className="text-ter">{problemsStateLabels[state]}</span>

  const count = row.problems ?? 0
  return (
    <button
      type="button"
      className="issues-btn"
      aria-label={`${plural(count, 'проблема', 'проблемы', 'проблем')} — открыть «Проблемы баз»`}
      title="Открыть «Проблемы баз»"
      onClick={onProblems}
    >
      <WarningIcon />
      {count}
    </button>
  )
}

export default App

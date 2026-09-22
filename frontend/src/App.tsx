import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import './App.css'
import AskModal, { AskIcon } from './AskModal'
import Backlog from './Backlog'
import DeleteWorkspaceModal, { TrashIcon } from './DeleteWorkspaceModal'
import { AGENT_NAME } from './BacklogWriteModal'
import { useCollapsedGroups } from './collapsedGroups'
import AgentBar from './AgentBar'
import type { AgentKind } from './agentRequest'
import Flow, { FlowIcon } from './Flow'
import NewWorkspaceModal, { PlusIcon } from './NewWorkspaceModal'
import Performers, { PerformerIcon } from './Performers'
import { notificationsActive, notifyStatusChange } from './notifications'
import { plural } from './plural'
import Problems, { KitNotice, WarningIcon } from './Problems'
import ReplyModal from './ReplyModal'
import RowMenu from './RowMenu'
import Sessions, { SessionsIcon } from './Sessions'
import Settings from './Settings'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import { PlayIcon } from './StartTaskModal'
import { rowKey, statusChanges } from './statusChanges'
import { splitTask } from './taskTitle'
import { TerminalIcon } from './TerminalIcon'
import Usage, { UsageIcon } from './Usage'
import { VsCodeIcon } from './VsCodeIcon'
import { useTheme } from './theme'

/** starting — панель запустила задачу, а памяти у копии ещё нет: агент только начал. */
export type WorkspaceStatus = 'free' | 'starting' | 'in-work' | 'waiting'

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
  /** Проблемы связи самой копии с базой, когда problemsState — checked; иначе state говорит, почему чисел нет. */
  problems?: number | null
  /** Находки сверки базы — общие для всех её копий, при том же problemsState. */
  baseProblems?: number | null
  problemsState?: ProblemsState | null
  /** Стоит у копии, от которой кит заводит новые: каталог, куда он их кладёт. */
  copiesDir?: string | null
  /** Что делает сессия агента в копии; null или нет поля — живой сессии в ней нет. */
  sessionState?: SessionState | null
  /** В копии идёт фоновая сессия агента — в неё есть переход из терминала. */
  backgroundSession?: boolean
  /** Буквы номеров проекта: по ним номер задачи отделяется от заголовка; null или нет поля — букв панель не знает. */
  letters?: string | null
}

/** Состояния сессии агента в копии; отсутствие сессии состоянием не считается. */
export type SessionState = 'working' | 'waiting' | 'idle'

/**
 * Подписи состояний. «Ждёт вас в терминале» — про вопрос самой сессии, на который из панели не ответить;
 * «Ждёт оператора» в статусе копии — про вопрос в файле памяти, и это разные ожидания.
 */
const sessionLabels: Record<SessionState, string> = {
  working: 'сессия работает',
  waiting: 'сессия ждёт вас в терминале',
  idle: 'сессия стоит без дела',
}

const noSessionLabel = 'сессии нет'

/**
 * Точка состояния сессии у имени копии: слова читаются подсказкой при наведении.
 * Подпись идёт меткой, а не скрытым текстом: скрытый текст попал бы в содержимое ячейки с именем копии.
 */
function SessionDot({ state }: { state: SessionState | null }) {
  const label = state ? sessionLabels[state] : noSessionLabel
  return <span className={`session-dot session-${state ?? 'none'}`} role="img" aria-label={label} title={label} />
}

/** Только что заведённая копия: её строка отмечена, пока висит уведомление. */
type Fresh = { base: string; name: string | null }

const freshMs = 8000

/** Сколько висит сообщение о запущенной задаче — решение оператора на приёмке B-40. */
const startedMs = 5000

export type ProblemsState = 'checked' | 'pending' | 'kit-not-set' | 'kit-not-found' | 'failed'

const problemsStateLabels: Record<Exclude<ProblemsState, 'checked'>, string> = {
  pending: 'проверяется',
  'kit-not-set': 'кит не задан',
  'kit-not-found': 'кит не найден',
  failed: 'сверка не выполнена',
}

const statusLabels: Record<WorkspaceStatus, string> = {
  free: 'Свободна',
  starting: 'Запускается',
  'in-work': 'В работе',
  waiting: 'Ждёт оператора',
}

const refreshIntervalMs = 3000

// rows — последний удачно прочитанный список: сбой опроса его не стирает
type State = { rows: WorkspaceRow[] | null; failed: boolean }

type Section =
  | 'workspaces'
  | 'backlog'
  | 'flow'
  | 'performers'
  | 'sessions'
  | 'usage'
  | 'problems'
  | 'settings'

function App() {
  const [state, setState] = useState<State>({ rows: null, failed: false })
  const reveal = useReveal(state.rows === null && !state.failed)
  const [section, setSection] = useState<Section>('workspaces')
  const [replyTo, setReplyTo] = useState<WorkspaceRow | null>(null)
  const [asking, setAsking] = useState(false)
  // Просьба, к которой оператор вернулся из шапки: раздел с её окном открывается заново, с её базой.
  const [openRequest, setOpenRequest] = useState<{
    kind: AgentKind
    base: string
    subject?: string | null
    at: number
  } | null>(null)
  const [creating, setCreating] = useState(false)
  // Копия, в которую раздел «Бэклог» запустил задачу: сообщение о ней переживает уход из раздела
  const [started, setStarted] = useState<string | null>(null)
  // Копия, которую оператор убирает, и сообщение об убранной
  const [removing, setRemoving] = useState<WorkspaceRow | null>(null)
  const [removed, setRemoved] = useState<string | null>(null)
  const [fresh, setFresh] = useState<Fresh | null>(null)
  const lastRequest = useRef(0)
  const inFlight = useRef(0)
  // Прошлый удачный опрос — с ним сравнивается новый, чтобы найти смены статуса
  const polledRows = useRef<WorkspaceRow[] | null>(null)
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

  // Раздел, выбранный в сайдбаре, забывает возврат к просьбе: иначе он каждый раз встаёт с её окном — B-73
  const chooseSection = useCallback((next: Section) => {
    setSection(next)
    setOpenRequest(null)
  }, [])

  const closeReply = useCallback(() => setReplyTo(null), [])
  const closeAsk = useCallback(() => setAsking(false), [])
  const closeCreate = useCallback(() => setCreating(false), [])

  // Сообщение о запущенной задаче гаснет само — решение оператора на приёмке B-40
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => setStarted(null), startedMs)
    return () => clearTimeout(timer)
  }, [started])

  useEffect(() => {
    if (!fresh) return
    const timer = setTimeout(() => setFresh(null), freshMs)
    return () => clearTimeout(timer)
  }, [fresh])

  useEffect(() => {
    if (!removed) return
    const timer = setTimeout(() => setRemoved(null), startedMs)
    return () => clearTimeout(timer)
  }, [removed])

  return (
    <>
      <header className="app-header">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" />
        </svg>
        <h3>Agents Kit Web</h3>
        <AgentBar
          onOpen={(request) => {
            if (request.kind === 'ask') {
              setAsking(true)
              return
            }
            setSection(request.kind === 'backlog' ? 'backlog' : request.kind === 'flow' ? 'flow' : 'performers')
            setOpenRequest({ kind: request.kind, base: request.base, subject: request.subject, at: Date.now() })
          }}
        />
        <button type="button" className="bases-btn" onClick={() => setAsking(true)}>
          <AskIcon />
          Спросить {AGENT_NAME}
        </button>
        <button type="button" className="bases-btn" onClick={theme.toggle}>
          {theme.theme === 'dark' ? <SunIcon /> : <MoonIcon />}
          {theme.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}
        </button>
      </header>
      <div className="app-body">
        <Sidebar
          section={section}
          waiting={state.rows?.filter((row) => row.status === 'waiting').length ?? 0}
          onSection={chooseSection}
        />
        <main className={`content ${section === 'flow' ? 'content-fixed' : ''}`}>
          {section === 'workspaces' ? (
            <>
              <div className="content-head">
                <h2>Рабочие копии</h2>
                <button
                  type="button"
                  className="bases-btn bases-btn-add head-btn"
                  disabled={!state.rows}
                  onClick={() => setCreating(true)}
                >
                  <PlusIcon />
                  Новая копия
                </button>
              </div>
              {state.failed && <p className="message warning-text">Нет связи с API</p>}
              {state.rows === null && !state.failed && <WorkspacesSkeleton shown={reveal.shown} />}
              {state.rows && (
                <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
                  <WorkspacesTable
                    rows={state.rows}
                    fresh={fresh}
                    onReply={setReplyTo}
                    onRemove={setRemoving}
                    onProblems={() => setSection('problems')}
                    onSettings={() => setSection('settings')}
                  />
                </div>
              )}
              {state.rows?.length === 0 && (
                <p className="empty-message">
                  Нет отслеживаемых баз или рабочих копий. Базы добавляются в разделе «Настройки».
                </p>
              )}
            </>
          ) : section === 'backlog' ? (
            // Возврат к просьбе открывает раздел заново: окно встаёт на базе просьбы, а не на прежнем фильтре.
            <Backlog
              key={openRequest?.kind === 'backlog' ? openRequest.at : 'backlog'}
              writeFor={openRequest?.kind === 'backlog' ? openRequest.base : null}
              onStarted={(copy) => {
                setStarted(copy)
                // Копия станет занятой, когда агент заведёт память задачи; опрос покажет это сам
                loadRows()
              }}
            />
          ) : section === 'flow' ? (
            <Flow
              key={openRequest?.kind === 'flow' ? openRequest.at : 'flow'}
              baseFor={openRequest?.kind === 'flow' ? openRequest.base : null}
              onPerformers={() => setSection('performers')}
            />
          ) : section === 'performers' ? (
            // Возврат к просьбе открывает раздел заново: окно исполнителя встаёт на базе просьбы.
            <Performers
              key={openRequest?.kind === 'performer' ? openRequest.at : 'performers'}
              draftFor={openRequest?.kind === 'performer' ? openRequest.base : null}
              draftSubject={openRequest?.kind === 'performer' ? (openRequest.subject ?? null) : null}
            />
          ) : section === 'sessions' ? (
            <Sessions />
          ) : section === 'usage' ? (
            <Usage />
          ) : section === 'problems' ? (
            <Problems onSettings={() => setSection('settings')} />
          ) : (
            <Settings />
          )}
        </main>
      </div>
      {replyTo && <ReplyModal base={replyTo.base} copy={replyTo.path} onClose={closeReply} onAnswered={loadRows} />}
      {asking && <AskModal onClose={closeAsk} />}
      {started && (
        <div className="nw-toast" role="status">
          <PlayIcon />
          <span>Задача запущена в {started}</span>
        </div>
      )}
      {removing && (
        <DeleteWorkspaceModal
          row={removing}
          onClose={() => setRemoving(null)}
          onRemoved={() => {
            setRemoved(copyName(removing.path))
            setRemoving(null)
            // Копию убрал кит — ближайший опрос и так её потеряет, но ждать его незачем
            loadRows()
          }}
          onSettings={() => {
            setRemoving(null)
            setSection('settings')
          }}
        />
      )}
      {removed && (
        <div className="nw-toast nw-toast-plain" role="status">
          <TrashIcon />
          <span>
            Копия <span className="mono">{removed}</span> удалена
          </span>
        </div>
      )}
      {creating && state.rows && (
        <NewWorkspaceModal
          rows={state.rows}
          onClose={closeCreate}
          onCreated={(base, name) => {
            setCreating(false)
            setFresh({ base, name })
            // Копию заводит git worktree — ближайший опрос и так её покажет, но ждать его незачем
            loadRows()
          }}
          onSettings={() => {
            setCreating(false)
            setSection('settings')
          }}
        />
      )}
      {fresh && (
        <div className="nw-toast" role="status">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <span>
            {fresh.name ? (
              <>
                Копия <span className="mono">{fresh.name}</span> заведена
              </>
            ) : (
              'Копия заведена'
            )}
          </span>
        </div>
      )}
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
        {/* Исполнители стоят за флоу: шаг флоу поручает работу им же */}
        <SideItem
          label="Исполнители"
          expanded={expanded}
          active={section === 'performers'}
          onClick={() => onSection('performers')}
        >
          <PerformerIcon />
        </SideItem>
        {/* Сессии стоят за флоу и перед проблемами: это раздел про то, что идёт прямо сейчас */}
        <SideItem
          label="Сессии"
          expanded={expanded}
          active={section === 'sessions'}
          onClick={() => onSection('sessions')}
        >
          <SessionsIcon />
        </SideItem>
        {/* Расход стоит за сессиями: это тоже про происходящее сейчас, только про его цену */}
        <SideItem label="Расход" expanded={expanded} active={section === 'usage'} onClick={() => onSection('usage')}>
          <UsageIcon />
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

// Номер записи бэклога стоит своей колонкой перед заголовком: в тексте задачи он терялся
function TaskCells({ task, letters }: { task: string | null; letters: string | null | undefined }) {
  if (task === null) {
    // Задачу берут в разделе «Бэклог», а у свободной копии здесь стоит прочерк — решение оператора на B-86
    return (
      <>
        <td className="num-col text-ter">—</td>
        <td className="task-col text-ter">—</td>
      </>
    )
  }
  const { number, title } = splitTask(task, letters)
  return (
    <>
      <td className={`num-col ${number ? '' : 'text-ter'}`}>
        {number ? <span className="num-chip">{number}</span> : '—'}
      </td>
      <td className="task-col">{title}</td>
    </>
  )
}

function WorkspacesHead() {
  return (
    <thead>
      <tr>
        <th>Копия</th>
        <th className="num-col">№</th>
        <th>Задача</th>
        <th>Стадия флоу</th>
        <th>Прогресс</th>
        <th>Статус</th>
        <th>Проблемы</th>
        <th className="actions-col">Действия</th>
      </tr>
    </thead>
  )
}

/**
 * Таблица копий, пока её не опросили в первый раз: группы и строки полосами под настоящей шапкой
 * колонок (макет B-201). Прежде до первого ответа раздел стоял пустым.
 */
function WorkspacesSkeleton({ shown }: { shown: boolean }) {
  const row = (name: number, branch: number, task: string, stage: number, badge: number) => (
    <tr className="sk-frame" key={`${name}-${branch}`}>
      <td className="copy-col">
        <div className="proj">
          <Sk w={8} h={8} className="sk-round" />
          <Sk w={name} h={11} />
        </div>
        <div className="sub">
          <Sk w={branch} h={8} />
        </div>
      </td>
      <td className="num-col">
        <Sk w={46} h={18} />
      </td>
      <td className="task-col">
        <Sk w={task} h={11} />
      </td>
      <td>
        <Sk w={stage} h={11} />
      </td>
      <td>
        <div className="progress-container">
          <Sk w="100%" h={4} style={{ flex: 1, width: 'auto' }} />
          <Sk w={26} h={9} />
        </div>
      </td>
      <td>
        <Sk w={badge} h={22} />
      </td>
      <td />
      <td>
        <div className="row-actions">
          <Sk w={24} h={24} />
        </div>
      </td>
    </tr>
  )
  const group = (width: number, rows: ReactNode[]) => (
    <tbody>
      <tr className="group-row sk-frame">
        <th colSpan={columnCount}>
          <div className="group-head">
            <Sk w={14} h={14} />
            <Sk w={width} h={12} />
          </div>
        </th>
      </tr>
      {rows}
    </tbody>
  )
  return (
    <Skeleton label="Загрузка рабочих копий" shown={shown}>
      <table>
        <WorkspacesHead />
        {group(118, [row(104, 150, '72%', 84, 84), row(88, 124, '58%', 96, 104), row(96, 138, '64%', 70, 72)])}
        {group(86, [row(70, 110, '48%', 84, 84), row(92, 132, '66%', 90, 104)])}
      </table>
    </Skeleton>
  )
}

function WorkspacesTable({
  rows,
  fresh,
  onReply,
  onRemove,
  onProblems,
  onSettings,
}: {
  rows: WorkspaceRow[]
  fresh: Fresh | null
  onReply: (row: WorkspaceRow) => void
  onRemove: (row: WorkspaceRow) => void
  onProblems: () => void
  onSettings: () => void
}) {
  const [opening, setOpening] = useState<string | null>(null)
  const [openError, setOpenError] = useState<string | null>(null)
  const groups = useCollapsedGroups()

  // Переход в фоновую сессию: своего окна у неё нет, и панель открывает терминал, подключённый к ней.
  async function openInTerminal(row: WorkspaceRow) {
    setOpening(row.path)
    setOpenError(null)
    try {
      const response = await fetch('/api/session/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path }),
      })
      if (response.ok) return
      setOpenError(
        response.status === 409
          ? `Сессия в ${copyName(row.path)} уже не идёт в фоне`
          : `Не удалось открыть терминал на ${row.path}`,
      )
    } catch {
      setOpenError(`Не удалось открыть терминал на ${row.path}: нет связи с API`)
    } finally {
      setOpening(null)
    }
  }

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
        <WorkspacesHead />
        {groupByBase(rows).map((group) => {
          const collapsed = groups.isCollapsed(group.base)
          const waiting = group.rows.some((row) => row.status === 'waiting')
          return (
            <tbody key={group.base}>
              <tr className="group-row">
                {/* Сворачивает клик по всей шапке — замечание оператора; клавиатуре и диктору — кнопка-стрелка,
                    её клик всплывает сюда же */}
                <th scope="rowgroup" colSpan={columnCount} onClick={() => groups.toggle(group.base)}>
                  <div className="group-head">
                    <button
                      type="button"
                      className="group-toggle"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? 'Развернуть' : 'Свернуть'} ${group.project}`}
                      title={collapsed ? 'Развернуть' : 'Свернуть'}
                    >
                      <ChevronIcon />
                    </button>
                    <span className="group-name">{group.project}</span>
                    {/* Сводки в заголовке нет — замечание оператора; у свёрнутой группы ожидание держит точка */}
                    {collapsed && waiting && (
                      <span className="group-waiting-dot" title="Есть копии, ждущие оператора">
                        <span className="visually-hidden">есть копии, ждущие оператора</span>
                      </span>
                    )}
                    {/* Число проблем ведёт в свой раздел и группу не сворачивает */}
                    <span className="group-problems" onClick={(event) => event.stopPropagation()}>
                      <BaseProblems rows={group.rows} onProblems={onProblems} />
                    </span>
                  </div>
                </th>
              </tr>
              {!collapsed && group.rows.map((row) => (
            <tr key={rowKey(row)} className={isFresh(row, fresh) ? 'row-fresh' : undefined}>
              {/* Строке с ошибкой точку ставить не о чем: копии на диске нет или её не прочитали. */}
              <td title={row.path} className={row.error ? undefined : 'copy-col'}>
                <div className="proj">
                  {!row.error && <SessionDot state={row.sessionState ?? null} />}
                  {copyName(row.path)}
                  {isFresh(row, fresh) && <span className="new-tag">новая</span>}
                  {/* Каталог копий приходит только у основной копии проекта — от неё заводят новые */}
                  {row.copiesDir && <span className="main-tag">Основная</span>}
                </div>
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
                  <TaskCells task={row.task} letters={row.letters} />
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
                    <RowActionsMenu
                      row={row}
                      busy={opening === row.path}
                      onTerminal={() => void openInTerminal(row)}
                      onVsCode={() => void openInVsCode(row)}
                      onRemove={() => onRemove(row)}
                    />
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

/**
 * Действия строки: переходов стало два, и они собраны в меню — решение оператора. Без фоновой сессии
 * пункт терминала виден, но не нажимается: подписи о причине у него нет — оператор убрал её на приёмке.
 * Удаление копии стоит там же, за разделителем: у основной копии проекта его нет вовсе — её кит
 * не удаляет и от неё заводит новые, — а у копии с задачей пункт приглушён.
 */
function RowActionsMenu({
  row,
  busy,
  onTerminal,
  onVsCode,
  onRemove,
}: {
  row: WorkspaceRow
  busy: boolean
  onTerminal: () => void
  onVsCode: () => void
  onRemove: () => void
}) {
  return (
    <RowMenu label={`Действия с ${copyName(row.path)}`} disabled={busy}>
      {(close) => (
        <>
          <button
            type="button"
            role="menuitem"
            className="row-menu-item"
            disabled={!row.backgroundSession}
            onClick={() => {
              close()
              onTerminal()
            }}
          >
            <TerminalIcon />
            Открыть в терминале
          </button>
          <button
            type="button"
            role="menuitem"
            className="row-menu-item"
            onClick={() => {
              close()
              onVsCode()
            }}
          >
            <VsCodeIcon />
            Открыть в VS Code
          </button>
          {!row.copiesDir && (
            <>
              <div className="row-menu-sep" />
              <button
                type="button"
                role="menuitem"
                className="row-menu-item row-menu-item-danger"
                disabled={row.status !== 'free'}
                onClick={() => {
                  close()
                  onRemove()
                }}
              >
                <TrashIcon />
                Удалить копию
              </button>
            </>
          )}
        </>
      )}
    </RowMenu>
  )
}

function isFresh(row: WorkspaceRow, fresh: Fresh | null) {
  return fresh?.name != null && row.base === fresh.base && row.branch === fresh.name
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

// Проблемы базы и почему их нет — один раз в заголовке группы: состояние проверки у копий базы общее
function BaseProblems({ rows, onProblems }: { rows: WorkspaceRow[]; onProblems: () => void }) {
  const row = rows.find((candidate) => !candidate.error && candidate.problemsState)
  const state = row?.problemsState ?? null
  if (state === null || (state === 'checked' && !row?.baseProblems)) return null
  if (state !== 'checked') return <span className="text-ter">{problemsStateLabels[state]}</span>

  const count = row?.baseProblems ?? 0
  return (
    <button
      type="button"
      className="issues-btn"
      aria-label={`${plural(count, 'проблема', 'проблемы', 'проблем')} базы — открыть «Проблемы баз»`}
      title="Открыть «Проблемы баз»"
      onClick={onProblems}
    >
      <WarningIcon />
      {count}
    </button>
  )
}

// В строке — только проблемы связи самой копии; у здоровой копии ячейка пустая
function ProblemsCell({ row, onProblems }: { row: WorkspaceRow; onProblems: () => void }) {
  if (row.problemsState !== 'checked' || !row.problems) return null

  const count = row.problems
  return (
    <button
      type="button"
      className="issues-btn"
      aria-label={`${plural(count, 'проблема', 'проблемы', 'проблем')} копии — открыть «Проблемы баз»`}
      title="Открыть «Проблемы баз»"
      onClick={onProblems}
    >
      <WarningIcon />
      {count}
    </button>
  )
}

export default App

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useCollapsedGroups } from './collapsedGroups'
import NewSessionModal from './NewSessionModal'
import { PlusIcon } from './NewWorkspaceModal'
import RowMenu from './RowMenu'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import './Modal.css'
import './Sessions.css'
import { TerminalIcon } from './TerminalIcon'
import { uptime } from './uptime'
import { VsCodeIcon } from './VsCodeIcon'

/** Строка перечня сессий; в перечень идут только сессии рабочих копий из списка баз. */
export type SessionRow = {
  path: string
  project: string
  base: string
  name: string | null
  /** Короткий id фоновой сессии — им её гасят и в неё входят; null — сессия идёт в своём окне. */
  session: string | null
  state: SessionState
  background: boolean
  /** Время старта в миллисекундах epoch, как его пишет реестр. */
  startedAt: number | null
}

type SessionState = 'working' | 'waiting' | 'operator' | 'idle'

/**
 * Состояние сессии показывается такой же плашкой, как статус копии в её таблице, — решение оператора.
 * Ожиданий два, и они разные: «Ждёт в терминале» — про вопрос самой сессии, на который из панели
 * не ответить, «Ждёт оператора» — про вопрос в файле памяти копии, тот же, что в статусе копии.
 */
const stateLabels: Record<SessionState, string> = {
  working: 'Работает',
  waiting: 'Ждёт в терминале',
  operator: 'Ждёт оператора',
  idle: 'Стоит без дела',
}

const stateBadges: Record<SessionState, string> = {
  working: 'status-in-work',
  waiting: 'status-waiting',
  operator: 'status-waiting',
  idle: 'status-free',
}

const refreshIntervalMs = 3000

const startedMessageMs = 5000

const collapsedKey = 'agents-kit-web.collapsed-session-groups'

const columnCount = 5

/**
 * Раздел «Сессии»: живые сессии Claude Code — те, что панель запускала, и те, что завёл оператор сам.
 * Ненужная фоновая сессия гасится отсюда же: иначе сессии копятся незаметно и съедают память машины.
 */
export default function Sessions() {
  const [rows, setRows] = useState<SessionRow[] | null>(null)
  const [failed, setFailed] = useState(false)
  const reveal = useReveal(rows === null && !failed)
  const [copy, setCopy] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<SessionRow | null>(null)
  const [starting, setStarting] = useState(false)
  const [started, setStarted] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const lastRequest = useRef(0)
  const groups = useCollapsedGroups(collapsedKey)

  const load = useCallback(() => {
    const request = ++lastRequest.current
    fetch('/api/sessions')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<SessionRow[]>
      })
      .then(
        (value) => {
          if (request !== lastRequest.current) return
          setRows(value)
          setNow(Date.now())
          setFailed(false)
        },
        () => {
          if (request === lastRequest.current) setFailed(true)
        },
      )
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, refreshIntervalMs)
    return () => clearInterval(timer)
  }, [load])

  // Сообщение о запуске гаснет само, как в окне запуска задачи
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => setStarted(null), startedMessageMs)
    return () => clearTimeout(timer)
  }, [started])

  // Сессия со своим окном гаснет там, где её открыли; панель гасит только фоновую — по её короткому id.
  async function stop(row: SessionRow) {
    if (!row.session) return
    setBusy(rowKey(row))
    setError(null)
    try {
      const response = await fetch('/api/sessions/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: row.session }),
      })
      if (response.ok) {
        load()
        return
      }
      setError(await failure(response, row, 'погасить'))
    } catch {
      setError(`Сессия ${row.session} не погашена: нет связи с API`)
    } finally {
      setBusy(null)
    }
  }

  // Переход в редактор есть и у сессии своего окна: войти в неё панель не может, но показать, где она идёт, — да
  async function openInEditor(row: SessionRow) {
    setBusy(rowKey(row))
    setError(null)
    try {
      const response = await fetch('/api/workspace/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path }),
      })
      if (response.ok) return
      setError(
        response.status === 404
          ? `Копия ${row.path} больше не числится за базой`
          : `Не удалось открыть VS Code на ${row.path}`,
      )
    } catch {
      setError(`Не удалось открыть VS Code на ${row.path}: нет связи с API`)
    } finally {
      setBusy(null)
    }
  }

  async function openInTerminal(row: SessionRow) {
    if (!row.session) return
    setBusy(rowKey(row))
    setError(null)
    try {
      const response = await fetch('/api/sessions/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: row.session }),
      })
      if (response.ok) return
      setError(await failure(response, row, 'открыть в терминале'))
    } catch {
      setError(`Сессию ${row.session} не открыть в терминале: нет связи с API`)
    } finally {
      setBusy(null)
    }
  }

  const copies = [...new Map(rows?.map((row) => [row.path, row]) ?? []).keys()]
  const shown = copy === null ? rows : (rows?.filter((row) => row.path === copy) ?? null)

  return (
    <>
      <div className="content-head">
        <h2>Сессии</h2>
        {/* Кнопка стоит там же и выглядит так же, как «Новая копия» в таблице копий — решение оператора */}
        <button type="button" className="bases-btn bases-btn-add head-end" onClick={() => setStarting(true)}>
          <PlusIcon />
          Новая сессия
        </button>
      </div>
      {started && <p className="message">{started}</p>}
      {failed && <p className="message warning-text">Нет связи с API</p>}
      {error && (
        <p className="message warning-text" role="alert">
          {error}
        </p>
      )}
      {rows === null && !failed && <SessionsSkeleton shown={reveal.shown} />}
      {rows && (
        <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
          {rows.length > 0 && (
            <div className="filter-bar" role="group" aria-label="Фильтр по копиям">
              <FilterChip label="Все копии" active={copy === null} onClick={() => setCopy(null)} />
              {copies.map((path) => (
                <FilterChip
                  key={path}
                  label={copyName(path)}
                  title={path}
                  active={copy === path}
                  onClick={() => setCopy(path)}
                />
              ))}
            </div>
          )}
          {rows.length === 0 && <p className="empty-message">Живых сессий Claude Code нет.</p>}
          {shown && shown.length > 0 && (
            <table>
              <SessionsHead />
              {groupByProject(shown).map((group) => {
                const collapsed = groups.isCollapsed(group.key)
                return (
                  <tbody key={group.key}>
                    <tr className="group-row">
                      {/* Сворачивает клик по всей шапке, как в таблице рабочих копий; кнопка-стрелка — клавиатуре */}
                      <th scope="rowgroup" colSpan={columnCount} onClick={() => groups.toggle(group.key)}>
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
                        </div>
                      </th>
                    </tr>
                    {!collapsed &&
                      group.rows.map((row) => (
                        <tr key={rowKey(row)}>
                          <td title={row.path}>{copyName(row.path)}</td>
                          <td>
                            <div>{row.name ?? '—'}</div>
                            <div className="mono text-sec sub">
                              {row.background ? `фоновая · ${row.session}` : 'в своём окне'}
                            </div>
                          </td>
                          <td>
                            <span className={`status-badge ${stateBadges[row.state]}`}>{stateLabels[row.state]}</span>
                          </td>
                          <td className="mono text-sec">{uptime(row.startedAt, now)}</td>
                          <td>
                            <div className="row-actions">
                              <RowMenu
                                label={`Действия с сессией в ${copyName(row.path)}`}
                                // Ждёт ответа API только та строка, над которой идёт действие
                                disabled={busy === rowKey(row)}
                              >
                                {(close) => (
                                  <>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="row-menu-item"
                                      onClick={() => {
                                        close()
                                        void openInEditor(row)
                                      }}
                                    >
                                      <VsCodeIcon />
                                      Открыть в VS Code
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="row-menu-item"
                                      disabled={!row.background}
                                      onClick={() => {
                                        close()
                                        void openInTerminal(row)
                                      }}
                                    >
                                      <TerminalIcon />
                                      Войти в сессию
                                    </button>
                                    <button
                                      type="button"
                                      role="menuitem"
                                      className="row-menu-item row-menu-danger"
                                      disabled={!row.background}
                                      onClick={() => {
                                        close()
                                        // Через вопрос гасят и занятую, и ждущую ответа сессию; сразу — только простаивающую: решение оператора
                                        if (row.state === 'idle') void stop(row)
                                        else setConfirming(row)
                                      }}
                                    >
                                      <PowerIcon />
                                      Погасить сессию
                                    </button>
                                  </>
                                )}
                              </RowMenu>
                            </div>
                          </td>
                        </tr>
                      ))}
                  </tbody>
                )
              })}
            </table>
          )}
        </div>
      )}
      {starting && (
        <NewSessionModal
          sessions={rows ?? []}
          onClose={() => setStarting(false)}
          onStarted={(session, terminal) => {
            setStarting(false)
            // Окно с сессией открывает API; не открылось — оператор входит в неё из строки перечня
            setStarted(
              terminal
                ? `Сессия ${session} запущена — окно с ней открыто.`
                : `Сессия ${session} запущена, но окно с ней не открылось: войдите в неё из строки перечня.`,
            )
            load()
          }}
        />
      )}
      {confirming && (
        <StopConfirm
          row={confirming}
          onClose={() => setConfirming(null)}
          onStop={() => {
            const row = confirming
            setConfirming(null)
            void stop(row)
          }}
        />
      )}
    </>
  )
}

function SessionsHead() {
  return (
    <thead>
      <tr>
        <th>Копия</th>
        <th>Сессия</th>
        <th>Состояние</th>
        <th>Живёт</th>
        <th className="actions-col">Действия</th>
      </tr>
    </thead>
  )
}

/**
 * Перечень, пока сессии читаются в первый раз: чипы копий и строки таблицы полосами под настоящей
 * шапкой колонок (макет B-201). Прежде до первого ответа раздел стоял пустым.
 */
function SessionsSkeleton({ shown }: { shown: boolean }) {
  const row = (copy: number, name: number, sub: number, badge: number) => (
    <tr className="sk-frame" key={`${copy}-${name}`}>
      <td>
        <Sk w={copy} h={11} />
      </td>
      <td>
        <div>
          <Sk w={name} h={11} />
        </div>
        <div className="sub">
          <Sk w={sub} h={8} />
        </div>
      </td>
      <td>
        <Sk w={badge} h={22} />
      </td>
      <td>
        <Sk w={52} h={10} />
      </td>
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
    <Skeleton label="Загрузка сессий" shown={shown}>
      <div className="filter-bar">
        {[86, 130, 116, 124].map((w) => (
          <Sk key={w} w={w} h={28} className="sk-pill" />
        ))}
      </div>
      <table>
        <SessionsHead />
        {group(118, [row(120, 170, 118, 80), row(104, 140, 96, 118)])}
        {group(86, [row(112, 160, 118, 100)])}
      </table>
    </Skeleton>
  )
}

/** Чем занята сессия, у которой панель переспрашивает; простаивающую она гасит без вопроса. */
const stopStates: Record<SessionState, string> = {
  working: 'сейчас работает',
  waiting: 'ждёт вас в терминале',
  operator: 'ждёт вашего ответа в памяти задачи',
  idle: 'ничего не делает',
}

/** Гашение необратимо, и у занятой сессии панель переспрашивает — решение оператора. */
function StopConfirm({ row, onClose, onStop }: { row: SessionRow; onClose: () => void; onStop: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="stop-modal" role="dialog" aria-modal="true" aria-labelledby="stop-title">
        <h3 id="stop-title">Погасить сессию?</h3>
        <p>
          Сессия <span className="mono">{row.session}</span> в копии {copyName(row.path)}{' '}
          {stopStates[row.state]}. Погашенная сессия не
          возобновляется: начатое в ней придётся начинать заново.
        </p>
        <p className="text-sec">Незакоммиченные правки останутся в копии как есть.</p>
        <div className="stop-footer">
          <button type="button" className="btn" onClick={onClose}>
            Отмена
          </button>
          <button type="button" className="btn btn-danger" onClick={onStop}>
            Погасить
          </button>
        </div>
      </div>
    </div>
  )
}

function FilterChip({
  label,
  title,
  active,
  onClick,
}: {
  label: string
  title?: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`chip ${active ? 'active' : ''}`}
      title={title}
      aria-pressed={active}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

async function failure(response: Response, row: SessionRow, action: string) {
  if (response.status === 409) return `Сессия ${row.session} уже не идёт`
  const problem = (await response.json().catch(() => null)) as { message?: string } | null
  return `Сессию ${row.session} не ${action}${problem?.message ? `: ${problem.message}` : ''}`
}

type SessionGroup = { key: string; project: string; rows: SessionRow[] }

// Группа — проект копии; группы и сессии в них идут в порядке, в каком их отдал API
function groupByProject(rows: SessionRow[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>()
  for (const row of rows) {
    const group = groups.get(row.base)
    if (group) group.rows.push(row)
    else groups.set(row.base, { key: row.base, project: row.project, rows: [row] })
  }
  return [...groups.values()]
}

// Сессия в копии не одна: строку опознаёт её id, а сессию своего окна — каталог и номер процесса
function rowKey(row: SessionRow) {
  return row.session ?? `${row.path}:${row.startedAt}`
}

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

export function PowerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 4v8" />
      <path d="M6.5 7.5a8 8 0 1 0 11 0" />
    </svg>
  )
}

export function SessionsIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="4" width="18" height="13" rx="2" />
      <path d="M9 21h6M12 17v4M7.5 9l2.5 2-2.5 2" />
    </svg>
  )
}

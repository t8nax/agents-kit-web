import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import DeleteProjectTrackerModal from './DeleteProjectTrackerModal'
import { TrashIcon } from './DeleteWorkspaceModal'
import { PlusIcon } from './NewWorkspaceModal'
import { WarningIcon } from './Problems'
import { Sk, Skeleton } from './Skeleton'
import type { TrackerField } from './TrackerGroup'
import TrackerModal from './TrackerModal'
import { busyText, faultsText, kitFaultsText, knownTracker, type ProjectTrackerRow } from './projectTracker'
import { useReveal, withReveal } from './reveal'
import type { TrackerInfo } from './tracker'
import './EmptyState.css'
import './TrackerProjects.css'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; rows: ProjectTrackerRow[] }

/** Сервер трекера с владельцем ключа — почтой у Jira, логином у YouTrack; email — почта, с которой ключ входит в Jira. */
export type TrackerServer = { server: string; login: string; email?: string | null }

type Props = {
  /** Окно трекера этой базы открывается само — возврат к просьбе из шапки панели. */
  rewriteFor?: { base: string; at: number } | null
  /**
   * Показать проект этой базы — переход из строки «Бэклога» о поломке описания трекера; с полем — открыть окно его
   * трекера с курсором в этом поле (B-285).
   */
  focus?: { base: string; at: number; field?: TrackerField } | null
  /** Проект, выбранный при открытии раздела; нет — выбран первый. */
  selected?: string | null
  /** Серверы трекеров с владельцами ключей; null — список ещё не прочитан или не прочитался. */
  servers?: TrackerServer[] | null
  /** Описание записано или удалено — с ним мог сохраниться или уйти ключ к серверу. */
  onChanged?: () => void
}

/**
 * Трекеры проектов раздела «Трекеры» (B-323, макет в памяти задачи): слева все проекты из списка баз, справа
 * трекер выбранного — вид, сервер, проект, ключ к серверу и поломки описания. Ключ вводится в окне трекера (B-285). Описание заводится,
 * правится и удаляется отсюда, а не словами киту в сессии (B-293).
 */
export default function TrackerProjects({
  rewriteFor = null,
  focus = null,
  selected: initial = null,
  servers = null,
  onChanged,
}: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reveal = useReveal(load.kind === 'loading')
  const [selected, setSelected] = useState<string | null>(rewriteFor?.base ?? focus?.base ?? initial)
  // Окно трекера; talking — возврат к переписке из шапки: она встаёт поверх окна сразу.
  const [open, setOpen] = useState<{ base: string; talking: boolean; field?: TrackerField } | null>(
    rewriteFor
      ? { base: rewriteFor.base, talking: true }
      : focus?.field
        ? { base: focus.base, talking: false, field: focus.field }
        : null,
  )
  const [deleting, setDeleting] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  const reload = useCallback(
    () =>
      fetch('/api/trackers/projects')
        .then((response) => {
          if (!response.ok) throw new Error(`Трекеры проектов не загрузились: HTTP ${response.status}`)
          return response.json() as Promise<ProjectTrackerRow[]>
        })
        .then((rows) => setLoad({ kind: 'loaded', rows }))
        .catch((e: unknown) =>
          setLoad((prev) =>
            // Перечитать после записи не вышло — строки остаются прежними, а сбой скажет следующее чтение.
            prev.kind === 'loaded'
              ? prev
              : { kind: 'failed', message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message) },
          ),
        ),
    [],
  )

  useEffect(() => {
    void reload()
  }, [reload])

  // Переход из «Бэклога»: выбран проект, чьё описание сломано (раздел для него встаёт заново), и список с подробностями
  // встаёт на экран, когда прочитан.
  const loaded = load.kind === 'loaded'
  useEffect(() => {
    if (focus !== null && loaded) panel.current?.scrollIntoView?.({ block: 'start' })
  }, [focus, loaded])

  const rows = load.kind === 'loaded' ? load.rows : []
  // Выбранного нет или он ушёл из списка баз — выбран первый проект.
  const current = rows.find((row) => row.base === selected) ?? rows[0] ?? null
  const opened = open === null ? null : (rows.find((row) => row.base === open.base) ?? null)
  const deleted = deleting === null ? null : (rows.find((row) => row.base === deleting) ?? null)

  return (
    <>
      {load.kind === 'loading' && (
        <Skeleton label="Загрузка трекеров проектов" shown={reveal.shown}>
          <div className="tp sk-frame">
            <div className="tp-list">
              {[0, 1, 2].map((i) => (
                <div key={i} className="tp-item">
                  <Sk w={22} h={22} style={{ borderRadius: 6 }} />
                  {/* Строка списка — одно имя, без второй строки: заготовка той же формы (decisions/loading.md) */}
                  <Sk w="60%" h={10} />
                </div>
              ))}
            </div>
            <div className="tp-detail">
              <Sk w="30%" h={14} />
            </div>
          </div>
        </Skeleton>
      )}
      {load.kind === 'failed' && (
        <p className="bases-error tp-error" role="alert">
          {load.message}
        </p>
      )}
      {load.kind === 'loaded' && rows.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}
      {load.kind === 'loaded' && current && (
        <div ref={panel} className={withReveal('tp', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
          <nav className="tp-list" aria-label="Трекеры проектов">
            <div className="tp-group">Проекты</div>
            {rows.map((row) => (
              <ProjectItem key={row.base} row={row} active={row === current} onPick={() => setSelected(row.base)} />
            ))}
          </nav>
          <section className="tp-detail" aria-label={`Трекер проекта ${current.project}`}>
            <ProjectDetail
              row={current}
              servers={servers}
              onEdit={() => setOpen({ base: current.base, talking: false })}
              onDelete={() => setDeleting(current.base)}
            />
          </section>
        </div>
      )}
      {opened && (
        <TrackerModal
          key={opened.base}
          row={opened}
          keyOwner={keyOwner(opened, servers)}
          sharedWith={sharedWith(opened, rows)}
          focusField={open?.field ?? null}
          talking={open?.talking}
          onSaved={() => {
            void reload()
            onChanged?.()
          }}
          onClose={() => setOpen(null)}
        />
      )}
      {deleted && (
        <DeleteProjectTrackerModal
          row={deleted}
          onClose={() => setDeleting(null)}
          // О ключе окно говорит, только когда он сохранён и других проектов на его сервере нет (ревью B-285)
          keyLeaves={keyOwner(deleted, servers) !== null && sharedWith(deleted, rows).length === 0}
          onRemoved={() => {
            setDeleting(null)
            void reload()
            onChanged?.()
          }}
          onChanged={reload}
        />
      )}
    </>
  )
}

/** Вид трекера, как его показывает раздел: имя из таблицы кита, иначе как записано. */
function trackerName(row: ProjectTrackerRow): string | null {
  return knownTracker(row.description?.tracker) ?? row.tracker?.name ?? row.description?.tracker?.trim() ?? null
}

/** Что в описании не так — те же слова, что строкой под проектом в прежней карточке (B-293). */
function faultOf(row: ProjectTrackerRow): string | null {
  const tracker = row.tracker
  if (row.problem !== null) return row.problem
  if (row.newerFormat || tracker === null) return null
  if (tracker.kind === 'unreadable') return 'Описание трекера не прочитано: нет доступа к файлу tracker.md.'
  if (tracker.kind === 'no-keys') return faultsText(tracker.faults)
  return kitFaultsText(row.faults)
}

/** Адрес для сравнения — тем же правилом, что сервер панели (TrackerServersStore.Normalize): схема и хост без регистра
 *  и без порта по умолчанию, без «/» в конце (ревью B-323). */
function serverKey(server: string): string {
  const trimmed = server.trim().replace(/\/+$/, '')
  try {
    const url = new URL(trimmed)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`.toLowerCase()
  } catch {
    return trimmed.toLowerCase()
  }
}

const sameServer = (a: string, b: string) => serverKey(a) === serverKey(b)

/** Трекер, к серверу которого нужен ключ из панели: YouTrack и Jira; у GitHub вход — у программы gh. */
function needsKey(tracker: TrackerInfo | null | undefined): boolean {
  return tracker?.kind === 'youtrack' || tracker?.kind === 'jira'
}

/** Сохранённый ключ к серверу трекера проекта; нет его или трекеру ключ не нужен — null. */
function keyOwner(row: ProjectTrackerRow, servers: TrackerServer[] | null): TrackerServer | null {
  const tracker = row.tracker
  if (!needsKey(tracker) || !tracker?.server || servers === null) return null
  return servers.find((one) => sameServer(one.server, tracker.server!)) ?? null
}

/** Другие проекты на том же сервере — их читает тот же ключ: он хранится по адресу сервера (B-285). */
function sharedWith(row: ProjectTrackerRow, rows: ProjectTrackerRow[]): string[] {
  const server = row.tracker?.server
  if (!needsKey(row.tracker) || !server) return []
  return rows
    .filter((other) => other.base !== row.base && needsKey(other.tracker) && sameServer(other.tracker!.server ?? '', server))
    .map((other) => other.project)
}

/**
 * Ключ, которым панель читает задачи: у GitHub — вход программы gh, у YouTrack и Jira — ключ, введённый в окне трекера.
 * Ключа нет — красная строка; вводится он кнопкой «Изменить» (ответ оператора на B-285), своей кнопки у строки нет.
 */
function keyOf(row: ProjectTrackerRow, servers: TrackerServer[] | null): ReactNode {
  const tracker = row.tracker
  if (tracker?.kind === 'github') return <span className="tp-pill">вход через gh</span>
  if (!needsKey(tracker) || servers === null) return null
  const entry = keyOwner(row, servers)
  return entry ? (
    <span className="tp-pill">
      <KeyIcon />
      ключ пользователя <span className="mono">{entry.login}</span>
    </span>
  ) : (
    <span className="tp-pill bad">
      <KeyIcon />
      нет ключа к этому серверу
    </span>
  )
}

// Строка списка — метка трекера и имя проекта, без второй строки: остальное — в подробностях справа (приёмка B-323).
function ProjectItem({ row, active, onPick }: { row: ProjectTrackerRow; active: boolean; onPick: () => void }) {
  const name = trackerName(row)
  const tracker = row.tracker
  const broken = faultOf(row) !== null || row.newerFormat
  return (
    <button
      type="button"
      className={`tp-item ${active ? 'active' : ''}`}
      aria-current={active ? 'true' : undefined}
      title={row.base}
      onClick={onPick}
    >
      <TrackerMark name={tracker === null || row.problem !== null ? null : name} />
      <span className="tp-item-name">{row.project}</span>
      {broken ? <span className="tp-dot" role="img" aria-label="есть поломка" /> : <span />}
    </button>
  )
}

type DetailProps = {
  row: ProjectTrackerRow
  servers: TrackerServer[] | null
  onEdit: () => void
  onDelete: () => void
}

function ProjectDetail({ row, servers, onEdit, onDelete }: DetailProps) {
  const tracker = row.tracker
  const description = row.description
  const unreadable = tracker?.kind === 'unreadable'
  const closed = row.newerFormat || row.problem !== null
  const name = trackerName(row)
  const server = tracker?.server ?? description?.server.trim() ?? ''
  const project = tracker?.project ?? description?.project.trim() ?? ''
  const busy = row.busy.length > 0 ? busyText(row.busy) : null
  const refusal = row.newerFormat ? 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.' : undefined
  const fault = faultOf(row)
  const key = tracker === null ? null : keyOf(row, servers)
  const shown = tracker !== null && row.problem === null && !unreadable

  // Проект без трекера — как пустой проект во «Флоу», без градиента на фоне (приёмка B-323).
  if (tracker === null && row.problem === null)
    return (
      <div className="empty-state tp-empty">
        <span className="empty-state-mark" aria-hidden="true">
          <TicketIcon />
        </span>
        <h3>В этом проекте нет трекера</h3>
        <p>
          Трекер — место, где команда ведёт задачи проекта: GitHub, GitLab, Jira или YouTrack. Пока его нет, задачи
          проекта живут только в бэклоге.
        </p>
        {row.newerFormat && (
          <p className="tp-notice fmt">
            <WarningIcon />
            <span>{refusal}</span>
          </p>
        )}
        <button
          type="button"
          className="bases-btn bases-btn-primary"
          aria-label={`Завести трекер ${row.project}`}
          disabled={closed}
          title={refusal}
          onClick={onEdit}
        >
          <PlusIcon />
          Завести трекер
        </button>
      </div>
    )

  return (
    <>
      <div className="tp-head">
        <TrackerMark name={shown ? name : null} large />
        <div className="tp-who">
          <h3 title={row.base}>{row.project}</h3>
          <span>{tracker === null || row.problem !== null ? 'Проект из списка баз' : name ? `Трекер ${name}` : 'Трекер'}</span>
        </div>
        <span className="tp-acts">
          {tracker === null ? null : (
            <>
              <button
                type="button"
                className="bases-btn"
                aria-label={`Изменить трекер ${row.project}`}
                disabled={closed || unreadable}
                title={refusal}
                onClick={onEdit}
              >
                Изменить
              </button>
              <button
                type="button"
                className="bases-btn bases-btn-danger"
                aria-label={`Удалить трекер ${row.project}`}
                disabled={closed || unreadable || busy !== null}
                title={refusal ?? busy ?? undefined}
                onClick={onDelete}
              >
                <TrashIcon />
                Удалить
              </button>
            </>
          )}
        </span>
      </div>
      {fault && (
        <p className="tp-notice" role="alert">
          <WarningIcon />
          <span>{fault}</span>
        </p>
      )}
      {row.newerFormat && (
        <p className="tp-notice fmt">
          <WarningIcon />
          <span>{refusal}</span>
        </p>
      )}
      {shown ? (
        <dl className="tp-dl">
          <dt>Вид трекера</dt>
          {name ? <dd className="plain">{name}</dd> : <dd className="none">—</dd>}
          <dt>Адрес сервера</dt>
          {server ? <dd>{server}</dd> : <dd className="none">—</dd>}
          <dt>Проект</dt>
          {project ? <dd>{project}</dd> : <dd className="none">—</dd>}
          {key && (
            <>
              <dt>Ключ к серверу</dt>
              <dd className="plain">{key}</dd>
            </>
          )}
        </dl>
      ) : null}
    </>
  )
}

/**
 * Метка трекера квадратом, как у исполнителей: у каждого трекера из таблицы кита свой цвет, которого в панели больше
 * нигде нет (ответ оператора на B-285), трекер не из таблицы — нейтральный, без трекера — пунктир.
 */
function TrackerMark({ name, large = false }: { name: string | null; large?: boolean }) {
  const marks: Record<string, string> = { GitHub: 'gh', GitLab: 'gl', Jira: 'ji', YouTrack: 'yt' }
  const kind = name === null ? 'none' : (marks[name] ?? 'other')
  const text = name === null ? '' : (marks[name]?.toUpperCase() ?? '')
  return (
    <span className={`tp-mark ${kind} ${large ? 'lg' : ''}`} aria-hidden="true">
      {text}
    </span>
  )
}

export function TicketIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v3a2 2 0 0 0 0 4v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 0 0-4z" />
      <path d="M14 5v2M14 11v2M14 17v2" />
    </svg>
  )
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2M16 7l3 3M19 4l2 2" />
    </svg>
  )
}

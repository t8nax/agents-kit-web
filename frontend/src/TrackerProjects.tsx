import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import DeleteProjectTrackerModal from './DeleteProjectTrackerModal'
import { TrashIcon } from './DeleteWorkspaceModal'
import { WarningIcon } from './Problems'
import { Sk, Skeleton } from './Skeleton'
import TrackerRewriteModal from './TrackerRewriteModal'
import type { TrackerServer } from './TrackerServersCard'
import { busyText, faultsText, kitFaultsText, knownTracker, type ProjectTrackerRow } from './projectTracker'
import { useReveal, withReveal } from './reveal'
import type { TrackerInfo } from './tracker'
import './TrackerProjects.css'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; rows: ProjectTrackerRow[] }

type Props = {
  /** Окно трекера этой базы открывается само — возврат к просьбе из шапки панели. */
  rewriteFor?: { base: string; at: number } | null
  /** Выбрать проект этой базы — переход из строки «Бэклога» о поломке описания трекера. */
  focus?: { base: string; at: number } | null
  /** Серверы трекеров с владельцами ключей; null — список ещё не прочитан или не прочитался. */
  servers?: TrackerServer[] | null
}

/**
 * Трекеры проектов раздела «Трекеры» (B-323, макет в памяти задачи): слева все проекты из списка баз, справа
 * трекер выбранного — вид, сервер, проект, фильтр, ключ к серверу и поломки описания. Описание заводится,
 * правится и удаляется отсюда, а не словами киту в сессии (B-293).
 */
export default function TrackerProjects({ rewriteFor = null, focus = null, servers = null }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reveal = useReveal(load.kind === 'loading')
  const [selected, setSelected] = useState<string | null>(rewriteFor?.base ?? focus?.base ?? null)
  const [open, setOpen] = useState<string | null>(rewriteFor?.base ?? null)
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

  // Переход из «Бэклога»: выбран проект, чьё описание сломано, и список с подробностями встаёт на экран, когда прочитан.
  const loaded = load.kind === 'loaded'
  useEffect(() => {
    if (focus === null) return
    setSelected(focus.base)
    if (loaded) panel.current?.scrollIntoView?.({ block: 'start' })
  }, [focus, loaded])

  const rows = load.kind === 'loaded' ? load.rows : []
  // Выбранного нет или он ушёл из списка баз — выбран первый проект.
  const current = rows.find((row) => row.base === selected) ?? rows[0] ?? null
  const opened = open === null ? null : (rows.find((row) => row.base === open) ?? null)
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
                  <span style={{ display: 'grid', gap: 6 }}>
                    <Sk w="60%" h={10} />
                    <Sk w="40%" h={8} />
                  </span>
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
              onEdit={() => setOpen(current.base)}
              onDelete={() => setDeleting(current.base)}
            />
          </section>
        </div>
      )}
      {opened && <TrackerRewriteModal key={opened.base} row={opened} onSaved={reload} onClose={() => setOpen(null)} />}
      {deleted && (
        <DeleteProjectTrackerModal
          row={deleted}
          onClose={() => setDeleting(null)}
          onRemoved={() => {
            setDeleting(null)
            void reload()
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

const sameServer = (a: string, b: string) =>
  a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase()

/** Ключ, которым панель читает задачи: у GitHub — вход программы gh, у YouTrack — ключ из «Серверов трекеров». */
function keyOf(tracker: TrackerInfo, servers: TrackerServer[] | null): ReactNode {
  if (tracker.kind === 'github') return <span className="tp-pill">вход через gh</span>
  if (tracker.kind !== 'youtrack' || servers === null) return null
  const entry = servers.find((one) => sameServer(one.server, tracker.server ?? ''))
  return entry ? (
    <span className="tp-pill">
      <KeyIcon />
      ключ пользователя <span className="mono">{entry.login}</span>
    </span>
  ) : (
    <span className="tp-pill bad">
      <KeyIcon />
      нет ключа — добавьте сервер в «Серверах трекеров»
    </span>
  )
}

function ProjectItem({ row, active, onPick }: { row: ProjectTrackerRow; active: boolean; onPick: () => void }) {
  const name = trackerName(row)
  const tracker = row.tracker
  const project = tracker?.project ?? row.description?.project.trim() ?? ''
  const sub =
    row.problem !== null
      ? 'База не читается'
      : tracker === null
        ? 'Трекера нет'
        : tracker.kind === 'unreadable'
          ? 'Описание не прочитано'
          : [name, project].filter(Boolean).join(' · ') || '—'
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
      <span className="tp-item-text">
        <span className="tp-item-name">{row.project}</span>
        <span className="tp-item-sub">{sub}</span>
      </span>
      {broken ? <span className="tp-dot" role="img" aria-label="есть поломка" /> : <span />}
    </button>
  )
}

type DetailProps = { row: ProjectTrackerRow; servers: TrackerServer[] | null; onEdit: () => void; onDelete: () => void }

function ProjectDetail({ row, servers, onEdit, onDelete }: DetailProps) {
  const tracker = row.tracker
  const description = row.description
  const unreadable = tracker?.kind === 'unreadable'
  const closed = row.newerFormat || row.problem !== null
  const name = trackerName(row)
  const server = tracker?.server ?? description?.server.trim() ?? ''
  const project = tracker?.project ?? description?.project.trim() ?? ''
  const filter = tracker?.filter ?? description?.filter?.trim() ?? ''
  const filtered = tracker?.kind === 'github' || tracker?.kind === 'youtrack'
  const busy = row.busy.length > 0 ? busyText(row.busy) : null
  const refusal = row.newerFormat ? 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.' : undefined
  const fault = faultOf(row)
  const key = tracker === null ? null : keyOf(tracker, servers)
  const shown = tracker !== null && row.problem === null && !unreadable

  return (
    <>
      <div className="tp-head">
        <TrackerMark name={shown ? name : null} large />
        <div className="tp-who">
          <h3 title={row.base}>{row.project}</h3>
          <span>{tracker === null || row.problem !== null ? 'Проект из списка баз' : name ? `Трекер ${name}` : 'Трекер'}</span>
        </div>
        <span className="tp-acts">
          {tracker === null ? (
            <button
              type="button"
              className="bases-btn bases-btn-add"
              aria-label={`Завести трекер ${row.project}`}
              disabled={closed}
              title={refusal}
              onClick={onEdit}
            >
              Завести
            </button>
          ) : (
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
          {filtered && (
            <>
              <dt>Фильтр</dt>
              {filter ? <dd>{filter}</dd> : <dd className="none">нет, берутся все задачи проекта</dd>}
            </>
          )}
          {key && (
            <>
              <dt>Ключ к серверу</dt>
              <dd className="plain">{key}</dd>
            </>
          )}
        </dl>
      ) : (
        tracker === null &&
        row.problem === null && (
          <div className="tp-empty">
            <p>У проекта нет трекера, его задачи живут только в бэклоге.</p>
          </div>
        )
      )}
    </>
  )
}

/** Метка трекера квадратом, как у исполнителей: YouTrack — синяя, GitHub — нейтральная, без трекера — пунктир. */
function TrackerMark({ name, large = false }: { name: string | null; large?: boolean }) {
  const kind = name === 'YouTrack' ? 'yt' : name === 'GitHub' ? 'gh' : name === null ? 'none' : 'other'
  const text = name === 'YouTrack' ? 'YT' : name === 'GitHub' ? 'GH' : name === 'Jira' ? 'JI' : name === 'GitLab' ? 'GL' : ''
  return (
    <span className={`tp-mark ${kind} ${large ? 'lg' : ''}`} aria-hidden="true">
      {text}
    </span>
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

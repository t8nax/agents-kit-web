import { useCallback, useEffect, useRef, useState } from 'react'
import DeleteProjectTrackerModal from './DeleteProjectTrackerModal'
import { TrashIcon } from './DeleteWorkspaceModal'
import { WarningIcon } from './Problems'
import { Sk, Skeleton } from './Skeleton'
import TrackerRewriteModal from './TrackerRewriteModal'
import { busyText, faultsText, knownTracker, type ProjectTrackerRow } from './projectTracker'
import { useReveal, withReveal } from './reveal'
import './TrackerProjectsCard.css'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; rows: ProjectTrackerRow[] }

type Props = {
  /** Окно трекера этой базы открывается само — возврат к просьбе из шапки панели. */
  rewriteFor?: { base: string; at: number } | null
  /** Карточку показать на экране — переход из строки «Бэклога» о поломке описания. */
  focusAt?: number | null
}

/**
 * Карточка «Трекеры проектов» (B-293, макет в памяти задачи): все проекты из списка баз, у каждого его трекер,
 * и описание трекера заводится, правится и удаляется из панели, а не словами киту в сессии.
 */
export default function TrackerProjectsCard({ rewriteFor = null, focusAt = null }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reveal = useReveal(load.kind === 'loading')
  const [open, setOpen] = useState<string | null>(rewriteFor?.base ?? null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const card = useRef<HTMLElement>(null)

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

  useEffect(() => {
    if (focusAt !== null) card.current?.scrollIntoView({ block: 'start' })
  }, [focusAt])

  const rows = load.kind === 'loaded' ? load.rows : []
  const opened = open === null ? null : (rows.find((row) => row.base === open) ?? null)
  const deleted = deleting === null ? null : (rows.find((row) => row.base === deleting) ?? null)

  return (
    <section ref={card} className="settings-card prj-card" aria-labelledby="settings-project-trackers">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-project-trackers">Трекеры проектов</h3>
          <p className="settings-lead">Трекер задач каждого проекта из списка баз.</p>
        </div>
      </div>
      <div className="bases-body">
        {load.kind === 'loading' && (
          <Skeleton label="Загрузка трекеров проектов" shown={reveal.shown}>
            <ul className="bases-list sk-frame">
              <li>
                <Sk w="30%" h={10} style={{ flex: 'none' }} />
                <span style={{ flex: 1 }} />
                <Sk w={180} h={26} style={{ borderRadius: 6 }} />
              </li>
            </ul>
          </Skeleton>
        )}
        {load.kind === 'failed' && (
          <p className="bases-error" role="alert">
            {load.message}
          </p>
        )}
        {load.kind === 'loaded' && (
          <ul className={withReveal('bases-list prj-list', reveal)} onAnimationEnd={reveal.onAnimationEnd} aria-label="Трекеры проектов">
            {rows.length === 0 && <li className="bases-empty">Нет отслеживаемых баз.</li>}
            {rows.map((row) => (
              <ProjectRow key={row.base} row={row} onEdit={() => setOpen(row.base)} onDelete={() => setDeleting(row.base)} />
            ))}
          </ul>
        )}
      </div>
      {opened && (
        <TrackerRewriteModal
          key={opened.base}
          row={opened}
          onSaved={reload}
          onClose={() => setOpen(null)}
        />
      )}
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
    </section>
  )
}

function ProjectRow({ row, onEdit, onDelete }: { row: ProjectTrackerRow; onEdit: () => void; onDelete: () => void }) {
  const tracker = row.tracker
  const description = row.description
  const unreadable = tracker?.kind === 'unreadable'
  const closed = row.newerFormat || row.problem !== null
  const name = knownTracker(description?.tracker) ?? tracker?.name ?? description?.tracker?.trim() ?? null
  const server = tracker?.server ?? description?.server.trim() ?? ''
  const project = tracker?.project ?? description?.project.trim() ?? ''
  const busy = row.busy.length > 0 ? busyText(row.busy) : null
  const refusal = row.newerFormat ? 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.' : undefined

  return (
    <li className={closed ? 'is-closed' : undefined}>
      <span className="prj-name" title={row.base}>
        {row.project}
      </span>
      {row.problem !== null ? (
        <span className="prj-none">База не читается</span>
      ) : tracker === null ? (
        <span className="prj-none">Трекера нет</span>
      ) : unreadable ? (
        <>
          <span className="prj-dash">—</span>
          <span className="prj-dash">—</span>
          <span className="prj-dash">—</span>
        </>
      ) : (
        <>
          {name ? <span className="prj-kind">{name}</span> : <span className="prj-dash">—</span>}
          <span className="prj-server mono" title={server || undefined}>
            {server || <span className="prj-dash">—</span>}
          </span>
          <span className="prj-project mono" title={project || undefined}>
            {project || <span className="prj-dash">—</span>}
          </span>
        </>
      )}
      <span className="prj-actions">
        {tracker === null ? (
          <button
            type="button"
            className="bases-btn bases-btn-small bases-btn-add"
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
              className="bases-btn bases-btn-small"
              aria-label={`Изменить трекер ${row.project}`}
              disabled={closed || unreadable}
              title={refusal}
              onClick={onEdit}
            >
              Изменить
            </button>
            <button
              type="button"
              className="bases-btn bases-btn-small bases-btn-danger"
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
      {row.problem !== null && (
        <p className="prj-line err">
          <WarningIcon />
          <span>{row.problem}</span>
        </p>
      )}
      {row.newerFormat && (
        <p className="prj-line fmt">
          <WarningIcon />
          <span>{refusal}</span>
        </p>
      )}
      {!row.newerFormat && unreadable && (
        <p className="prj-line err">
          <WarningIcon />
          <span>Описание трекера не прочитано: нет доступа к файлу tracker.md.</span>
        </p>
      )}
      {!row.newerFormat && tracker?.kind === 'no-keys' && (
        <p className="prj-line err">
          <WarningIcon />
          <span>{faultsText(tracker.faults)}</span>
        </p>
      )}
    </li>
  )
}

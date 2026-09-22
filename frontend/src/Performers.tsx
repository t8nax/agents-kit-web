import { useCallback, useEffect, useId, useRef, useState } from 'react'
import PerformerModal from './PerformerModal'
import './Performers.css'

/**
 * Исполнитель — субагент проекта: файл в его базе знаний. По рабочим копиям его развозит панель
 * сама, поэтому состояния копий в строке нет. path — файл базы, из которого взяты поля.
 */
export type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
  path: string
}

/** Исполнители одного проекта: directory — каталог их файлов в базе. */
export type BasePerformers = {
  base: string
  project: string
  directory: string
  performers: Performer[]
  error: string | null
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; bases: BasePerformers[] }

/**
 * Раздел «Исполнители»: субагенты проектов панели. Строка — файл базы, поэтому в списке видны и те,
 * кого завели в базе помимо панели; проекты фильтруют чипы, где рядом стоит «Все».
 * draftFor — база просьбы, к которой вернулся оператор: окно исполнителя открывается сразу на ней.
 * draftSubject — кого просьба переписывает: тогда открывается правка этого исполнителя, а не окно нового.
 */
export default function Performers({
  draftFor = null,
  draftSubject = null,
}: { draftFor?: string | null; draftSubject?: string | null } = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [project, setProject] = useState<string | null>(draftFor)
  // Окно открыто: заводится новый (performer null) или правится заведённый; base — чей он проект.
  const [editing, setEditing] = useState<{ performer: Performer | null; base: BasePerformers | undefined } | null>(null)
  // Только что записанные, именем: отмечены в списке до следующего чтения раздела.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Последний записанный: о нём раздел говорит строкой — звать его можно со следующей сессии.
  const [saved, setSaved] = useState<string | null>(null)
  // Окно просьбы открывается само один раз: оператор вернулся к ней из шапки, а не открыл раздел.
  const opened = useRef(false)

  const loadPerformers = useCallback(() => {
    fetch('/api/performers')
      .then((response) => {
        if (!response.ok) throw new Error(`Исполнители не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<BasePerformers[]>
      })
      .then(
        (bases) => {
          setLoad({ kind: 'loaded', bases })
          // База могла уйти из списка, пока раздел был открыт: тогда возвращаемся ко «Всем».
          setProject((current) => (current !== null && bases.some((b) => b.base === current) ? current : null))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [])

  // Файлы читаются при открытии раздела: по таймеру раздел не опрашивается, как и бэклог.
  useEffect(loadPerformers, [loadPerformers])

  useEffect(() => {
    if (draftFor === null || opened.current || load.kind !== 'loaded') return
    opened.current = true
    const base = load.bases.find((b) => b.base === draftFor)
    const performer = draftSubject ? (base?.performers.find((p) => p.name === draftSubject) ?? null) : null
    // Переписывали заведённого, а его уже нет: окно нового его просьбу не подхватит и встало бы пустым.
    setEditing(draftSubject && !performer ? null : { performer, base })
  }, [draftFor, draftSubject, load])

  const bases = load.kind === 'loaded' ? load.bases : []
  // Итог переписывания исполнителя, которого в проекте уже нет: окна для него нет, и об этом сказано строкой.
  const lost =
    draftSubject !== null &&
    load.kind === 'loaded' &&
    !bases.find((b) => b.base === draftFor)?.performers.some((p) => p.name === draftSubject)
      ? draftSubject
      : null
  // Выбран проект — его исполнители; выбран «Все» (project === null) — исполнители всех проектов.
  const shown = project === null ? bases : bases.filter((b) => b.base === project)
  const rows = shown.flatMap((base) => base.performers.map((performer) => ({ base, performer })))
  const errors = shown.filter((base) => base.error !== null)

  return (
    <>
      <div className="content-head">
        <h2>Исполнители</h2>
        <button
          type="button"
          className="bases-btn bases-btn-add head-end"
          disabled={bases.length === 0}
          onClick={() => setEditing({ performer: null, base: shown[0] ?? bases[0] })}
        >
          <PlusIcon />
          Новый исполнитель
        </button>
      </div>

      {load.kind === 'loading' && <p className="message text-sec">Загрузка исполнителей…</p>}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && bases.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}

      {bases.length > 1 && (
        <div className="filter-bar" role="group" aria-label="Фильтр по проектам">
          {/* Исполнитель принадлежит проекту своей базой: «Все» показывает исполнителей всех баз. */}
          <button
            type="button"
            className={`chip ${project === null ? 'active' : ''}`}
            aria-pressed={project === null}
            onClick={() => setProject(null)}
          >
            Все
          </button>
          {bases.map((base) => (
            <button
              type="button"
              key={base.base}
              className={`chip ${base.base === project ? 'active' : ''}`}
              aria-pressed={base.base === project}
              onClick={() => setProject(base.base)}
            >
              {base.project}
            </button>
          ))}
        </div>
      )}

      {lost && (
        <p className="message warning-text" role="alert">
          Исполнителя {lost} в проекте больше нет: переписанное открыть не в чем.
        </p>
      )}

      {saved && (
        <p className="message performer-saved" role="status">
          {saved} записан. Звать его можно со следующей сессии.
        </p>
      )}

      {load.kind === 'loaded' && bases.length > 0 && (
        <>
          {errors.map((base) => (
            <p className="message warning-text" key={base.base} role="alert">
              {base.project}: {base.error}
            </p>
          ))}
          {rows.length === 0 && errors.length === 0 && (
            <p className="empty-message">
              {project === null
                ? 'Исполнителей ещё нет. Заводятся кнопкой «Новый исполнитель».'
                : `У проекта «${shown[0]?.project ?? ''}» исполнителей нет. Заводятся кнопкой «Новый исполнитель».`}
            </p>
          )}
          {rows.length > 0 && (
            <div className="performer-grid">
              {rows.map(({ base, performer }) => (
                <PerformerCard
                  key={`${base.base}|${performer.name}`}
                  performer={performer}
                  project={base.project}
                  fresh={fresh.has(performer.name)}
                  onEdit={() => setEditing({ performer, base })}
                />
              ))}
            </div>
          )}
        </>
      )}

      {editing && editing.base && (
        <PerformerModal
          bases={bases}
          initial={editing.base.base}
          editing={editing.performer}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null)
            setFresh((prev) => new Set([...prev, name]))
            setSaved(name)
            loadPerformers()
          }}
        />
      )}
    </>
  )
}

/**
 * Карточка исполнителя: имя, проект, описание в две строки и модель — остальное живёт в окне,
 * которое открывает клик по карточке (B-80: в прежней строке было слишком много всего).
 */
function PerformerCard({
  performer,
  project,
  fresh,
  onEdit,
}: {
  performer: Performer
  project: string
  fresh: boolean
  onEdit: () => void
}) {
  // Имя кнопки — исполнитель и проект, а описание, модель и пометка читаются её описанием.
  const details = useId()
  return (
    <button
      type="button"
      className={`performer-card ${fresh ? 'performer-fresh' : ''}`}
      aria-label={`${performer.name}, ${project}`}
      aria-describedby={details}
      onClick={onEdit}
    >
      <span className="performer-top">
        <span className="performer-mark" aria-hidden="true">
          <PerformerIcon />
        </span>
        <span className="performer-name">{performer.name}</span>
        {/* Проект у карточки — та база, в которой лежит файл исполнителя. */}
        <span className="performer-source">{project}</span>
      </span>
      <span id={details} className="performer-details">
        {performer.description && <span className="performer-desc">{performer.description}</span>}
        <span className="performer-foot">
          {performer.model && <span className="performer-badge">{performer.model}</span>}
          {fresh && <span className="performer-fresh-mark">записан</span>}
        </span>
      </span>
    </button>
  )
}

/** Значок исполнителя — тот же бот, что стоит у раздела в сайдбаре. */
export function PerformerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="8" width="16" height="11" rx="3.5" />
      <path d="M12 4.6V8" />
      <circle cx="12" cy="3.4" r="1.2" />
      <path d="M9.2 13h.01" />
      <path d="M14.8 13h.01" />
      <path d="M2 12.5v2.5" />
      <path d="M22 12.5v2.5" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

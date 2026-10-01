import { useCallback, useEffect, useId, useRef, useState } from 'react'
import PerformerModal, { Select } from './PerformerModal'
import { FormatNotice, NEWER_FORMAT_REFUSAL } from './NewerFormat'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'
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
  /**
   * Этапы, которые зовут его исполнителем или помощником: этапы флоу — названием, этапы копий сценария идущих задач —
   * названием и номером задачи, «Ревью (B-7)». Пока они есть, удалить его нельзя (B-83, B-299).
   */
  calledBy?: string[] | null
}

/** Исполнители одного проекта: directory — каталог их файлов в базе. */
export type BasePerformers = {
  base: string
  project: string
  directory: string
  performers: Performer[]
  error: string | null
  /** База нового формата кита: исполнители видны, но не правятся и не заводятся (B-281). */
  formatWarning?: string | null
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; bases: BasePerformers[] }

/**
 * Раздел «Исполнители»: субагенты проектов панели. Карточка — файл базы, поэтому в сетке видны и те,
 * кого завели в базе помимо панели; проект выбирается выпадающим списком, где первым стоит «Все».
 * draftFor — база переписки, к которой вернулся оператор: окно исполнителя открывается сразу на ней, а переписка
 * с Чудо-Юдо — поверх него. draftSubject — кого переписка переписывает: тогда открывается правка этого исполнителя,
 * а не окно нового.
 */
export default function Performers({
  draftFor = null,
  draftSubject = null,
}: { draftFor?: string | null; draftSubject?: string | null } = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reveal = useReveal(load.kind === 'loading')
  const [project, setProject] = useState<string | null>(draftFor)
  // Окно открыто: заводится новый (performer null) или правится заведённый; base — чей он проект.
  // talking — окно открыто из шапки, и переписка встаёт поверх сразу.
  const [editing, setEditing] = useState<{
    performer: Performer | null
    base: BasePerformers | undefined
    talking?: boolean
  } | null>(null)
  // Только что записанные, именем: отмечены в списке до следующего чтения раздела.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Последний записанный: о нём раздел говорит строкой — звать его можно со следующей сессии.
  const [saved, setSaved] = useState<string | null>(null)
  // Окно переписки открывается само один раз: оператор вернулся к ней из шапки, а не открыл раздел.
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
    setEditing(draftSubject && !performer ? null : { performer, base, talking: true })
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
  // База нового формата: плашка — когда выбрана она (или она одна), а новый исполнитель заводится только в базу,
  // которую панель знает (B-281).
  const warned = project !== null || bases.length === 1 ? shown.filter((base) => base.formatWarning) : []
  const target = shown.find((base) => !base.formatWarning)

  return (
    <>
      <div className="content-head">
        <h2>Исполнители</h2>
      </div>

      {load.kind === 'loading' && <PerformersSkeleton shown={reveal.shown} />}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && bases.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}

      {bases.length > 1 && (
        <div className={withReveal('filter-bar performer-filter', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
          {/* Проект выбирается выпадающим списком, как в окне исполнителя, — замечание оператора на приёмке B-80.
              Исполнитель принадлежит проекту своей базой: «Все» показывает исполнителей всех баз. */}
          <label className="performer-filter-label" htmlFor="performer-project">
            Проект
          </label>
          <Select id="performer-project" value={project ?? ''} onChange={(value) => setProject(value || null)} wide>
            <option value="">Все</option>
            {bases.map((base) => (
              <option key={base.base} value={base.base}>
                {base.project}
              </option>
            ))}
          </Select>
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
        <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
          {errors.map((base) => (
            <p className="message warning-text" key={base.base} role="alert">
              {base.project}: {base.error}
            </p>
          ))}
          {warned.map((base) => (
            <FormatNotice key={base.base} text={base.formatWarning!} />
          ))}
          {/* Новый исполнитель заводится пунктирной карточкой последней в сетке, как «Новая стадия» во «Флоу» (B-198).
              У проекта без исполнителей она стоит в сетке одна: строки о пустом списке нет. */}
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
            <button
              type="button"
              className="performer-card performer-card-add"
              disabled={!target}
              title={target ? undefined : NEWER_FORMAT_REFUSAL}
              onClick={() => setEditing({ performer: null, base: target })}
            >
              <PlusIcon />
              Новый исполнитель
            </button>
          </div>
        </div>
      )}

      {editing && editing.base && (
        <PerformerModal
          bases={bases}
          initial={editing.base.base}
          editing={editing.performer}
          talking={editing.talking}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null)
            setFresh((prev) => new Set([...prev, name]))
            setSaved(name)
            loadPerformers()
          }}
          onDeleted={(name) => {
            setEditing(null)
            // Строка «записан» про удалённого больше не верна.
            setSaved((current) => (current === name ? null : current))
            loadPerformers()
          }}
        />
      )}
    </>
  )
}

/** Исполнители, пока они читаются в первый раз: выбор проекта и сетка карточек полосами (макет B-201). */
function PerformersSkeleton({ shown }: { shown: boolean }) {
  const card = (name: number, source: number, last: string) => (
    <div className="performer-card sk-frame">
      <span className="performer-top">
        <Sk w={26} h={26} style={{ borderRadius: 7 }} />
        <span style={{ flex: 1 }}>
          <Sk w={name} h={12} />
        </span>
        <Sk w={source} h={18} className="sk-pill" />
      </span>
      <span className="performer-details">
        <span style={{ display: 'grid', gap: 7 }}>
          <Sk w="100%" h={9} className="sk-block" />
          <Sk w="92%" h={9} className="sk-block" />
          <Sk w={last} h={9} className="sk-block" />
        </span>
        <span className="performer-foot">
          <Sk w={58} h={18} className="sk-pill" />
        </span>
      </span>
    </div>
  )
  return (
    <Skeleton label="Загрузка исполнителей" shown={shown}>
      <div className="filter-bar performer-filter">
        <Sk w={52} h={11} />
        <Sk w={200} h={30} style={{ borderRadius: 6 }} />
      </div>
      <div className="performer-grid">
        {card(90, 96, '64%')}
        {card(74, 96, '48%')}
        {card(84, 96, '70%')}
        {card(100, 72, '56%')}
        {card(70, 72, '40%')}
        {card(96, 96, '62%')}
      </div>
    </Skeleton>
  )
}

/**
 * Карточка исполнителя: имя, проект, описание в три строки и модель — остальное живёт в окне,
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

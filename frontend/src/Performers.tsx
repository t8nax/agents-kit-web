import { useCallback, useEffect, useState } from 'react'
import './Performers.css'

/** Исполнитель — субагент Claude Code. source: copy — лежит в копии проекта, profile — в профиле оператора. */
export type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  path: string
  source: 'copy' | 'profile'
  copy: string | null
}

export type PerformerCopy = {
  path: string
  name: string
  branch: string | null
  main: boolean
}

export type BasePerformers = {
  base: string
  project: string
  copies: PerformerCopy[]
  performers: Performer[]
  error: string | null
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; bases: BasePerformers[] }

/**
 * Раздел «Исполнители»: субагенты проекта и профиля. Проект выбирается чипами, как в бэклоге и флоу,
 * а списка «все проекты» нет — заводят исполнителя всегда в копию одного проекта.
 */
export default function Performers() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [project, setProject] = useState<string | null>(null)

  const loadPerformers = useCallback(() => {
    fetch('/api/performers')
      .then((response) => {
        if (!response.ok) throw new Error(`Исполнители не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<BasePerformers[]>
      })
      .then(
        (bases) => {
          setLoad({ kind: 'loaded', bases })
          // База могла уйти из списка, пока раздел был открыт: тогда встаём на первый проект.
          setProject((current) => (bases.some((b) => b.base === current) ? current : (bases[0]?.base ?? null)))
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

  const bases = load.kind === 'loaded' ? load.bases : []
  const shown = bases.find((b) => b.base === project) ?? null

  return (
    <>
      <div className="content-head">
        <h2>Исполнители</h2>
        <button type="button" className="bases-btn bases-btn-add head-end" disabled={shown === null}>
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

      {shown && (
        <div className="performer-list">
          {shown.error && (
            <p className="message warning-text" role="alert">
              {shown.error}
            </p>
          )}
          {!shown.error && shown.performers.length === 0 && (
            <p className="empty-message">
              У проекта «{shown.project}» исполнителей нет. Заводятся кнопкой «Новый исполнитель».
            </p>
          )}
          {shown.performers.map((performer) => (
            <PerformerRow key={`${performer.source}|${performer.path}`} performer={performer} />
          ))}
        </div>
      )}
    </>
  )
}

function PerformerRow({ performer }: { performer: Performer }) {
  const fromProfile = performer.source === 'profile'
  return (
    <div className={`performer ${fromProfile ? 'performer-profile' : ''}`}>
      <span className="performer-mark" aria-hidden="true">
        <PerformerIcon />
      </span>
      <div className="performer-body">
        <div className="performer-title">
          <span className="performer-name">{performer.name}</span>
          <span className={`performer-source ${fromProfile ? '' : 'performer-source-copy'}`}>
            {fromProfile ? 'из профиля' : 'в проекте'}
          </span>
        </div>
        {performer.description && <p className="performer-desc">{performer.description}</p>}
        <span className="performer-path">{performer.path}</span>
      </div>
      <div className="performer-end">
        {performer.model && <span className="performer-badge">{performer.model}</span>}
        <span className="performer-badge">{performer.tools ?? 'все инструменты'}</span>
        {/* Панель правит только то, что лежит в копии проекта: профиль она показывает и не трогает. */}
        <button type="button" className="bases-btn" disabled={fromProfile}>
          Править
        </button>
      </div>
    </div>
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

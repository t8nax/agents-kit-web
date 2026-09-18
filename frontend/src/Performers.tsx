import { useCallback, useEffect, useRef, useState } from 'react'
import PerformerModal from './PerformerModal'
import PerformerSyncModal, { type RiskyCopy, type SyncOutcome, type SyncStage } from './PerformerSyncModal'
import './Performers.css'

/**
 * Исполнитель — субагент Claude Code, схлопнутый по имени: один файл в нескольких копиях — одна строка.
 * source: copy — лежит в копиях проекта, profile — в профиле оператора.
 * copy и path — откуда взяты поля; in — копии, где файл есть, differs — из них те, где он другой.
 * everywhere — есть во всех копиях и всюду одинаков: только таким шаг флоу даёт поручить работу.
 */
export type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
  path: string
  source: 'copy' | 'profile'
  copy: string | null
  in: string[]
  differs: string[]
  everywhere: boolean
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
 * draftFor — база просьбы, к которой вернулся оператор: окно исполнителя открывается сразу на ней.
 */
export default function Performers({ draftFor = null }: { draftFor?: string | null } = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [project, setProject] = useState<string | null>(draftFor)
  // Окно открыто: заводится новый (performer null) или правится заведённый.
  const [editing, setEditing] = useState<{ performer: Performer | null } | null>(
    draftFor === null ? null : { performer: null },
  )
  // Только что записанные, именем: отмечены в списке до следующего чтения раздела.
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Исполнитель, которого разносят по копиям, и чем занято его окно.
  const [syncing, setSyncing] = useState<{ performer: Performer; stage: SyncStage } | null>(null)
  // Хоть одна копия записана: закрывая окно, раздел перечитывается.
  const synced = useRef(false)

  /**
   * Синхронизация исполнителя: первый запрос уходит без подтверждения — рискованных копий может
   * не быть, и тогда спрашивать не о чем. Панель называет их и ждёт слова оператора — B-77.
   */
  const sync = useCallback(async (performer: Performer, base: string, confirmed: boolean) => {
    setSyncing({ performer, stage: { kind: 'running' } })
    const stage = await request(base, performer.name, confirmed)
    if (stage.kind === 'done' && stage.outcomes.some((outcome) => outcome.done)) synced.current = true
    setSyncing({ performer, stage })
  }, [])

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
        <button
          type="button"
          className="bases-btn bases-btn-add head-end"
          disabled={shown === null || shown.copies.length === 0}
          onClick={() => setEditing({ performer: null })}
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
            <PerformerRow
              key={`${performer.source}|${performer.name}`}
              performer={performer}
              copies={shown.copies}
              fresh={fresh.has(performer.name)}
              syncing={syncing?.performer.name === performer.name}
              onEdit={() => setEditing({ performer })}
              onSync={() => void sync(performer, shown.base, false)}
            />
          ))}
        </div>
      )}

      {editing && shown && (
        <PerformerModal
          base={shown.base}
          copies={shown.copies}
          editing={editing.performer}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null)
            setFresh((prev) => new Set([...prev, name]))
            loadPerformers()
          }}
        />
      )}

      {syncing && shown && (
        <PerformerSyncModal
          performer={syncing.performer}
          stage={syncing.stage}
          onConfirm={() => void sync(syncing.performer, shown.base, true)}
          onClose={() => {
            setSyncing(null)
            // Где записалось, там исполнитель теперь есть: строка про копии должна это показать.
            if (synced.current) loadPerformers()
            synced.current = false
          }}
        />
      )}
    </>
  )
}

function PerformerRow({
  performer,
  copies,
  fresh,
  syncing,
  onEdit,
  onSync,
}: {
  performer: Performer
  copies: PerformerCopy[]
  fresh: boolean
  syncing: boolean
  onEdit: () => void
  onSync: () => void
}) {
  const fromProfile = performer.source === 'profile'
  // Пока исполнитель лежит не во всех копиях или где-то отличается, пользоваться им нельзя.
  const spread = !fromProfile && !performer.everywhere
  return (
    <div
      className={`performer ${fromProfile ? 'performer-profile' : ''} ${fresh ? 'performer-fresh' : ''} ${
        spread ? 'performer-partial' : ''
      }`}
    >
      <span className="performer-mark" aria-hidden="true">
        <PerformerIcon />
      </span>
      <div className="performer-body">
        <div className="performer-title">
          <span className="performer-name">{performer.name}</span>
          <span className={`performer-source ${fromProfile ? '' : 'performer-source-copy'}`}>
            {fromProfile ? 'из профиля' : 'в проекте'}
          </span>
          {spread && (
            <span className="performer-partial-mark">
              в {performer.in.length} копиях из {copies.length} — пользоваться нельзя
            </span>
          )}
          {fresh && <span className="performer-fresh-mark">записан</span>}
        </div>
        {performer.description && <p className="performer-desc">{performer.description}</p>}
        <span className="performer-path">{performer.path}</span>
        {!fromProfile && <CopyChips performer={performer} copies={copies} />}
      </div>
      <div className="performer-end">
        {performer.model && <span className="performer-badge">{performer.model}</span>}
        <span className="performer-badge">{performer.tools ?? 'все инструменты'}</span>
        {/* Разнос по копиям — своё действие оператора: коммит в чужую ветку не побочный шаг заведения. */}
        {spread && (
          <button type="button" className="bases-btn bases-btn-warn" disabled={syncing} onClick={onSync}>
            Синхронизировать
          </button>
        )}
        {/* Панель правит только то, что лежит в копии проекта: профиль она показывает и не трогает. */}
        <button type="button" className="bases-btn" disabled={fromProfile} onClick={onEdit}>
          Править
        </button>
      </div>
    </div>
  )
}

/** Запрос синхронизации: панель разбирает ответ в стадию окна — исход, предупреждение или отказ. */
async function request(base: string, name: string, confirmed: boolean): Promise<SyncStage> {
  try {
    const response = await fetch('/api/performers/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base, name, confirmed }),
    })
    if (response.ok) {
      const body = (await response.json()) as { copies: SyncOutcome[] }
      return { kind: 'done', outcomes: body.copies }
    }
    if (response.status === 409) {
      const body = (await response.json()) as { problem: string; risky: RiskyCopy[] }
      if (body.problem === 'needs-confirmation') return { kind: 'confirm', risky: body.risky }
      return {
        kind: 'refused',
        text:
          body.problem === 'not-in-main'
            ? 'В основной копии проекта этого исполнителя нет, а брать его из чужой ветки панель не станет. Откройте его правку и сохраните: файл ляжет в основную копию, и оттуда разойдётся по остальным.'
            : 'Основной копии проекта нет на диске — брать файл неоткуда.',
      }
    }
    return {
      kind: 'refused',
      text:
        response.status === 404
          ? 'Этой базы больше нет в списке панели.'
          : `Панель не синхронизировала исполнителя: HTTP ${response.status}.`,
    }
  } catch {
    return { kind: 'refused', text: 'Нет связи с API.' }
  }
}

/**
 * Копии проекта у строки исполнителя: где он есть, где лежит другой файл и где его нет вовсе.
 * Пока он есть не всюду, шаг флоу поручить ему работу не даёт, и по строке видно, чего не хватает.
 */
function CopyChips({ performer, copies }: { performer: Performer; copies: PerformerCopy[] }) {
  if (performer.everywhere) return null
  return (
    <div className="performer-copies">
      {copies.map((copy) => {
        const differs = performer.differs.includes(copy.path)
        const has = performer.in.includes(copy.path)
        return (
          <span
            key={copy.path}
            className={`performer-copy ${differs ? 'performer-copy-differs' : has ? 'performer-copy-has' : 'performer-copy-missing'}`}
          >
            {differs ? <WarnMark /> : has ? <CheckMark /> : null}
            {copy.name}
            {differs ? ' — файл другой' : ''}
          </span>
        )
      })}
    </div>
  )
}

function CheckMark() {
  return (
    <svg className="performer-copy-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  )
}

function WarnMark() {
  return (
    <svg className="performer-copy-mark" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </svg>
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

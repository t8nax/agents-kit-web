import { useCallback, useEffect, useState } from 'react'
import './Backlog.css'
import { InlineMarkdown, Markdown } from './Markdown'

export type BacklogEntry = {
  number: string | null
  title: string
  text: string | null
}

export type BaseBacklog = {
  base: string
  project: string
  entries: BacklogEntry[]
  error: string | null
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; backlogs: BaseBacklog[] }

// Фильтр по проектам: null — все проекты, иначе путь базы выбранного проекта.
export default function Backlog() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [filter, setFilter] = useState<string | null>(null)

  const loadBacklogs = useCallback(() => {
    fetch('/api/backlog')
      .then((response) => {
        if (!response.ok) throw new Error(`Бэклог не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseBacklog[]>
      })
      .then(
        (backlogs) => {
          setLoad({ kind: 'loaded', backlogs })
          // База могла уйти из списка, пока раздел был открыт: показываем тогда все проекты.
          setFilter((current) => (backlogs.some((b) => b.base === current) ? current : null))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [])

  // Бэклог читается при открытии раздела и кнопкой «Обновить», без опроса по таймеру.
  useEffect(loadBacklogs, [loadBacklogs])

  const refresh = useCallback(() => {
    setLoad({ kind: 'loading' })
    loadBacklogs()
  }, [loadBacklogs])

  const backlogs = load.kind === 'loaded' ? load.backlogs : []
  const shown = filter === null ? backlogs : backlogs.filter((b) => b.base === filter)

  return (
    <>
      <div className="content-head">
        <h2>Бэклог</h2>
        <button type="button" className="bases-btn head-end" onClick={refresh} disabled={load.kind === 'loading'}>
          <RefreshIcon />
          Обновить
        </button>
      </div>

      {load.kind === 'loading' && <p className="message text-sec">Загрузка бэклога…</p>}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && backlogs.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в окне «Базы знаний».</p>
      )}

      {load.kind === 'loaded' && backlogs.length > 0 && (
        <>
          {backlogs.length > 1 && (
            <div className="filter-bar" role="group" aria-label="Фильтр по проектам">
              <FilterChip label="Все проекты" active={filter === null} onClick={() => setFilter(null)} />
              {backlogs.map((backlog) => (
                <FilterChip
                  key={backlog.base}
                  label={backlog.project}
                  active={filter === backlog.base}
                  onClick={() => setFilter(backlog.base)}
                />
              ))}
            </div>
          )}

          <div className="backlog-list">
            {shown.map((backlog) => (
              <section key={backlog.base} aria-label={backlog.project}>
                <div className="base-head">
                  <h3>{backlog.project}</h3>
                </div>
                {backlog.error && (
                  <p className="backlog-note warning-text">
                    <WarningIcon />
                    {backlog.error}
                  </p>
                )}
                {!backlog.error && backlog.entries.length === 0 && (
                  <p className="backlog-note text-sec">В бэклоге этого проекта записей нет.</p>
                )}
                {backlog.entries.map((entry, index) => (
                  <article className="entry" key={entry.number ?? `${backlog.base}-${index}`}>
                    <div className="entry-head">
                      {entry.number && <span className="entry-num">{entry.number}</span>}
                      <InlineMarkdown className="entry-title" text={entry.title} />
                    </div>
                    {entry.text && <Markdown className="entry-text" text={entry.text} />}
                  </article>
                ))}
              </section>
            ))}
          </div>
        </>
      )}
    </>
  )
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

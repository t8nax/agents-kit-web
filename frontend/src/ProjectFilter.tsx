import { useEffect, useRef, useState } from 'react'
import { filterExample, type TrackerInfo } from './tracker'

/**
 * Фильтр проекта в шапке его группы на вкладке «Задачи трекера» — вариант А макета B-285: воронка раскрывает поле
 * прямо в шапке, Enter применяет, Escape — оставить как было; заданный фильтр виден плашкой с крестиком, а не принятый
 * трекером — красной плашкой. Фильтр хранит панель на этом компьютере, а не описание трекера в базе (ответ оператора).
 */
export default function ProjectFilter({
  base,
  tracker,
  rejected,
  onApplied,
}: {
  base: string
  tracker: TrackerInfo
  /** Трекер не принял фильтр: плашка красная, причина — строкой под шапкой. */
  rejected: boolean
  /** Фильтр записан — раздел перечитывает трекер этого проекта. */
  onApplied: () => void
}) {
  const filter = tracker.filter ?? ''
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(filter)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editing) input.current?.focus()
  }, [editing])

  function open() {
    setDraft(filter)
    setError(null)
    setEditing(true)
  }

  async function apply(next: string) {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      const response = await fetch('/api/backlog/tracker/filter', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, filter: next.trim() }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      setEditing(false)
      onApplied()
    } catch (e) {
      setError(`Фильтр не сохранён: ${e instanceof TypeError ? 'нет связи с API' : (e as Error).message}.`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {editing ? (
        <span className="fa-edit">
          <input
            ref={input}
            className="flt-input"
            type="text"
            aria-label="Фильтр проекта"
            value={draft}
            placeholder={filterExample(tracker)}
            autoComplete="off"
            spellCheck={false}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                void apply(draft)
              } else if (e.key === 'Escape') {
                // Escape закрывает поле, а не раздел и не окно поверх него
                e.stopPropagation()
                setEditing(false)
              }
            }}
          />
          <button type="button" className="fa-icon on" aria-label="Фильтр проекта" aria-expanded="true" onClick={() => setEditing(false)}>
            <FunnelIcon />
          </button>
        </span>
      ) : (
        <>
          {filter && (
            <span className={`fa-pill ${rejected ? 'bad' : ''}`}>
              <button type="button" className="fa-pill-text" title="Изменить фильтр" onClick={open}>
                {rejected ? <WarnIcon /> : <FunnelIcon />}
                <span>{filter}</span>
              </button>
              <button type="button" className="fa-x" aria-label="Снять фильтр" disabled={saving} onClick={() => void apply('')}>
                <CloseIcon />
              </button>
            </span>
          )}
          <button type="button" className="fa-icon" aria-label="Фильтр проекта" aria-expanded="false" onClick={open}>
            <FunnelIcon />
          </button>
        </>
      )}
      {error && (
        <span className="fa-error warning-text" role="alert">
          {error}
        </span>
      )}
    </>
  )
}

function FunnelIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 4h18l-7 8.5V19l-4 2v-8.5z" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

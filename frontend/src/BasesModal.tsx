import { useEffect, useState, type FormEvent } from 'react'
import './BasesModal.css'

export type BaseEntry = {
  path: string
  copies: number | null
}

type AddProblem = 'empty' | 'not-full-path' | 'not-a-base' | 'duplicate'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; bases: BaseEntry[] }

type Props = {
  onClose: () => void
}

const problemText: Record<AddProblem, string> = {
  empty: 'Введите путь к каталогу базы.',
  'not-full-path': 'Укажите полный путь, например D:\\Projects\\project-knowledge.',
  'not-a-base': 'В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.',
  duplicate: 'Эта база уже в списке.',
}

export default function BasesModal({ onClose }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/bases')
      .then((response) => {
        if (!response.ok) throw new Error(`Список баз не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseEntry[]>
      })
      .then((bases) => setLoad({ kind: 'loaded', bases }))
      .catch((e: unknown) =>
        setLoad({ kind: 'failed', message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message) }),
      )
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const bases = load.kind === 'loaded' ? load.bases : []

  async function add(event: FormEvent) {
    event.preventDefault()
    if (!path.trim()) {
      setError(problemText.empty)
      return
    }

    setBusy(true)
    try {
      const response = await fetch('/api/bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      })
      if (response.ok) {
        const added = (await response.json()) as BaseEntry
        setLoad({ kind: 'loaded', bases: [...bases, added] })
        setPath('')
        setError(null)
        return
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as { problem: AddProblem }
        setError(problemText[body.problem] ?? 'База не добавлена.')
        return
      }
      setError(`База не добавлена: HTTP ${response.status}.`)
    } catch {
      setError('База не добавлена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  async function remove(base: BaseEntry) {
    setBusy(true)
    setListError(null)
    try {
      const response = await fetch(`/api/bases?${new URLSearchParams({ path: base.path })}`, { method: 'DELETE' })
      if (response.ok || response.status === 404) {
        setLoad({ kind: 'loaded', bases: bases.filter((b) => b.path !== base.path) })
        return
      }
      setListError(`База не удалена: HTTP ${response.status}.`)
    } catch {
      setListError('База не удалена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="bases-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bases-modal" role="dialog" aria-modal="true" aria-labelledby="bases-title">
        <div className="bases-header">
          <h3 id="bases-title">Базы знаний</h3>
          <button type="button" className="bases-icon-btn" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="bases-body">
          {load.kind === 'loading' && <p className="bases-lead">Загрузка списка…</p>}
          {load.kind === 'failed' && (
            <p className="bases-error" role="alert">
              {load.message}
            </p>
          )}
          {load.kind === 'loaded' && (
            <ul className="bases-list" aria-label="Базы знаний">
              {bases.length === 0 && <li className="bases-empty">Список пуст.</li>}
              {bases.map((base) => (
                <li key={base.path}>
                  <span className="bases-path mono">{base.path}</span>
                  <span className="bases-meta">{base.copies === null ? 'нет agents-kit.json' : `${base.copies} коп.`}</span>
                  <button
                    type="button"
                    className="bases-btn bases-btn-danger"
                    aria-label={`Удалить ${base.path}`}
                    disabled={busy}
                    onClick={() => remove(base)}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polyline points="3 6 5 6 21 6" />
                      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                      <path d="M10 11v6M14 11v6" />
                      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                    </svg>
                    Удалить
                  </button>
                </li>
              ))}
            </ul>
          )}
          {listError && (
            <p className="bases-error" role="alert">
              {listError}
            </p>
          )}

          {load.kind === 'loaded' && (
            <form className="bases-add" onSubmit={add} noValidate>
              <label htmlFor="bases-new-path">Путь к каталогу базы</label>
              <div className="bases-add-row">
                <input
                  id="bases-new-path"
                  type="text"
                  value={path}
                  placeholder="D:\Projects\project-knowledge"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'bases-add-error' : undefined}
                  onChange={(e) => {
                    setPath(e.target.value)
                    setError(null)
                  }}
                />
                <button type="submit" className="bases-btn" disabled={busy}>
                  Добавить
                </button>
              </div>
              {error && (
                <div className="bases-error" id="bases-add-error" role="alert">
                  {error}
                </div>
              )}
            </form>
          )}
        </div>

        <div className="bases-footer">
          <button type="button" className="bases-btn bases-btn-primary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

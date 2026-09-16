import { useEffect, useState, type FormEvent } from 'react'
import './NewWorkspaceModal.css'
import type { BaseEntry } from './BasesModal'

type Problem = 'bad-name' | 'no-copy' | 'kit-missing' | 'script'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; bases: BaseEntry[] }

type Props = {
  onClose: () => void
  onCreated: () => void
}

const problemText: Record<Problem, string> = {
  'bad-name': 'Имя — строчная латиница и цифры через дефис, например quiet-cedar.',
  'no-copy': 'Ни одной копии проекта нет на диске — заводить новую не от чего.',
  'kit-missing': 'Скрипт кита не найден:',
  script: '',
}

export default function NewWorkspaceModal({ onClose, onCreated }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [base, setBase] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/bases')
      .then((response) => {
        if (!response.ok) throw new Error(`Список баз не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseEntry[]>
      })
      .then((bases) => {
        setLoad({ kind: 'loaded', bases })
        if (bases.length > 0) setBase(bases[0].path)
      })
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

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!base) {
      setError('Выберите проект.')
      return
    }

    setBusy(true)
    setError(null)
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, name: name.trim() || null }),
      })
      if (response.ok) {
        // Копия заведена — её покажет ближайший опрос таблицы, как и после ответа оператору.
        onCreated()
        onClose()
        return
      }
      if (response.status === 404) {
        setError('Этой базы нет в списке панели — обновите страницу.')
        return
      }
      if (response.status === 400) {
        const body = (await response.json()) as { problem: Problem; message: string | null }
        setError([problemText[body.problem] ?? 'Копия не заведена.', body.message].filter(Boolean).join(' ').trim())
        return
      }
      setError(`Копия не заведена: HTTP ${response.status}.`)
    } catch {
      setError('Копия не заведена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="neww-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="neww-modal" role="dialog" aria-modal="true" aria-labelledby="neww-title">
        <div className="neww-header">
          <h3 id="neww-title">Новая рабочая копия</h3>
          <button type="button" className="neww-icon-btn" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <form className="neww-body" onSubmit={create} noValidate>
          {load.kind === 'loading' && <p className="neww-lead">Загрузка списка проектов…</p>}
          {load.kind === 'failed' && (
            <p className="neww-error" role="alert">
              {load.message}
            </p>
          )}
          {load.kind === 'loaded' && bases.length === 0 && (
            <p className="neww-lead">Нет отслеживаемых баз. Базы добавляются в окне «Базы знаний».</p>
          )}

          {bases.length > 0 && (
            <>
              <div className="neww-field">
                <label htmlFor="neww-base">Проект</label>
                <select id="neww-base" value={base} onChange={(e) => setBase(e.target.value)}>
                  {bases.map((entry) => (
                    <option key={entry.path} value={entry.path}>
                      {entry.project}
                    </option>
                  ))}
                </select>
              </div>

              <div className="neww-field">
                <label htmlFor="neww-name">Имя копии</label>
                <input
                  id="neww-name"
                  type="text"
                  value={name}
                  placeholder="quiet-cedar"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby="neww-name-hint"
                  onChange={(e) => {
                    setName(e.target.value)
                    setError(null)
                  }}
                />
                <p className="neww-hint" id="neww-name-hint">
                  Оставьте пустым — кит придумает имя сам. Копия появится рядом с основной копией проекта, на новой
                  ветке с тем же именем.
                </p>
              </div>
            </>
          )}

          {error && (
            <p className="neww-error" role="alert">
              {error}
            </p>
          )}

          <div className="neww-footer">
            <button type="button" className="neww-btn" onClick={onClose}>
              Отмена
            </button>
            <button type="submit" className="neww-btn neww-btn-primary" disabled={busy || bases.length === 0}>
              {busy ? 'Заводится…' : 'Завести копию'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

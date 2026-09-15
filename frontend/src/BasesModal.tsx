import { useEffect, useRef, useState, type FormEvent } from 'react'
import './BasesModal.css'

export type BaseEntry = {
  path: string
  copies: number | null
}

export type FolderEntry = {
  name: string
  path: string
  isBase: boolean
  copies: number | null
}

export type FolderListing = {
  path: string | null
  parent: string | null
  folders: FolderEntry[]
}

type AddProblem = 'empty' | 'not-full-path' | 'not-a-base' | 'duplicate'

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; bases: BaseEntry[] }

type Browse =
  | { kind: 'loading'; path: string | null }
  | { kind: 'failed'; path: string | null; message: string }
  | { kind: 'loaded'; listing: FolderListing }

type Props = {
  onClose: () => void
}

const problemText: Record<AddProblem, string> = {
  empty: 'Введите путь к каталогу базы или выберите папку через «Обзор…».',
  'not-full-path': 'Укажите полный путь, например D:\\Projects\\project-knowledge.',
  'not-a-base': 'В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.',
  duplicate: 'Эта база уже в списке.',
}

const folderProblemText: Record<string, string> = {
  'not-found': 'Папка не найдена.',
  'access-denied': 'Нет доступа к этой папке.',
  'not-full-path': 'Папка не найдена.',
}

const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** Звенья пути для навигации: «D:\», «D:\Projects», «D:\Projects\app». */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.map((part, i) => ({
    name: part,
    path: i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\'),
  }))
}

export default function BasesModal({ onClose }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browse, setBrowse] = useState<Browse | null>(null)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const lastFolder = useRef<string | null>(null)

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

  const browsing = browse !== null

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (browsing) setBrowse(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, browsing])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const bases = load.kind === 'loaded' ? load.bases : []

  async function openFolder(folder: string | null) {
    setBrowse({ kind: 'loading', path: folder })
    setBrowseError(null)
    try {
      const query = folder ? `?${new URLSearchParams({ path: folder })}` : ''
      const response = await fetch(`/api/folders${query}`)
      if (response.ok) {
        const listing = (await response.json()) as FolderListing
        lastFolder.current = listing.path
        setBrowse({ kind: 'loaded', listing })
        return
      }
      const body = (await response.json().catch(() => null)) as { problem?: string } | null
      setBrowse({
        kind: 'failed',
        path: folder,
        message: folderProblemText[body?.problem ?? ''] ?? `Папки не загрузились: HTTP ${response.status}.`,
      })
    } catch {
      setBrowse({ kind: 'failed', path: folder, message: 'Нет связи с API.' })
    }
  }

  /** Добавляет базу; null — добавлена, иначе текст причины. */
  async function addBase(newPath: string): Promise<string | null> {
    if (!newPath.trim()) return problemText.empty

    setBusy(true)
    try {
      const response = await fetch('/api/bases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath }),
      })
      if (response.ok) {
        const added = (await response.json()) as BaseEntry
        setLoad((prev) => ({ kind: 'loaded', bases: [...(prev.kind === 'loaded' ? prev.bases : []), added] }))
        return null
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as { problem: AddProblem }
        return problemText[body.problem] ?? 'База не добавлена.'
      }
      return `База не добавлена: HTTP ${response.status}.`
    } catch {
      return 'База не добавлена: нет связи с API.'
    } finally {
      setBusy(false)
    }
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    const problem = await addBase(path)
    setError(problem)
    if (!problem) setPath('')
  }

  async function addFromBrowser(folder: FolderEntry) {
    const problem = await addBase(folder.path)
    setBrowseError(problem)
    if (!problem) setToast(`Добавлена ${folder.name}`)
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

  const current = browse?.kind === 'loaded' ? browse.listing.path : (browse?.path ?? null)

  return (
    <div className="bases-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bases-modal" role="dialog" aria-modal="true" aria-labelledby="bases-title">
        <div className="bases-header">
          {browsing && (
            <button type="button" className="bases-icon-btn" aria-label="К списку баз" onClick={() => setBrowse(null)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
          )}
          <h3 id="bases-title">
            Базы знаний
            {browsing && <span className="bases-title-suffix"> · выбор папки</span>}
          </h3>
          <button type="button" className="bases-icon-btn bases-close" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {!browsing && (
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
                    <span className="bases-meta">
                      {base.copies === null ? 'нет agents-kit.json' : `${base.copies} коп.`}
                    </span>
                    <button
                      type="button"
                      className="bases-btn bases-btn-small bases-btn-danger"
                      aria-label={`Удалить ${base.path}`}
                      disabled={busy}
                      onClick={() => remove(base)}
                    >
                      <TrashIcon />
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
                  <button
                    type="button"
                    className="bases-btn"
                    onClick={() => {
                      setError(null)
                      void openFolder(lastFolder.current)
                    }}
                  >
                    <FolderIcon />
                    Обзор…
                  </button>
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
        )}

        {browse && (
          <div className="bases-body">
            <div className="bases-browser-bar">
              <button
                type="button"
                className="bases-icon-btn"
                aria-label="На уровень выше"
                disabled={current === null}
                onClick={() =>
                  void openFolder(browse.kind === 'loaded' ? browse.listing.parent : null)
                }
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
              <nav className="bases-crumbs" aria-label="Текущая папка">
                <button
                  type="button"
                  aria-current={current === null ? 'location' : undefined}
                  onClick={() => void openFolder(null)}
                >
                  Этот компьютер
                </button>
                {current &&
                  crumbs(current).map((crumb, i, all) => (
                    <span key={crumb.path} className="bases-crumb">
                      <span className="bases-crumb-sep" aria-hidden="true">
                        ›
                      </span>
                      <button
                        type="button"
                        aria-current={i === all.length - 1 ? 'location' : undefined}
                        onClick={() => void openFolder(crumb.path)}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
              </nav>
            </div>

            <ul className="bases-folders" aria-label="Папки">
              {browse.kind === 'loading' && <li className="bases-folders-hint">Загрузка папок…</li>}
              {browse.kind === 'failed' && (
                <li className="bases-folders-hint bases-error" role="alert">
                  {browse.message}
                </li>
              )}
              {browse.kind === 'loaded' && browse.listing.folders.length === 0 && (
                <li className="bases-folders-hint">В этой папке нет подпапок.</li>
              )}
              {browse.kind === 'loaded' &&
                browse.listing.folders.map((folder) => {
                  const listed = bases.some((b) => samePath(b.path, folder.path))
                  const isDrive = browse.listing.path === null
                  return (
                    <li key={folder.path} className={folder.isBase ? 'is-base' : undefined}>
                      <button type="button" className="bases-folder-open" onClick={() => void openFolder(folder.path)}>
                        {isDrive ? <DriveIcon /> : <FolderIcon />}
                        <span className="bases-folder-name">{folder.name}</span>
                        {folder.isBase && (
                          <span className="bases-kb-tag">
                            база знаний{folder.copies === null ? '' : ` · ${folder.copies} коп.`}
                          </span>
                        )}
                        {!folder.isBase && <ChevronIcon />}
                      </button>
                      {folder.isBase &&
                        (listed ? (
                          <span className="bases-in-list">уже в списке</span>
                        ) : (
                          <button
                            type="button"
                            className="bases-btn bases-btn-small bases-btn-add"
                            aria-label={`Добавить ${folder.path}`}
                            disabled={busy}
                            onClick={() => void addFromBrowser(folder)}
                          >
                            Добавить
                          </button>
                        ))}
                    </li>
                  )
                })}
            </ul>
            {browseError && (
              <p className="bases-error" role="alert">
                {browseError}
              </p>
            )}
            <p className="bases-legend">
              <span className="bases-kb-tag">база знаний</span> — в папке есть agents-kit.json. Скрытые и системные папки
              не показываются.
            </p>
          </div>
        )}

        <div className="bases-footer">
          <span className="bases-toast" role="status">
            {toast}
          </span>
          <button type="button" className="bases-btn bases-btn-primary" onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  )
}

function DriveIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="2" y="13" width="20" height="8" rx="2" />
      <path d="M5.5 13 8 4h8l2.5 9" />
      <line x1="6" y1="17" x2="6.01" y2="17" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="bases-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

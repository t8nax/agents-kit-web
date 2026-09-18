import { useEffect, useState, type FormEvent } from 'react'
import FolderBrowser, { FolderIcon, type FolderEntry } from './FolderBrowser'
import PanelCard from './PanelCard'
import './Settings.css'

export type BaseEntry = {
  path: string
  copies: number | null
}

export type KitEntry = {
  path: string | null
  found: boolean
}

type AddProblem = 'empty' | 'not-full-path' | 'not-a-base' | 'duplicate'
type KitProblem = 'empty' | 'not-full-path' | 'not-a-kit'

type KitSearch =
  | { kind: 'idle' }
  | { kind: 'searching' }
  | { kind: 'failed'; message: string }
  | { kind: 'found'; paths: string[] }

type Load<T> = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; value: T }

const problemText: Record<AddProblem, string> = {
  empty: 'Введите путь к каталогу базы или выберите папку через «Обзор…».',
  'not-full-path': 'Укажите полный путь, например D:\\Projects\\project-knowledge.',
  'not-a-base': 'В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.',
  duplicate: 'Эта база уже в списке.',
}

const kitProblemText: Record<KitProblem, string> = {
  empty: 'Введите путь к каталогу кита или выберите папку через «Обзор…».',
  'not-full-path': 'Укажите полный путь, например C:\\Users\\me\\.claude\\skills\\agents-kit.',
  'not-a-kit': 'В каталоге нет скриптов проверок кита — это не кит. Путь не сохранён.',
}

const samePath = (a: string, b: string) =>
  a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

function loadJson<T>(url: string, what: string): Promise<Load<T>> {
  return fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${what} не загрузился: HTTP ${response.status}`)
      return response.json() as Promise<T>
    })
    .then((value): Load<T> => ({ kind: 'loaded', value }))
    .catch(
      (e: unknown): Load<T> => ({
        kind: 'failed',
        message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
      }),
    )
}

/** Раздел «Настройки»: какие базы видны в панели и где стоит кит, которым они проверяются. */
export default function Settings() {
  return (
    <div className="settings">
      <div className="content-head">
        <h2>Настройки</h2>
      </div>
      <BasesSettings />
      <KitSettings />
      <PanelCard />
    </div>
  )
}

function BasesSettings() {
  const [load, setLoad] = useState<Load<BaseEntry[]>>({ kind: 'loading' })
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [listError, setListError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [browseError, setBrowseError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [lastFolder, setLastFolder] = useState<string | null>(null)

  useEffect(() => {
    void loadJson<BaseEntry[]>('/api/bases', 'Список баз').then(setLoad)
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 2500)
    return () => clearTimeout(timer)
  }, [toast])

  const bases = load.kind === 'loaded' ? load.value : []

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
        setLoad((prev) => ({ kind: 'loaded', value: [...(prev.kind === 'loaded' ? prev.value : []), added] }))
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
        setLoad({ kind: 'loaded', value: bases.filter((b) => b.path !== base.path) })
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
    <section className="settings-card" aria-labelledby="settings-bases">
      <div className="settings-card-head">
        {browsing && (
          <button
            type="button"
            className="bases-icon-btn"
            aria-label="К списку баз"
            onClick={() => {
              setBrowsing(false)
              setBrowseError(null)
            }}
          >
            <BackIcon />
          </button>
        )}
        <div>
          <h3 id="settings-bases">
            Базы знаний
            {browsing && <span className="bases-title-suffix"> · выбор папки</span>}
          </h3>
          <p className="settings-lead">Базы, рабочие копии которых видны в панели.</p>
        </div>
        <span className="bases-toast" role="status">
          {toast}
        </span>
      </div>

      {!browsing && (
        <div className="bases-body">
          {load.kind === 'loading' && <p className="settings-lead">Загрузка списка…</p>}
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
                    setBrowsing(true)
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

      {browsing && (
        <div className="bases-body">
          <FolderBrowser
            start={lastFolder}
            onLocation={(folder) => {
              setLastFolder(folder)
              setBrowseError(null)
            }}
            tag={(folder) =>
              folder.isBase ? (
                <span className="bases-kb-tag">
                  база знаний{folder.copies === null ? '' : ` · ${folder.copies} коп.`}
                </span>
              ) : null
            }
            action={(folder) =>
              bases.some((b) => samePath(b.path, folder.path)) ? (
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
              )
            }
            legend={
              <>
                <span className="bases-kb-tag">база знаний</span> — в папке есть agents-kit.json. Скрытые и системные
                папки не показываются.
              </>
            }
          />
          {browseError && (
            <p className="bases-error" role="alert">
              {browseError}
            </p>
          )}
        </div>
      )}
    </section>
  )
}

function KitSettings() {
  const [load, setLoad] = useState<Load<KitEntry>>({ kind: 'loading' })
  const [path, setPath] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [lastFolder, setLastFolder] = useState<string | null>(null)
  const [search, setSearch] = useState<KitSearch>({ kind: 'idle' })

  useEffect(() => {
    void loadJson<KitEntry>('/api/kit', 'Путь к киту').then((result) => {
      setLoad(result)
      if (result.kind === 'loaded') setPath(result.value.path ?? '')
    })
  }, [])

  const kit = load.kind === 'loaded' ? load.value : null

  /** Сохраняет путь к киту; null — сохранён, иначе текст причины. */
  async function saveKit(newPath: string): Promise<string | null> {
    if (!newPath.trim()) return kitProblemText.empty

    setBusy(true)
    try {
      const response = await fetch('/api/kit', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newPath }),
      })
      if (response.ok) {
        const saved = (await response.json()) as KitEntry
        setLoad({ kind: 'loaded', value: saved })
        setPath(saved.path ?? '')
        return null
      }
      if (response.status === 400) {
        const body = (await response.json()) as { problem: KitProblem }
        return kitProblemText[body.problem] ?? 'Путь к киту не сохранён.'
      }
      return `Путь к киту не сохранён: HTTP ${response.status}.`
    } catch {
      return 'Путь к киту не сохранён: нет связи с API.'
    } finally {
      setBusy(false)
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    setError(await saveKit(path))
  }

  // Найденный путь только подставляется в поле: сохраняет его оператор — решение оператора на приёмке
  async function find() {
    setSearch({ kind: 'searching' })
    setError(null)
    try {
      const response = await fetch('/api/kit/found')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const paths = (await response.json()) as string[]
      if (paths.length === 1) setPath(paths[0])
      setSearch({ kind: 'found', paths })
    } catch (e) {
      setSearch({
        kind: 'failed',
        message: e instanceof TypeError ? 'Кит не искали: нет связи с API.' : `Кит не искали: ${(e as Error).message}.`,
      })
    }
  }

  async function pick(folder: FolderEntry) {
    const problem = await saveKit(folder.path)
    setError(problem)
    setBrowsing(false)
  }

  // Строка о состоянии относится к сохранённому пути, а не к набранному в поле
  const saved =
    kit === null ? null : kit.path === null ? (
      <p className="settings-note">Путь к киту не задан — проблемы баз не проверяются.</p>
    ) : kit.found ? (
      <p className="settings-note settings-ok">Кит найден: скрипты проверок на месте.</p>
    ) : (
      <p className="settings-note bases-error">По сохранённому пути кита больше нет — проблемы баз не проверяются.</p>
    )

  return (
    <section className="settings-card" aria-labelledby="settings-kit">
      <div className="settings-card-head">
        {browsing && (
          <button type="button" className="bases-icon-btn" aria-label="К пути кита" onClick={() => setBrowsing(false)}>
            <BackIcon />
          </button>
        )}
        <div>
          <h3 id="settings-kit">
            Кит
            {browsing && <span className="bases-title-suffix"> · выбор папки</span>}
          </h3>
          <p className="settings-lead">
            Каталог установленного agents-kit. Его скриптами панель проверяет связь копий и сверяет базы.
          </p>
        </div>
      </div>

      {!browsing && (
        <div className="bases-body">
          {load.kind === 'loading' && <p className="settings-lead">Загрузка…</p>}
          {load.kind === 'failed' && (
            <p className="bases-error" role="alert">
              {load.message}
            </p>
          )}
          {load.kind === 'loaded' && (
            <form className="bases-add" onSubmit={save} noValidate>
              <label htmlFor="kit-path">Путь к каталогу кита</label>
              <div className="bases-add-row">
                <input
                  id="kit-path"
                  type="text"
                  value={path}
                  placeholder="C:\Users\me\.claude\skills\agents-kit"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={error ? true : undefined}
                  aria-describedby={error ? 'kit-error' : undefined}
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
                    setBrowsing(true)
                  }}
                >
                  <FolderIcon />
                  Обзор…
                </button>
                <button type="button" className="bases-btn" disabled={search.kind === 'searching'} onClick={() => void find()}>
                  <SearchIcon />
                  Найти автоматически
                </button>
                <button type="submit" className="bases-btn" disabled={busy}>
                  Сохранить
                </button>
              </div>
              {error && (
                <div className="bases-error" id="kit-error" role="alert">
                  {error}
                </div>
              )}
              {search.kind === 'searching' && <p className="settings-note">Ищем кит…</p>}
              {search.kind === 'failed' && <p className="settings-note bases-error">{search.message}</p>}
              {search.kind === 'found' && search.paths.length === 0 && (
                <p className="settings-note">
                  Кит не найден среди навыков и плагинов Claude Code — укажите путь сами или выберите через «Обзор…».
                </p>
              )}
              {search.kind === 'found' && search.paths.length === 1 && (
                <p className="settings-note">Кит найден, путь подставлен в поле — сохраните его.</p>
              )}
              {search.kind === 'found' && search.paths.length > 1 && (
                <div>
                  <p className="settings-note">Найдено несколько китов — выберите, какой подставить:</p>
                  <ul className="bases-list" aria-label="Найденные киты">
                    {search.paths.map((found) => (
                      <li key={found}>
                        <span className="bases-path mono">{found}</span>
                        <button
                          type="button"
                          className="bases-btn bases-btn-small"
                          aria-label={`Подставить ${found}`}
                          onClick={() => {
                            setPath(found)
                            setError(null)
                          }}
                        >
                          Подставить
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {saved}
            </form>
          )}
        </div>
      )}

      {browsing && (
        <div className="bases-body">
          <FolderBrowser
            start={lastFolder}
            onLocation={setLastFolder}
            tag={(folder) => (folder.isKit ? <span className="bases-kb-tag">кит</span> : null)}
            action={(folder) =>
              kit?.path && samePath(kit.path, folder.path) ? (
                <span className="bases-in-list">выбран</span>
              ) : (
                <button
                  type="button"
                  className="bases-btn bases-btn-small bases-btn-add"
                  aria-label={`Выбрать ${folder.path}`}
                  disabled={busy}
                  onClick={() => void pick(folder)}
                >
                  Выбрать
                </button>
              )
            }
            legend={
              <>
                <span className="bases-kb-tag">кит</span> — в папке есть скрипты проверок кита. Скрытые и системные
                папки не показываются.
              </>
            }
          />
        </div>
      )}
    </section>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="15 18 9 12 15 6" />
    </svg>
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

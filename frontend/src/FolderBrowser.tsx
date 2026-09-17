import { useEffect, useState, type ReactNode } from 'react'

export type FolderEntry = {
  name: string
  path: string
  isBase: boolean
  copies: number | null
  isKit?: boolean
}

export type FolderListing = {
  path: string | null
  parent: string | null
  folders: FolderEntry[]
}

type Browse =
  | { kind: 'loading'; path: string | null }
  | { kind: 'failed'; path: string | null; message: string }
  | { kind: 'loaded'; listing: FolderListing }

const folderProblemText: Record<string, string> = {
  'not-found': 'Папка не найдена.',
  'access-denied': 'Нет доступа к этой папке.',
  'not-full-path': 'Папка не найдена.',
}

/** Звенья пути для навигации: «D:\», «D:\Projects», «D:\Projects\app». */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts.map((part, i) => ({
    name: part,
    path: i === 0 ? `${part}\\` : parts.slice(0, i + 1).join('\\'),
  }))
}

type Props = {
  /** Папка, с которой открывается обзор; null — список дисков. */
  start: string | null
  onLocation: (path: string | null) => void
  /** Отметка у папки, которую можно выбрать: база знаний или кит. */
  tag: (folder: FolderEntry) => ReactNode
  /** Что стоит справа у отмеченной папки: кнопка выбора или «уже в списке». */
  action: (folder: FolderEntry) => ReactNode
  legend: ReactNode
}

/**
 * Обзор папок через API: браузер полного пути к папке странице не отдаёт,
 * а системный диалог потребовал бы от API запускать внешний процесс.
 */
async function listFolder(folder: string | null): Promise<Browse> {
  try {
    const query = folder ? `?${new URLSearchParams({ path: folder })}` : ''
    const response = await fetch(`/api/folders${query}`)
    if (response.ok) return { kind: 'loaded', listing: (await response.json()) as FolderListing }
    const body = (await response.json().catch(() => null)) as { problem?: string } | null
    return {
      kind: 'failed',
      path: folder,
      message: folderProblemText[body?.problem ?? ''] ?? `Папки не загрузились: HTTP ${response.status}.`,
    }
  } catch {
    return { kind: 'failed', path: folder, message: 'Нет связи с API.' }
  }
}

export default function FolderBrowser({ start, onLocation, tag, action, legend }: Props) {
  // Обзор открывается с начальной папки один раз; дальше по папкам ходит оператор
  const [initial] = useState(start)
  const [browse, setBrowse] = useState<Browse>({ kind: 'loading', path: initial })

  useEffect(() => {
    let cancelled = false
    void listFolder(initial).then((result) => {
      if (!cancelled) setBrowse(result)
    })
    return () => {
      cancelled = true
    }
  }, [initial])

  async function openFolder(folder: string | null) {
    setBrowse({ kind: 'loading', path: folder })
    const result = await listFolder(folder)
    if (result.kind === 'loaded') onLocation(result.listing.path)
    setBrowse(result)
  }

  const current = browse.kind === 'loaded' ? browse.listing.path : browse.path

  return (
    <>
      <div className="bases-browser-bar">
        <button
          type="button"
          className="bases-icon-btn"
          aria-label="На уровень выше"
          disabled={current === null}
          onClick={() => void openFolder(browse.kind === 'loaded' ? browse.listing.parent : null)}
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
            const marked = tag(folder)
            const isDrive = browse.listing.path === null
            return (
              <li key={folder.path} className={marked ? 'is-base' : undefined}>
                <button type="button" className="bases-folder-open" onClick={() => void openFolder(folder.path)}>
                  {isDrive ? <DriveIcon /> : <FolderIcon />}
                  <span className="bases-folder-name">{folder.name}</span>
                  {marked}
                  {!marked && <ChevronIcon />}
                </button>
                {marked && action(folder)}
              </li>
            )
          })}
      </ul>
      <p className="bases-legend">{legend}</p>
    </>
  )
}

export function FolderIcon() {
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

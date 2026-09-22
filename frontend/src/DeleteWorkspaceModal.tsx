import { useEffect, useState } from 'react'
import type { WorkspaceRow } from './App'
import { WarningIcon } from './Problems'
import './Modal.css'
import './DeleteWorkspaceModal.css'

type Problem = 'kit-not-set' | 'kit-not-found' | 'in-work' | 'main-copy' | 'refused'

/** kit — дорога в «Настройки»; refused — слова кита, их панель не переписывает. */
type Failure = { kind: 'kit'; text: string } | { kind: 'refused'; text: string } | { kind: 'other'; text: string }

type Props = {
  row: WorkspaceRow
  onClose: () => void
  onRemoved: () => void
  onSettings: () => void
}

function failureOf(problem: Problem, message: string | null): Failure {
  switch (problem) {
    case 'kit-not-set':
      return { kind: 'kit', text: 'Путь к киту не задан, а копию убирает скрипт кита. Задайте его в «Настройках».' }
    case 'kit-not-found':
      return {
        kind: 'kit',
        text: `Скрипт кита не найден: ${message ?? 'worktree-remove.ps1'}. Проверьте путь к киту в «Настройках».`,
      }
    case 'in-work':
      return { kind: 'other', text: 'В копии идёт задача — сначала её нужно закрыть.' }
    case 'main-copy':
      return { kind: 'other', text: 'Это основная копия проекта: её не удаляют, от неё заводят новые.' }
    default:
      return { kind: 'refused', text: message ?? 'Кит не объяснил причину.' }
  }
}

export default function DeleteWorkspaceModal({ row, onClose, onRemoved, onSettings }: Props) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  async function remove() {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/workspace/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, copy: row.path }),
      })
      if (response.ok) {
        onRemoved()
        return
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as { problem: Problem; message: string | null }
        setFailure(failureOf(body.problem, body.message))
      } else if (response.status === 404) {
        setFailure({ kind: 'other', text: 'Этой копии больше нет в таблице: её уже убрали.' })
      } else {
        setFailure({ kind: 'other', text: `Копия не удалена: HTTP ${response.status}.` })
      }
    } catch {
      setFailure({ kind: 'other', text: 'Копия не удалена: нет связи с API.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dw-modal" role="dialog" aria-modal="true" aria-labelledby="dw-title">
        <div className="dw-head">
          <span className="dw-head-icon" aria-hidden="true">
            <TrashIcon />
          </span>
          <h3 id="dw-title">Удалить рабочую копию</h3>
          <button type="button" className="dw-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dw-body">
          <p className="dw-lead">
            Копия <span className="dw-strong">{copyName(row.path)}</span> уйдёт с диска. Вернуть её панель не сможет.
          </p>

          <dl className="dw-preview" aria-label="Что будет удалено">
            <dt>Проект</dt>
            <dd>{row.project}</dd>
            <dt>Каталог</dt>
            <dd className="mono">{row.path}</dd>
            <dt>Ветка</dt>
            <dd>
              {row.branch ? <span className="mono">{row.branch}</span> : <span className="text-ter">отсоединён</span>}
              <span className="dw-note"> — останется</span>
            </dd>
          </dl>

          {failure && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                {failure.kind === 'refused' ? 'Кит не убрал копию' : 'Копия не удалена'}
              </span>
              <p className={failure.kind === 'refused' ? 'mono dw-error-text' : 'dw-error-text'}>{failure.text}</p>
              {failure.kind === 'kit' && (
                <button type="button" className="bases-btn bases-btn-small dw-error-action" onClick={onSettings}>
                  Открыть «Настройки»
                </button>
              )}
            </div>
          )}
        </div>

        <div className="dw-footer">
          {busy && <span className="text-ter dw-busy-note">Кит убирает рабочую копию — несколько секунд.</span>}
          <div className="dw-footer-end">
            <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button
              type="button"
              className="bases-btn dw-btn-danger"
              disabled={busy || failure?.kind === 'kit'}
              onClick={() => void remove()}
            >
              {busy && <span className="dw-spinner" aria-hidden="true" />}
              {busy ? 'Удаляется…' : 'Удалить копию'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function copyName(path: string) {
  return path.split('\\').filter(Boolean).pop() ?? path
}

export function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="4 7 20 7" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </svg>
  )
}

import { useEffect, useState } from 'react'
import { TrashIcon } from './DeleteWorkspaceModal'
import { WarningIcon } from './Problems'
import type { TrackerServer } from './TrackerServersCard'
import './Modal.css'
import './DeleteWorkspaceModal.css'

type Props = {
  entry: TrackerServer
  onClose: () => void
  onRemoved: () => void
}

/**
 * Удаление сервера трекера — окном, как удаление рабочей копии: вместе с сервером уходит ключ, а новый придётся
 * выпускать в профиле трекера — решение оператора на B-288.
 */
export default function DeleteTrackerServerModal({ entry, onClose, onRemoved }: Props) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

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
      const response = await fetch(`/api/trackers?${new URLSearchParams({ server: entry.server })}`, { method: 'DELETE' })
      // Сервера уже нет в списке — удалять нечего, окно закрывается так же.
      if (response.ok || response.status === 404) {
        onRemoved()
        return
      }
      setFailure(`Сервер не удалён: HTTP ${response.status}.`)
    } catch {
      setFailure('Сервер не удалён: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dw-modal" role="dialog" aria-modal="true" aria-labelledby="trk-delete-title">
        <div className="dw-head">
          <span className="dw-head-icon" aria-hidden="true">
            <TrashIcon />
          </span>
          <h3 id="trk-delete-title">Удалить сервер трекера</h3>
          <button type="button" className="dw-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dw-body">
          <p className="dw-lead">
            Сервер{' '}
            <span className="dw-strong mono dw-url" title={entry.server}>
              {entry.server}
            </span>{' '}
            уйдёт из списка вместе с ключом пользователя <span className="dw-strong mono trk-nowrap">{entry.login}</span>.
            Чтобы снова читать задачи с этого сервера, ключ придётся ввести заново.
          </p>

          {failure && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                Сервер не удалён
              </span>
              <p className="dw-error-text">{failure}</p>
            </div>
          )}
        </div>

        <div className="dw-footer">
          <div className="dw-footer-end">
            <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button type="button" className="bases-btn dw-btn-danger" disabled={busy} onClick={() => void remove()}>
              {busy && <span className="dw-spinner" aria-hidden="true" />}
              {busy ? 'Удаляется…' : 'Удалить сервер'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useEffect, useState } from 'react'
import { TrashIcon } from './DeleteWorkspaceModal'
import { WarningIcon } from './Problems'
import { knownTracker, rejectedText, type ProjectTrackerRow, type TrackerRejected } from './projectTracker'
import './Modal.css'
import './DeleteWorkspaceModal.css'

type Props = {
  row: ProjectTrackerRow
  onClose: () => void
  /** Описание удалено — карточка перечитывает строки. */
  onRemoved: () => void
  /** Отказ, после которого строки карточки стоит перечитать: описание поменялось или пришла задача трекера. */
  onChanged: () => void
}

type Failure = { title: string; text: string; output?: string }

/**
 * Удаление трекера проекта — окном с подтверждением, как удаление сервера трекера (макет B-293): описание уходит
 * из базы, база — на сервер. Пока идёт задача из этого трекера, окно не открывается: «Удалить» погашено.
 */
export default function DeleteProjectTrackerModal({ row, onClose, onRemoved, onChanged }: Props) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // Описание удалено, а база на сервер не ушла: окно остаётся сказать об этом, и кнопка одна — «Закрыть».
  const [removed, setRemoved] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function close() {
    if (removed) onRemoved()
    else onClose()
  }

  async function remove() {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const query = new URLSearchParams({ base: row.base, version: row.version })
      const response = await fetch(`/api/trackers/projects?${query}`, { method: 'DELETE' })
      if (response.ok) {
        const answer = (await response.json()) as { pushed: boolean; message?: string | null }
        if (answer.pushed) {
          onRemoved()
          return
        }
        setRemoved(true)
        setFailure({
          title: 'База не отправлена на сервер',
          text: 'Описание трекера удалено на этом компьютере, но на сервер не ушло. Кит ответил:',
          output: answer.message ?? undefined,
        })
        return
      }
      const rejected = (await response.json().catch(() => null)) as TrackerRejected | null
      if (rejected?.problem === 'changed' || rejected?.problem === 'busy') onChanged()
      setFailure({
        title: 'Трекер не удалён',
        ...(rejected ? rejectedText(rejected) : { text: `HTTP ${response.status}.` }),
      })
    } catch {
      setFailure({ title: 'Трекер не удалён', text: 'Нет связи с API.' })
    } finally {
      setBusy(false)
    }
  }

  const name = knownTracker(row.description?.tracker) ?? row.tracker?.name ?? null
  const project = row.tracker?.project ?? row.description?.project.trim() ?? ''
  const shown = row.tracker?.kind === 'github' || row.tracker?.kind === 'youtrack'

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && close()}>
      <div className="dw-modal" role="dialog" aria-modal="true" aria-labelledby="prj-delete-title">
        <div className="dw-head">
          <span className="dw-head-icon" aria-hidden="true">
            <TrashIcon />
          </span>
          <h3 id="prj-delete-title">Удалить трекер проекта</h3>
          <button type="button" className="dw-close" aria-label="Закрыть" disabled={busy} onClick={close}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dw-body">
          <p className="dw-lead">
            Описание трекера проекта <span className="dw-strong">{row.project}</span> уйдёт из базы знаний
            {shown && project && name ? (
              <>
                , и «Бэклог» перестанет показывать задачи проекта <span className="dw-strong mono">{project}</span> из {name}
              </>
            ) : null}
            . Панель отправит базу на сервер.
          </p>

          {failure && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                {failure.title}
              </span>
              <p className="dw-error-text">{failure.text}</p>
              {failure.output && <pre className="dw-error-text">{failure.output}</pre>}
            </div>
          )}
        </div>

        <div className="dw-footer">
          <div className="dw-footer-end">
            {removed ? (
              <button type="button" className="bases-btn" onClick={close}>
                Закрыть
              </button>
            ) : (
              <>
                <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
                  Отмена
                </button>
                <button type="button" className="bases-btn dw-btn-danger" disabled={busy} onClick={() => void remove()}>
                  {busy && <span className="dw-spinner" aria-hidden="true" />}
                  {busy ? 'Удаляется…' : 'Удалить трекер'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

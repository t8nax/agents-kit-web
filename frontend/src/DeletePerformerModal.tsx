import { useEffect, useState } from 'react'
import { TrashIcon } from './DeleteWorkspaceModal'
import { NEWER_FORMAT_REFUSAL } from './NewerFormat'
import { WarningIcon } from './Problems'
import './Modal.css'
import './DeleteWorkspaceModal.css'

type Props = {
  base: string
  project: string
  name: string
  onClose: () => void
  onRemoved: () => void
}

/** git — вывод git дословно: база не приняла коммит удаления, и панель его слов не переписывает. */
type Failure = { git: boolean; text: string }

/**
 * Удаление исполнителя — окном поверх окна исполнителя, как удаление рабочей копии: файл уходит из базы коммитом,
 * а вернуть его панель не сможет — решение оператора на B-83 по макету https://claude.ai/artifact/CYpFJgoK9QsybDDkNM43pA.
 */
export default function DeletePerformerModal({ base, project, name, onClose, onRemoved }: Props) {
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
      const response = await fetch(`/api/performers?${new URLSearchParams({ base, name })}`, { method: 'DELETE' })
      if (response.ok) {
        onRemoved()
        return
      }
      if (response.status === 404) {
        const body = (await response.json().catch(() => null)) as { problem?: string } | null
        // Исполнителя уже нет в базе — удалять нечего, окно закрывается так же. Нет базы — это другое: исполнитель
        // на месте, и молча закрытое окно выдало бы его за удалённого.
        if (body?.problem === 'no-performer') onRemoved()
        else setFailure({ git: false, text: 'Этой базы больше нет в списке панели.' })
        return
      }
      if (response.status === 409) {
        const body = (await response.json()) as { problem: string; detail?: string | null }
        if (body.problem === 'not-committed') setFailure({ git: true, text: body.detail ?? 'База не приняла коммит.' })
        else if (body.problem === 'git-silent')
          setFailure({ git: false, text: 'Git базы не ответил, исполнитель не тронут. Попробуйте ещё раз.' })
        // Флоу поправили, пока окно было открыто: этап снова зовёт исполнителя, и панель его не удалила.
        // Слова те же, что у подсказки погашенной кнопки в окне исполнителя.
        else if (body.problem === 'called-by-flow')
          setFailure({ git: false, text: `Его зовут этапы: ${body.detail ?? ''}. Пока они его зовут, удалить его нельзя.` })
        else if (body.problem === 'newer-format') setFailure({ git: false, text: body.detail ?? NEWER_FORMAT_REFUSAL })
        else setFailure({ git: false, text: `Исполнитель не удалён: панель не поняла отказ «${body.problem}».` })
      } else {
        setFailure({ git: false, text: `Исполнитель не удалён: HTTP ${response.status}.` })
      }
    } catch {
      setFailure({ git: false, text: 'Исполнитель не удалён: нет связи с API.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="dw-modal" role="dialog" aria-modal="true" aria-labelledby="pf-delete-title">
        <div className="dw-head">
          <span className="dw-head-icon" aria-hidden="true">
            <TrashIcon />
          </span>
          <h3 id="pf-delete-title">Удалить исполнителя</h3>
          <button type="button" className="dw-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="dw-body">
          <p className="dw-lead">
            Исполнитель <span className="dw-strong mono">{name}</span> проекта <span className="dw-strong">{project}</span>{' '}
            уйдёт из базы. Вернуть его панель не сможет.
          </p>

          {failure && (
            <div className="dw-error" role="alert">
              <span className="dw-error-title">
                <WarningIcon />
                {failure.git ? 'База не приняла удаление' : 'Исполнитель не удалён'}
              </span>
              <p className={failure.git ? 'mono dw-error-text' : 'dw-error-text'}>{failure.text}</p>
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
              {busy ? 'Удаляется…' : 'Удалить исполнителя'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

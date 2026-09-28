import { useEffect, useState } from 'react'
import type { BacklogEntry } from './Backlog'
import { Markdown } from './Markdown'
import { OutIcon } from './TrackerGroup'
import type { TrackerDraft, TrackerIssue, TrackerMoved } from './tracker'
import './Modal.css'
import './ReplyModal.css'
import './StartTaskModal.css'
import './TrackerMoveModal.css'

type Props = {
  base: string
  entry: BacklogEntry & { number: string }
  onClose: () => void
  /** Задача заведена: бэклог перечитывается, запись из него ушла или осталась — это скажет окно. */
  onMoved: () => void
}

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; draft: TrackerDraft }

/** Задача заведена; error — запись осталась в бэклоге. */
type Result = { issue: TrackerIssue; error: string | null }

/**
 * Окно переноса записи в трекер — по образцу окна запуска задачи, без поля «Куда» (макет B-286, вариант А). Что уйдёт
 * в трекер, собирает API: окно показывает ровно то, что заведёт перенос.
 */
export default function TrackerMoveModal({ base, entry, onClose, onMoved }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  useEffect(() => {
    let alive = true
    fetch(`/api/backlog/tracker/draft?base=${encodeURIComponent(base)}&number=${encodeURIComponent(entry.number)}`)
      .then((response) => {
        if (response.status === 404) throw new Error('Этой записи больше нет в бэклоге: её взяли или удалили.')
        if (response.status === 409) throw new Error('Трекер проекта больше не GitHub с адресом репозитория.')
        if (!response.ok) throw new Error(`Задача не собрана: HTTP ${response.status}.`)
        return response.json() as Promise<TrackerDraft>
      })
      .then(
        (draft) => alive && setLoad({ kind: 'loaded', draft }),
        (e: unknown) =>
          alive &&
          setLoad({ kind: 'failed', message: e instanceof TypeError ? 'Нет связи с API.' : String((e as Error).message) }),
      )
    return () => {
      alive = false
    }
  }, [base, entry.number])

  async function move(draft: TrackerDraft) {
    if (busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/backlog/tracker/move', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, number: draft.number, original: draft.original }),
      })
      if (!response.ok) {
        setFailure(
          response.status === 404
            ? 'Этой записи больше нет в бэклоге: её взяли или удалили.'
            : response.status === 409
              ? 'Трекер проекта больше не GitHub с адресом репозитория.'
              : `Задача не заведена: HTTP ${response.status}.`,
        )
        return
      }
      const moved = (await response.json()) as TrackerMoved
      if (moved.issue) {
        setResult({ issue: moved.issue, error: moved.error ?? null })
        onMoved()
      } else {
        // Фразу пишет API — одна на окно и разговор с Чудо-Юдо; «возможно, заведена» она говорит сама
        setFailure(moved.error ?? 'Задача не заведена.')
      }
    } catch {
      setFailure('Задача не заведена: нет связи с API.')
    } finally {
      setBusy(false)
    }
  }

  const draft = load.kind === 'loaded' ? load.draft : null

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className={`st-modal ${busy ? 'tt-busy' : ''}`} role="dialog" aria-modal="true" aria-labelledby="tt-title">
        <div className="st-head">
          <h3 id="tt-title">{result ? 'Задача заведена' : 'Перенести в трекер'}</h3>
          <button type="button" className="btn btn-icon st-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="st-body">
          {result ? (
            <>
              {result.error && (
                <div className="st-failure tt-failure" role="alert">
                  <strong>Запись осталась в бэклоге</strong>
                  <span>
                    Панель не убрала {entry.number} из бэклога: {result.error}. Задача и запись теперь повторяют друг друга:
                    уберите запись из бэклога.
                  </span>
                </div>
              )}
              <div className="st-field">
                <span className="st-label">Задача трекера</span>
                <IssueLink issue={result.issue} />
              </div>
              {!result.error && (
                <p className="st-text text-sec">
                  Запись {entry.number} убрана из бэклога
                  {draft && draft.files.length > 0 ? ', приложенные к ней файлы удалены.' : '.'}
                </p>
              )}
            </>
          ) : (
            <>
              {failure && (
                <p className="st-failure" role="alert">
                  {failure}
                </p>
              )}
              <div className="st-field">
                <span className="st-label">Запись бэклога</span>
                <span className="st-entry">
                  <span className="num-chip">{entry.number}</span>
                  <span className="st-entry-title">{entry.title}</span>
                </span>
              </div>
              {load.kind === 'loading' && <p className="text-sec st-message">Задача собирается…</p>}
              {load.kind === 'failed' && <p className="warning-text st-message">{load.message}</p>}
              {draft && (
                <>
                  <div className="st-field">
                    <span className="st-label">Заголовок задачи</span>
                    <div className="tt-box tt-issue-title">{draft.title}</div>
                  </div>
                  <div className="st-field">
                    <span className="st-label">Описание задачи</span>
                    <div className="tt-box tt-desc">
                      {draft.body ? <Markdown text={draft.body} /> : <span className="text-ter">Описания нет</span>}
                    </div>
                  </div>
                  {draft.files.length > 0 && (
                    <div className="st-failure tt-failure">
                      <strong>Файлы в задачу не попадут и удалятся вместе с записью:</strong>
                      <ul className="tt-files">
                        {draft.files.map((file) => (
                          <li key={file.address}>
                            <span className="tt-file-label">{file.label}</span>
                            <span className="tt-file-path">{file.address}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>

        <div className="st-footer">
          <div className="st-footer-end">
            {result ? (
              <button type="button" className="btn" onClick={onClose}>
                Закрыть
              </button>
            ) : (
              <>
                <button type="button" className="btn" disabled={busy} onClick={onClose}>
                  Отмена
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy || !draft}
                  onClick={() => draft && void move(draft)}
                >
                  {busy ? 'Заводится…' : 'Завести задачу'}
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Строка задачи — как в группе задач трекера: ссылка на GitHub во вкладку браузера, и адрес под ней. */
function IssueLink({ issue }: { issue: TrackerIssue }) {
  return (
    <div>
      <div className="entry-row">
        <a className="entry" href={issue.url} target="_blank" rel="noreferrer" title={`Открыть ${issue.name} во вкладке браузера`}>
          <span className="entry-num-slot tt-num-slot">
            <span className="tracker-num">#{issue.number}</span>
          </span>{' '}
          <span className="entry-title">{issue.title}</span>
          <OutIcon />
        </a>
      </div>
      <span className="tt-link-url">{issue.url.replace(/^https:\/\//, '')}</span>
    </div>
  )
}

/** Значок кнопки «В трекер» — стрелка вверх из лотка: запись уходит из бэклога наружу. */
export function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" />
      <polyline points="16 6 12 2 8 6" />
      <line x1="12" y1="2" x2="12" y2="15" />
    </svg>
  )
}

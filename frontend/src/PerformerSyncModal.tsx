import { useEffect } from 'react'
import type { Performer } from './Performers'
import './PerformerSyncModal.css'

/** Копия, куда коммит придётся некстати: branch — она на master, dirty — в ней лежит чужая незакоммиченная работа. */
export type RiskyCopy = {
  copy: string
  name: string
  branch: string | null
  reason: 'branch' | 'dirty'
}

/** Исход по одной копии: done — файл записан и закоммичен, иначе error — вывод git дословно. */
export type SyncOutcome = {
  copy: string
  name: string
  done: boolean
  commit: string | null
  error: string | null
}

/** Чем занято окно синхронизации: запрос идёт, ждём слова оператора, показан исход или отказ. */
export type SyncStage =
  | { kind: 'running' }
  | { kind: 'confirm'; risky: RiskyCopy[] }
  | { kind: 'done'; outcomes: SyncOutcome[] }
  | { kind: 'refused'; text: string }

const risk: Record<RiskyCopy['reason'], string> = {
  branch: 'копия на master — из неё публикуется панель',
  dirty: 'в копии лежит незакоммиченная работа',
}

/**
 * Окно синхронизации исполнителя по копиям проекта. Копии здесь не выбирают: файл основной копии
 * уезжает во все, где его нет или где он другой, — решение оператора на B-77. Предупреждение встаёт
 * только тогда, когда среди них есть копия, куда коммитить не стоит: сама панель в неё не пишет.
 * Запросы шлёт раздел: окно показывает стадию и зовёт onConfirm, когда оператор согласился.
 */
export default function PerformerSyncModal({
  performer,
  stage,
  onConfirm,
  onClose,
}: {
  performer: Performer
  stage: SyncStage
  onConfirm: () => void
  onClose: () => void
}) {
  const busy = stage.kind === 'running'

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <div className="sync-modal" role="dialog" aria-modal="true" aria-labelledby="sync-title">
        <div className="sync-head">
          {stage.kind === 'confirm' && (
            <span className="sync-warn-mark" aria-hidden="true">
              <WarnIcon />
            </span>
          )}
          <h3 id="sync-title">
            {stage.kind === 'confirm' ? 'Синхронизировать ' : 'Синхронизация '}
            <span className="mono">{performer.name}</span>
            {stage.kind === 'confirm' ? '?' : ''}
          </h3>
          <span className="sync-head-end" />
          <button type="button" className="btn btn-icon" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="sync-body">
          {stage.kind === 'running' && <p className="message text-sec">Панель смотрит копии проекта…</p>}

          {stage.kind === 'refused' && (
            <p className="message warning-text" role="alert">
              {stage.text}
            </p>
          )}

          {stage.kind === 'confirm' && (
            <>
              <p className="sync-lead">
                Файл из основной копии ляжет в копии проекта, в каждой своим коммитом. Вот где коммит придётся
                некстати:
              </p>
              <div className="sync-list">
                {stage.risky.map((copy) => (
                  <div key={copy.copy} className="sync-row sync-row-risky">
                    <span className="mono sync-copy">{copy.name}</span>
                    {copy.branch && <span className="mono text-ter sync-branch">{copy.branch}</span>}
                    <span className="sync-row-end warning-text">{risk[copy.reason]}</span>
                  </div>
                ))}
              </div>
              <p className="sync-note">Копию, где файл другой, синхронизация перезапишет файлом основной копии.</p>
            </>
          )}

          {stage.kind === 'done' && stage.outcomes.length === 0 && (
            <p className="message text-sec">Исполнитель уже лежит во всех копиях проекта — синхронизировать нечего.</p>
          )}

          {stage.kind === 'done' && stage.outcomes.length > 0 && (
            <div className="sync-list">
              {stage.outcomes.map((outcome) => (
                <div key={outcome.copy} className={`sync-row ${outcome.done ? 'sync-row-done' : 'sync-row-failed'}`}>
                  <div className="sync-row-head">
                    <span className="mono sync-copy">{outcome.name}</span>
                    <span className="sync-row-end">
                      {outcome.done ? (
                        <>
                          <span className="text-sec">записан и закоммичен</span>
                          {outcome.commit && <span className="mono text-ter sync-commit">{outcome.commit}</span>}
                        </>
                      ) : (
                        <span className="warning-text">коммит не прошёл</span>
                      )}
                    </span>
                  </div>
                  {/* Вывод git оператор видит дословно: по нему и видно, почему копия осталась без исполнителя. */}
                  {!outcome.done && outcome.error && <pre className="mono sync-git">{outcome.error}</pre>}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="sync-footer">
          <span className="sync-footer-gap" />
          {stage.kind === 'confirm' ? (
            <>
              <button type="button" className="bases-btn" onClick={onClose}>
                Отмена
              </button>
              <button type="button" className="bases-btn bases-btn-warn" onClick={onConfirm}>
                Синхронизировать всё равно
              </button>
            </>
          ) : (
            <button type="button" className="bases-btn bases-btn-primary" disabled={busy} onClick={onClose}>
              {stage.kind === 'done' ? 'Готово' : 'Закрыть окно'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8v5" />
      <path d="M12 16.5h.01" />
    </svg>
  )
}

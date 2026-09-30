import { useCallback, useEffect, useRef, useState } from 'react'
import type { PanelRelease } from './PanelCard'
import './DeleteWorkspaceModal.css'

/**
 * ready — стоящую Бету можно выложить; running — выкладка идёт; failed — последняя выкладка сорвалась;
 * already — стоящая сборка уже в Стабильном; older — в Стабильном сборка новее; no-rights — выкладка не дана.
 */
export type PanelStable = {
  version: string
  stable: string | null
  state: 'ready' | 'running' | 'failed' | 'already' | 'older' | 'no-rights'
  releases: PanelRelease[]
}

/** Выкладка идёт на GitHub минуты: блок спрашивает, как она идёт, раз в несколько секунд. */
const pollMs = 5000

/**
 * Блок «Выкладка в Стабильный» внизу карточки «Панель» — по макету B-312: стоящая Бета уходит в Стабильный
 * кнопкой с тем же номером и без пересборки. Есть только у поставленной Беты; API не отдал блок — его нет.
 */
export default function StablePromotion() {
  const [stable, setStable] = useState<PanelStable | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  // Выкладка шла на глазах — её конец показывается итогом «вышла», а не «уже в Стабильном».
  const watched = useRef(false)
  const [done, setDone] = useState(false)

  // Блока нет, пока API его не отдал. Сбой посреди выкладки — GitHub промолчал или отказал по лимиту — блок
  // не убирает: он остаётся как был, и опрос идёт дальше.
  const load = useCallback(() => {
    fetch('/api/panel/stable')
      .then((response) => {
        if (response.status === 404) return null
        return response.ok ? (response.json() as Promise<PanelStable>) : undefined
      })
      .then((loaded) => {
        if (loaded === undefined) return
        if (loaded?.state === 'running') watched.current = true
        else if (loaded?.state === 'already' && watched.current) setDone(true)
        setStable(loaded)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const running = stable?.state === 'running'
  useEffect(() => {
    if (!running) return
    const timer = setInterval(load, pollMs)
    return () => clearInterval(timer)
  }, [running, load])

  const promote = () => {
    setConfirming(false)
    setRefused(null)
    fetch('/api/panel/stable', { method: 'POST' })
      .then(async (response) => {
        if (response.ok) {
          watched.current = true
          setStable((current) => (current ? { ...current, state: 'running' } : current))
          return
        }
        // Выкладка уже идёт или выкладывать больше нечего — блок просто читает, как обстоит дело.
        if (response.status !== 409) setRefused(await refusal(response))
        load()
      })
      .catch(() => setRefused('нет связи с API'))
  }

  if (!stable) return null

  const failed = stable.state === 'failed' || refused !== null
  const stableNumber = done ? stable.version : (stable.stable ?? '—')

  return (
    <div className="rel-block">
      {stable.state !== 'already' || done ? <span className="rel-title">Выкладка в Стабильный</span> : null}
      <div className="rel-body">
        <div className="rel-cell">
          <span className="rel-cell-label">Стабильный</span>
          <span className="panel-build">{stableNumber}</span>
        </div>
        {!done && stable.state !== 'already' && (
          <>
            <span className="rel-arrow" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </span>
            <div className="rel-cell">
              <span className="rel-cell-label">Стоит</span>
              <span className="panel-build">{stable.version}</span>
            </div>
          </>
        )}
        <End stable={stable} done={done} failed={failed} onPromote={() => setConfirming(true)} />
      </div>
      {running && (
        <div className="rel-track">
          <div className="panel-progress">
            <div className="panel-progress-bar" />
          </div>
          <span className="panel-hint">Выкладка на GitHub займёт несколько минут.</span>
        </div>
      )}
      {!running && failed && (
        <div className="rel-track">
          <span className="rel-failed" role="alert">
            Выкладка не удалась: {refused ?? 'GitHub не принял выпуск.'}
            {refused && !refused.endsWith('.') ? '.' : ''} В Стабильном осталась {stable.stable ?? 'прежняя сборка'}.
          </span>
        </div>
      )}
      {confirming && <Confirm stable={stable} onCancel={() => setConfirming(false)} onConfirm={promote} />}
    </div>
  )
}

function End({
  stable,
  done,
  failed,
  onPromote,
}: {
  stable: PanelStable
  done: boolean
  failed: boolean
  onPromote: () => void
}) {
  if (done)
    return (
      <span className="rel-status panel-current">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
        Сборка {stable.version} вышла в Стабильный
      </span>
    )
  switch (stable.state) {
    case 'running':
      return <span className="rel-status rel-busy-now">Выпускается {stable.version}…</span>
    case 'already':
      return <span className="rel-status panel-current">Стоящая сборка уже в Стабильном</span>
    case 'older':
      return <span className="rel-status rel-no-rights">В Стабильном сборка новее стоящей</span>
    case 'no-rights':
      return <span className="rel-status rel-no-rights">У вас нет прав для выпуска сборки</span>
    default:
      return (
        <button type="button" className="bases-btn panel-primary rel-end" onClick={onPromote}>
          {failed ? 'Повторить' : 'Выпустить в Стабильный'}
        </button>
      )
  }
}

/** Окно подтверждения: что уйдёт, какие задачи оно привезёт и что отменить выпуск нельзя. */
function Confirm({ stable, onCancel, onConfirm }: { stable: PanelStable; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const tasks = stable.releases.reduce((count, release) => count + release.tasks.length, 0)

  return (
    <div className="panel-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div className="panel-window" role="dialog" aria-modal="true" aria-labelledby="stable-confirm-title">
        <h3 id="stable-confirm-title">Выпустить {stable.version} в Стабильный?</h3>
        <p className="release-lead">
          В Стабильный уйдёт сборка <span className="mono">{stable.version}</span>, которая стоит сейчас, — с тем же
          номером и без пересборки. Её получат все панели на канале «Стабильный». Выкладка на GitHub займёт несколько
          минут.
        </p>
        {stable.releases.length > 0 && (
          <div className="release-what">
            <div className="release-what-head">
              <span className="panel-arrived">{taskCount(tasks)}</span>
              {stable.stable && (
                <span className="from">
                  новее Стабильного <span className="panel-release-num">{stable.stable}</span>
                </span>
              )}
            </div>
            <div className="panel-releases release-list">
              {stable.releases.map((release) => (
                <div key={release.tag} className="panel-release">
                  <span className="panel-release-num">{release.version}</span>
                  <ul>
                    {release.tasks.map((task, index) => (
                      <li key={index}>{task}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="release-warn">
          <strong>Отменить выпуск нельзя.</strong> Номер {stable.version} останется в Стабильном; исправление выйдет
          только следующим выпуском.
        </div>
        <div className="window-actions">
          <button type="button" className="bases-btn" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="bases-btn dw-btn-danger" onClick={onConfirm}>
            Выпустить в Стабильный
          </button>
        </div>
      </div>
    </div>
  )
}

/** Причина отказа запуска: 502 с телом — слова gh, без тела — GitHub не отдал выпуски. */
async function refusal(response: Response) {
  if (response.status !== 502) return `HTTP ${response.status}`
  const detail = await response
    .json()
    .then((body: { detail?: string }) => body.detail)
    .catch(() => undefined)
  return detail ?? 'GitHub не ответил'
}

/** «1 задача», «2 задачи», «5 задач». */
function taskCount(count: number) {
  const tail = count % 100
  if (tail % 10 === 1 && tail !== 11) return `${count} задача`
  if (tail % 10 >= 2 && tail % 10 <= 4 && (tail < 12 || tail > 14)) return `${count} задачи`
  return `${count} задач`
}

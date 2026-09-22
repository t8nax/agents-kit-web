import { useCallback, useEffect, useRef, useState } from 'react'
import './PanelCard.css'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'

export type PanelBuild = {
  channel: string
  sha: string
  builtAt: string
}

export type Panel = {
  installed: boolean
  channel: string
  published: PanelBuild | null
}

export type PanelRelease = {
  sha: string
  title: string
}

export type PanelUpdates = {
  sha: string
  releases: PanelRelease[]
}

export type PanelUpdateState = {
  state: 'none' | 'running' | 'done' | 'failed'
  log: string[]
  file: string
}

const channels = ['master', 'dev'] as const

/** Пока идёт обновление, панель подменяется и на минуту перестаёт отвечать — опрос это переживает. */
const pollMs = 1500

const built = (at: string) =>
  new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/** Код сборки на месте номера версии: он и говорит, чем одна панель отличается от другой. */
const code = (build: PanelBuild) => `${build.channel} ${build.sha.slice(0, 7)}`

/** «1 задача ждёт», «2 задачи ждут», «5 задач ждут» — иначе счёт читается не по-русски. */
const waiting = (count: number) => {
  const tail = count % 100
  if (tail % 10 === 1 && tail !== 11) return `${count} задача ждёт обновления`
  if (tail % 10 >= 2 && tail % 10 <= 4 && (tail < 12 || tail > 14)) return `${count} задачи ждут обновления`
  return `${count} задач ждут обновления`
}

/**
 * Карточка «Панель» в «Настройках»: какой панель собрана, что лежит в канале и кнопка обновления.
 * Номерами версий карточка не говорит: номер поднимают руками и пропускают, а свежесть панели
 * считается кодом канала. В запуске для разработки обновлять нечего — панель говорит это вместо кнопки.
 */
export default function PanelCard() {
  const [panel, setPanel] = useState<Panel | null>(null)
  const [updates, setUpdates] = useState<PanelUpdates | null>(null)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<PanelUpdateState | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reveal = useReveal(panel === null && !error)
  const [copied, setCopied] = useState(false)

  const loadUpdates = useCallback((installed: boolean) => {
    if (!installed) return
    setChecking(true)
    fetch('/api/panel/updates')
      .then((response) => (response.ok ? (response.json() as Promise<PanelUpdates>) : null))
      .then(setUpdates)
      .catch(() => setUpdates(null))
      .finally(() => setChecking(false))
  }, [])

  useEffect(() => {
    let alive = true
    fetch('/api/panel')
      .then((response) => response.json() as Promise<Panel>)
      .then((loaded) => {
        if (!alive) return
        setPanel(loaded)
        loadUpdates(loaded.installed)
      })
      .catch(() => setError('Нет связи с API'))
    fetch('/api/panel/update')
      .then((response) => response.json() as Promise<PanelUpdateState>)
      .then((state) => {
        if (!alive) return
        setUpdate(state)
        // Панель перезапустилась посреди обновления — окно поднимается само, чтобы оператор
        // не гадал, чем оно кончилось.
        if (state.state === 'running') setRunning(true)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [loadUpdates])

  const chooseChannel = (channel: string) => {
    if (!panel || panel.channel === channel) return
    setPanel({ ...panel, channel })
    setUpdates(null)
    fetch('/api/panel/channel', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel }),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        loadUpdates(panel.installed)
      })
      .catch(() => setError('Канал не сохранился'))
  }

  const start = () => {
    setError(null)
    fetch('/api/panel/update', { method: 'POST' })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        setRunning(true)
      })
      .catch(() => setError('Обновление не запустилось'))
  }

  const copyLog = () => {
    if (!update) return
    void navigator.clipboard?.writeText(update.file)
    setCopied(true)
    setTimeout(() => setCopied(false), 3000)
  }

  if (!panel)
    return (
      <PanelShell>
        {error ? <p className="bases-error">{error}</p> : <PanelSkeleton shown={reveal.shown} />}
      </PanelShell>
    )

  // Отстала панель или нет, видно только по коду канала: номер версии поднимает человек, и он
  // его пропускает — по номерам ушедший вперёд канал выглядел бы прежним.
  const behind = !!updates && !!panel.published && updates.sha !== panel.published.sha
  const releases = updates?.releases ?? []
  // Исходников проекта на месте нет — собрать обновление не из чего, и кнопка ничего не сделает.
  const unavailable = panel.installed && !checking && !updates

  return (
    <PanelShell>
      <div className={withReveal('panel-card-body', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
        <div className="panel-row">
          <span className="panel-label">Канал</span>
          <div className="panel-channels" role="group" aria-label="Канал панели">
            {channels.map((channel) => (
              <button
                key={channel}
                type="button"
                aria-pressed={panel.channel === channel}
                className={panel.channel === channel ? 'panel-channel panel-channel-on' : 'panel-channel'}
                onClick={() => chooseChannel(channel)}
              >
                {channel}
              </button>
            ))}
          </div>
        </div>

        <div className="panel-divider" />

        <div className="panel-row">
          <span className="panel-label">Стоит</span>
          <span className="panel-build">{panel.published ? code(panel.published) : 'рабочая копия'}</span>
          {panel.published && <span className="panel-hint">собрана {built(panel.published.builtAt)}</span>}
        </div>

        {panel.installed && (
          <div className="panel-row panel-row-top">
            <span className="panel-label">В канале</span>
            {checking && <span className="panel-hint">Смотрим, что вышло…</span>}
            {!checking && !updates && (
              <span className="panel-hint">Исходники проекта недоступны — сравнить не с чем.</span>
            )}
            {!checking && updates && !behind && (
              <span className="panel-current">Новее в канале {panel.channel} пока нет</span>
            )}
            {!checking && updates && behind && releases.length > 0 && (
              <div className="panel-releases">
                <span className="panel-arrived">{waiting(releases.length)}</span>
                <ul>
                  {releases.map((release) => (
                    <li key={release.sha}>{release.title}</li>
                  ))}
                </ul>
              </div>
            )}
            {!checking && updates && behind && releases.length === 0 && (
              // Код разошёлся, а назвать нечего: панель собрана не из канала — так стоит приёмочная
              // сборка из ветки задачи. Считать ей задачи не по чему, а обновление вернёт её в канал.
              <span className="panel-arrived">
                Панель собрана не из канала {panel.channel} — обновление вернёт её в него
              </span>
            )}
          </div>
        )}

        {update?.state === 'failed' && !running && (
          <div className="panel-failed" role="alert">
            <strong>Обновление не удалось — панель осталась прежней</strong>
            <p>Сборка сорвалась до подмены, поэтому панель работает прежним кодом и ничего не потеряла.</p>
            <pre>{update.log.join('\n')}</pre>
            <div className="panel-failed-actions">
              <button type="button" className="bases-btn" onClick={copyLog}>
                {copied ? 'Путь скопирован' : 'Скопировать путь к журналу'}
              </button>
              <button type="button" className="bases-btn panel-primary" onClick={start}>
                Повторить
              </button>
            </div>
          </div>
        )}

        {error && <p className="bases-error" role="alert">{error}</p>}

        <div className="panel-row panel-row-actions">
          {!panel.installed && (
            <span className="panel-development">
              Это запуск для разработки — обновлять тут нечего. Обновляется постоянная панель, и кнопка живёт в ней.
            </span>
          )}
          {unavailable && (
            <span className="panel-development">
              Панель собирает обновление из исходников проекта. Их нет на месте, которое записано при установке, —
              обновиться отсюда не получится.
            </span>
          )}
          {panel.installed && !unavailable && (
            <>
              <span className="panel-hint panel-hint-grow">
                Обновление собирает панель заново и подменяет её: минуты две она будет недоступна, страница дождётся
                её сама.
              </span>
              <button type="button" className="bases-btn panel-primary" onClick={start}>
                {behind ? 'Обновить' : 'Собрать заново'}
              </button>
            </>
          )}
        </div>
      </div>

      {running && <UpdateProgress onFailed={(state) => {
        setRunning(false)
        setUpdate(state)
      }} />}
    </PanelShell>
  )
}

/** Карточка, пока панель читает, какая она: канал, сборка и кнопка полосами (макет B-201). */
function PanelSkeleton({ shown }: { shown: boolean }) {
  const row = (label: number, value: number, height = 12) => (
    <div className="panel-row">
      <span className="panel-label">
        <Sk w={label} h={10} />
      </span>
      <Sk w={value} h={height} />
    </div>
  )
  return (
    <Skeleton label="Загрузка сведений о панели" shown={shown} className="panel-card-body">
      {row(46, 170, 36)}
      <div className="panel-divider" />
      {row(40, 150)}
      {row(58, 210)}
      <div className="panel-row">
        <Sk w="60%" h={9} />
        <span style={{ flex: 1 }} />
        <Sk w={120} h={32} style={{ borderRadius: 6 }} />
      </div>
    </Skeleton>
  )
}

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="settings-card" aria-labelledby="settings-panel">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-panel">Панель</h3>
          <p className="settings-lead">Какой панель собрана и как она обновляется.</p>
        </div>
      </div>
      {children}
    </section>
  )
}

/**
 * Окно хода обновления. В середине панель подменяется и перестаёт отвечать — это часть работы,
 * а не поломка: окно ждёт её возвращения и перезагружает страницу уже на новой сборке.
 */
function UpdateProgress({ onFailed }: { onFailed: (state: PanelUpdateState) => void }) {
  const [state, setState] = useState<PanelUpdateState | null>(null)
  const [gone, setGone] = useState(false)
  const failed = useRef(onFailed)
  // Ref обновляется эффектом, а не в рендере: опрос заводится один раз и не перезапускается
  // из-за того, что родитель отдал новую функцию.
  useEffect(() => {
    failed.current = onFailed
  }, [onFailed])

  useEffect(() => {
    let alive = true
    const tick = () => {
      fetch('/api/panel/update')
        .then((response) => response.json() as Promise<PanelUpdateState>)
        .then((update) => {
          if (!alive) return
          setGone(false)
          setState(update)
          if (update.state === 'done') window.location.reload()
          if (update.state === 'failed') failed.current(update)
        })
        // Связи нет — панель подменяется. Ждём, пока поднимется, и перезагружаем страницу.
        .catch(() => alive && setGone(true))
    }
    tick()
    const timer = setInterval(tick, pollMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  return (
    <div className="panel-overlay" role="dialog" aria-modal="true" aria-labelledby="panel-update-title">
      <div className="panel-window">
        <h3 id="panel-update-title">{gone ? 'Панель перезапускается' : 'Панель обновляется'}</h3>
        <div className="panel-progress">
          <div className="panel-progress-bar" />
        </div>
        {gone ? (
          <p className="panel-hint">
            Каталог подменён, панель поднимается заново. Связи с ней сейчас нет — это часть обновления, а не сбой. Как
            ответит, страница перезагрузится сама.
          </p>
        ) : (
          <pre className="panel-log">{state?.log.join('\n') ?? 'Запускаем обновление…'}</pre>
        )}
      </div>
    </div>
  )
}

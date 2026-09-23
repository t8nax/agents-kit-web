import { useCallback, useEffect, useRef, useState } from 'react'
import './PanelCard.css'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'

export type PanelBuild = {
  channel: string
  sha: string
  version: string
  builtAt: string
}

export type Panel = {
  installed: boolean
  channel: string
  published: PanelBuild | null
}

export type PanelRelease = {
  version: string
  tag: string
  tasks: string[]
}

/** Latest — самый свежий выпуск канала, releases — выпуски новее стоящей панели, новые первыми. */
export type PanelUpdates = {
  latest: string | null
  releases: PanelRelease[]
}

export type PanelUpdateState = {
  state: 'none' | 'running' | 'done' | 'failed'
  log: string[]
  file: string
  release?: string | null
  downloaded?: number | null
  total?: number | null
  installing?: boolean
}

/** Ветки каналов оператору ничего не говорят: в карточке они названы по тому, что в них выходит. */
const channels = [
  { id: 'master', name: 'Стабильный' },
  { id: 'dev', name: 'Бета' },
] as const

const channelName = (id: string) => channels.find((channel) => channel.id === id)?.name ?? id

/** Пока идёт обновление, панель подменяется и на минуту перестаёт отвечать — опрос это переживает. */
const pollMs = 1500

const built = (at: string) =>
  new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/** «11,2 из 18,4 МБ» — сколько архива выпуска скачано. */
const megabytes = (bytes: number) =>
  (bytes / 1024 / 1024).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })

/** «1 задача ждёт», «2 задачи ждут», «5 задач ждут» — иначе счёт читается не по-русски. */
const waiting = (count: number) => {
  const tail = count % 100
  if (tail % 10 === 1 && tail !== 11) return `${count} задача ждёт обновления`
  if (tail % 10 >= 2 && tail % 10 <= 4 && (tail < 12 || tail > 14)) return `${count} задачи ждут обновления`
  return `${count} задач ждут обновления`
}

/**
 * Карточка «Панель» в «Настройках»: какой номер стоит, какой вышел в канале, что приехало с каждым
 * выпуском и кнопка обновления — она скачивает готовую сборку с GitHub. В запуске для разработки
 * обновлять нечего — панель говорит это вместо кнопки.
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

  const releases = updates?.releases ?? []
  const behind = releases.length > 0
  const tasks = releases.reduce((count, release) => count + release.tasks.length, 0)

  return (
    <PanelShell>
      <div className={withReveal('panel-card-body', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
        <div className="panel-row">
          <span className="panel-label">Канал</span>
          <div className="panel-channels" role="group" aria-label="Канал панели">
            {channels.map((channel) => (
              <button
                key={channel.id}
                type="button"
                aria-pressed={panel.channel === channel.id}
                className={panel.channel === channel.id ? 'panel-channel panel-channel-on' : 'panel-channel'}
                onClick={() => chooseChannel(channel.id)}
              >
                {channel.name}
              </button>
            ))}
          </div>
        </div>

        <div className="panel-divider" />

        <div className="panel-row">
          <span className="panel-label">Стоит</span>
          <span className="panel-build">{panel.published ? panel.published.version : 'рабочая копия'}</span>
          {panel.published && <span className="panel-hint">собрана {built(panel.published.builtAt)}</span>}
        </div>

        {panel.installed && (
          <div className={behind ? 'panel-row panel-row-top' : 'panel-row'}>
            <span className="panel-label">Вышла</span>
            {checking && <span className="panel-hint">Смотрим, что вышло…</span>}
            {!checking && !updates && <span className="panel-hint">GitHub не ответил — сравнить сейчас не с чем.</span>}
            {!checking && updates && !updates.latest && (
              <span className="panel-hint">В канале «{channelName(panel.channel)}» ещё нет ни одного выпуска.</span>
            )}
            {!checking && updates?.latest && !behind && (
              <>
                <span className="panel-build">{updates.latest}</span>
                <span className="panel-current">Новее в канале «{channelName(panel.channel)}» пока нет</span>
              </>
            )}
            {!checking && updates?.latest && behind && (
              <div className="panel-news">
                <div className="panel-news-top">
                  <span className="panel-build">{updates.latest}</span>
                  {tasks > 0 && <span className="panel-arrived">{waiting(tasks)}</span>}
                </div>
                <div className="panel-releases">
                  {releases.length === 1 ? (
                    <Tasks tasks={releases[0].tasks} />
                  ) : (
                    releases.map((release) => (
                      <div key={release.tag} className="panel-release">
                        <span className="panel-release-num">{release.version}</span>
                        <Tasks tasks={release.tasks} />
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {update?.state === 'failed' && !running && (
          <div className="panel-failed" role="alert">
            <strong>Обновление не удалось — панель осталась прежней</strong>
            <p>Установка сорвалась до подмены, поэтому панель работает прежней сборкой и ничего не потеряла.</p>
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

        {!panel.installed && (
          <div className="panel-row panel-row-actions">
            <span className="panel-development">
              Это запуск для разработки — обновлять тут нечего. Обновляется постоянная панель, и кнопка живёт в ней.
            </span>
          </div>
        )}
        {panel.installed && behind && (
          <div className="panel-row panel-row-actions">
            <span className="panel-hint panel-hint-grow">
              На время обновления панель станет недоступна — страница дождётся её сама.
            </span>
            <button type="button" className="bases-btn panel-primary" onClick={start}>
              Обновить
            </button>
          </div>
        )}
      </div>

      {running && <UpdateProgress onFailed={(state) => {
        setRunning(false)
        setUpdate(state)
      }} />}
    </PanelShell>
  )
}

function Tasks({ tasks }: { tasks: string[] }) {
  return (
    <ul>
      {tasks.map((task, index) => (
        <li key={index}>{task}</li>
      ))}
    </ul>
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
 * Окно хода обновления: два шага — скачать сборку, сколько скачано из скольких, и поставить её.
 * В середине панель подменяется и перестаёт отвечать — это часть работы, а не поломка: окно ждёт
 * её возвращения и перезагружает страницу уже на новой сборке.
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
          <ul className="panel-steps">
            <li className={state?.installing ? 'done' : 'now'}>
              <span className="mark" />
              Скачать сборку{state?.release ? ` ${state.release}` : ''}
              {state?.total ? (
                <span className="size">
                  {megabytes(state.downloaded ?? 0)} из {megabytes(state.total)} МБ
                </span>
              ) : null}
            </li>
            <li className={state?.installing ? 'now' : undefined}>
              <span className="mark" />
              Поставить сборку
            </li>
          </ul>
        )}
      </div>
    </div>
  )
}

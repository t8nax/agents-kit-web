import { useCallback, useEffect, useRef, useState } from 'react'
import './PanelCard.css'

export type PanelBuild = {
  channel: string
  sha: string
  version: string
  builtAt: string
}

export type Panel = {
  version: string
  installed: boolean
  channel: string
  published: PanelBuild | null
}

export type PanelRelease = {
  version: string
  title: string
}

export type PanelUpdates = {
  latest: string
  sha: string
  releases: PanelRelease[]
}

export type PanelUpdateState = {
  state: 'none' | 'running' | 'done' | 'failed'
  version: string | null
  log: string[]
  file: string
}

const channels = ['master', 'dev'] as const

/** Пока идёт обновление, панель подменяется и на минуту перестаёт отвечать — опрос это переживает. */
const pollMs = 1500

const built = (at: string) =>
  new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })

/**
 * Карточка «Панель» в «Настройках»: какая версия стоит, какая вышла в канале и кнопка обновления.
 * В запуске для разработки обновлять нечего — панель говорит это вместо кнопки.
 */
export default function PanelCard() {
  const [panel, setPanel] = useState<Panel | null>(null)
  const [updates, setUpdates] = useState<PanelUpdates | null>(null)
  const [checking, setChecking] = useState(false)
  const [update, setUpdate] = useState<PanelUpdateState | null>(null)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
        {error ? <p className="bases-error">{error}</p> : <p className="settings-lead">Загрузка…</p>}
      </PanelShell>
    )

  const version = panel.published?.version ?? panel.version
  const latest = updates?.latest
  // Отстала панель или нет, видно только по коду канала: номер версии поднимает человек, и он
  // его пропускает — по номерам ушедший вперёд канал выглядел бы прежним.
  const behind = !!updates && !!panel.published && updates.sha !== panel.published.sha
  const releases = updates?.releases ?? []
  // Исходников проекта на месте нет — собрать обновление не из чего, и кнопка ничего не сделает.
  const unavailable = panel.installed && !checking && !updates

  return (
    <PanelShell>
      <div className="panel-card-body">
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
          <span className="panel-hint">
            master — принятое и слитое;
            <br />
            dev — свежее, ещё не в master.
          </span>
        </div>

        <div className="panel-divider" />

        <div className="panel-row">
          <span className="panel-label">Стоит</span>
          <span className="panel-version">{version}</span>
          <span className="panel-hint">
            {panel.published
              ? `собрана ${built(panel.published.builtAt)} · ${panel.published.channel} ${panel.published.sha.slice(0, 7)}`
              : 'из рабочей копии'}
          </span>
        </div>

        {panel.installed && (
          <div className="panel-row panel-row-top">
            <span className="panel-label">Вышла</span>
            {checking && <span className="panel-hint">Смотрим, что вышло…</span>}
            {!checking && !updates && (
              <span className="panel-hint">Исходники проекта недоступны — сравнить не с чем.</span>
            )}
            {!checking && updates && !behind && (
              <span className="panel-current">{latest} — новее в канале {panel.channel} пока нет</span>
            )}
            {!checking && updates && behind && (
              <div className="panel-releases">
                <span className="panel-version panel-version-new">{latest}</span>
                {releases.length > 0 ? (
                  <ul>
                    {releases.map((release) => (
                      <li key={release.version}>
                        <span className="panel-release-version">{release.version}</span>
                        {release.title}
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Номер не подняли — перечислять нечего, и панель говорит это словами.
                  <span className="panel-hint">
                    в канале {panel.channel} есть работа, за которой номер версии не подняли
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {update?.state === 'failed' && !running && (
          <div className="panel-failed" role="alert">
            <strong>Обновление не удалось — панель осталась на {version}</strong>
            <p>Сборка сорвалась до подмены, поэтому панель работает прежней версией и ничего не потеряла.</p>
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
                Обновление собирает версию и подменяет панель: минуты две она будет недоступна, страница дождётся её
                сама.
              </span>
              <button type="button" className="bases-btn panel-primary" onClick={start}>
                {behind ? (latest === version ? 'Обновить' : `Обновить до ${latest}`) : 'Собрать заново'}
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

function PanelShell({ children }: { children: React.ReactNode }) {
  return (
    <section className="settings-card" aria-labelledby="settings-panel">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-panel">Панель</h3>
          <p className="settings-lead">Какая версия панели стоит и как она обновляется.</p>
        </div>
      </div>
      {children}
    </section>
  )
}

/**
 * Окно хода обновления. В середине панель подменяется и перестаёт отвечать — это часть работы,
 * а не поломка: окно ждёт её возвращения и перезагружает страницу уже на новой версии.
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
          <>
            <pre className="panel-log">{state?.log.join('\n') ?? 'Запускаем обновление…'}</pre>
            <p className="panel-hint">
              Когда дойдёт до подмены, панель на минуту пропадёт — страница дождётся её и вернётся сама.
            </p>
          </>
        )}
      </div>
    </div>
  )
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import DeleteTrackerServerModal from './DeleteTrackerServerModal'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'
import './TrackerServersCard.css'

/** Сервер трекера в «Настройках»: адрес и логин владельца ключа; сам ключ страница не получает. */
export type TrackerServer = { server: string; login: string }

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; value: TrackerServer[] }

/** Отказ сохранить ключ: текст и поле, к которому он относится. */
type Refusal = { text: string; field: 'server' | 'key' | null }

/**
 * Причины отказа API словами: ключ сохраняется, только когда сервер назвал его владельца —
 * решение оператора на B-288.
 */
function refusalOf(problem: string, detail: string | null | undefined): Refusal {
  switch (problem) {
    case 'empty-server':
      return { text: 'Введите адрес сервера, например https://acme.youtrack.cloud.', field: 'server' }
    case 'not-address':
      return {
        text: 'Адрес сервера — вида https://хост или https://хост/путь, без логина, пароля и параметров.',
        field: 'server',
      }
    case 'empty-key':
      return { text: 'Введите ключ — постоянный токен из профиля в трекере.', field: 'key' }
    case 'duplicate':
      return { text: 'Этот сервер уже в списке — замените у него ключ.', field: 'server' }
    case 'key-rejected':
      return {
        text: 'Сервер отклонил ключ, ключ не сохранён. Проверьте, что ключ скопирован полностью и действует.',
        field: 'key',
      }
    case 'key-forbidden':
      return {
        text: 'Сервер не дал владельцу ключа доступа, ключ не сохранён. Проверьте права владельца ключа в YouTrack.',
        field: 'key',
      }
    case 'file-broken':
      return { text: brokenText(detail), field: null }
    case 'server-silent':
      return {
        text: `Сервер не ответил: ${detail ?? 'нет связи'}. Ключ не сохранён. Проверьте адрес сервера и подключение к сети.`,
        field: 'server',
      }
    default:
      return { text: `Сервер отказал: ${detail ?? problem}. Ключ не сохранён.`, field: null }
  }
}

/** Файл серверов с ключами не разобран: панель его не перезаписывает, поправить или удалить его — оператору. */
function brokenText(file: string | null | undefined): string {
  return `Файл серверов трекеров не разобран${file ? `: ${file}` : ''}. Поправьте или удалите его — после удаления ключи придётся ввести заново.`
}

async function refusalFrom(response: Response): Promise<Refusal> {
  if (response.status === 400 || response.status === 409 || response.status === 500) {
    const body = (await response.json()) as { problem: string; detail?: string | null }
    return refusalOf(body.problem, body.detail)
  }
  if (response.status === 404) return { text: 'Этого сервера больше нет в списке — добавьте его заново.', field: null }
  return { text: `Ключ не сохранён: HTTP ${response.status}.`, field: null }
}

/** Карточка «Серверы трекеров»: адреса серверов и ключи оператора к ним (B-288, макет в памяти задачи). */
export default function TrackerServersCard() {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const reveal = useReveal(load.kind === 'loading')
  const [server, setServer] = useState('')
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [rekey, setRekey] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<TrackerServer | null>(null)

  useEffect(() => {
    fetch('/api/trackers')
      .then(async (response) => {
        if (response.status === 500) {
          const body = (await response.json().catch(() => null)) as { problem?: string; detail?: string } | null
          if (body?.problem === 'file-broken') throw new Error(brokenText(body.detail))
        }
        if (!response.ok) throw new Error(`Список серверов не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<TrackerServer[]>
      })
      .then((value) => setLoad({ kind: 'loaded', value }))
      .catch((e: unknown) =>
        setLoad({
          kind: 'failed',
          message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
        }),
      )
  }, [])

  const servers = load.kind === 'loaded' ? load.value : []

  function saved(entry: TrackerServer) {
    setLoad((prev) => {
      const list = prev.kind === 'loaded' ? prev.value : []
      return {
        kind: 'loaded',
        value: list.some((s) => s.server === entry.server)
          ? list.map((s) => (s.server === entry.server ? entry : s))
          : [...list, entry],
      }
    })
  }

  async function add(event: FormEvent) {
    event.preventDefault()
    if (checking) return
    setRefusal(null)
    setChecking(server.trim())
    try {
      const response = await fetch('/api/trackers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server, key }),
      })
      if (response.ok) {
        saved((await response.json()) as TrackerServer)
        setServer('')
        setKey('')
        return
      }
      setRefusal(await refusalFrom(response))
    } catch {
      setRefusal({ text: 'Ключ не сохранён: нет связи с API.', field: null })
    } finally {
      setChecking(null)
    }
  }

  return (
    <section className="settings-card trk-card" aria-labelledby="settings-trackers">
      <div className="settings-card-head">
        <div>
          <h3 id="settings-trackers">Серверы трекеров</h3>
          <p className="settings-lead">Серверы трекеров задач и ваши ключи доступа к ним.</p>
        </div>
      </div>
      <div className="bases-body">
        {load.kind === 'loading' && (
          <Skeleton label="Загрузка серверов трекеров" shown={reveal.shown}>
            <ul className="bases-list sk-frame">
              <li>
                <Sk w="42%" h={10} style={{ flex: 'none' }} />
                <span style={{ flex: 1 }} />
                <Sk w={120} h={9} />
                <Sk w={200} h={26} style={{ borderRadius: 6 }} />
              </li>
            </ul>
          </Skeleton>
        )}
        {load.kind === 'failed' && (
          <p className="bases-error" role="alert">
            {load.message}
          </p>
        )}
        {load.kind === 'loaded' && (
          <>
            <ul className={withReveal('bases-list', reveal)} onAnimationEnd={reveal.onAnimationEnd} aria-label="Серверы трекеров">
              {servers.length === 0 && <li className="bases-empty">Список пуст.</li>}
              {servers.map((entry) => (
                <ServerRow
                  key={entry.server}
                  entry={entry}
                  editing={rekey === entry.server}
                  onRekey={() => setRekey(entry.server)}
                  onCancel={() => setRekey(null)}
                  onSaved={(next) => {
                    saved(next)
                    setRekey(null)
                  }}
                  onDelete={() => setDeleting(entry)}
                />
              ))}
            </ul>
            <form className={withReveal('bases-add', reveal)} onAnimationEnd={reveal.onAnimationEnd} onSubmit={add} noValidate>
              <div className="trk-add-row">
                <div className="trk-field">
                  <label htmlFor="trk-new-server">Адрес сервера</label>
                  <input
                    id="trk-new-server"
                    type="text"
                    value={server}
                    placeholder="https://acme.youtrack.cloud"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={refusal?.field === 'server' ? true : undefined}
                    aria-describedby={refusal ? 'trk-add-error' : undefined}
                    onChange={(e) => {
                      setServer(e.target.value)
                      setRefusal(null)
                    }}
                  />
                </div>
                <div className="trk-field">
                  <label htmlFor="trk-new-key">Ключ</label>
                  <input
                    id="trk-new-key"
                    type="password"
                    value={key}
                    placeholder="Постоянный токен"
                    autoComplete="off"
                    aria-invalid={refusal?.field === 'key' ? true : undefined}
                    aria-describedby={refusal ? 'trk-add-error' : undefined}
                    onChange={(e) => {
                      setKey(e.target.value)
                      setRefusal(null)
                    }}
                  />
                </div>
                <button type="submit" className="bases-btn" disabled={checking !== null}>
                  Добавить
                </button>
              </div>
              {checking !== null && (
                <p className="settings-note">
                  Ключ проверяется на сервере <span className="mono trk-nowrap">{checking}</span>…
                </p>
              )}
              {refusal && (
                <div className="bases-error" id="trk-add-error" role="alert">
                  {refusal.text}
                </div>
              )}
            </form>
          </>
        )}
      </div>
      {deleting && (
        <DeleteTrackerServerModal
          entry={deleting}
          onClose={() => setDeleting(null)}
          onRemoved={() => {
            setLoad({ kind: 'loaded', value: servers.filter((s) => s.server !== deleting.server) })
            setDeleting(null)
          }}
        />
      )}
    </section>
  )
}

type RowProps = {
  entry: TrackerServer
  editing: boolean
  onRekey: () => void
  onCancel: () => void
  onSaved: (entry: TrackerServer) => void
  onDelete: () => void
}

/** Строка сервера: адрес сжимается и обрезается многоточием, логин и кнопки — никогда (макет B-288, круг 4). */
function ServerRow({ entry, editing, onRekey, onCancel, onSaved, onDelete }: RowProps) {
  return (
    <li className={editing ? 'trk-editing' : undefined}>
      <span className="trk-url mono" title={entry.server}>
        {entry.server}
      </span>
      <span className="bases-meta trk-key-meta">
        <KeyIcon />
        ключ пользователя <span className="mono">{entry.login}</span>
      </span>
      {!editing && (
        <>
          <button type="button" className="bases-btn bases-btn-small" aria-label={`Заменить ключ ${entry.server}`} onClick={onRekey}>
            Заменить ключ
          </button>
          <button
            type="button"
            className="bases-btn bases-btn-small bases-btn-danger"
            aria-label={`Удалить ${entry.server}`}
            onClick={onDelete}
          >
            <TrashIcon />
            Удалить
          </button>
        </>
      )}
      {editing && <RekeyForm entry={entry} onCancel={onCancel} onSaved={onSaved} />}
    </li>
  )
}

/** Замена ключа под строкой сервера: новый ключ проходит ту же проверку, что при добавлении. */
function RekeyForm({ entry, onCancel, onSaved }: Pick<RowProps, 'entry' | 'onCancel' | 'onSaved'>) {
  const [key, setKey] = useState('')
  const [checking, setChecking] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const id = `trk-rekey-${entry.server.replace(/[^A-Za-z0-9]/g, '-')}`

  useEffect(() => input.current?.focus(), [])

  async function save(event: FormEvent) {
    event.preventDefault()
    if (checking) return
    setRefusal(null)
    setChecking(true)
    try {
      const response = await fetch('/api/trackers/key', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ server: entry.server, key }),
      })
      if (response.ok) {
        onSaved((await response.json()) as TrackerServer)
        return
      }
      setRefusal(await refusalFrom(response))
    } catch {
      setRefusal({ text: 'Ключ не сохранён: нет связи с API.', field: null })
    } finally {
      setChecking(false)
    }
  }

  return (
    <form className="trk-rekey" onSubmit={save} noValidate>
      <label className="settings-note" htmlFor={id}>
        Новый ключ
      </label>
      <div className="bases-add-row">
        <input
          ref={input}
          id={id}
          type="password"
          value={key}
          autoComplete="off"
          aria-invalid={refusal?.field ? true : undefined}
          aria-describedby={refusal ? `${id}-error` : undefined}
          onChange={(e) => {
            setKey(e.target.value)
            setRefusal(null)
          }}
        />
        <button type="button" className="bases-btn" disabled={checking} onClick={onCancel}>
          Отмена
        </button>
        <button type="submit" className="bases-btn" disabled={checking}>
          Сохранить
        </button>
      </div>
      {checking && (
        <p className="settings-note">
          Ключ проверяется на сервере <span className="mono trk-nowrap">{entry.server}</span>…
        </p>
      )}
      {refusal && (
        <div className="bases-error" id={`${id}-error`} role="alert">
          {refusal.text}
        </div>
      )}
    </form>
  )
}

function KeyIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="M10.7 12.3 21 2M16 7l3 3M19 4l2 2" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}

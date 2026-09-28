import { useEffect, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import type { AgentKind, AgentRequestSummary } from './agentRequest'
import './AgentBar.css'

/** Как часто панель перечитывает свои просьбы — тем же шагом, что и таблицу копий. */
const refreshIntervalMs = 3000

// Имя агента панели носят все просьбы, вопрос по базе тоже, — замечание оператора на приёмке B-52.
const running: Record<AgentKind, (project: string) => string> = {
  ask: (project) => `${AGENT_NAME} читает базу ${project}`,
  backlog: (project) => `${AGENT_NAME} разбирает бэклог ${project}`,
  flow: (project) => `${AGENT_NAME} разбирает флоу ${project}`,
  performer: (project) => `${AGENT_NAME} заводит исполнителя ${project}`,
}

const done: Record<AgentKind, (project: string) => string> = {
  ask: (project) => `${AGENT_NAME} ответил по базе ${project}`,
  backlog: (project) => `${AGENT_NAME} ответил по бэклогу ${project}`,
  flow: (project) => `${AGENT_NAME} ответил по флоу ${project}`,
  performer: (project) => `${AGENT_NAME} завёл исполнителя ${project}`,
}

const failed: Record<AgentKind, (project: string) => string> = {
  ask: (project) => `${AGENT_NAME} не ответил по базе ${project}`,
  backlog: (project) => `${AGENT_NAME} не ответил по бэклогу ${project}`,
  flow: (project) => `${AGENT_NAME} не ответил по флоу ${project}`,
  performer: (project) => `${AGENT_NAME} не завёл исполнителя ${project}`,
}

// Просьба о правке заведённого исполнителя называет его: по ней отметка ведёт в его правку, а не в нового (B-80).
const rewriting = {
  running: (name: string, project: string) => `${AGENT_NAME} переписывает исполнителя ${name} ${project}`,
  done: (name: string, project: string) => `${AGENT_NAME} переписал исполнителя ${name} ${project}`,
  failed: (name: string, project: string) => `${AGENT_NAME} не переписал исполнителя ${name} ${project}`,
}

function title(request: AgentRequestSummary) {
  if (request.kind === 'performer' && request.subject) return rewriting[request.state](request.subject, request.project)
  const words = request.state === 'running' ? running : request.state === 'done' ? done : failed
  return words[request.kind](request.project)
}

/**
 * Идущие просьбы к агенту в шапке панели: пока агент занят, видно, чем и сколько времени, а готовый итог
 * ждёт оператора здесь же. Отсюда же открывается окно просьбы — то самое, что оператор закрыл.
 */
export default function AgentBar({ onOpen }: { onOpen: (request: AgentRequestSummary) => void }) {
  const [requests, setRequests] = useState<AgentRequestSummary[]>([])
  const [readAt, setReadAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let alive = true
    const read = () =>
      fetch('/api/agent/requests')
        .then((response) => (response.ok ? (response.json() as Promise<AgentRequestSummary[]>) : []))
        .then(
          (list) => {
            if (!alive) return
            setRequests(list)
            setReadAt(Date.now())
          },
          () => {},
        )
    void read()
    const timer = setInterval(read, refreshIntervalMs)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // Время идущей просьбы тикает само: панель говорит, сколько она шла к моменту ответа.
  useEffect(() => {
    if (!requests.some((request) => request.state === 'running')) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [requests])

  if (requests.length === 0) return null

  const busy = requests.filter((request) => request.state === 'running')
  const only = requests.length === 1 ? requests[0] : null
  const state = busy.length > 0 ? 'running' : requests.some((r) => r.state === 'failed') ? 'failed' : 'done'

  function pick(request: AgentRequestSummary) {
    setOpen(false)
    onOpen(request)
  }

  return (
    <div className="agent-bar">
      <button
        type="button"
        className={`agent-chip ${state}`}
        aria-expanded={only ? undefined : open}
        onClick={() => (only ? pick(only) : setOpen((shown) => !shown))}
      >
        {state === 'running' ? <Spinner /> : <span className="agent-dot" aria-hidden="true" />}
        <span className="agent-chip-text">
          {only ? title(only) : busy.length > 0 ? `${AGENT_NAME} занят` : 'Итоги ждут вас'}
        </span>
        {only?.state === 'running' && <Elapsed since={only.elapsedMs} read={readAt} now={now} />}
        {!only && <span className="agent-count">{requests.length}</span>}
      </button>

      {!only && open && (
        <ul className="agent-list" aria-label="Просьбы">
          {requests.map((request) => (
            <li key={request.kind}>
              <button type="button" className="agent-row" onClick={() => pick(request)}>
                {request.state === 'running' ? <Spinner /> : <span className={`agent-dot ${request.state}`} aria-hidden="true" />}
                <span className="agent-row-what">
                  <span className="agent-row-title">{title(request)}</span>
                  <span className="agent-row-text">{request.text}</span>
                </span>
                {request.state === 'running' ? (
                  <Elapsed since={request.elapsedMs} read={readAt} now={now} />
                ) : (
                  <span className={`agent-row-state ${request.state}`}>
                    {request.state === 'done' ? 'готов' : 'не вышло'}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Spinner() {
  return <span className="agent-spinner" aria-hidden="true" />
}

function Elapsed({ since, read, now }: { since: number; read: number; now: number }) {
  const seconds = Math.max(0, Math.floor((since + Math.max(0, now - read)) / 1000))
  return (
    <span className="agent-elapsed" aria-label="Просьба идёт">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { AgentRequestSummary, Started } from './agentRequest'

/** Событие переписки: реплика оператора, ход работы агента, его ответ, сбой или слово панели о разговоре. */
export type AskEvent =
  | { type: 'reply'; text: string }
  | { type: 'step'; text: string }
  | { type: 'note'; text: string }
  | { type: 'stopped'; text: string }
  | { type: 'answer'; text: string; files?: string[]; durationMs?: number }
  | { type: 'error'; text: string; output?: string }

/** Через сколько окно дочитывает оборванный поток разговора. */
const reconnectDelay = 500

/** Разговор ещё в панели: по этому окно отличает оборванную связь от убранной просьбы. */
async function alive(id: string) {
  try {
    const response = await fetch('/api/agent/requests')
    if (!response.ok) return false
    const list = (await response.json()) as { kind: string; id: string }[]
    return list.some((request) => request.kind === 'ask' && request.id === id)
  } catch {
    return false
  }
}

/**
 * Разговор с агентом по базе. Переписку держит панель, а окно её только показывает: открытое заново, оно
 * читает её с начала — вместе с ответом, пришедшим без него. Закрытие окна разговор не трогает, убирает его
 * только «Новая переписка» — решения оператора на B-79.
 */
export function useAgentConversation() {
  const [events, setEvents] = useState<AskEvent[]>([])
  const [base, setBase] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [retry, setRetry] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(true)
  const reading = useRef<AbortController | null>(null)

  const follow = useCallback(async function watch(summary: AgentRequestSummary, from = 0): Promise<void> {
    reading.current?.abort()
    const controller = new AbortController()
    reading.current = controller
    setBase(summary.base)
    setFailure(null)
    if (from === 0) {
      setEvents([])
      setRetry(null)
    }
    let answering = summary.state === 'running'
    setRunning(answering)
    // Время реплики идёт от её начала, а не от открытия окна: сколько агент отвечает, знает панель.
    setStartedAt(Date.now() - summary.elapsedMs)

    try {
      const response = await fetch(`/api/agent/ask/stream?id=${summary.id}&from=${from}`, {
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        setRunning(false)
        setFailure('Панель потеряла разговор: его больше нет в списке')
        return
      }

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      let restored = from > 0
      let said: string | null = null
      let seen = from
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += value
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        const chunk: AskEvent[] = []
        for (const line of lines) {
          if (!line.trim()) continue
          const event = JSON.parse(line) as AskEvent
          chunk.push(event)
          if (event.type === 'reply') {
            answering = true
            said = event.text
            setRetry(null)
            setStartedAt(Date.now())
          }
          // Ответ кончает и отмена: агента, которого оборвал оператор, окно ждать не должно — B-109.
          if (event.type === 'answer' || event.type === 'error' || event.type === 'stopped') answering = false
          // Реплика, на которой агент сорвался, возвращается оператору в поле: отправить её ещё раз — одно нажатие.
          if (event.type === 'error') setRetry(said)
        }
        if (chunk.length > 0) setEvents((prev) => [...prev, ...chunk])
        seen += chunk.length
        setRunning(answering)
        if (!restored) {
          restored = true
          // Первым куском пришла вся прошлая переписка: время нынешней реплики берётся у панели, а не у него.
          if (answering) setStartedAt(Date.now() - summary.elapsedMs)
        }
      }
      // Поток кончился: разговор мог уйти из панели, а мог просто оборваться — тогда окно дочитывает его
      // дальше с того же места, и ход работы агента не теряется.
      await new Promise((wake) => setTimeout(wake, reconnectDelay))
      if (controller.signal.aborted) return
      if (await alive(summary.id)) {
        void watch(summary, seen)
        return
      }
      setRunning(false)
      if (answering) setFailure('Ответ оборвался: API закрыл поток без ответа агента')
    } catch (error) {
      if (controller.signal.aborted) return
      setRunning(false)
      setFailure(error instanceof SyntaxError ? 'API прислал непонятный ответ' : 'Нет связи с API')
    }
  }, [])

  // Окно открылось: идущий или дождавшийся разговор подхватывается с начала.
  useEffect(() => {
    let alive = true
    fetch('/api/agent/requests')
      .then((response) => (response.ok ? (response.json() as Promise<AgentRequestSummary[]>) : []))
      .then(
        (list) => {
          if (!alive) return
          setRestoring(false)
          const mine = list.find((request) => request.kind === 'ask')
          if (mine) void follow(mine)
        },
        () => alive && setRestoring(false),
      )
    return () => {
      alive = false
      // Закрытое окно перестаёт читать поток, но разговор не трогает: агент остаётся с ним.
      reading.current?.abort()
    }
  }, [follow])

  /** Первый вопрос: заводит разговор по выбранной базе. */
  const start = useCallback(
    async (basePath: string, question: string): Promise<Started> => {
      try {
        const response = await fetch('/api/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ base: basePath, question }),
        })
        if (!response.ok) return { ok: false, status: response.status }
        const summary = (await response.json()) as AgentRequestSummary
        void follow(summary)
        return { ok: true }
      } catch {
        return { ok: false, status: null }
      }
    },
    [follow],
  )

  /** Следующая реплика уходит в тот же разговор: в переписке она появится его же потоком. */
  const send = useCallback(async (text: string): Promise<Started> => {
    try {
      const response = await fetch('/api/ask/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      return response.ok ? { ok: true } : { ok: false, status: response.status }
    } catch {
      return { ok: false, status: null }
    }
  }, [])

  /** «Отменить»: нынешний ответ обрывается, а переписка остаётся — её продолжает следующая реплика. */
  const stop = useCallback(async () => {
    try {
      await fetch('/api/ask/stop', { method: 'POST' })
    } catch {
      // Панель недоступна: остановить агента нечем, и окно скажет об этом сбоем чтения потока.
    }
  }, [])

  /** Новая переписка: прежний разговор уходит из панели вместе со своим агентом. */
  const forget = useCallback(async () => {
    reading.current?.abort()
    reading.current = null
    setEvents([])
    setBase(null)
    setRunning(false)
    setStartedAt(null)
    setFailure(null)
    setRetry(null)
    try {
      await fetch('/api/agent/ask', { method: 'DELETE' })
    } catch {
      // Панель недоступна: разговор уйдёт вместе с ней, показывать оператору нечего.
    }
  }, [])

  return { events, base, running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure }
}

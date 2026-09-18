import { useCallback, useEffect, useRef, useState } from 'react'

/** Виды просьб к агенту: разом идёт по одной каждого вида — решение оператора на B-52. */
export type AgentKind = 'ask' | 'backlog' | 'flow'

export type AgentRequestSummary = {
  kind: AgentKind
  id: string
  base: string
  project: string
  text: string
  elapsedMs: number
  state: 'running' | 'done' | 'failed'
}

/** Событие просьбы: «step» — ход работы агента, любое другое — её итог. */
export type AgentEvent = { type: string; text: string }

export type Started = { ok: true } | { ok: false; status: number | null }

/**
 * Просьба живёт в панели, а не в окне: окно её только показывает. Открытое заново, оно читает ход просьбы
 * с начала — вместе с тем, что пришло без него, — и ждёт продолжения. Закрытие окна агента не трогает:
 * останавливает его «Отменить», то есть cancel.
 */
export function useAgentRequest<E extends AgentEvent>(kind: AgentKind) {
  const [asked, setAsked] = useState('')
  const [base, setBase] = useState<string | null>(null)
  const [steps, setSteps] = useState<string[]>([])
  const [outcome, setOutcome] = useState<E | null>(null)
  const [running, setRunning] = useState(false)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(true)
  const reading = useRef<AbortController | null>(null)

  const follow = useCallback(
    async (summary: AgentRequestSummary) => {
      reading.current?.abort()
      const controller = new AbortController()
      reading.current = controller
      setAsked(summary.text)
      setBase(summary.base)
      setSteps([])
      setOutcome(null)
      setFailure(null)
      setRunning(summary.state === 'running')
      // Время просьбы идёт от её начала, а не от открытия окна: сколько она длится, знает панель.
      setStartedAt(Date.now() - summary.elapsedMs)

      let finished = false
      try {
        const response = await fetch(`/api/agent/${kind}/stream?id=${summary.id}&from=0`, {
          signal: controller.signal,
        })
        if (!response.ok || !response.body) {
          setRunning(false)
          setFailure('Панель потеряла просьбу: её больше нет в списке')
          return
        }

        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += value
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.trim()) continue
            const event = JSON.parse(line) as E
            if (event.type === 'step') {
              setSteps((prev) => [...prev, event.text])
            } else {
              finished = true
              setOutcome(event)
              setRunning(false)
            }
          }
        }
        if (!finished) {
          setRunning(false)
          setFailure('Ответ оборвался: API закрыл поток без ответа агента')
        }
      } catch (error) {
        if (controller.signal.aborted) return
        setRunning(false)
        setFailure(error instanceof SyntaxError ? 'API прислал непонятный ответ' : 'Нет связи с API')
      }
    },
    [kind],
  )

  // Итог, который оператор уже видел, уходит вместе с окном: отметка в шапке о нём больше не говорит —
  // решение оператора на приёмке B-52. Идущая просьба закрытием окна не трогается.
  const finished = useRef(false)
  useEffect(() => {
    finished.current = outcome !== null || failure !== null
  }, [outcome, failure])
  useEffect(
    () => () => {
      if (finished.current) void fetch(`/api/agent/${kind}`, { method: 'DELETE', keepalive: true })
    },
    [kind],
  )

  // Окно открылось: идущая или дождавшаяся просьба этого вида подхватывается с начала.
  useEffect(() => {
    let alive = true
    fetch('/api/agent/requests')
      .then((response) => (response.ok ? (response.json() as Promise<AgentRequestSummary[]>) : []))
      .then(
        (list) => {
          if (!alive) return
          setRestoring(false)
          const mine = list.find((request) => request.kind === kind)
          if (mine) void follow(mine)
        },
        () => alive && setRestoring(false),
      )
    return () => {
      alive = false
      // Закрытое окно перестаёт читать поток, но просьбу не трогает: агент работает дальше.
      reading.current?.abort()
    }
  }, [kind, follow])

  const start = useCallback(
    async (url: string, body: unknown): Promise<Started> => {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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

  /** Убирает просьбу из панели: идущую — вместе с агентом, дождавшуюся — вместе с её итогом. */
  const forget = useCallback(async () => {
    reading.current?.abort()
    reading.current = null
    setAsked('')
    setBase(null)
    setSteps([])
    setOutcome(null)
    setRunning(false)
    setStartedAt(null)
    setFailure(null)
    try {
      await fetch(`/api/agent/${kind}`, { method: 'DELETE' })
    } catch {
      // Панель недоступна: просьба уйдёт вместе с ней, показывать оператору нечего.
    }
  }, [kind])

  return { asked, base, steps, outcome, running, startedAt, failure, restoring, start, forget, setFailure }
}

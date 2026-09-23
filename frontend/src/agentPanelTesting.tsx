import { vi } from 'vitest'
import type { AgentKind, AgentRequestSummary } from './agentRequest'

/** Поток NDJSON просьбы, который тест выдаёт по строке, когда нужно. */
export function controlledStream<E>() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    body,
    send: (event: E) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(),
  }
}

export type PanelStub = {
  /** Что панель приняла: POST просьбы, её текст и адрес. */
  posts: { url: string; body: Record<string, unknown> }[]
  /** Просьбы, которые панель забыла: DELETE — то самое «Отменить». */
  deletes: string[]
  /** Ответы на вызовы, которых стенд не знает: тест дописывает свои. */
  others: (url: string, init?: RequestInit) => Response | null
}

/**
 * Панель с одной просьбой заданного вида: POST её заводит, GET отдаёт её поток, DELETE убирает.
 * running — просьба, которая уже идёт, когда окно открывают: так проверяется возврат к работе агента.
 */
export function stubPanel(
  kind: AgentKind,
  stream: { body: ReadableStream<Uint8Array> },
  options: { running?: AgentRequestSummary; project?: string; others?: PanelStub['others'] } = {},
) {
  const posts: PanelStub['posts'] = []
  const deletes: string[] = []
  let request: AgentRequestSummary | null = options.running ?? null

  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const answered = options.others?.(url, init)
      if (answered) return Promise.resolve(answered)
      if (url === '/api/agent/requests') return Promise.resolve(Response.json(request ? [request] : []))
      if (method === 'DELETE') {
        deletes.push(url)
        request = null
        return Promise.resolve(new Response(null, { status: 204 }))
      }
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>
        posts.push({ url, body })
        request = {
          kind,
          id: 'r1',
          base: String(body.base ?? ''),
          project: options.project ?? '',
          text: String(body.question ?? body.text ?? body.wish ?? ''),
          elapsedMs: 0,
          state: 'running',
          // Как в API: просьба о правке исполнителя помнит, кого переписывает, а разговор — копию проекта.
          subject:
            kind === 'ask'
              ? ((body.copy as string | undefined) ?? null)
              : ((body.current as { name?: string } | null | undefined)?.name ?? null),
          // Как в API: просьба переписать стадии помнит, какие стадии ушли агенту.
          ...(kind === 'flow' ? { stages: (body.stages as AgentRequestSummary['stages']) ?? [] } : {}),
        }
        return Promise.resolve(Response.json(request))
      }
      if (!request) return Promise.resolve(new Response(null, { status: 404 }))
      return Promise.resolve(new Response(stream.body, { headers: { 'Content-Type': 'application/x-ndjson' } }))
    }),
  )
  return { posts, deletes }
}

export function runningRequest(
  kind: AgentKind,
  text: string,
  base = '',
  project = '',
  elapsedMs = 0,
  subject: string | null = null,
): AgentRequestSummary {
  return { kind, id: 'r1', base, project, text, elapsedMs, state: 'running', subject }
}

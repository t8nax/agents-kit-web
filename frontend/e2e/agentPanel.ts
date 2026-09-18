import type { Page } from '@playwright/test'

export type AgentKind = 'ask' | 'backlog' | 'flow' | 'performer'

export type Panel = {
  /** Что панель получила POST-ом просьбы. */
  posts: unknown[]
  /** Сколько раз просьбу забирали: DELETE — это «Отменить» и забранный итог. */
  deletes: number
  /** Ход и итог, которые отдаст поток просьбы. Пока не задано — поток висит, агент «думает». */
  reply(ndjson: string): void
  /** Итог дождался оператора: в списке панели просьба помечена законченной. */
  ready(): void
}

export const ndjson = (...events: object[]) => events.map((event) => JSON.stringify(event)).join('\n') + '\n'

/**
 * Панель, которая держит просьбу к агенту, как настоящая: POST её заводит, GET отдаёт её поток с начала,
 * DELETE убирает. Настоящий агент в прогоне не запускается — он работал бы в живой базе оператора.
 */
export async function mockAgentPanel(page: Page, kind: AgentKind, postUrl: string, project = 'Agents Kit Web') {
  const panel = {
    posts: [] as unknown[],
    deletes: 0,
    body: null as string | null,
    state: 'running',
    request: null as Record<string, unknown> | null,
    reply(body: string) {
      panel.body = body
      panel.state = 'done'
    },
    ready() {
      panel.state = 'done'
    },
  }

  await page.route(`**${postUrl}`, async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.posts.push(body)
    panel.request = {
      kind,
      id: `r${panel.posts.length}`,
      base: String(body.base ?? ''),
      project,
      text: String(body.question ?? body.text ?? body.wish ?? ''),
      elapsedMs: 0,
      state: 'running',
    }
    panel.state = 'running'
    await route.fulfill({ json: { ...panel.request } })
  })

  await page.route('**/api/agent/requests', (route) =>
    route.fulfill({ json: panel.request ? [{ ...panel.request, state: panel.state }] : [] }),
  )

  await page.route(`**/api/agent/${kind}/stream*`, async (route) => {
    if (!panel.request) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    // Поток висит, пока итога нет: так выглядит работающий агент.
    if (panel.body === null) return
    await route.fulfill({ contentType: 'application/x-ndjson', body: panel.body })
  })

  await page.route(`**/api/agent/${kind}`, async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }
    panel.deletes++
    panel.request = null
    panel.body = null
    await route.fulfill({ status: 204, body: '' })
  })

  return panel as Panel & { body: string | null }
}

import { expect, test, type Page, type Route } from '@playwright/test'

type Entry = { number: string | null; title: string; text: string | null; type?: string; priority?: string }
type Said = { type: string; text: string; [field: string]: unknown }

const akwBase = 'D:\\Projects\\app-knowledge'
const B1: Entry = { number: 'B-1', title: 'Панель показывает проблемы баз знаний', text: 'Сводка **по каждой** базе.', type: 'фича', priority: 'средний' }
const B2: Entry = { number: 'B-2', title: 'Выгрузка бэклога в CSV', text: 'Нужна выгрузка.' }
const added: Entry = { number: 'B-32', title: 'Таблица показывает, сколько копия ждёт ответа', text: 'Сейчас не видно, **как давно** копия ждёт.' }
const changed: Entry = { ...B1, title: 'Панель показывает проблемы баз знаний сводкой', priority: 'высокий' }

const proposal = {
  id: 'p1',
  changes: [
    { kind: 'change', number: 'B-1', entry: changed },
    { kind: 'delete', number: 'B-2', entry: B2 },
  ],
}

/**
 * Панель с разговором о бэклоге, как настоящая: POST его заводит, реплики дописываются в переписку, окно
 * читает её потоком с начала, а «Сохранить» и «Отказаться» пишут в неё свои события. /api подменяется: запись
 * из прогона не должна попасть в живые бэклоги оператора (decisions/tests.md).
 */
async function mockApi(page: Page) {
  const panel = {
    posts: [] as Record<string, unknown>[],
    replies: [] as string[],
    saves: [] as string[],
    refusals: [] as string[],
    stops: 0,
    deletes: 0,
    reads: 0,
    lines: [] as string[],
    request: null as Record<string, unknown> | null,
    state: 'running',
    waiting: null as { route: Route; from: number } | null,

    /** Агент сказал своё: ход работы, ответ или сбой. */
    answer(...events: Said[]) {
      panel.say(...events)
      if (events.some((event) => event.type !== 'step')) panel.state = 'done'
    },

    say(...events: Said[]) {
      panel.lines.push(...events.map((event) => JSON.stringify(event)))
      panel.flush()
    },

    flush() {
      const waiting = panel.waiting
      if (!waiting || panel.lines.length <= waiting.from) return
      panel.waiting = null
      void waiting.route.fulfill({
        contentType: 'application/x-ndjson',
        body: panel.lines.slice(waiting.from).join('\n') + '\n',
      })
    },
  }

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/backlog', (route) => {
    panel.reads++
    const entries = panel.saves.length > 0 ? [{ ...changed }, added] : panel.reads === 1 ? [B1, B2] : [B1, B2, added]
    route.fulfill({
      json: [
        { base: akwBase, project: 'Agents Kit Web', entries, error: null, letters: 'B' },
        { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: [], error: null, letters: 'B' },
      ],
    })
  })

  await page.route('**/api/backlog/write', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.posts.push(body)
    panel.lines = [JSON.stringify({ type: 'reply', text: String(body.text ?? ''), number: body.number ?? null })]
    panel.request = {
      kind: 'backlog',
      id: `r${panel.posts.length}`,
      base: String(body.base ?? ''),
      project: 'Agents Kit Web',
      text: String(body.text ?? ''),
      elapsedMs: 0,
      state: 'running',
    }
    panel.state = 'running'
    await route.fulfill({ json: { ...panel.request } })
  })

  await page.route('**/api/backlog/write/reply', async (route) => {
    const body = route.request().postDataJSON() as { text: string }
    panel.replies.push(body.text)
    panel.state = 'running'
    panel.say({ type: 'reply', text: body.text })
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/backlog/write/stop', async (route) => {
    panel.stops++
    panel.answer({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/backlog/write/save', async (route) => {
    const { id } = route.request().postDataJSON() as { id: string }
    panel.saves.push(id)
    panel.say({ type: 'saved', text: '', commit: 'c0ffee1', proposalId: id })
    await route.fulfill({ json: { commit: 'c0ffee1' } })
  })

  await page.route('**/api/backlog/write/refuse', async (route) => {
    const { id } = route.request().postDataJSON() as { id: string }
    panel.refusals.push(id)
    panel.say({ type: 'refused', text: '', proposalId: id })
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/agent/requests', (route) =>
    route.fulfill({ json: panel.request ? [{ ...panel.request, state: panel.state }] : [] }),
  )

  await page.route('**/api/agent/backlog/stream*', async (route) => {
    if (!panel.request) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const from = Number(new URL(route.request().url()).searchParams.get('from') ?? 0)
    // Нового нет — поток висит: так выглядит разговор, в котором ждут ответа или следующей реплики.
    panel.waiting = { route, from }
    panel.flush()
  })

  await page.route('**/api/agent/backlog', async (route) => {
    if (route.request().method() !== 'DELETE') {
      await route.fallback()
      return
    }
    panel.deletes++
    panel.request = null
    panel.lines = []
    panel.waiting = null
    await route.fulfill({ status: 204, body: '' })
  })

  return panel
}

async function openBacklog(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await expect(page.getByText('B-1', { exact: true })).toBeVisible()
}

async function openFromHead(page: Page) {
  await openBacklog(page)
  await page.getByRole('button', { name: 'Попросить Чудо-Юдо' }).click()
  return page.getByRole('dialog', { name: 'Чудо-Юдо' })
}

async function openFromEntry(page: Page, number: string) {
  await openBacklog(page)
  const row = page.locator('.entry-row').filter({ has: page.getByText(number, { exact: true }) })
  await row.getByRole('button', { name: 'Изменить' }).click()
  return page.getByRole('dialog', { name: 'Чудо-Юдо' })
}

async function say(dialog: ReturnType<Page['getByRole']>, text: string) {
  await dialog.getByLabel('Просьба к Чудо-Юдо').fill(text)
  await dialog.getByRole('button', { name: 'Отправить' }).click()
}

test('новая запись сохраняется сразу, отмечена в окне «добавлена» и в бэклоге «новая»', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openFromHead(page)
  await say(dialog, 'Хочу видеть, сколько копия ждёт ответа')
  await expect(dialog.getByText('Чудо-Юдо читает бэклог Agents Kit Web…')).toBeVisible()
  expect(panel.posts).toEqual([{ base: akwBase, text: 'Хочу видеть, сколько копия ждёт ответа' }])

  panel.answer({ type: 'step', text: 'правит backlog.md' }, { type: 'answer', text: 'Записал B-32.', entries: [added], commit: '4f1c2a9' })
  const entries = dialog.getByRole('list', { name: 'Новые записи' })
  await expect(entries.getByText('добавлена')).toBeVisible()
  await expect(entries.locator('strong')).toHaveText('как давно')

  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toHaveCount(0)
  expect(panel.deletes).toBe(1)
  const fresh = page.getByRole('button', { name: /B-32 Таблица показывает/ })
  await expect(fresh.getByText('новая')).toBeVisible()
})

test('«Изменить» открывает разговор про запись, изменение и удаление пишутся по «Сохранить»', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openFromEntry(page, 'B-1')
  await expect(dialog.getByText('Запись', { exact: true })).toBeVisible()
  await expect(dialog.getByText('Панель показывает проблемы баз знаний', { exact: true })).toBeVisible()
  await say(dialog, 'Поставь высокий и убери B-2')
  expect(panel.posts).toEqual([{ base: akwBase, text: 'Поставь высокий и убери B-2', number: 'B-1' }])

  panel.answer({ type: 'answer', text: 'Сохраню, когда скажете.', proposal })
  await expect(dialog.getByText('Ждут сохранения: изменить 1, удалить 1')).toBeVisible()
  expect(panel.saves).toEqual([])

  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(dialog.getByText('изменена')).toBeVisible()
  await expect(dialog.getByText('удалена')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toHaveCount(0)
  expect(panel.saves).toEqual(['p1'])

  // Раздел перечитал бэклог: удалённой записи в нём больше нет.
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(page.getByText('B-2', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /B-1 .*сводкой/ })).toBeVisible()
})

test('«Отказаться» ничего не пишет, а новая просьба гасит прежнее предложение', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openFromHead(page)
  await say(dialog, 'Убери B-2')
  panel.answer({ type: 'answer', text: '', proposal })
  await dialog.getByRole('button', { name: 'Отказаться' }).click()
  await expect(dialog.getByText('отказались')).toHaveCount(2)
  expect(panel.refusals).toEqual(['p1'])
  expect(panel.saves).toEqual([])

  await say(dialog, 'Тогда только B-2')
  panel.answer({ type: 'answer', text: '', proposal: { id: 'p2', changes: [proposal.changes[1]] } })
  await expect(dialog.getByText('Ждёт сохранения: удалить 1')).toBeVisible()
  await say(dialog, 'Нет, оставь всё')
  await expect(dialog.getByText('заменено')).toBeVisible()
  expect(panel.replies).toEqual(['Тогда только B-2', 'Нет, оставь всё'])
})

test('запись, названная словами, уточняется в том же окне, а «Отменить» обрывает ответ', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openFromHead(page)
  await say(dialog, 'Удали запись про CSV')
  panel.answer({ type: 'answer', text: 'Нашёл B-2 «Выгрузка бэклога в CSV». Та ли это?' })
  await expect(dialog.getByText('Нашёл B-2 «Выгрузка бэклога в CSV». Та ли это?')).toBeVisible()

  await say(dialog, 'Да')
  await expect(dialog.getByLabel('Прошло времени')).toBeVisible()
  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await expect(dialog.getByText('Чудо-Юдо остановлен: ответа на эту реплику не будет')).toBeVisible()
  expect(panel.stops).toBe(1)
  expect(panel.replies).toEqual(['Да'])
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно Чудо-Юдо читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockApi(page)
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openFromHead(page)
    await say(dialog, 'Запиши и убери B-2')
    panel.answer({ type: 'answer', text: 'Новую записал, остальное — по «Сохранить».', entries: [added], proposal })

    const pending = dialog.getByRole('status').filter({ hasText: 'Ждут сохранения' })
    await expect(pending).toBeVisible()
    const [pendingColor, pendingBackground, dialogBackground] = await Promise.all([
      pending.evaluate((el) => getComputedStyle(el).color),
      pending.evaluate((el) => getComputedStyle(el).backgroundColor),
      dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(pendingColor).not.toBe(pendingBackground)
    expect(pendingBackground).not.toBe(dialogBackground)
    // Значок часов — 16px: общее правило значков окна его не раздувает.
    await expect(async () => {
      const box = await pending.locator('svg').boundingBox()
      expect(box?.width).toBe(16)
    }).toPass()
    await page.screenshot({ path: `test-results/backlog-talk-${theme}.png` })
  })
}

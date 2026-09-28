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
    // Бэклог меняется только записью агента: раздел читает его сколько угодно раз и видит одно и то же.
    written: false,
    lines: [] as string[],
    request: null as Record<string, unknown> | null,
    state: 'running',
    // Потоков может ждать несколько: оборванное окном чтение доходит до подмены позже нового, и ответ,
    // отданный одному последнему, пропал бы в оборванном.
    waiting: [] as { route: Route; from: number }[],

    /** Агент сказал своё: ход работы, ответ или сбой. */
    answer(...events: Said[]) {
      if (events.some((event) => Array.isArray(event.entries))) panel.written = true
      panel.say(...events)
      if (events.some((event) => event.type !== 'step')) panel.state = 'done'
    },

    say(...events: Said[]) {
      panel.lines.push(...events.map((event) => JSON.stringify(event)))
      panel.flush()
    },

    flush() {
      const ready = panel.waiting.filter((waiting) => panel.lines.length > waiting.from)
      panel.waiting = panel.waiting.filter((waiting) => !ready.includes(waiting))
      for (const waiting of ready) {
        // Оборванное окном чтение ответа уже не примет: отказ подмены тут не ошибка.
        waiting.route
          .fulfill({ contentType: 'application/x-ndjson', body: panel.lines.slice(waiting.from).join('\n') + '\n' })
          .catch(() => {})
      }
    },
  }

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/backlog', (route) => {
    const entries = panel.saves.length > 0 ? [{ ...changed }, added] : panel.written ? [B1, B2, added] : [B1, B2]
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
      // Как в API: разговор помнит запись, от которой открыт.
      subject: body.number ?? null,
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
    panel.waiting.push({ route, from })
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
    panel.waiting = []
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

/** Реплика ушла, и окно ждёт ответа: только тогда тест отвечает за агента, иначе ответ обгонит реплику. */
async function say(dialog: ReturnType<Page['getByRole']>, text: string) {
  await dialog.getByLabel('Просьба к Чудо-Юдо').fill(text)
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByLabel('Прошло времени')).toBeVisible()
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

  // Закрытое окно разговор не трогает: открытое снова из шапки, оно показывает его на месте (B-228).
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toHaveCount(0)
  expect(panel.deletes).toBe(0)
  const fresh = page.getByRole('button', { name: /B-32 Таблица показывает/ })
  await expect(fresh.getByText('новая')).toBeVisible()

  await page.getByRole('button', { name: 'Попросить Чудо-Юдо' }).click()
  await expect(dialog.getByText('Записал B-32.')).toBeVisible()
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
  await expect.poll(() => panel.replies).toEqual(['Тогда только B-2', 'Нет, оставь всё'])
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

test('подвал: поле во всю ширину, под ним кнопки одного роста, переспрос той же высоты, что поле', async ({ page }) => {
  const panel = await mockApi(page)
  const dialog = await openFromHead(page)
  const field = dialog.getByLabel('Просьба к Чудо-Юдо')
  const fresh = dialog.getByRole('button', { name: 'Новая переписка' })
  const send = dialog.getByRole('button', { name: 'Отправить' })
  await expect(fresh).toBeDisabled()

  // Замер с повтором: пока грузится шрифт, подвал успевает померяться на запасной гарнитуре.
  await expect(async () => {
    const [box, left, right] = await Promise.all([field.boundingBox(), fresh.boundingBox(), send.boundingBox()])
    expect(left!.height).toBe(right!.height)
    expect(left!.y).toBe(right!.y)
    expect(Number.isInteger(left!.height)).toBe(true)
    // Кнопки строкой под полем, а не рядом с ним: поле во всю ширину подвала.
    expect(left!.y).toBeGreaterThanOrEqual(box!.y + box!.height)
    expect(right!.x + right!.width).toBeCloseTo(box!.x + box!.width, 0)
    // Поле — в три строки текста: замечание оператора на приёмке B-228.
    expect(box!.height).toBe(84)
  }).toPass({ timeout: 5000 })

  await say(dialog, 'Убери B-2')
  panel.answer({ type: 'answer', text: 'Сохраню, когда скажете.', proposal })
  // Ждущее предложение — полосой под шапкой, над лентой.
  const bar = dialog.getByRole('status').filter({ hasText: 'Ждут сохранения' })
  await expect(bar.getByRole('button', { name: 'Сохранить' })).toBeVisible()
  const [head, barBox, feed] = await Promise.all([
    dialog.locator('.reply-head').boundingBox(),
    bar.boundingBox(),
    dialog.locator('.talk-feed').boundingBox(),
  ])
  expect(barBox!.y).toBeGreaterThanOrEqual(head!.y + head!.height - 1)
  expect(feed!.y).toBeGreaterThanOrEqual(barBox!.y + barBox!.height - 1)

  const footer = dialog.locator('.talk-composer')
  const before = (await footer.boundingBox())!.height
  await fresh.click()
  const asking = dialog.getByRole('alertdialog', { name: 'Начать новую переписку?' })
  await expect(asking).toBeVisible()
  expect((await footer.boundingBox())!.height).toBe(before)
  expect((await asking.locator('.talk-confirm').boundingBox())!.height).toBe(84)
  await expect(bar.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  await asking.getByRole('button', { name: 'Отмена' }).click()
  await expect(asking).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  await fresh.click()
  await dialog.getByRole('button', { name: 'Начать новую' }).click()
  await expect(dialog.getByText('Сохраню, когда скажете.')).toHaveCount(0)
  await expect(field).toHaveValue('')
  await expect(dialog.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeEnabled()
  expect(panel.deletes).toBe(1)
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

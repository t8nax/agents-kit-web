import { expect, test, type Page, type Route } from '@playwright/test'

const bases = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

type Said = { type: string; text: string; files?: string[]; durationMs?: number; output?: string }

/**
 * Панель с одним разговором, как настоящая: POST его заводит, реплики дописываются в переписку, а окно
 * читает её потоком с начала. /api подменяется: настоящий вопрос запустил бы агента в живой базе оператора.
 */
async function mockConversation(page: Page, project = 'Agents Kit Web') {
  const panel = {
    posts: [] as unknown[],
    replies: [] as string[],
    deletes: 0,
    stops: 0,
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

    /** Поток отдаёт то, что накопилось, и закрывается: окно дочитывает его дальше само. */
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
  await page.route('**/api/ask/bases', (route) => route.fulfill({ json: bases }))

  await page.route('**/api/ask', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.posts.push(body)
    panel.lines = [JSON.stringify({ type: 'reply', text: String(body.question ?? '') })]
    panel.request = {
      kind: 'ask',
      id: `r${panel.posts.length}`,
      base: String(body.base ?? ''),
      project,
      text: String(body.question ?? ''),
      elapsedMs: 0,
      state: 'running',
    }
    panel.state = 'running'
    await route.fulfill({ json: { ...panel.request } })
  })

  await page.route('**/api/ask/reply', async (route) => {
    const body = route.request().postDataJSON() as { text: string }
    panel.replies.push(body.text)
    panel.state = 'running'
    panel.say({ type: 'reply', text: body.text })
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/ask/stop', async (route) => {
    panel.stops++
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/agent/requests', (route) =>
    route.fulfill({ json: panel.request ? [{ ...panel.request, state: panel.state }] : [] }),
  )

  await page.route('**/api/agent/ask/stream*', async (route) => {
    if (!panel.request) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const from = Number(new URL(route.request().url()).searchParams.get('from') ?? 0)
    // Нового нет — поток висит: так выглядит разговор, в котором ждут ответа или следующей реплики.
    panel.waiting = { route, from }
    panel.flush()
  })

  await page.route('**/api/agent/ask', async (route) => {
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

async function openAsk(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Спросить Чудо-Юдо' }).click()
  return page.getByRole('dialog', { name: 'Разговор с Чудо-Юдо' })
}

test('оператор спрашивает базу из шапки и читает ответ с прочитанными файлами', async ({ page }) => {
  const panel = await mockConversation(page, 'Nota')

  const dialog = await openAsk(page)
  await dialog.getByRole('button', { name: 'Nota', exact: true }).click()
  await dialog.getByLabel('Вопрос').fill('Почему таблица обновляется опросом?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()

  await expect(dialog.getByText('Почему таблица обновляется опросом?')).toBeVisible()
  panel.answer(
    { type: 'step', text: 'читает decisions/ui.md' },
    {
      type: 'answer',
      text: 'Так выбрал **оператор**:\n\n- опрос по таймеру\n- без SSE',
      files: ['decisions/ui.md', 'product.md'],
      durationMs: 31000,
    },
  )

  await expect(dialog.getByText('без SSE')).toBeVisible()
  await expect(dialog.locator('strong', { hasText: 'оператор' })).toBeVisible()
  await expect(dialog.getByText('decisions/ui.md')).toBeVisible()
  await expect(dialog.getByText('product.md')).toBeVisible()
  await expect(dialog.getByText('31 с')).toBeVisible()
  expect(panel.posts).toEqual([
    { base: 'D:\\Projects\\nota-knowledge', question: 'Почему таблица обновляется опросом?' },
  ])

  await dialog.getByRole('button', { name: 'Новая переписка' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('')
  expect(panel.deletes).toBe(1)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('разговор продолжается: переспросить можно в том же окне, и вся переписка видна', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что решено про запись в базы?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  panel.answer({ type: 'answer', text: 'Панель пишет только ответы и бэклог.', files: [], durationMs: 4000 })
  await expect(dialog.getByText('Панель пишет только ответы и бэклог.')).toBeVisible()

  // База разговора выбрана один раз и посреди переписки не меняется.
  await expect(dialog.getByRole('button', { name: 'Nota', exact: true })).toBeDisabled()

  await dialog.getByLabel('Следующая реплика').fill('А коммитит кто?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByText('А коммитит кто?')).toBeVisible()
  panel.answer({ type: 'answer', text: 'Коммитит сам агент.', files: [], durationMs: 3000 })

  await expect(dialog.getByText('Коммитит сам агент.')).toBeVisible()
  expect(panel.replies).toEqual(['А коммитит кто?'])
  expect(panel.posts).toHaveLength(1)
  // Прошлая пара осталась на экране: переписка читается целиком.
  await expect(dialog.getByText('Что решено про запись в базы?')).toBeVisible()
  await expect(dialog.getByText('Панель пишет только ответы и бэклог.')).toBeVisible()
})

test('закрытое окно разговор не теряет: ответ ждёт в шапке и открывается оттуда', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Почему опрос?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toContainText('Чудо-Юдо читает базу Agents Kit Web…')

  // Оператор закрыл окно и занялся другим: агент работает дальше.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  const chip = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо читает базу/ })
  await expect(chip).toBeVisible()

  // Агент закончил, пока окно было закрыто.
  panel.answer({ type: 'answer', text: 'Так решил оператор.', files: ['decisions/ui.md'], durationMs: 12000 })
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо ответил по базе Agents Kit Web/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog', { name: 'Разговор с Чудо-Юдо' })
  await expect(reopened.getByText('Почему опрос?')).toBeVisible()
  await expect(reopened.getByText('Так решил оператор.')).toBeVisible()
  await expect(reopened.getByText('decisions/ui.md')).toBeVisible()
  expect(panel.posts).toHaveLength(1)

  // Прочитанный ответ разговор не кончает: он ждёт следующей реплики и после закрытия окна.
  await page.keyboard.press('Escape')
  await expect(reopened).toHaveCount(0)
  await expect(page.getByRole('banner').locator('.agent-chip')).toHaveCount(1)
  expect(panel.deletes).toBe(0)
})

test('пока агент думает, идёт счётчик, а «Отменить» обрывает ответ и оставляет переписку', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Долгий вопрос')
  await dialog.getByRole('button', { name: 'Отправить' }).click()

  const waiting = dialog.getByRole('status')
  await expect(waiting).toContainText('Чудо-Юдо читает базу Agents Kit Web…')
  await expect(waiting.getByLabel('Прошло времени')).toHaveText('0:01', { timeout: 5000 })

  await dialog.getByRole('button', { name: 'Отменить' }).click()
  panel.answer({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })

  await expect(dialog.getByText('Чудо-Юдо остановлен: ответа на эту реплику не будет')).toBeVisible()
  await expect(dialog.getByText('Долгий вопрос')).toBeVisible()
  expect(panel.stops).toBe(1)
  expect(panel.deletes).toBe(0)
})

test('сбой посреди переписки её не рушит: реплика возвращается в поле', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что за проект?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  panel.answer({ type: 'error', text: 'Чудо-Юдо завершился с ошибкой', output: 'Invalid API key · Please run /login' })

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Чудо-Юдо не ответил')
  await expect(alert).toContainText('Invalid API key · Please run /login')
  await expect(dialog.getByLabel('Следующая реплика')).toHaveValue('Что за проект?')

  await dialog.getByRole('button', { name: 'Отправить' }).click()
  panel.answer({ type: 'note', text: 'Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит' })
  panel.answer({ type: 'answer', text: 'Теперь ответил', files: [], durationMs: 2000 })

  await expect(dialog.getByText('Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит')).toBeVisible()
  await expect(dialog.getByText('Теперь ответил')).toBeVisible()
  expect(panel.replies).toEqual(['Что за проект?'])
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно разговора читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockConversation(page)
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openAsk(page)
    await dialog.getByLabel('Вопрос').fill('Вопрос')
    await dialog.getByRole('button', { name: 'Отправить' }).click()
    panel.answer({ type: 'error', text: 'Чудо-Юдо завершился с ошибкой', output: 'сбой' })

    const title = dialog.getByRole('alert').locator('strong')
    await expect(title).toBeVisible()
    const [color, background] = await Promise.all([
      title.evaluate((el) => getComputedStyle(el).color),
      dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(color).not.toBe(background)

    // Реплика оператора читается на своей подложке: карточка справа, а не текст на фоне окна.
    const said = dialog.locator('.ask-said')
    const [saidColor, saidBackground] = await Promise.all([
      said.evaluate((el) => getComputedStyle(el).color),
      said.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(saidColor).not.toBe(saidBackground)
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`просьба в шапке читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockConversation(page)
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openAsk(page)
    await dialog.getByLabel('Вопрос').fill('Вопрос')
    await dialog.getByRole('button', { name: 'Отправить' }).click()
    await page.keyboard.press('Escape')

    const chip = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо читает базу/ })
    await expect(chip).toBeVisible()
    const [color, background] = await Promise.all([
      chip.evaluate((el) => getComputedStyle(el).color),
      chip.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(color).not.toBe(background)
    expect(panel.deletes).toBe(0)
  })
}

import { expect, test, type Page, type Route } from '@playwright/test'

const bases = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

/** Копии баз: у первой — основная и копия задачи, у второй — одна основная. */
const copies: Record<string, { path: string; name: string; branch: string | null; main: boolean }[]> = {
  [bases[0].base]: [
    { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
    { path: 'D:\\Projects\\bright-sunny-glacier', name: 'bright-sunny-glacier', branch: 'b-130-ask-reads-code', main: false },
  ],
  [bases[1].base]: [{ path: 'D:\\Projects\\nota', name: 'nota', branch: 'dev', main: true }],
}

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
    // Потоков может ждать несколько: оборванное окном чтение доходит до подмены позже нового, и ответ,
    // отданный одному последнему, пропал бы в оборванном.
    waiting: [] as { route: Route; from: number }[],

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
  await page.route('**/api/ask/bases', (route) => route.fulfill({ json: bases }))
  await page.route('**/api/ask/copies*', (route) =>
    route.fulfill({ json: copies[new URL(route.request().url()).searchParams.get('base') ?? ''] ?? [] }),
  )

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
      // Как в API: разговор помнит копию проекта, чей код читает агент.
      subject: body.copy ?? null,
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
    panel.waiting.push({ route, from })
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
    panel.waiting = []
    await route.fulfill({ status: 204, body: '' })
  })

  return panel
}

async function openAsk(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Спросить Чудо-Юдо' }).click()
  return page.getByRole('dialog', { name: 'Разговор с Чудо-Юдо' })
}

/** Выбор из выпадающего списка окна: «Проект» или «Копия». */
async function pick(dialog: ReturnType<Page['getByRole']>, list: 'Проект' | 'Копия', option: string) {
  const button = dialog.getByRole('button', { name: new RegExp(`^${list}: `) })
  await expect(button).toBeEnabled()
  await button.click()
  await dialog.getByRole('listbox', { name: list }).getByRole('option', { name: new RegExp(option) }).click()
}

test('оператор спрашивает базу из шапки и читает ответ с прочитанными файлами', async ({ page }) => {
  const panel = await mockConversation(page, 'Nota')

  const dialog = await openAsk(page)
  await pick(dialog, 'Проект', 'Nota')
  await expect(dialog.getByRole('button', { name: 'Копия: nota' })).toBeEnabled()
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
  // Файл ответа, а не шаг «читает decisions/ui.md»: шаг может ещё стоять в окне, пока ответ дочитывается.
  await expect(dialog.getByText('decisions/ui.md', { exact: true })).toBeVisible()
  await expect(dialog.getByText('product.md', { exact: true })).toBeVisible()
  await expect(dialog.getByText('31 с')).toBeVisible()
  expect(panel.posts).toEqual([
    { base: 'D:\\Projects\\nota-knowledge', copy: 'D:\\Projects\\nota', question: 'Почему таблица обновляется опросом?' },
  ])

  await dialog.getByRole('button', { name: 'Новая переписка' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('')
  expect(panel.deletes).toBe(1)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('копия выбирается из списка с ветками, и код выбранной копии уходит в разговор', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  const button = dialog.getByRole('button', { name: 'Копия: agents-kit-web' })
  await expect(button).toBeEnabled()
  // Значок списка — свой, а не общий значок окна: правило окна той же силы его перебивало бы.
  const chevron = await button.locator('svg').boundingBox()
  expect([chevron?.width, chevron?.height]).toEqual([14, 14])

  await button.click()
  const list = dialog.getByRole('listbox', { name: 'Копия' })
  await expect(list.getByRole('option')).toHaveText(['agents-kit-webОсновнаяmaster', 'bright-sunny-glacierb-130-ask-reads-code'])
  await expect(list).toBeInViewport()
  await list.getByRole('option', { name: /bright-sunny-glacier/ }).click()
  await expect(dialog.getByRole('button', { name: 'Копия: bright-sunny-glacier' })).toBeVisible()

  await dialog.getByLabel('Вопрос').fill('Что делает AskEndpoints?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toBeVisible()
  panel.answer({
    type: 'answer',
    text: 'Запускает агента.',
    files: ['backend/src/AgentsKitWeb.Api/Ask/AskEndpoints.cs', 'decisions/base-agent.md'],
    durationMs: 2000,
  })

  await expect(dialog.getByText('backend/src/AgentsKitWeb.Api/Ask/AskEndpoints.cs')).toBeVisible()
  expect(panel.posts).toEqual([
    { base: bases[0].base, copy: 'D:\\Projects\\bright-sunny-glacier', question: 'Что делает AskEndpoints?' },
  ])
  await expect(dialog.getByRole('button', { name: 'Копия: bright-sunny-glacier' })).toBeDisabled()
})

test('кнопки подвала одного размера и на своих местах во всём разговоре', async ({ page }) => {
  const panel = await mockConversation(page)
  // Кнопки подвала — одна пара: разный рост и съехавшее место бросаются в глаза — замечания
  // оператора на приёмке B-79. Рост целый, а не дробный: половина пикселя красится по-разному
  // у заливки и у рамки, и кнопки выглядят разными.
  // Замер идёт с повтором: пока грузится шрифт, кнопки успевают померяться на запасной гарнитуре.
  const pair = async () => {
    let right!: { x: number; y: number; width: number; height: number }
    await expect(async () => {
      const left = await dialog.getByRole('button', { name: 'Новая переписка' }).boundingBox()
      right = (await dialog.getByRole('button', { name: /^(Отправить|Отменить)$/ }).boundingBox())!
      expect(left).not.toBeNull()
      expect(right).not.toBeNull()
      expect(left!.height).toBe(right.height)
      expect(left!.width).toBe(right.width)
      expect(left!.y).toBe(right.y)
      expect(Number.isInteger(left!.height)).toBe(true)
    }).toPass({ timeout: 5000 })
    return right
  }

  const dialog = await openAsk(page)
  // Места кнопок сличаются между замерами: все они идут на догруженном шрифте панели.
  await page.evaluate(() => document.fonts.load('14px "Inter Variable"'))
  const idle = await pair()

  await dialog.getByLabel('Вопрос').fill('Вопрос')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toBeVisible()
  const running = await pair()

  panel.answer({ type: 'answer', text: 'Ответ', files: [], durationMs: 1000 })
  await expect(dialog.getByText('Ответ')).toBeVisible()
  const answered = await pair()

  // «Отменить» встаёт ровно туда, где была «Отправить», и обратно.
  expect([running.x, running.y]).toEqual([idle.x, idle.y])
  expect([answered.x, answered.y]).toEqual([idle.x, idle.y])
})

test('разговор продолжается: переспросить можно в том же окне, и вся переписка видна', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что решено про запись в базы?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toBeVisible()
  panel.answer({ type: 'answer', text: 'Панель пишет только ответы и бэклог.', files: [], durationMs: 4000 })
  await expect(dialog.getByText('Панель пишет только ответы и бэклог.')).toBeVisible()

  // База и копия разговора выбраны один раз и посреди переписки не меняются.
  await expect(dialog.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Копия: agents-kit-web' })).toBeDisabled()

  await dialog.getByLabel('Следующая реплика').fill('А коммитит кто?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByText('А коммитит кто?')).toBeVisible()
  panel.answer({ type: 'answer', text: 'Коммитит сам агент.', files: [], durationMs: 3000 })

  await expect(dialog.getByText('Коммитит сам агент.')).toBeVisible()
  await expect.poll(() => panel.replies).toEqual(['А коммитит кто?'])
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
  await expect(dialog.getByRole('status')).toContainText('Чудо-Юдо читает базу и код Agents Kit Web…')

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
  await expect(waiting).toContainText('Чудо-Юдо читает базу и код Agents Kit Web…')
  // Счётчик пошёл от реплики: под нагрузкой проверка застаёт его и позже первой секунды, но не дальше
  // своего окна ожидания.
  await expect(waiting.getByLabel('Прошло времени')).toHaveText(/^0:0[1-9]$/)

  await dialog.getByRole('button', { name: 'Отменить' }).click()
  panel.answer({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })

  await expect(dialog.getByText('Чудо-Юдо остановлен: ответа на эту реплику не будет')).toBeVisible()
  await expect(dialog.getByText('Долгий вопрос')).toBeVisible()
  expect(panel.stops).toBe(1)
  expect(panel.deletes).toBe(0)

  // Окно перестаёт ждать оборванного агента и снова готово говорить — B-109.
  await expect(waiting).toBeHidden()
  await expect(dialog.getByLabel('Следующая реплика')).toBeEnabled()
  await expect(dialog.getByRole('button', { name: 'Новая переписка' })).toBeEnabled()

  // Разговор продолжается той же просьбой: новый агент отвечает и честно говорит, что прежнего не помнит.
  await dialog.getByLabel('Следующая реплика').fill('Тогда короче')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByText('Тогда короче')).toBeVisible()
  panel.say({ type: 'note', text: 'Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит' })
  panel.answer({ type: 'answer', text: 'Короткий ответ', files: [], durationMs: 1000 })

  await expect(dialog.getByText('Короткий ответ')).toBeVisible()
  await expect(dialog.getByText('Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит')).toBeVisible()
  await expect.poll(() => panel.replies).toEqual(['Тогда короче'])
  expect(panel.posts).toHaveLength(1)
})

test('сбой посреди переписки её не рушит: реплика возвращается в поле', async ({ page }) => {
  const panel = await mockConversation(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что за проект?')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toBeVisible()
  panel.answer({ type: 'error', text: 'Чудо-Юдо завершился с ошибкой', output: 'Invalid API key · Please run /login' })

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Чудо-Юдо не ответил')
  await expect(alert).toContainText('Invalid API key · Please run /login')
  await expect(dialog.getByLabel('Следующая реплика')).toHaveValue('Что за проект?')

  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.getByRole('status')).toBeVisible()
  panel.answer({ type: 'note', text: 'Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит' })
  panel.answer({ type: 'answer', text: 'Теперь ответил', files: [], durationMs: 2000 })

  await expect(dialog.getByText('Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит')).toBeVisible()
  await expect(dialog.getByText('Теперь ответил')).toBeVisible()
  await expect.poll(() => panel.replies).toEqual(['Что за проект?'])
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно разговора читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockConversation(page)
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openAsk(page)
    await dialog.getByLabel('Вопрос').fill('Вопрос')
    await dialog.getByRole('button', { name: 'Отправить' }).click()
    await expect(dialog.getByRole('status')).toBeVisible()
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

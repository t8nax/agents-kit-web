import { expect, test, type Page, type Route } from '@playwright/test'

const base = 'D:\\Projects\\app-knowledge'
const agents = `${base}\\agents`

const drafted = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи и возвращает вердикт.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком и возвращаешь вердикт.',
}

const fields = ['name', 'description', 'model', 'tools', 'prompt']

type Said = Record<string, unknown> & { type: string; text: string }

/**
 * Панель с одной перепиской об исполнителе, как настоящая: POST её заводит, реплики дописываются в переписку, а окно
 * читает её потоком с начала. /api подменяется: настоящая переписка запустила бы агента в живой копии оператора,
 * а «Сохранить» положило бы файл в её репозиторий и закоммитило бы его.
 */
async function mockApi(page: Page, performers: unknown[] = []) {
  const panel = {
    posts: [] as Record<string, unknown>[],
    replies: [] as Record<string, unknown>[],
    saved: [] as Record<string, unknown>[],
    lines: [] as string[],
    request: null as Record<string, unknown> | null,
    state: 'running',
    waiting: null as { route: Route; from: number } | null,

    /** Агент сказал своё: ход работы, ответ или сбой. */
    answer(...events: Said[]) {
      panel.lines.push(...events.map((event) => JSON.stringify(event)))
      if (events.some((event) => event.type !== 'step')) panel.state = 'done'
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
  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as { name: string }
      panel.saved.push(request)
      // Копию не выбирают: файл ложится в каталог исполнителей базы проекта.
      return route.fulfill({ json: { path: `${agents}\\${request.name}.md` } })
    }
    return route.fulfill({
      json: [{ base, project: 'Agents Kit Web', directory: agents, performers, error: null }],
    })
  })

  await page.route('**/api/performers/draft', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.posts.push(body)
    panel.lines = [JSON.stringify({ type: 'reply', text: String(body.wish ?? '') })]
    panel.request = {
      kind: 'performer',
      id: `r${panel.posts.length}`,
      base: String(body.base ?? ''),
      project: 'Agents Kit Web',
      text: String(body.wish ?? ''),
      elapsedMs: 0,
      state: 'running',
      // Как в API: переписка о заведённом помнит, кого переписывает.
      subject: (body.subject as string | null | undefined) ?? null,
    }
    panel.state = 'running'
    await route.fulfill({ json: { ...panel.request } })
  })

  await page.route('**/api/performers/draft/reply', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.replies.push(body)
    panel.state = 'running'
    panel.lines.push(JSON.stringify({ type: 'reply', text: body.text }))
    panel.flush()
    await route.fulfill({ status: 204, body: '' })
  })

  await page.route('**/api/agent/requests', (route) =>
    route.fulfill({ json: panel.request ? [{ ...panel.request, state: panel.state }] : [] }),
  )

  await page.route('**/api/agent/performer/stream*', async (route) => {
    if (!panel.request) {
      await route.fulfill({ status: 404, body: '' })
      return
    }
    const from = Number(new URL(route.request().url()).searchParams.get('from') ?? 0)
    // Нового нет — поток висит: так выглядит переписка, в которой ждут ответа или следующей реплики.
    panel.waiting = { route, from }
    panel.flush()
  })

  return panel
}

async function openSection(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
}

test('исполнителя пишут с Чудо-Юдо перепиской, а в поля он ложится по «Принять правки»', async ({ page }) => {
  const panel = await mockApi(page)
  await openSection(page)
  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog', { name: 'Новый исполнитель' })
  await expect(modal.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  await modal.getByRole('button', { name: 'Завести с Чудо-Юдо' }).click()
  const chat = page.getByRole('dialog', { name: 'Исполнитель с Чудо-Юдо' })
  await chat.getByLabel('Просьба').fill('Читает дифф ветки и возвращает вердикт')
  await chat.getByRole('button', { name: 'Отправить' }).click()
  await expect(chat.getByRole('status')).toContainText('Чудо-Юдо пишет исполнителя Agents Kit Web')

  // Чудо-Юдо переспрашивает, оператор уточняет в той же переписке.
  panel.answer({ type: 'answer', text: 'С чем сверять дифф?', durationMs: 8000 })
  await expect(chat.getByText('С чем сверять дифф?')).toBeVisible()
  await chat.getByLabel('Следующая реплика').fill('С критериями закрытия')
  await chat.getByRole('button', { name: 'Отправить' }).click()
  panel.answer({ type: 'answer', text: 'Вот ревьюер.', durationMs: 20000, proposal: drafted, changed: fields })
  await expect(chat.getByText('Вот ревьюер.')).toBeVisible()

  expect(panel.posts).toEqual([
    {
      base,
      wish: 'Читает дифф ветки и возвращает вердикт',
      current: { name: '', description: '', model: '', tools: '', prompt: '' },
      subject: null,
    },
  ])
  expect(panel.replies).toEqual([
    { text: 'С критериями закрытия', current: { name: '', description: '', model: '', tools: '', prompt: '' } },
  ])

  await chat.getByRole('tab', { name: /Изменения/ }).click()
  await chat.getByRole('button', { name: 'Открыть задание' }).click()
  const task = page.getByRole('dialog', { name: 'Задание reviewer' })
  await expect(task.getByText('Ты читаешь дифф ветки целиком и возвращаешь вердикт.')).toBeVisible()
  await task.getByRole('button', { name: 'Закрыть', exact: true }).click()
  // До «Принять правки» поля окна исполнителя не тронуты.
  await expect(modal.getByLabel('Имя')).toHaveValue('')
  await chat.getByRole('button', { name: 'Принять правки' }).click()

  await expect(chat).toHaveCount(0)
  await expect(modal.getByLabel('Имя')).toHaveValue('reviewer')
  await expect(modal.getByLabel('Описание')).toHaveValue('Читает дифф ветки задачи и возвращает вердикт.')
  await expect(modal.getByLabel('Модель')).toHaveValue('opus')
  await expect(modal.getByText('Правки Чудо-Юдо приняты')).toBeVisible()

  // Файл пишет панель, и только по «Сохранить»: до него на диске ничего нет.
  expect(panel.saved).toHaveLength(0)
  await modal.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(panel.saved).toEqual([{ base, ...drafted, editing: null }])
})

test('закрытое окно переписку не кончает: ответ ждёт в шапке и открывается переписанием того же исполнителя', async ({
  page,
}) => {
  const reviewer = { ...drafted, path: `${agents}\\reviewer.md` }
  const panel = await mockApi(page, [reviewer])
  await openSection(page)
  await page.getByRole('button', { name: 'reviewer, Agents Kit Web' }).click()
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  await modal.getByRole('button', { name: 'Переписать с Чудо-Юдо' }).click()
  const chat = page.getByRole('dialog', { name: 'Исполнитель с Чудо-Юдо' })
  await chat.getByLabel('Просьба').fill('Пусть ещё сверяет с критериями')
  await chat.getByRole('button', { name: 'Отправить' }).click()
  await expect(chat.getByRole('status')).toContainText('переписывает исполнителя reviewer')
  expect(panel.posts[0]).toMatchObject({ subject: 'reviewer', current: drafted })

  // Оператор закрыл оба окна, пока агент работает: переписка остаётся в панели.
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  panel.answer({
    type: 'answer',
    text: 'Дописал сверку.',
    durationMs: 9000,
    proposal: { ...drafted, description: 'Сверяет дифф с критериями.' },
    changed: ['description'],
  })
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо ответил об исполнителе reviewer/ })
  await expect(done).toBeVisible()

  await done.click()

  // Ответ открывается правкой reviewer с перепиской поверх, а не окном нового, где его имя было бы занято.
  const reopened = page.getByRole('dialog', { name: 'Исполнитель с Чудо-Юдо' })
  await expect(reopened.getByText('Дописал сверку.')).toBeVisible()
  await reopened.getByRole('button', { name: 'описание' }).click()
  await reopened.getByRole('button', { name: 'Принять правки' }).click()
  await expect(page.getByRole('dialog', { name: 'reviewer' }).getByLabel('Описание')).toHaveValue('Сверяет дифф с критериями.')
  expect(panel.posts).toHaveLength(1)
})

test('неудача агента сказана в переписке, поля окна не тронуты', async ({ page }) => {
  const panel = await mockApi(page)
  await openSection(page)
  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog', { name: 'Новый исполнитель' })
  await modal.getByRole('button', { name: 'Завести с Чудо-Юдо' }).click()
  const chat = page.getByRole('dialog', { name: 'Исполнитель с Чудо-Юдо' })
  await chat.getByLabel('Просьба').fill('Ревьюер ветки')
  await chat.getByRole('button', { name: 'Отправить' }).click()

  panel.answer({ type: 'error', text: 'Исполнитель без имени: в шапке файла нет строки name', output: 'Готово.' })

  await expect(chat.getByRole('alert')).toContainText('Исполнитель без имени')
  await expect(chat.getByRole('tab', { name: 'Изменения' })).toBeDisabled()
  await chat.getByRole('button', { name: 'Закрыть' }).click()
  // Закрытая переписка возвращает фокус на свою кнопку: пока она открыта, окно исполнителя inert.
  await expect(modal.getByRole('button', { name: 'Завести с Чудо-Юдо' })).toBeFocused()
  await expect(modal.getByLabel('Имя')).toHaveValue('')
  await expect(modal.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

import { expect, test, type Page, type Route } from '@playwright/test'

const base = 'D:\\Projects\\app-knowledge'

const review = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha',
  skip: null,
  description: '1. Собрать дифф.',
  helpers: [],
  slug: 'review',
}
const merge = { title: 'Мерж', executor: 'оркестратор', output: 'sha в dev', skip: null, description: null, helpers: [], slug: 'merge' }
const spare = { title: 'Запас', executor: 'оператор', output: 'ничего', skip: null, description: null, helpers: [], slug: 'spare' }

const full = {
  name: 'полный',
  when: 'новая возможность',
  entries: [{ stage: 'Ревью', returns: [] }, { stage: 'Мерж', returns: [{ condition: 'красное', stage: 'Ревью' }] }],
}
const small = { name: 'мелкий', when: 'правка в одном месте', entries: [{ stage: 'Ревью', returns: [] }] }

/** Правки Чудо-Юдо: ревью переименовано, документация заведена и встала в мелкий сценарий, запас удалён. */
const proposal = {
  stages: [
    { of: 'Ревью', stage: { ...review, title: 'Проверка', output: 'вердикт по sha и тестам' } },
    { stage: { title: 'Документация', executor: 'оператор', output: 'раздел', skip: null, description: null, helpers: [] } },
    { of: 'Запас' },
  ],
  scenarios: [{ of: 'мелкий', flow: { ...small, entries: [{ stage: 'Проверка' }, { stage: 'Документация' }] } }],
}

type Said = Record<string, unknown> & { type: string; text: string }

/**
 * Панель с одной перепиской о флоу, как настоящая: POST её заводит, реплики дописываются в переписку, а окно
 * читает её потоком с начала. /api подменяется: настоящая просьба запустила бы агента в живой копии оператора,
 * а «Принять правки» записало бы флоу в живую базу и закоммитило бы его.
 */
async function mockApi(page: Page, tasks: { task: string; flow: string | null }[] = []) {
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
  await page.route('**/api/performers', (route) =>
    route.fulfill({
      json: [
        {
          base,
          project: 'Agents Kit Web',
          directory: `${base}\\agents`,
          performers: [{ name: 'reviewer', description: null, model: null, tools: null, prompt: '', path: `${base}\\agents\\reviewer.md` }],
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/flow', (route) => {
    if (route.request().method() === 'POST') {
      panel.saved.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2' } })
    }
    return route.fulfill({
      json: [
        { base, project: 'Agents Kit Web', stages: [review, merge, spare], flows: [full, small], version: 'v1', error: null, icons: {}, tasks },
      ],
    })
  })

  await page.route('**/api/flow/rewrite', async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>
    panel.posts.push(body)
    panel.lines = [JSON.stringify({ type: 'reply', text: String(body.wish ?? '') })]
    panel.request = {
      kind: 'flow',
      id: `r${panel.posts.length}`,
      base: String(body.base ?? ''),
      project: 'Agents Kit Web',
      text: String(body.wish ?? ''),
      elapsedMs: 0,
      state: 'running',
    }
    panel.state = 'running'
    await route.fulfill({ json: { ...panel.request } })
  })

  await page.route('**/api/flow/rewrite/reply', async (route) => {
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

  await page.route('**/api/agent/flow/stream*', async (route) => {
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

async function openRewrite(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  await page.mouse.move(900, 400)
  await expect(page.getByRole('region', { name: 'Сценарий «полный»' })).toBeVisible()
  await page.getByRole('button', { name: 'Ещё действия' }).click()
  await page.getByRole('menuitem', { name: 'Переписать с Чудо-Юдо' }).click()
  return page.getByRole('dialog', { name: 'Переписать с Чудо-Юдо' })
}

test('оператор переписывается с Чудо-Юдо: вопрос, уточнение, правки копятся на вкладке и записываются разом', async ({ page }) => {
  const panel = await mockApi(page)
  const modal = await openRewrite(page)
  await expect(modal.getByRole('button', { name: /Этапы/ })).toHaveCount(0)
  await expect(modal.getByRole('tab', { name: /^Изменения/ })).toBeDisabled()

  await modal.getByLabel('Просьба').fill('Переименуй ревью в проверку и заведи документацию')
  await modal.getByRole('button', { name: 'Отправить' }).click()
  // Агент видит флоу целиком: просьба уходит со всеми этапами и сценариями раздела.
  await expect.poll(() => panel.posts.length).toBe(1)
  expect(panel.posts[0]).toMatchObject({ base, stages: [{ title: 'Ревью' }, { title: 'Мерж' }, { title: 'Запас' }], flows: [{ name: 'полный' }, { name: 'мелкий' }] })
  await expect(modal.getByText('Чудо-Юдо читает флоу Agents Kit Web…')).toBeVisible()

  // Ответ-вопрос: списка изменений нет, вкладка погашена.
  panel.answer({ type: 'answer', text: 'Документацию ставить в оба сценария?', durationMs: 9000, proposal: { stages: [], scenarios: [] } })
  await expect(modal.getByText('Документацию ставить в оба сценария?')).toBeVisible()
  await expect(modal.getByRole('tab', { name: /^Изменения/ })).toBeDisabled()

  await modal.getByLabel('Следующая реплика').fill('Только в мелкий, а запас убери')
  await modal.getByRole('button', { name: 'Отправить' }).click()
  await expect.poll(() => panel.replies.length).toBe(1)
  expect(panel.replies[0]).toMatchObject({ text: 'Только в мелкий, а запас убери', flows: [{ name: 'полный' }, { name: 'мелкий' }] })

  panel.answer({ type: 'answer', text: 'Готово.', durationMs: 41000, proposal, changed: { scenarios: 1, stages: 3 } })
  await expect(modal.getByText('В изменениях:')).toBeVisible()
  await expect(modal.getByLabel('Список изменён последним ответом')).toBeVisible()
  await modal.getByRole('button', { name: '1 сценарий, 3 этапа' }).click()

  const changes = modal.getByLabel('Изменения флоу')
  await expect(changes.getByText('Сценарии', { exact: true })).toBeVisible()
  await expect(changes.getByText('Этапы', { exact: true })).toBeVisible()
  await expect(changes.getByText('в сценариях «полный», «мелкий»')).toBeVisible()
  await expect(changes.getByText('удалён')).toBeVisible()
  // Цепочка мелкого сценария: документация в нём новая.
  await changes.getByText('мелкий', { exact: true }).click()
  await expect(changes.locator('.rewrite-token-added', { hasText: 'Документация' })).toBeVisible()
  // На вкладке «Изменения» поля нет, а кнопки свои.
  await expect(modal.getByLabel('Следующая реплика')).toHaveCount(0)
  await expect(modal.getByLabel('Список изменён последним ответом')).toHaveCount(0)

  await modal.getByRole('button', { name: 'Принять правки' }).click()

  await expect.poll(() => panel.saved.length).toBe(1)
  expect(panel.saved[0]).toMatchObject({
    stages: [{ title: 'Проверка', slug: 'review', output: 'вердикт по sha и тестам' }, { title: 'Мерж' }, { title: 'Документация', slug: null }],
    flows: [
      { name: 'полный', entries: [{ stage: 'Проверка' }, { stage: 'Мерж', returns: [{ condition: 'красное', stage: 'Проверка' }] }] },
      { name: 'мелкий', entries: [{ stage: 'Проверка' }, { stage: 'Документация' }] },
    ],
  })
  expect((panel.saved[0].stages as unknown[]).length).toBe(3)
  // Переписка после записи продолжается.
  await expect(modal).toBeVisible()
})

test('описание из правок открывается окном того же размера, что на вкладке «Этапы», и закрытое возвращает фокус', async ({ page }) => {
  const panel = await mockApi(page)
  const modal = await openRewrite(page)
  await modal.getByLabel('Просьба').fill('Пусть ревью смотрит тесты')
  await modal.getByRole('button', { name: 'Отправить' }).click()
  const described = { ...review, description: '1. Собрать дифф.\n2. Прогнать тесты.' }
  panel.answer({ type: 'answer', text: 'Готово.', proposal: { stages: [{ of: 'Ревью', stage: described }], scenarios: [] }, changed: { scenarios: 0, stages: 1 } })
  await modal.getByRole('button', { name: '1 этап' }).click()
  await modal.getByText('Ревью', { exact: true }).click()

  const open = modal.getByRole('button', { name: 'Открыть описание' })
  await open.click()
  const fromChanges = page.getByRole('dialog', { name: 'Описание этапа «Ревью»' })
  await expect(fromChanges.getByRole('listitem')).toHaveText(['Собрать дифф.', 'Прогнать тесты.'])
  await expect(fromChanges.getByRole('button', { name: /Редактировать/ })).toHaveCount(0)
  const measure = async (dialog: typeof fromChanges) => {
    const box = (await dialog.boundingBox())!
    const icon = (await dialog.locator('.ask-title svg').first().boundingBox())!
    return { width: Math.round(box.width), height: Math.round(box.height), icon: Math.round(icon.width) }
  }
  let rewriteSize = { width: 0, height: 0, icon: 0 }
  await expect(async () => {
    rewriteSize = await measure(fromChanges)
    expect(rewriteSize.height).toBeGreaterThan(page.viewportSize()!.height * 0.85)
  }).toPass()

  await fromChanges.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(fromChanges).toHaveCount(0)
  await expect(open).toBeFocused()

  // Escape закрывает только окно описания: окно переписки под ним остаётся.
  await open.click()
  await expect(fromChanges).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(fromChanges).toHaveCount(0)
  await expect(modal).toBeVisible()
  await expect(open).toBeFocused()

  // То же окно со схемы вкладки «Сценарии»: размер и значок совпадают.
  await modal.getByRole('button', { name: 'Закрыть' }).first().click()
  await page.getByRole('region', { name: 'Сценарий «полный»' }).getByRole('button', { name: 'Этап 1: Ревью' }).click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Редактировать описание' }).click()
  const fromStages = page.getByRole('dialog', { name: 'Описание этапа «Ревью»' })
  await expect(async () => expect(await measure(fromStages)).toEqual(rewriteSize)).toPass()
})

test('правки занятого задачей сценария помечены замком, и «Принять правки» погашена', async ({ page }) => {
  const panel = await mockApi(page, [{ task: 'B-238', flow: 'мелкий' }])
  const modal = await openRewrite(page)

  await modal.getByLabel('Просьба').fill('Заведи документацию в мелком')
  await modal.getByRole('button', { name: 'Отправить' }).click()
  panel.answer({ type: 'answer', text: 'Готово.', proposal, changed: { scenarios: 1, stages: 3 } })
  await modal.getByRole('button', { name: '1 сценарий, 3 этапа' }).click()

  await expect(modal.getByRole('status')).toContainText('Правки не записать: заняты задачами в работе')
  await expect(modal.getByRole('status')).toContainText('сценарий «мелкий»')
  await expect(modal.getByTitle('Занят: B-238').first()).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
  expect(panel.saved).toHaveLength(0)
})

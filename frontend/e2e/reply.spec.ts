import { expect, test, type Page } from '@playwright/test'

const row = (status = 'waiting', path = 'D:\\Projects\\app', branch = 'feat/reply') => ({
  project: 'app-knowledge',
  base: 'D:\\Projects\\app-knowledge',
  path,
  branch,
  task: 'Окно ответа',
  flowStep: 'Критерий',
  progress: 0,
  status,
  error: null,
})

type Question = { title: string; context: string | null; variants: { choice: string; effect: string | null; recommended: boolean }[]; answer: null }

const plain = (title: string): Question => ({ title, context: null, variants: [], answer: null })

// /api подменяется: dev-API читает настоящую базу знаний, и ответ из прогона попал бы в живую память.
async function stubQuestions(page: Page, questions: Question[], extra: Record<string, unknown> = {}) {
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [],
        outOfScope: null,
        artifacts: [],
        vsCodeSession: false,
        questions,
        ...extra,
      },
    }),
  )
}

async function openReply(page: Page) {
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()
  return page.getByRole('dialog', { name: 'Ответ оператора' })
}

test('оператор отвечает на вопросы копии лентой, ответы уходят после секунд с «Отменить», и строка перестаёт ждать', async ({ page }) => {
  let answered = false
  let posted: unknown = null

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row(answered ? 'in-work' : 'waiting')] }))
  await stubQuestions(
    page,
    [
      { title: 'Подтвердить критерий?', context: 'За вами объём проверок', variants: [], answer: null },
      {
        title: 'Как быть с переносами?',
        context: 'Ответ записывается одной строкой',
        variants: [
          { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
          { choice: 'Не отправлять', effect: 'Оператор переписывает', recommended: false },
        ],
        answer: null,
      },
    ],
    { criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }], outOfScope: 'Health баз.' },
  )
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    answered = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const tableRow = page.getByRole('row', { name: /Окно ответа/ })
  await expect(tableRow.getByText('Ждёт оператора')).toBeVisible()
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  // второй вопрос виден свёрнутым с самого открытия
  await expect(dialog.getByRole('button', { name: /^Как быть с переносами\?/ })).toBeVisible()

  // строка ввода получает фокус сама: отвечают, не берясь за мышь
  const answer = dialog.getByLabel('Ответ')
  await expect(answer).toBeFocused()
  await answer.fill('принимаю')
  await answer.press('Enter')

  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
  await dialog.getByRole('button', { name: /Заменять пробелами/ }).click()
  await expect(answer).toHaveValue('Заменять пробелами')
  await dialog.getByRole('button', { name: 'Ответить' }).click()

  await expect(dialog.getByRole('status')).toHaveText(/Ответы отправлены агенту/)
  await expect(dialog.getByRole('button', { name: 'Отменить' })).toBeVisible()
  expect(posted).toBeNull()
  // галочка строки — своего размера, а не общих 18px значков окна
  const check = (await dialog.locator('.sent svg').boundingBox())!
  expect([Math.round(check.width), Math.round(check.height)]).toEqual([14, 14])

  // после секунд с «Отменить» ответы записываются, и окно закрывается само
  await expect(dialog).toBeHidden({ timeout: 10000 })
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'Заменять пробелами' },
    ],
  })
  await expect(tableRow.getByText('В работе')).toBeVisible()
})

test('«Отменить» ничего не записывает, а окно остаётся с данными ответами', async ({ page }) => {
  let posted = false
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')])
  await page.route('**/api/answers', async (route) => {
    posted = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  await answer.press('Enter')
  await dialog.getByRole('button', { name: 'Отменить' }).click()

  await expect(answer).toHaveValue('принимаю')
  await page.waitForTimeout(3500)
  expect(posted).toBe(false)
  await expect(dialog).toBeVisible()
})

test('вопросы агента — пузыри слева, ответы оператора — справа, в обеих темах', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  await answer.press('Enter')

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(async () => {
      const feed = (await dialog.locator('.reply-feed').boundingBox())!
      const question = (await dialog.locator('.agent-q').boundingBox())!
      const compact = (await dialog.locator('.q-compact').boundingBox())!
      const bubble = (await dialog.locator('.op-bubble').boundingBox())!
      // вопрос и свёрнутый вопрос прижаты влево и не во всю ширину, ответ — вправо
      expect(question.x - feed.x).toBeLessThan(40)
      expect(compact.x - feed.x).toBeLessThan(40)
      expect(question.width).toBeLessThan(feed.width - 48)
      expect(compact.width).toBeLessThan(feed.width - 48)
      expect(feed.x + feed.width - (bubble.x + bubble.width)).toBeLessThan(40)
    }).toPass()
    // пузырь вопроса залит своим цветом, отличным от фона окна
    const fill = await dialog.locator('.agent-q').evaluate((el) => getComputedStyle(el).backgroundColor)
    const windowFill = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(fill).not.toBe(windowFill)
  }
})

test('пропущенный вопрос — пунктиром, у вариантов кружок выбора, значки шапки и строки ввода своего размера', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(
    page,
    [
      plain('Подтвердить критерий?'),
      {
        title: 'Как быть с переносами?',
        context: null,
        variants: [
          { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
          { choice: 'Не отправлять', effect: null, recommended: false },
        ],
        answer: null,
      },
    ],
    { outOfScope: 'Health баз.', artifacts: [{ label: 'макет', address: 'https://claude.ai/artifact/AbC123' }] },
  )

  await page.goto('/')
  const dialog = await openReply(page)
  await dialog.getByRole('button', { name: 'Пропустить' }).click()
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()

  const skipped = dialog.locator('.q-compact.is-skipped')
  await expect(skipped).toHaveText(/Пропущен/)
  await expect(skipped).toHaveCSS('border-top-style', 'dashed')

  // кружок выбора: пустой у невыбранного, с точкой у выбранного
  const option = dialog.getByRole('button', { name: /Заменять пробелами/ })
  const dot = option.locator('.radio-dot')
  const dotBox = (await dot.boundingBox())!
  expect(Math.round(dotBox.width)).toBe(16)
  expect(await dot.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
  await option.click()
  expect(await dot.evaluate((el) => getComputedStyle(el, '::after').content)).not.toBe('none')

  // общее `.modal-overlay svg` (18px) перебивает правило компонента той же силы — размер меряется
  const size = async (selector: string) => {
    const box = (await dialog.locator(selector).first().boundingBox())!
    return [Math.round(box.width), Math.round(box.height)]
  }
  await expect(async () => {
    expect(await size('.strip-actions .btn-ghost svg')).toEqual([16, 16])
    expect(await size('.composer-skip svg')).toEqual([16, 16])
    expect(await size('.composer-send svg')).toEqual([16, 16])
  }).toPass()

  await dialog.getByLabel('Ответ').fill('')
  // у пропущенного вопроса тоже есть «Ответить» — строка ввода отвечает кнопкой с этим именем целиком
  await dialog.getByRole('button', { name: 'Ответить', exact: true }).click()
  await expect(dialog.locator('.field-error')).toBeVisible()
  expect(await size('.field-error svg')).toEqual([14, 14])
})

test('окна «Контекст задачи» и «Артефакты» открываются поверх, держат фокус и возвращают его на свою кнопку', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')], {
    criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }],
    outOfScope: 'Health баз.',
    artifacts: [
      { label: 'макет окна ответа', address: 'https://claude.ai/artifact/AbC123' },
      { label: 'спецификация', address: 'D:\\Projects\\app\\spec.md' },
    ],
  })
  let openedArtifact: unknown = null
  await page.route('**/api/artifact/open', async (route) => {
    openedArtifact = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()

  const contextButton = dialog.getByRole('button', { name: 'Контекст задачи' })
  await contextButton.click()
  const context = page.getByRole('dialog', { name: 'Контекст задачи' })
  await expect(context.getByText('Оператор отвечает из панели.')).toBeVisible()
  await expect(context.getByText('Health баз.')).toBeVisible()
  // окно ответа под ним недоступно: Tab в него не заходит
  for (let i = 0; i < 6; i++) {
    await page.keyboard.press('Tab')
    expect(await page.locator('.reply-window').evaluate((el) => el.contains(document.activeElement))).toBe(false)
  }
  await page.keyboard.press('Escape')
  await expect(context).toBeHidden()
  await expect(dialog).toBeVisible()
  await expect(contextButton).toBeFocused()

  const artifactsButton = dialog.getByRole('button', { name: /^Артефакты/ })
  await expect(artifactsButton).toHaveText(/Артефакты\s*2/)
  await artifactsButton.click()
  const artifacts = page.getByRole('dialog', { name: 'Артефакты' })
  const link = artifacts.getByRole('link', { name: 'https://claude.ai/artifact/AbC123' })
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(artifacts.getByRole('link', { name: 'D:\\Projects\\app\\spec.md' })).toHaveCount(0)
  // ссылка янтарная, как остальные ссылки панели, а путь — серый
  const tokenColor = (token: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }, token)
  await expect(link).toHaveCSS('color', await tokenColor('--accent-waiting-text'))
  const file = artifacts.getByRole('button', { name: 'D:\\Projects\\app\\spec.md' })
  await expect(file).toHaveCSS('color', await tokenColor('--text-secondary'))
  await file.click()
  await expect.poll(() => openedArtifact).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    index: 1,
    address: 'D:\\Projects\\app\\spec.md',
  })

  await artifacts.getByRole('button', { name: 'Закрыть' }).click()
  await expect(artifacts).toBeHidden()
  await expect(artifactsButton).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

// Раньше шапка контекста была одной строкой, и длинный путь копии рвался на много строк рядом с кнопками перехода.
test('длинные задача, копия и ветка в шапке не наезжают друг на друга, на кнопки и на ленту', async ({ page }) => {
  const long = 'очень-длинное-имя-'.repeat(6)
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: [row('waiting', `D:\\Projects\\${long}copy`, `feat/${long}branch`)] }),
  )
  await stubQuestions(page, [plain('Подтвердить критерий?')], {
    copy: `D:\\Projects\\${long}copy`,
    branch: `feat/${long}branch`,
    task: `B-199 Окно ответа ${'с очень длинным названием задачи '.repeat(4)}`,
    outOfScope: 'Health баз.',
    artifacts: [{ label: 'макет', address: 'https://claude.ai/artifact/AbC123' }],
    backgroundSession: true,
  })

  await page.goto('/')
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await expect(dialog.locator('.strip-meta')).toContainText(`${long}copy`)
  await expect(dialog.locator('.strip-meta')).not.toContainText('D:\\Projects')

  // шрифт панели грузится после первой отрисовки — замер повторяется, пока не сойдётся
  await expect(async () => {
    const strip = (await dialog.locator('.task-strip').boundingBox())!
    const task = (await dialog.locator('.strip-task').boundingBox())!
    const meta = (await dialog.locator('.strip-meta').boundingBox())!
    const actions = (await dialog.locator('.strip-actions').boundingBox())!
    const feed = (await dialog.locator('.reply-feed').boundingBox())!
    expect(task.y + task.height).toBeLessThanOrEqual(meta.y + 1)
    expect(meta.y + meta.height).toBeLessThanOrEqual(actions.y + 1)
    expect(actions.y + actions.height).toBeLessThanOrEqual(strip.y + strip.height + 1)
    expect(strip.y + strip.height).toBeLessThanOrEqual(feed.y + 1)
    for (const part of [task, meta, actions]) expect(part.x + part.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
  }).toPass()
  const fits = await dialog.locator('.reply-feed').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)
})

test('данные ответы возвращаются после закрытия окна и перезагрузки страницы, а открыто на вопросе без ответа', async ({ page }) => {
  let posted = false
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', async (route) => {
    posted = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  let dialog = await openReply(page)
  await dialog.getByLabel('Ответ').fill('принимаю, но без e2e')
  await dialog.getByLabel('Ответ').press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  for (const reload of [false, true]) {
    if (reload) await page.reload()
    dialog = await openReply(page)
    await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
    await expect(dialog.locator('.op-bubble')).toHaveText(/принимаю, но без e2e/)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
  expect(posted).toBe(false)
})

// Внешняя страница тоже подменена, чтобы прогон не ходил в сеть.
test('ссылка из вопроса открывается в новой вкладке, окно ответа и набранное остаются', async ({ page, context }) => {
  const longUrl = `https://example.com/${'verylongsegment'.repeat(20)}end`
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Внешняя страница</title>' }),
  )
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [
    {
      title: 'Куда переносить выгрузку?',
      context: `Объявление в заявке https://example.com/tickets/OPS-1\n\nПример адреса: ${longUrl}`,
      variants: [],
      answer: null,
    },
  ])

  await page.goto('/')
  const dialog = await openReply(page)
  await dialog.getByLabel('Ответ').fill('в новую папку')

  const link = dialog.getByRole('link', { name: 'https://example.com/tickets/OPS-1' })
  await expect(link).toBeVisible()
  await expect(link.locator('svg')).toHaveCount(0)

  // длинный адрес переносится внутри пузыря вопроса и не раздвигает ленту
  const box = (await dialog.locator('.q-context').boundingBox())!
  const bubble = (await dialog.locator('.agent-q').boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(bubble.x + bubble.width + 1)
  const fits = await dialog.locator('.reply-feed').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)

  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()])
  await tab.waitForLoadState()
  expect(tab.url()).toBe('https://example.com/tickets/OPS-1')

  expect(page.url()).not.toContain('example.com')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('в новую папку')
})

test('лента проходится одной клавиатурой: Enter отвечает, стрелка возвращает к прежнему, ответ правится', async ({ page }) => {
  let posted: unknown = null
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')

  await answer.fill('принимаю')
  await answer.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Предыдущий вопрос' }).click()
  await expect(answer).toHaveValue('принимаю')
  await answer.fill('принимаю с оговоркой')
  await answer.press('Enter')

  await answer.fill('заменять')
  await answer.press('Enter')

  await expect(dialog).toBeHidden({ timeout: 10000 })
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю с оговоркой' },
      { question: 'Как быть с переносами?', answer: 'заменять' },
    ],
  })
})

test('отказ записи — красной строкой под полем ответа, окно остаётся на вопросе отказа', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', (route) =>
    route.fulfill({ status: 409, json: { question: 'Подтвердить критерий?', problem: 'already-answered' } }),
  )

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  await answer.press('Enter')
  await answer.fill('заменять')
  await answer.press('Enter')

  const alert = dialog.getByRole('alert')
  await expect(alert).toHaveText(/уже ответили из другого места/, { timeout: 10000 })
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await expect(answer).toHaveValue('принимаю')
  // строка стоит под полем ответа
  const field = (await answer.boundingBox())!
  const line = (await alert.boundingBox())!
  expect(line.y).toBeGreaterThanOrEqual(field.y + field.height - 1)
})

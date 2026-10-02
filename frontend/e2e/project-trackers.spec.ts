import { expect, test, type Locator, type Page } from '@playwright/test'

// Трекеры проектов раздела «Трекеры» и окно «Трекер проекта» (B-293, B-323). /api подменяется: запись описания
// коммитит в базу и сводит её с сервером скриптом кита — это проверяют тесты бэкенда на временной базе.

const long = 'https://tracker.severo-zapadnaya-logisticheskaya-kompaniya.corp.northwind-group.ru/youtrack'

const description = {
  tracker: 'YouTrack',
  server: long,
  project: 'LOGISTICS_NORTH_WEST',
  where: 'Ходим MCP-сервером youtrack.',
  backlog: 'Незакрытые задачи проекта на мне.',
  take: 'Назначить на себя и перевести в «В работе».',
  closed: 'Перевести в «Готово».',
  move: 'Новая задача в том же проекте.',
}

const rows = [
  {
    base: String.raw`D:\Projects\logistics-knowledge`,
    project: 'Логистика северо-западного направления',
    problem: null,
    tracker: { kind: 'youtrack', name: 'YouTrack', server: long, project: 'LOGISTICS_NORTH_WEST' },
    description,
    version: 'v1',
    busy: [],
    newerFormat: false,
  },
  {
    base: String.raw`D:\Projects\crm-knowledge`,
    project: 'CRM',
    problem: null,
    tracker: null,
    description: null,
    version: '',
    busy: [],
    newerFormat: false,
  },
]

async function mockApi(page: Page, list: unknown[] = rows) {
  const saved: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/bases', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/kit', (route) => route.fulfill({ json: { path: null, found: false } }))
  await page.route('**/api/trackers', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/agent/requests', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/trackers/projects**', (route) => {
    if (route.request().method() === 'PUT') {
      saved.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2', checked: true, pushed: true, message: null } })
    }
    return route.fulfill({ json: list })
  })
  return saved
}

async function openSection(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Трекеры' }).click()
  // Мышь уходит с полосы разделов: под ней полоса раскрыта и лежит поверх списка проектов.
  await page.mouse.move(page.viewportSize()!.width - 20, page.viewportSize()!.height - 20)
  return page.getByRole('navigation', { name: 'Трекеры проектов' })
}

/** Подробности выбранного проекта — справа от списка. */
function detail(page: Page, project: string) {
  return page.getByRole('region', { name: `Трекер проекта ${project}` })
}

/** Элемент не выходит за правый край рамки. */
async function inside(element: Locator, frame: Locator) {
  await expect(async () => {
    const [box, outer] = await Promise.all([element.boundingBox(), frame.boundingBox()])
    expect(box!.x + box!.width).toBeLessThanOrEqual(outer!.x + outer!.width + 0.5)
  }).toPass()
}

/** Горизонтальной прокрутки нет: содержимое не шире своего места. */
async function noSideScroll(element: Locator) {
  await expect(async () => {
    const { scroll, client } = await element.evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(scroll).toBeLessThanOrEqual(client + 1)
  }).toPass()
}

const logistics = rows[0].project

for (const width of [1400, 900]) {
  test(`длинный адрес сервера не выталкивает кнопки из подробностей проекта (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockApi(page)

    await openSection(page)
    const card = detail(page, logistics)
    await expect(card.getByText(long)).toBeVisible()
    await inside(card.getByRole('button', { name: /^Изменить трекер/ }), card)
    await inside(card.getByRole('button', { name: /^Удалить трекер/ }), card)
    await inside(card.getByText(long), card)
    await noSideScroll(page.locator('html'))
  })
}

// Замечание оператора на приёмке B-285: рамка проектов тянется до низа экрана, а не стоит низкой полосой.
test('рамка проектов раздела «Трекеры» тянется до низа экрана', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 })
  await mockApi(page)

  await openSection(page)
  const frame = page.locator('.trackers > .tp')
  await expect(async () => {
    const box = await frame.boundingBox()
    // Под рамкой — только её отступ и отступ раздела
    expect(1000 - (box!.y + box!.height)).toBeLessThanOrEqual(48)
  }).toPass()
  await noSideScroll(page.locator('html'))
})

// Критерий 2 B-323: выбранный проект выделен, как выбранный пункт полосы разделов (ответ оператора на макет).
test('выбранный проект выделен так же, как выбранный раздел в полосе', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockApi(page)

  const list = await openSection(page)
  await list.getByRole('button', { name: /^CRM/ }).click()
  await expect(detail(page, 'CRM')).toBeVisible()

  const look = (element: Locator) =>
    element.evaluate((el) => {
      const style = getComputedStyle(el)
      return { background: style.backgroundColor, border: style.borderLeftColor, color: style.color, width: style.borderLeftWidth }
    })
  const section = page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Трекеры' })
  // Мышь уводится и с полосы, и со строки: под ней обе подсвечивались бы наведением.
  await page.mouse.move(1300, 850)
  await expect(async () => expect(await look(list.getByRole('button', { name: /^CRM/ }))).toEqual(await look(section))).toPass()
})

// Приёмка B-323: проект без трекера — как пустой проект во «Флоу», но без градиента на фоне.
test('проект без трекера — круг пунктиром, заголовок и «Завести трекер» по центру подробностей, без градиента', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockApi(page)

  const list = await openSection(page)
  await list.getByRole('button', { name: /^CRM/ }).click()
  const card = detail(page, 'CRM')
  const empty = card.locator('.empty-state')
  await expect(card.getByRole('heading', { name: 'В этом проекте нет трекера' })).toBeVisible()
  await expect(empty.getByRole('button')).toHaveText(['Завести трекер'])
  // Текст заголовка — по центру подробностей, пустой вид — во всю их высоту; замер — до совпадения: шрифт грузится
  // после первой отрисовки. Меряется сам текст, а не блок h3: блок во всю ширину стоял бы «по центру» и у текста слева.
  await expect(async () => {
    const [frame, box, text] = await Promise.all([
      card.boundingBox(),
      empty.boundingBox(),
      empty.locator('h3').evaluate((element) => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const rect = range.getBoundingClientRect()
        return { x: rect.x, width: rect.width }
      }),
    ])
    expect(Math.abs(text.x + text.width / 2 - (frame!.x + frame!.width / 2))).toBeLessThan(2)
    expect(Math.abs(box!.y + box!.height - (frame!.y + frame!.height))).toBeLessThan(24)
    expect(box!.height).toBeGreaterThan(frame!.height / 2)
  }).toPass()
  const look = await empty.evaluate((element) => {
    const mark = element.querySelector('.empty-state-mark')!
    const style = getComputedStyle(mark)
    return {
      background: getComputedStyle(element).backgroundImage,
      border: style.borderTopStyle,
      round: style.borderRadius,
      size: (mark as HTMLElement).offsetWidth,
    }
  })
  expect(look).toEqual({ background: 'none', border: 'dashed', round: '50%', size: 96 })
})

// Ключ к серверу — в окне трекера (ответ оператора на B-285): отдельного списка серверов нет, у строки ключа — без «Добавить».
test('без ключа — красная строка ключа без кнопки, и раздел без списка «Серверы трекеров»', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockApi(page)

  await openSection(page)
  const card = detail(page, logistics)
  await expect(card.getByText('нет ключа к этому серверу')).toBeVisible()
  await expect(card.getByRole('button', { name: /Добавить/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Серверы трекеров' })).toHaveCount(0)
})

// Замечание оператора к макету B-293: окно без горизонтальной прокрутки на любой ширине.
for (const width of [1400, 700]) {
  test(`окно трекера без горизонтальной прокрутки, «Сохранить» пишет описание из полей (${width}px)`, async ({ page }) => {
    const saved = await mockApi(page)

    await openSection(page)
    await detail(page, logistics).getByRole('button', { name: /^Изменить трекер/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Трекер проекта', exact: true })
    // Окно сужается уже открытым: на узком экране раскрытый сайдбар лёг бы поверх кнопок раздела.
    await page.setViewportSize({ width, height: 900 })
    await expect(dialog.getByLabel('Адрес сервера')).toHaveValue(long)
    await noSideScroll(dialog)
    await noSideScroll(dialog.locator('.ask-body'))
    await inside(dialog.getByRole('button', { name: 'Сохранить' }), dialog)
    await inside(dialog.getByRole('button', { name: 'Переписать с Чудо-Юдо' }), dialog)

    await dialog.getByLabel('Проект').fill('LOGISTICS')
    await expect(dialog.getByText('изменено')).toBeVisible()
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect
      .poll(() => saved)
      .toEqual([{ base: rows[0].base, version: 'v1', description: { ...description, project: 'LOGISTICS', filter: '' }, key: '', email: null }])
    await expect(dialog).toBeHidden()
  })
}

// Критерий 3 B-323: переписка с Чудо-Юдо — окном поверх окна трекера, как у исполнителя; Escape закрывает верхнее.
test('переписка открывается поверх окна трекера, Escape закрывает сначала её', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 })
  await mockApi(page)

  await openSection(page)
  await detail(page, logistics).getByRole('button', { name: /^Изменить трекер/ }).click()
  const form = page.getByRole('dialog', { name: 'Трекер проекта', exact: true })
  await form.getByRole('button', { name: 'Переписать с Чудо-Юдо' }).click()
  const chat = page.getByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' })
  await expect(chat.getByRole('tab', { name: 'Переписка' })).toHaveAttribute('aria-selected', 'true')
  await expect(chat.getByRole('button', { name: 'Голосовой ввод' })).toBeVisible()

  // Окно трекера под перепиской недоступно: Tab ходит только по переписке (decisions/tests.md — inert проверяет браузер).
  await expect(form).toHaveAttribute('inert', '')
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press('Tab')
    expect(await form.evaluate((element) => element.contains(document.activeElement))).toBe(false)
  }

  await page.keyboard.press('Escape')
  await expect(chat).toBeHidden()
  await expect(form).toBeVisible()
  // Закрытая переписка возвращает фокус на свою кнопку в подвале окна трекера.
  await expect(form.getByRole('button', { name: 'Переписать с Чудо-Юдо' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(form).toBeHidden()
})

// Макет B-285: у Jira в окне группа «Ключ к серверу» — «Почта» и «Ключ» под сервером и проектом; фильтра в окне нет,
// почта и ключ уходят с описанием.
for (const width of [1400, 700]) {
  test(`у Jira в окне «Почта» и «Ключ» под сервером и проектом, без горизонтальной прокрутки (${width}px)`, async ({ page }) => {
    const jira = {
      ...rows[0],
      tracker: { kind: 'jira', name: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' },
      description: { ...description, tracker: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY', filter: 'assignee = currentUser()' },
    }
    const saved = await mockApi(page, [jira, rows[1]])

    await openSection(page)
    await detail(page, logistics).getByRole('button', { name: /^Изменить трекер/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Трекер проекта', exact: true })
    await page.setViewportSize({ width, height: 900 })
    await expect(dialog.getByLabel('Фильтр')).toHaveCount(0)
    const [address, project, email, key] = await Promise.all(
      [dialog.getByLabel('Адрес сервера'), dialog.getByLabel('Проект'), dialog.getByLabel('Почта'), dialog.getByLabel('Ключ')].map((one) =>
        one.boundingBox(),
      ),
    )
    expect(email!.y).toBeGreaterThan(Math.max(address!.y + address!.height, project!.y + project!.height))
    expect(key!.y).toBeGreaterThan(email!.y + email!.height)
    await noSideScroll(dialog.locator('.ask-body'))

    await dialog.getByLabel('Почта').fill('anna@acme.example')
    await dialog.getByLabel('Ключ').fill('токен')
    await dialog.getByRole('button', { name: 'Сохранить' }).click()
    await expect
      .poll(() => saved)
      .toEqual([{ base: jira.base, version: 'v1', description: { ...jira.description, filter: '' }, key: 'токен', email: 'anna@acme.example' }])
  })
}

// Причина о ключе в «Бэклоге» открывает окно трекера проекта, курсор — в поле «Ключ» (комментарий оператора к макету B-285).
test('строка о ключе в «Бэклоге» открывает окно трекера с курсором в «Ключ»', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await mockApi(page)
  await page.route('**/api/backlog', (route) =>
    route.fulfill({ json: [{ base: rows[0].base, project: logistics, entries: [], error: null, tracker: rows[0].tracker }] }),
  )
  await page.route('**/api/backlog/tracker?**', (route) => route.fulfill({ json: { issues: [], problem: 'no-key' } }))

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await page.getByRole('tab', { name: 'Задачи трекера' }).click()
  await expect(page.getByText(`Нет ключа к серверу ${long}. Введите ключ в разделе «Трекеры».`)).toBeVisible()
  await page.getByRole('button', { name: '«Трекеры»' }).click()

  const dialog = page.getByRole('dialog', { name: 'Трекер проекта', exact: true })
  await expect(dialog.getByLabel('Ключ')).toBeFocused()
})

// Критерий 4 B-323: строка поломки в «Бэклоге» ведёт в раздел «Трекеры» и выбирает проект с поломкой.
test('строка поломки трекера в «Бэклоге» ведёт в раздел «Трекеры» к своему проекту', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await mockApi(page, [rows[0], { ...rows[1], tracker: { kind: 'no-keys', faults: ['проект'] } }])
  await page.route('**/api/backlog', (route) =>
    route.fulfill({
      json: [
        {
          base: rows[1].base,
          project: 'CRM',
          entries: [],
          error: null,
          tracker: { kind: 'no-keys', faults: ['проект'] },
        },
      ],
    }),
  )

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  // Строки о задачах трекера — на своей вкладке (B-305)
  await page.getByRole('tab', { name: 'Задачи трекера' }).click()
  await page.getByRole('button', { name: '«Трекеры»' }).click()

  const card = detail(page, 'CRM')
  await expect(card).toBeInViewport()
  await expect(card.getByText('В описании трекера не указан проект или указан не так.')).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Трекеры проектов' }).getByRole('button', { name: /^CRM/ })).toHaveAttribute(
    'aria-current',
    'true',
  )
})

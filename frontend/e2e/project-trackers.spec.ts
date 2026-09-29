import { expect, test, type Locator, type Page } from '@playwright/test'

// Карточка «Трекеры проектов» в «Настройках» и окно «Трекер проекта с Чудо-Юдо» (B-293). /api подменяется: запись
// описания коммитит в базу и сводит её с сервером скриптом кита — это проверяют тесты бэкенда на временной базе.

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

async function mockApi(page: Page) {
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
    return route.fulfill({ json: rows })
  })
  return saved
}

async function openCard(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Настройки' }).click()
  return page.getByRole('region', { name: 'Трекеры проектов' })
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

for (const width of [1400, 900]) {
  test(`строки проектов с длинным адресом не выталкивают кнопки из карточки (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockApi(page)

    const card = await openCard(page)
    const row = card.getByRole('listitem').filter({ hasText: 'Логистика' })
    await expect(row.locator('.prj-server')).toHaveAttribute('title', long)
    await inside(row.getByRole('button', { name: /^Изменить трекер/ }), card)
    await inside(row.getByRole('button', { name: /^Удалить трекер/ }), card)
    await inside(card.getByRole('button', { name: 'Завести трекер CRM' }), card)
    await noSideScroll(page.locator('html'))
  })
}

// Замечание оператора к макету B-293: окно без горизонтальной прокрутки на любой ширине.
for (const width of [1400, 700]) {
  test(`окно трекера без горизонтальной прокрутки, «Принять правки» пишет описание из полей (${width}px)`, async ({ page }) => {
    const saved = await mockApi(page)

    const card = await openCard(page)
    await card.getByRole('button', { name: /^Изменить трекер/ }).click()
    const dialog = page.getByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' })
    // Окно сужается уже открытым: на узком экране раскрытый сайдбар лёг бы поверх кнопок карточки.
    await page.setViewportSize({ width, height: 900 })
    await dialog.getByRole('tab', { name: 'Изменения' }).click()
    await expect(dialog.getByLabel('Адрес сервера')).toHaveValue(long)
    await noSideScroll(dialog)
    await noSideScroll(dialog.locator('.ask-body'))
    await inside(dialog.getByRole('button', { name: 'Принять правки' }), dialog)

    await dialog.getByLabel('Проект').fill('LOGISTICS')
    await expect(dialog.getByText('изменено')).toBeVisible()
    await dialog.getByRole('button', { name: 'Принять правки' }).click()
    await expect
      .poll(() => saved)
      .toEqual([{ base: rows[0].base, version: 'v1', description: { ...description, project: 'LOGISTICS' } }])
    await expect(dialog.getByRole('tab', { name: 'Переписка' })).toHaveAttribute('aria-selected', 'true')

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
}

// Ревью B-293: переход из «Бэклога» показывает карточку, хотя карточки выше дочитываются позже и растут.
test('строка поломки трекера в «Бэклоге» ведёт к карточке, и она остаётся на экране', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 })
  await mockApi(page)
  const bases = Array.from({ length: 14 }, (_, i) => ({ path: String.raw`D:\Projects\base-${i}-knowledge`, copies: 1 }))
  await page.route('**/api/bases', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 700))
    await route.fulfill({ json: bases })
  })
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
  await page.getByRole('button', { name: '«Трекеры проектов»' }).click()

  const card = page.getByRole('region', { name: 'Трекеры проектов' })
  await expect(page.getByRole('list', { name: 'Базы знаний' }).getByRole('listitem')).toHaveCount(14)
  await expect(async () => {
    const box = await card.boundingBox()
    expect(box!.y).toBeGreaterThanOrEqual(-1)
    expect(box!.y).toBeLessThan(800 / 2)
  }).toPass()
})

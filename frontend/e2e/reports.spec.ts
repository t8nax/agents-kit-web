import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

const base = 'D:\\Projects\\app-knowledge'

const requirements = [
  { code: 'П1', ring: 'Проходимость', priority: 'high', title: 'Каждый исход куда-то ведёт', text: 'У каждого исхода есть продолжение.' },
  { code: 'П6', ring: 'Проходимость', priority: 'high', title: 'Задача не теряет себя', text: 'Этап не отправляет недоделанное в бэклог.' },
  { code: 'С1', ring: 'Согласованность', priority: 'high', title: 'Флоу себе не противоречит', text: 'Этап не противоречит себе.' },
  { code: 'Я4', ring: 'Ясность', priority: 'low', title: 'Во флоу только порядок работы', text: 'Во флоу нет устройства системы.' },
]

const report = {
  built: '2026-09-26T09:30:00Z',
  checked: '2026-09-28T06:00:00Z',
  rings: [
    { name: 'Проходимость', score: 70, band: 'avg', total: 2, passed: 0 },
    { name: 'Согласованность', score: 85, band: 'avg', total: 1, passed: 0 },
    { name: 'Ясность', score: 100, band: 'pass', total: 1, passed: 1 },
  ],
  requirements,
  findings: [
    {
      id: '1',
      requirements: ['П1'],
      place: 'Мерж',
      quotes: [{ where: 'Мерж, описание', text: '«Если приёмки не было — спросить „принято“.»' }],
      why: 'При ответе «не принято» у задачи нет продолжения.',
      fix: 'Добавить этапу «Мерж» возврат на этап «Реализация».',
    },
    {
      id: '2',
      requirements: ['П6', 'С1'],
      place: 'Ревью',
      quotes: [],
      why: 'Этап запрещает переносить внесённое задачей в бэклог и тут же разрешает это.',
      fix: 'Заменить перенос в бэклог вопросом оператору.',
    },
  ],
  discussions: [],
}

const schedule = { enabled: true, days: [1, 3, 5], hour: 9 }

/**
 * /api подменяется: настоящий разбор запустил бы Чудо-Юдо по живой базе оператора, а запись расписания легла бы
 * в его профиль.
 */
async function mockReports(page: Page, state: { report: typeof report | null }) {
  const puts: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/reports/flow', (route) =>
    route.fulfill({ json: [{ base, project: 'Agents Kit Web', schedule, report: state.report, blocked: null }] }),
  )
  await page.route('**/api/reports/flow/schedule', (route) => {
    puts.push(route.request().postDataJSON())
    return route.fulfill({ json: schedule })
  })
  return puts
}

async function openReports(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Отчёты' }).click()
}

test('«Отчёты» стоят в сайдбаре сразу за «Расходом»', async ({ page }) => {
  await mockReports(page, { report })
  await page.goto('/')

  // Свёрнутый сайдбар держит название раздела в имени кнопки, а не в тексте.
  const names = await page
    .getByRole('navigation', { name: 'Разделы панели' })
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label')))
  expect(names).toContain('Отчёты')
  expect(names.indexOf('Отчёты')).toBe(names.indexOf('Расход') + 1)
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`строка расписания стоит в одну линию, ничего не уезжает вниз (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await mockReports(page, { report })
    await openReports(page)

    const line = page.locator('.rp-sched')
    await expect(line.getByText('Проверка флоу')).toBeVisible()
    // Шрифт панели грузится после первой отрисовки: замер повторяется до совпадения (decisions/e2e.md).
    await expect(async () => {
      const box = (await line.boundingBox())!
      expect(box.height).toBeLessThanOrEqual(50)
      const parts = [
        line.getByRole('switch', { name: 'Проверять по расписанию' }),
        line.getByRole('button', { name: 'Пн' }),
        line.getByRole('button', { name: 'Час проверки: 09:00' }),
        line.getByText('Проверка флоу'),
      ]
      const middles = await Promise.all(
        parts.map(async (part) => {
          const b = (await part.boundingBox())!
          return b.y + b.height / 2
        }),
      )
      for (const middle of middles) expect(Math.abs(middle - middles[0])).toBeLessThanOrEqual(2)
    }).toPass()
  })
}

test('кольца и находки видны, а находка раскрывается подробностями', async ({ page }) => {
  await mockReports(page, { report })
  await openReports(page)

  await expect(page.getByRole('button', { name: 'Проходимость: 70 из 100.' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Ясность: 100 из 100.' })).toBeVisible()
  const row = page.locator('details').filter({ hasText: 'Каждый исход куда-то ведёт' })
  await row.getByText('Каждый исход куда-то ведёт').click()
  await expect(row.getByText('При ответе «не принято» у задачи нет продолжения.')).toBeVisible()
  // Место и цитата стоят от левого края строки — замечание оператора к макету.
  const place = (await row.getByText('Мерж, описание').boundingBox())!
  const field = (await row.getByText('У каждого исхода есть продолжение.').boundingBox())!
  expect(Math.abs(place.x - field.x)).toBeLessThanOrEqual(12)
})

test('расписание пишется сразу при изменении', async ({ page }) => {
  const puts = await mockReports(page, { report })
  await openReports(page)

  await page.getByRole('button', { name: 'Вт' }).click()

  await expect.poll(() => puts).toEqual([{ base, enabled: true, days: [1, 3, 5, 2], hour: 9 }])
})

test('от находки поверх отчёта открывается окно переписывания флоу с просьбой в поле', async ({ page }) => {
  await mockReports(page, { report })
  await page.route('**/api/performers', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/flow', (route) =>
    route.fulfill({
      json: [{ base, project: 'Agents Kit Web', stages: [], flows: [], version: 'v1', error: null, icons: {}, tasks: [] }],
    }),
  )
  await page.route('**/api/agent/requests', (route) => route.fulfill({ json: [] }))
  await openReports(page)

  const row = page.locator('details').filter({ hasText: 'Каждый исход куда-то ведёт' })
  await row.getByText('Каждый исход куда-то ведёт').click()
  await row.getByRole('button', { name: 'Переписать с Чудо-Юдо' }).click()

  const dialog = page.getByRole('dialog', { name: 'Переписать с Чудо-Юдо' })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Просьба')).toHaveValue(/по требованию «Каждый исход куда-то ведёт»\. Место во флоу: Мерж\./)
  // Окно стоит поверх отчёта, как на макете: раздел под ним — «Отчёты», а не «Флоу».
  await expect(page.getByRole('heading', { name: 'Отчёты', level: 2 })).toBeAttached()
  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toHaveCount(0)

  // Фокус ходит по окну и не уходит в отчёт под подложкой (ревью B-270) — inert проверяется только в браузере.
  // Окно стоит в разметке за отчётом: назад, по Shift+Tab, путь в отчёт самый короткий.
  for (let press = 0; press < 12; press++) {
    await page.keyboard.press('Shift+Tab')
    expect(await page.evaluate(() => document.activeElement?.closest('.rp') !== null && document.activeElement?.closest('[role="dialog"]') === null)).toBe(false)
  }

  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(row.getByRole('button', { name: 'Переписать с Чудо-Юдо' })).toBeVisible()
})

test('первый отчёт строится кнопкой: идёт разбор с «Отменить», и готовый отчёт встаёт на место', async ({ page }) => {
  const state: { report: typeof report | null } = { report: null }
  await mockReports(page, state)
  const panel = await mockAgentPanel(page, 'report', '/api/reports/flow/run')
  await openReports(page)

  await page.getByRole('button', { name: 'Построить отчёт' }).click()

  const waiting = page.getByRole('status').filter({ hasText: 'Идёт разбор флоу Agents Kit Web.' })
  await expect(waiting.getByRole('button', { name: 'Отменить' })).toBeVisible()
  expect(panel.posts).toEqual([{ base }])

  state.report = report
  panel.reply(ndjson({ type: 'reported', text: 'Отчёт построен.' }))
  // Поток просьбы подхватывается заново, когда итог готов: раздел открывают снова.
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Расход' }).click()
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Отчёты' }).click()

  await expect(page.getByRole('button', { name: 'Проходимость: 70 из 100.' })).toBeVisible()
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`кольца и плашки приоритета красятся токенами своей темы (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await mockReports(page, { report })
    await openReports(page)
    await expect(page.getByRole('button', { name: 'Ясность: 100 из 100.' })).toBeVisible()

    // Токен темы — тем же вычислением, что и цвет: браузер приводит его к rgb.
    const token = (name: string) =>
      page.evaluate((variable) => {
        const probe = document.createElement('span')
        probe.style.color = `var(${variable})`
        document.body.append(probe)
        const value = getComputedStyle(probe).color
        probe.remove()
        return value
      }, name)
    const stroke = (ring: string) =>
      page
        .getByRole('button', { name: new RegExp(`^${ring}:`) })
        .locator('.rp-gauge-value')
        .evaluate((circle) => getComputedStyle(circle).stroke)

    expect(await stroke('Ясность')).toBe(await token('--accent-active-text'))
    expect(await stroke('Проходимость')).toBe(await token('--accent-waiting-fill'))
    const high = page.locator('.rp-pr-high').first()
    expect(await high.evaluate((tag) => getComputedStyle(tag).color)).toBe(await token('--accent-error-text'))
  })
}

import { expect, test } from '@playwright/test'

const now = new Date('2026-09-18T16:30:00Z')

const withPercents = {
  fiveHours: {
    since: '2026-09-18T11:30:00Z',
    tokens: 31_500_000,
    cost: 93.4,
    percent: 46,
    resetsAt: '2026-09-18T18:40:00Z',
  },
  week: {
    since: '2026-09-11T16:30:00Z',
    tokens: 164_500_000,
    cost: 480.2,
    percent: 82,
    resetsAt: '2026-09-21T11:00:00Z',
  },
  day: {
    since: '2026-09-17T16:30:00Z',
    tokens: 41_000_000,
    cost: 120.6,
    percent: 18.86,
  },
  models: [
    { model: 'claude-opus-5', tokens: 120_000_000, cost: 450, pricedAs: null, weight: 5, share: 0.83 },
    { model: 'claude-haiku-4-5', tokens: 44_500_000, cost: 4.56, pricedAs: null, weight: 0.33, share: 0.17 },
    { model: 'claude-opus-5-2', tokens: 1_000_000, cost: 25, pricedAs: 'Opus 5', weight: 5, share: 0 },
  ],
  limitsProblem: null,
  fetchedAt: now.toISOString(),
  pricesDate: '2026-09-21',
}

// /api подменяется: прогон идёт на машине с живыми журналами и живой учётной записью,
// и раздел показывал бы настоящий расход оператора вместо проверяемых чисел.
test('раздел показывает доли лимита, токены с долларами и расход по моделям', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/usage', (route) => route.fulfill({ json: withPercents }))

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Расход' }).click()

  await expect(page.getByRole('heading', { name: 'Расход', level: 2 })).toBeVisible()
  const five = page.locator('section').filter({ hasText: 'Пятичасовое окно' })
  await expect(five).toContainText('46%')
  await expect(five.locator('.usage-window-foot')).toHaveText('31,5 млн токенов · ≈ $93')
  await expect(five).not.toContainText('панель насчитала')
  await expect(five).not.toContainText('агента')
  await expect(five).toContainText('сбросится')

  const week = page.locator('section').filter({ hasText: 'Недельное окно' })
  await expect(week).toContainText('82%')
  await expect(week.locator('.usage-window-foot')).toHaveText('164,5 млн токенов · ≈ $480')

  // Сутки — третьей карточкой в том же ряду, без своей полосы
  const day = page.locator('section').filter({ has: page.getByRole('heading', { name: '24 часа' }) })
  await expect(day).toContainText('≈19%')
  await expect(day.locator('.usage-window-foot')).toHaveText('41,0 млн токенов · ≈ $121')
  await expect(day).not.toContainText('недельного расхода')
  await expect(day.locator('.usage-track')).toHaveCount(0)
  const weekBox = (await week.boundingBox())!
  const dayBox = (await day.boundingBox())!
  expect(dayBox.y).toBe(weekBox.y)
  expect(dayBox.x).toBeGreaterThan(weekBox.x + weekBox.width)

  const opus = page.getByRole('row', { name: /^claude-opus-5 / })
  await expect(opus).toContainText('83%')
  await expect(opus).toContainText('×5')
  await expect(opus).toContainText('≈ $450')

  await expect(page.getByRole('heading', { name: 'Расход по моделям' })).toBeVisible()
  await expect(page.getByRole('columnheader', { name: 'Ответов' })).toHaveCount(0)
  await expect(page.getByText('цены API на 21 сентября 2026', { exact: true })).toBeVisible()
  await expect(page.locator('.usage-card-foot')).toHaveText(
    'цены API на 21 сентября 2026 · claude-opus-5-2 посчитана по ценам Opus 5',
  )
  await expect(page.getByText(/из вашей учётной записи Anthropic/)).toHaveCount(0)
})

test('отказ Anthropic назван словами, а счёт токенов остаётся', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/usage', (route) =>
    route.fulfill({
      json: {
        ...withPercents,
        fiveHours: { ...withPercents.fiveHours, percent: null, resetsAt: null },
        week: { ...withPercents.week, percent: null, resetsAt: null },
        day: { ...withPercents.day, percent: null },
        limitsProblem: 'Anthropic не ответил: 401.',
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Расход' }).click()

  await expect(page.getByText('Проценты лимита сейчас недоступны.')).toBeVisible()
  await expect(page.getByText('Anthropic не ответил: 401.')).toBeVisible()
  await expect(page.locator('section').filter({ hasText: 'Пятичасовое окно' })).toContainText('31,5 млн токенов')
  // Без процента недели оценки за сутки нет, а токены остаются
  const day = page.locator('section').filter({ has: page.getByRole('heading', { name: '24 часа' }) })
  await expect(day).toContainText('—')
  // Оценки процента нет; знак «≈» остаётся только у долларов
  await expect(day.locator('.usage-percent')).toHaveText('—')
  await expect(day).toContainText('41,0 млн токенов')
})

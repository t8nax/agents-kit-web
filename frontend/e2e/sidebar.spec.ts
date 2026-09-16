import { expect, test } from '@playwright/test'

// /api подменяется: прогон работает с живыми базами оператора, и они в тесте не при чём.
test('сайдбар стоит полосой значков и разъезжается под мышью', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.goto('/')

  const sidebar = page.getByRole('navigation', { name: 'Разделы панели' })
  const backlog = sidebar.getByRole('button', { name: 'Бэклог' })
  const rail = 52

  await expect(backlog).toBeVisible()
  await expect(sidebar.getByText('Бэклог')).toBeHidden()
  expect((await sidebar.boundingBox())?.width).toBe(rail)
  // Содержимое начинается сразу за полосой: развёрнутый сайдбар ляжет поверх него
  expect((await page.getByRole('main').boundingBox())?.x).toBe(rail)

  await sidebar.hover()
  await expect(sidebar.getByText('Бэклог')).toBeVisible()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThan(rail)
  // Содержимое осталось на месте, сайдбар накрыл его край
  expect((await page.getByRole('main').boundingBox())?.x).toBe(rail)

  await page.getByRole('main').hover()
  await expect(sidebar.getByText('Бэклог')).toBeHidden()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(rail)
})

test('«Базы знаний» — кнопка в рамке, до которой доходят клавиатурой', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.goto('/')

  const sidebar = page.getByRole('navigation', { name: 'Разделы панели' })
  const bases = sidebar.getByRole('button', { name: 'Базы знаний' })
  const backlog = sidebar.getByRole('button', { name: 'Бэклог' })
  const borderWidth = (button: typeof bases) =>
    button.evaluate((element) => getComputedStyle(element).borderTopWidth)

  // В свёрнутой полосе кнопка — обведённый квадрат, а разделы остаются строками без рамки
  await expect(bases).toBeVisible()
  expect(await borderWidth(bases)).toBe('1px')
  expect(await borderWidth(backlog)).toBe('0px')
  const collapsed = await bases.boundingBox()
  expect(collapsed?.width).toBe(36)
  expect(collapsed?.height).toBe(36)

  // Tab доходит до кнопки: фокус разворачивает сайдбар, кнопка остаётся в рамке и с подписью
  for (let presses = 0; presses < 10 && !(await bases.evaluate((element) => element === document.activeElement)); presses++) {
    await page.keyboard.press('Tab')
  }
  await expect(bases).toBeFocused()
  await expect(sidebar.getByText('Базы знаний')).toBeVisible()
  expect(await borderWidth(bases)).toBe('1px')
  expect(await bases.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('solid')

  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'Базы знаний' })).toBeVisible()
})

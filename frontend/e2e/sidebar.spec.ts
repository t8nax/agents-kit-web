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

  const settings = sidebar.getByRole('button', { name: 'Настройки' })
  const collapsedBox = await settings.boundingBox()

  await sidebar.hover()
  await expect(sidebar.getByText('Бэклог')).toBeVisible()
  // Пункты не съезжают при раскрытии: мышь, наведённая на значок, остаётся на своём разделе
  expect((await settings.boundingBox())?.y).toBe(collapsedBox?.y)
  expect((await settings.boundingBox())?.height).toBe(collapsedBox?.height)
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBeGreaterThan(rail)
  // Содержимое осталось на месте, сайдбар накрыл его край
  expect((await page.getByRole('main').boundingBox())?.x).toBe(rail)

  await page.getByRole('main').hover()
  await expect(sidebar.getByText('Бэклог')).toBeHidden()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(rail)
})

test('«Настройки» — раздел в ряду остальных, до него доходят клавиатурой', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/bases', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/kit', (route) => route.fulfill({ json: { path: null, found: false } }))
  await page.goto('/')

  const sidebar = page.getByRole('navigation', { name: 'Разделы панели' })
  const problems = sidebar.getByRole('button', { name: 'Проблемы баз' })
  const settings = sidebar.getByRole('button', { name: 'Настройки' })

  // Кнопки «Базы знаний» внизу больше нет; «Настройки» стоит строкой сразу за «Проблемами баз»
  await expect(sidebar.getByRole('button', { name: 'Базы знаний' })).toHaveCount(0)
  await expect(settings).toBeVisible()
  const problemsBox = await problems.boundingBox()
  const settingsBox = await settings.boundingBox()
  expect(settingsBox?.y).toBe((problemsBox?.y ?? 0) + (problemsBox?.height ?? 0))
  expect(await settings.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px')

  // Tab доходит до раздела: фокус разворачивает сайдбар, Enter открывает раздел
  for (let presses = 0; presses < 10 && !(await settings.evaluate((element) => element === document.activeElement)); presses++) {
    await page.keyboard.press('Tab')
  }
  await expect(settings).toBeFocused()
  await expect(sidebar.getByText('Настройки')).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible()
  await expect(settings).toHaveAttribute('aria-current', 'page')
})

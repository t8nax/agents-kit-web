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

const waitingRow = {
  project: 'agents-kit-web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: 'D:\\Projects\\agents-kit-web',
  branch: 'fix/sidebar-items-jump',
  task: 'B-42 Панель дёргается под мышью',
  letters: 'B',
  flowStep: 'Реализация',
  progress: 45,
  status: 'waiting',
  error: null,
}

// Плашка со числом ждущих копий не помещалась в узкую полосу, её надпись ложилась
// в две строки, и пункты съезжали вниз на всё время раскрытия.
test('пункты полосы не меняют высоту, пока она разъезжается со плашкой ждущих', async ({ page }) => {
  const rows = [waitingRow, { ...waitingRow, path: 'D:\\Projects\\agents-kit-web-2' }]
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
  await page.goto('/')

  const sidebar = page.getByRole('navigation', { name: 'Разделы панели' })
  await expect(sidebar.getByRole('button', { name: /Рабочие копии, 2 ждут/ })).toBeVisible()

  // Высоты пунктов снимаются каждый кадр: съезд длился доли секунды, в начале раскрытия
  await page.evaluate(() => {
    const seen = new Set<string>()
    const tick = () => {
      seen.add(JSON.stringify([...document.querySelectorAll('.side-item')].map((item) => Math.round(item.getBoundingClientRect().height))))
      requestAnimationFrame(tick)
    }
    tick()
    Object.assign(window, { itemHeights: seen })
  })

  await sidebar.hover()
  await expect(sidebar.getByText('2 ждут')).toBeVisible()
  await expect.poll(async () => (await sidebar.boundingBox())?.width).toBe(232)

  const heights = await page.evaluate(() => [...(window as unknown as { itemHeights: Set<string> }).itemHeights])
  expect(heights).toHaveLength(1)
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

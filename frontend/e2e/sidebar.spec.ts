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

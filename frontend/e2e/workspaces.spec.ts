import { expect, test } from '@playwright/test'

test('страница показывает таблицу рабочих копий из API', async ({ page }) => {
  const response = page.waitForResponse('**/api/workspaces')
  await page.goto('/')
  const rows: unknown[] = await (await response).json()

  await expect(page).toHaveTitle('Agents Kit Web')
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Agents Kit Web' })).toBeVisible()

  const table = page.getByRole('table')
  for (const column of ['Проект и копия', '№', 'Задача', 'Шаг флоу', 'Прогресс', 'Статус', 'Проблемы']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible()
  }
  await expect(table.locator('tbody tr')).toHaveCount(rows.length)
  await expect(page.getByText('pong')).toHaveCount(0)
})

const row = {
  project: 'agents-kit-web',
  base: 'D:\Projects\agents-kit-web-knowledge',
  path: 'D:\Projects\agents-kit-web',
  branch: 'feat/task-number-column',
  task: 'B-24 Номер задачи и её заголовок — отдельные колонки таблицы',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
  error: null,
}
const rows = [
  row,
  { ...row, path: 'D:\Projects\agents-kit-web-2', task: 'Задача не из бэклога' },
  { ...row, path: 'D:\Projects\agents-kit-web-3', branch: 'dev', task: null, flowStep: null, progress: null, status: 'free' },
]

for (const colorScheme of ['light', 'dark'] as const) {
  test(`номер задачи стоит плашкой в своей колонке, без номера и без задачи — прочерк (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
    await page.goto('/')

    const bodyRows = page.getByRole('table').locator('tbody tr')
    await expect(bodyRows).toHaveCount(3)

    const numbered = bodyRows.nth(0).getByRole('cell')
    await expect(numbered.nth(1)).toHaveText('B-24')
    await expect(numbered.nth(2)).toHaveText('Номер задачи и её заголовок — отдельные колонки таблицы')
    const chip = numbered.nth(1).locator('.num-chip')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveCSS('border-top-width', '1px')
    // Плашка залита своим фоном, а не прозрачна, в обеих темах
    await expect(chip).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    // Узкая колонка: номер не переносится и не растягивает ячейку до заголовка
    const [chipBox, cellBox] = await Promise.all([chip.boundingBox(), numbered.nth(1).boundingBox()])
    expect(cellBox!.width).toBeLessThan(chipBox!.width + 40)

    const unnumbered = bodyRows.nth(1).getByRole('cell')
    await expect(unnumbered.nth(1)).toHaveText('—')
    await expect(unnumbered.nth(2)).toHaveText('Задача не из бэклога')

    const free = bodyRows.nth(2).getByRole('cell')
    await expect(free.nth(1)).toHaveText('—')
    await expect(free.nth(2)).toHaveText('—')
  })
}

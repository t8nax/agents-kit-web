import { expect, test } from '@playwright/test'

test('страница показывает таблицу рабочих копий из API', async ({ page }) => {
  const response = page.waitForResponse('**/api/workspaces')
  await page.goto('/')
  const rows: unknown[] = await (await response).json()

  const table = page.getByRole('table')
  for (const column of ['Проект и копия', 'Задача', 'Шаг флоу', 'Прогресс', 'Статус', 'Проблемы']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible()
  }
  await expect(table.locator('tbody tr')).toHaveCount(rows.length)
  await expect(page.getByText('pong')).toHaveCount(0)
})

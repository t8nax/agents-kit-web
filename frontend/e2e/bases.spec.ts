import { expect, test } from '@playwright/test'

// /api подменяется: dev-API пишет список баз в bases.json профиля оператора, и прогон поменял бы живой список.
test('оператор добавляет и удаляет базу, и таблица строится по новому списку', async ({ page }) => {
  const known: Record<string, { copies: number; row: object }> = {
    'D:\\Projects\\nota-knowledge': {
      copies: 1,
      row: {
        project: 'nota-knowledge',
        base: 'D:\\Projects\\nota-knowledge',
        path: 'D:\\Projects\\nota',
        branch: 'dev',
        task: 'Экспорт заметок в PDF',
        flowStep: 'Приёмка',
        progress: 66,
        status: 'in-work',
        error: null,
      },
    },
  }
  let bases: string[] = []

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: bases.map((b) => known[b].row) }))
  await page.route('**/api/bases**', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      return route.fulfill({ json: bases.map((path) => ({ path, copies: known[path].copies })) })
    }
    if (request.method() === 'POST') {
      const { path } = request.postDataJSON() as { path: string }
      if (!known[path]) return route.fulfill({ status: 400, json: { problem: 'not-a-base' } })
      if (bases.includes(path)) return route.fulfill({ status: 409, json: { problem: 'duplicate' } })
      bases = [...bases, path]
      return route.fulfill({ status: 201, json: { path, copies: known[path].copies } })
    }
    const path = new URL(request.url()).searchParams.get('path')
    bases = bases.filter((b) => b !== path)
    return route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await expect(page.getByText('Нет отслеживаемых баз или рабочих копий.')).toBeVisible()

  await page.getByRole('button', { name: 'Базы знаний' }).click()
  const dialog = page.getByRole('dialog', { name: 'Базы знаний' })
  const input = dialog.getByLabel('Путь к каталогу базы')

  await input.fill('D:\\Projects\\nota')
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.')

  await input.fill('D:\\Projects\\nota-knowledge')
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog.getByRole('list', { name: 'Базы знаний' }).getByText('D:\\Projects\\nota-knowledge')).toBeVisible()

  await dialog.getByRole('button', { name: 'Готово' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row', { name: /Экспорт заметок в PDF/ })).toBeVisible()

  await page.getByRole('button', { name: 'Базы знаний' }).click()
  await dialog.getByRole('button', { name: 'Удалить D:\\Projects\\nota-knowledge' }).click()
  await expect(dialog.getByText('Список пуст.')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('row', { name: /Экспорт заметок в PDF/ })).toHaveCount(0)
})

import { expect, test, type Page } from '@playwright/test'

const basePath = 'D:\\Projects\\nota-knowledge'

const mainRow = {
  project: 'Nota',
  base: basePath,
  path: 'D:\\Projects\\nota',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

const createdRow = { ...mainRow, path: 'D:\\Projects\\quiet-cedar', branch: 'quiet-cedar' }

// /api подменяется: настоящий API завёл бы рабочую копию рядом с живым проектом оператора.
async function mockApi(page: Page) {
  let rows = [mainRow]

  await page.route('**/api/bases**', (route) => route.fulfill({ json: [{ path: basePath, copies: 1, project: 'Nota' }] }))
  await page.route('**/api/workspaces', (route) => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: rows })

    const { name } = request.postDataJSON() as { base: string; name: string | null }
    if (name === 'dev') {
      return route.fulfill({
        status: 400,
        json: { problem: 'script', message: 'ветка «dev» уже существует — назвать копию иначе' },
      })
    }
    rows = [...rows, createdRow]
    return route.fulfill({ status: 204 })
  })
}

test('оператор заводит копию из панели, и она появляется в таблице', async ({ page }) => {
  await mockApi(page)

  await page.goto('/')
  await expect(page.getByRole('row', { name: /quiet-cedar/ })).toHaveCount(0)

  await page.getByRole('button', { name: 'Новая копия' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
  await expect(dialog.getByLabel('Проект')).toHaveValue(basePath)

  await dialog.getByLabel('Имя копии').fill('dev')
  await dialog.getByRole('button', { name: 'Завести копию' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('ветка «dev» уже существует — назвать копию иначе')

  await dialog.getByLabel('Имя копии').fill('quiet-cedar')
  await dialog.getByRole('button', { name: 'Завести копию' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('row', { name: /quiet-cedar/ })).toBeVisible()
})

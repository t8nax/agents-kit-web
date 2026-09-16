import { expect, test } from '@playwright/test'

const row = {
  project: 'app-knowledge',
  base: 'D:\\Projects\\app-knowledge',
  path: 'D:\\Projects\\app',
  branch: 'feat/reply',
  task: 'Окно ответа',
  flowStep: 'Критерий',
  progress: 0,
  status: 'waiting',
  error: null,
}

const questions = (vsCodeSession: boolean) => ({
  project: 'app-knowledge',
  copy: 'D:\\Projects\\app',
  task: 'Окно ответа',
  criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }],
  outOfScope: null,
  vsCodeSession,
  questions: [{ title: 'Подтвердить критерий?', context: 'За вами объём проверок', variants: [], answer: null }],
})

// /api подменяется: настоящий переход поднял бы окно редактора на машине, где идёт прогон.
test('из окна вопроса оператор открывает сессию копии в VS Code', async ({ page }) => {
  let opened: unknown = null

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row] }))
  await page.route('**/api/questions?**', (route) => route.fulfill({ json: questions(true) }))
  await page.route('**/api/session/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()

  const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
  await dialog.getByLabel('Ответ').fill('принимаю')
  await dialog.getByRole('button', { name: 'Открыть в VS Code' }).click()

  expect(opened).toEqual({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app' })
  // щелчок по кнопке в шапке не раскрывает аккордеон и не трогает набранный ответ
  await expect(dialog.getByText('Критерии закрытия')).toBeHidden()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('принимаю')
})

test('живой сессии в VS Code нет — кнопка перехода мертва', async ({ page }) => {
  let opened = false

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row] }))
  await page.route('**/api/questions?**', (route) => route.fulfill({ json: questions(false) }))
  await page.route('**/api/session/open', async (route) => {
    opened = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()

  const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
  await expect(dialog.getByRole('button', { name: 'Нет сессии в VS Code' })).toBeDisabled()
  expect(opened).toBe(false)
})

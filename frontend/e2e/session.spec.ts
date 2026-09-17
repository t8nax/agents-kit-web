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
  design: null,
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

test('из строки таблицы оператор открывает копию в VS Code', async ({ page }) => {
  const free = { ...row, path: 'D:\\Projects\\app-wt', branch: 'dev', task: null, flowStep: null, progress: null, status: 'free' }
  const gone = { ...row, path: 'E:\\gone', branch: null, task: null, flowStep: null, progress: null, status: null, error: 'Копия не найдена на диске' }
  let opened: unknown = null

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row, free, gone] }))
  await page.route('**/api/workspace/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await expect(page.getByRole('row', { name: /Копия не найдена на диске/ }).getByRole('button', { name: /в VS Code/ })).toHaveCount(0)

  await page.getByRole('row', { name: /app-wt/ }).getByRole('button', { name: /в VS Code/ }).click()

  expect(opened).toEqual({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app-wt' })
})

test('копия не открылась — таблица говорит об этом строкой', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row] }))
  await page.route('**/api/workspace/open', (route) => route.fulfill({ status: 502, json: { problem: 'not-opened' } }))

  await page.goto('/')
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: /в VS Code/ }).click()

  await expect(page.getByText('Не удалось открыть VS Code на D:\\Projects\\app')).toBeVisible()
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

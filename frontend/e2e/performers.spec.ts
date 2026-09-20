import { expect, test, type Page } from '@playwright/test'

type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
  path: string
}

const agents = 'D:\\Projects\\app-knowledge\\agents'

const reviewer: Performer = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи и возвращает вердикт.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком.',
  path: `${agents}\\reviewer.md`,
}

/**
 * /api подменяется: прогон работает с живыми базами оператора, и заведение исполнителя
 * положило бы файл в живой набор исполнителей машины.
 */
async function mockApi(page: Page, options: { taken?: boolean } = {}) {
  const saved: unknown[] = []
  let performers: Performer[] = [reviewer]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))

  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as Performer
      if (options.taken)
        return route.fulfill({ status: 409, json: { problem: 'name-taken' } })
      saved.push(request)
      performers = [
        ...performers,
        {
          name: request.name,
          description: request.description,
          model: request.model,
          tools: request.tools,
          prompt: request.prompt,
          path: `${agents}\\${request.name}.md`,
        },
      ]
      return route.fulfill({ json: { path: `${agents}\\${request.name}.md` } })
    }
    return route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          directory: agents,
          performers,
          error: null,
        },
      ],
    })
  })
  return { saved }
}

async function openPerformers(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
  await expect(page.getByRole('heading', { name: 'Исполнители', level: 2 })).toBeVisible()
}

test('раздел показывает исполнителей проекта, и править даёт каждого', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await expect(page.getByText('reviewer', { exact: true })).toBeVisible()
  await expect(page.getByText('Читает дифф ветки задачи и возвращает вердикт.')).toBeVisible()
  // Приставка видна только в пути к файлу.
  await expect(page.getByText(`${agents}\\reviewer.md`)).toBeVisible()

  await expect(page.getByRole('button', { name: 'Править' })).toBeEnabled()
})

test('исполнитель заводится окном и ложится в базу проекта', async ({ page }) => {
  const { saved } = await mockApi(page)
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('e2e-runner')
  await modal.getByLabel(/Описание/).fill('Прогоняет e2e затронутых экранов.')
  await modal.getByLabel('Задание').fill('Поднимаешь панель и прогоняешь e2e.')

  // Копию в окне не выбирают: путь файла виден до сохранения и ведёт в базу проекта.
  await expect(modal.getByLabel('Копия')).toHaveCount(0)
  await expect(modal.getByText(`${agents}\\e2e-runner.md`)).toBeVisible()

  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('e2e-runner', { exact: true })).toBeVisible()
  await expect(page.getByText('записан', { exact: true })).toBeVisible()
  // Про перенос по копиям панель молчит: единственное, что она говорит, — с какой сессии звать
  await expect(page.getByText('e2e-runner записан. Звать его можно со следующей сессии.')).toBeVisible()
  expect(saved).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      name: 'e2e-runner',
      description: 'Прогоняет e2e затронутых экранов.',
      model: null,
      tools: null,
      prompt: 'Поднимаешь панель и прогоняешь e2e.',
      editing: null,
    },
  ])
})

test('занятое имя названо до записи, и сохранить его нельзя', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('reviewer')

  await expect(modal.getByRole('status')).toContainText('уже есть')
  await expect(modal.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('отказ записи виден дословно, а набранное остаётся в окне', async ({ page }) => {
  await mockApi(page, { taken: true })
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('e2e-runner')
  await modal.getByLabel('Задание').fill('Поднимаешь панель.')
  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(modal.getByRole('alert')).toContainText('уже есть')
  await expect(modal.getByLabel('Имя')).toHaveValue('e2e-runner')
  await expect(modal.getByLabel('Задание')).toHaveValue('Поднимаешь панель.')
})

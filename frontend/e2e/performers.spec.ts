import { expect, test, type Page } from '@playwright/test'

type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
  path: string
  source: 'copy' | 'profile'
  copy: string | null
}

const reviewer: Performer = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи и возвращает вердикт.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком.',
  path: 'D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md',
  source: 'copy',
  copy: 'D:\\Projects\\agents-kit-web',
}

const specWriter: Performer = {
  name: 'spec-writer',
  description: 'Пишет спеку экрана.',
  model: null,
  tools: null,
  prompt: 'Тело.',
  path: 'C:\\Users\\me\\.claude\\agents\\spec-writer.md',
  source: 'profile',
  copy: null,
}

const copies = [
  { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
  { path: 'D:\\Projects\\noble-keen-walrus', name: 'noble-keen-walrus', branch: 'dev', main: false },
]

/**
 * /api подменяется: прогон работает с живыми базами оператора, и заведение исполнителя
 * положило бы файл в живой репозиторий и закоммитило бы его.
 */
async function mockApi(page: Page, options: { refuseCommit?: boolean } = {}) {
  const saved: unknown[] = []
  let performers: Performer[] = [reviewer, specWriter]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as Performer & { copy: string }
      if (options.refuseCommit)
        return route.fulfill({
          status: 409,
          json: { problem: 'not-committed', detail: 'hook: сверка кита не прошла' },
        })
      saved.push(request)
      performers = [
        ...performers,
        {
          name: request.name,
          description: request.description,
          model: request.model,
          tools: request.tools,
          prompt: request.prompt,
          path: `${request.copy}\\.claude\\agents\\${request.name}.md`,
          source: 'copy',
          copy: request.copy,
        },
      ]
      return route.fulfill({ json: { path: `${request.copy}\\.claude\\agents\\${request.name}.md` } })
    }
    return route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          copies,
          performers,
          error: null,
        },
      ],
    })
  })
  return saved
}

async function openPerformers(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
  await expect(page.getByRole('heading', { name: 'Исполнители', level: 2 })).toBeVisible()
}

test('раздел показывает исполнителей проекта и профиля, профильный не правится', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await expect(page.getByText('reviewer', { exact: true })).toBeVisible()
  await expect(page.getByText('Читает дифф ветки задачи и возвращает вердикт.')).toBeVisible()
  await expect(page.getByText('D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md')).toBeVisible()

  await expect(page.getByText('из профиля')).toBeVisible()
  const edit = page.getByRole('button', { name: 'Править' })
  await expect(edit.first()).toBeEnabled()
  await expect(edit.last()).toBeDisabled()
})

test('исполнитель заводится окном и появляется в списке', async ({ page }) => {
  const saved = await mockApi(page)
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('e2e-runner')
  await modal.getByLabel(/Описание/).fill('Прогоняет e2e затронутых экранов.')
  await modal.getByLabel('Копия').selectOption('D:\\Projects\\noble-keen-walrus')
  await modal.getByLabel('Задание').fill('Поднимаешь панель и прогоняешь e2e.')

  // Путь файла виден до сохранения: по нему понятно, в какую копию он ляжет
  await expect(modal.getByText('D:\\Projects\\noble-keen-walrus\\.claude\\agents\\e2e-runner.md')).toBeVisible()

  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('e2e-runner', { exact: true })).toBeVisible()
  await expect(page.getByText('записан')).toBeVisible()
  expect(saved).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      copy: 'D:\\Projects\\noble-keen-walrus',
      name: 'e2e-runner',
      description: 'Прогоняет e2e затронутых экранов.',
      model: null,
      tools: null,
      prompt: 'Поднимаешь панель и прогоняешь e2e.',
    },
  ])
})

test('отказ коммита виден дословно, а набранное остаётся в окне', async ({ page }) => {
  await mockApi(page, { refuseCommit: true })
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('e2e-runner')
  await modal.getByLabel('Задание').fill('Поднимаешь панель.')
  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(modal.getByRole('alert')).toContainText('hook: сверка кита не прошла')
  await expect(modal.getByLabel('Имя')).toHaveValue('e2e-runner')
  await expect(modal.getByLabel('Задание')).toHaveValue('Поднимаешь панель.')
})

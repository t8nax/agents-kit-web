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
  in: string[]
  differs: string[]
  everywhere: boolean
}

const main = 'D:\\Projects\\agents-kit-web'
const second = 'D:\\Projects\\noble-keen-walrus'

/** Заведён, но лежит только в основной копии: пользоваться им нельзя, пока не разойдётся по остальным. */
const reviewer: Performer = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи и возвращает вердикт.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком.',
  path: `${main}\\.claude\\agents\\reviewer.md`,
  source: 'copy',
  copy: main,
  in: [main],
  differs: [],
  everywhere: false,
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
  in: [],
  differs: [],
  everywhere: true,
}

const copies = [
  { path: main, name: 'agents-kit-web', branch: 'dev', main: true },
  { path: second, name: 'noble-keen-walrus', branch: 'master', main: false },
]

/**
 * /api подменяется: прогон работает с живыми базами оператора, и заведение исполнителя
 * положило бы файл в живой репозиторий и закоммитило бы его.
 */
async function mockApi(page: Page, options: { refuseCommit?: boolean; refuseSync?: boolean } = {}) {
  const saved: unknown[] = []
  const synced: unknown[] = []
  let performers: Performer[] = [reviewer, specWriter]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))

  await page.route('**/api/performers/sync', (route) => {
    const request = route.request().postDataJSON() as { name: string; confirmed: boolean }
    synced.push(request)
    if (!request.confirmed)
      return route.fulfill({
        status: 409,
        json: {
          problem: 'needs-confirmation',
          risky: [{ copy: second, name: 'noble-keen-walrus', branch: 'master', reason: 'branch' }],
        },
      })
    if (options.refuseSync)
      return route.fulfill({
        json: {
          copies: [
            { copy: second, name: 'noble-keen-walrus', done: false, commit: null, error: 'hook: сверка кита не прошла' },
          ],
        },
      })
    performers = performers.map((performer) =>
      performer.name === request.name
        ? { ...performer, in: [main, second], everywhere: true }
        : performer,
    )
    return route.fulfill({
      json: { copies: [{ copy: second, name: 'noble-keen-walrus', done: true, commit: 'a41c9e2', error: null }] },
    })
  })

  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as Performer
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
          // Копию не выбирают: файл ложится в основную копию проекта.
          path: `${main}\\.claude\\agents\\${request.name}.md`,
          source: 'copy',
          copy: main,
          in: [main],
          differs: [],
          everywhere: false,
        },
      ]
      return route.fulfill({ json: { path: `${main}\\.claude\\agents\\${request.name}.md` } })
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
  return { saved, synced }
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
  await expect(page.getByText(`${main}\\.claude\\agents\\reviewer.md`)).toBeVisible()

  await expect(page.getByText('из профиля')).toBeVisible()
  const edit = page.getByRole('button', { name: 'Править' })
  await expect(edit.first()).toBeEnabled()
  await expect(edit.last()).toBeDisabled()
})

test('строка показывает копии, где исполнителя ещё нет', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await expect(page.getByText('в 1 копиях из 2 — пользоваться нельзя')).toBeVisible()
  await expect(page.getByText('agents-kit-web', { exact: true })).toBeVisible()
  await expect(page.getByText('noble-keen-walrus', { exact: true })).toBeVisible()
  // Исполнителю профиля синхронизация ни к чему: его видно из любой копии.
  await expect(page.getByRole('button', { name: 'Синхронизировать' })).toHaveCount(1)
})

test('исполнитель заводится окном и ложится в основную копию', async ({ page }) => {
  const { saved } = await mockApi(page)
  await openPerformers(page)

  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  const modal = page.getByRole('dialog')
  await modal.getByLabel('Имя').fill('e2e-runner')
  await modal.getByLabel(/Описание/).fill('Прогоняет e2e затронутых экранов.')
  await modal.getByLabel('Задание').fill('Поднимаешь панель и прогоняешь e2e.')

  // Копию в окне не выбирают: путь файла виден до сохранения и ведёт в основную копию.
  await expect(modal.getByLabel('Копия')).toHaveCount(0)
  await expect(modal.getByText(`${main}\\.claude\\agents\\e2e-runner.md`)).toBeVisible()

  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText('e2e-runner', { exact: true })).toBeVisible()
  await expect(page.getByText('записан', { exact: true })).toBeVisible()
  expect(saved).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      name: 'e2e-runner',
      description: 'Прогоняет e2e затронутых экранов.',
      model: null,
      tools: null,
      prompt: 'Поднимаешь панель и прогоняешь e2e.',
    },
  ])
})

test('синхронизация спрашивает про копию на master и по согласию показывает исход', async ({ page }) => {
  const { synced } = await mockApi(page)
  await openPerformers(page)

  await page.getByRole('button', { name: 'Синхронизировать' }).click()

  const modal = page.getByRole('dialog')
  await expect(modal.getByText('копия на master — из неё публикуется панель')).toBeVisible()
  await modal.getByRole('button', { name: 'Синхронизировать всё равно' }).click()

  await expect(modal.getByText('записан и закоммичен')).toBeVisible()
  await expect(modal.getByText('a41c9e2')).toBeVisible()
  await modal.getByRole('button', { name: 'Готово' }).click()

  // Копия записана — строка это показывает, и синхронизировать больше нечего.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Синхронизировать' })).toHaveCount(0)
  expect(synced).toEqual([
    { base: 'D:\\Projects\\app-knowledge', name: 'reviewer', confirmed: false },
    { base: 'D:\\Projects\\app-knowledge', name: 'reviewer', confirmed: true },
  ])
})

test('копия, где коммит не прошёл, названа с выводом git дословно', async ({ page }) => {
  await mockApi(page, { refuseSync: true })
  await openPerformers(page)

  await page.getByRole('button', { name: 'Синхронизировать' }).click()

  const modal = page.getByRole('dialog')
  await modal.getByRole('button', { name: 'Синхронизировать всё равно' }).click()

  await expect(modal.getByText('коммит не прошёл')).toBeVisible()
  await expect(modal.getByText('hook: сверка кита не прошла')).toBeVisible()
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

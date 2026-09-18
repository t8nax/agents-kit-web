import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

const copies = [
  { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
  { path: 'D:\\Projects\\noble-keen-walrus', name: 'noble-keen-walrus', branch: 'dev', main: false },
]

const drafted = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи и возвращает вердикт.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком и возвращаешь вердикт.',
}

/**
 * /api подменяется: настоящая просьба запустила бы агента в живой копии оператора, а «Сохранить»
 * положило бы файл в её репозиторий и закоммитило бы его.
 */
async function mockApi(page: Page) {
  const saved: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as { name: string }
      saved.push(request)
      // Копию не выбирают: файл ложится в основную копию проекта.
      return route.fulfill({ json: { path: `${copies[0].path}\\.claude\\agents\\${request.name}.md` } })
    }
    return route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          copies,
          performers: [],
          error: null,
        },
      ],
    })
  })
  const panel = await mockAgentPanel(page, 'performer', '/api/performers/draft')
  return { panel, saved }
}

async function openNew(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  return page.getByRole('dialog')
}

test('оператор описывает исполнителя словами, а поля заполняет «Чудо-юдо»', async ({ page }) => {
  const { panel, saved } = await mockApi(page)
  panel.reply(
    ndjson(
      { type: 'step', text: 'читает flow.md' },
      { type: 'drafted', text: '---', fields: drafted, durationMs: 72000 },
    ),
  )

  const modal = await openNew(page)
  await modal.getByLabel(/Просьба к «Чудо-юдо»/).fill('Читает дифф ветки и возвращает вердикт')
  await modal.getByRole('button', { name: 'Завести с помощью «Чудо-юдо»' }).click()

  await expect(modal.getByLabel('Имя')).toHaveValue('reviewer')
  await expect(modal.getByLabel('Модель')).toHaveValue('opus')
  await expect(modal.getByLabel('Инструменты')).toHaveValue('Read, Glob, Grep')
  await expect(modal.getByLabel('Задание')).toHaveValue('Ты читаешь дифф ветки целиком и возвращаешь вердикт.')
  await expect(modal.getByText('Поля ниже заполнил «Чудо-юдо»')).toBeVisible()
  expect(panel.posts).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      wish: 'Читает дифф ветки и возвращает вердикт',
      current: null,
    },
  ])

  // Файл пишет панель, и только по «Сохранить»: до него на диске ничего нет.
  expect(saved).toHaveLength(0)
  await modal.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(saved).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      name: 'reviewer',
      description: 'Читает дифф ветки задачи и возвращает вердикт.',
      model: 'opus',
      tools: 'Read, Glob, Grep',
      prompt: 'Ты читаешь дифф ветки целиком и возвращаешь вердикт.',
    },
  ])
})

test('закрытое окно не останавливает агента: поля ждут в шапке и приходят оттуда', async ({ page }) => {
  const { panel } = await mockApi(page)

  const modal = await openNew(page)
  await modal.getByLabel(/Просьба к «Чудо-юдо»/).fill('Ревьюер ветки')
  await modal.getByRole('button', { name: 'Завести с помощью «Чудо-юдо»' }).click()
  await expect(modal.getByRole('status')).toContainText('заводит исполнителя')

  // Оператор закрыл окно и занялся другим: агент работает дальше.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  panel.reply(ndjson({ type: 'drafted', text: '---', fields: drafted, durationMs: 12000 }))
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-юдо завёл исполнителя Agents Kit Web/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog')
  await expect(reopened.getByLabel('Имя')).toHaveValue('reviewer')
  await expect(reopened.getByLabel('Задание')).toHaveValue('Ты читаешь дифф ветки целиком и возвращаешь вердикт.')
  expect(panel.posts).toHaveLength(1)
})

test('неудача агента сказана словами, просьба остаётся, поля не тронуты', async ({ page }) => {
  const { panel } = await mockApi(page)
  panel.reply(
    ndjson({ type: 'error', text: 'Чудо-юдо вернул исполнителя без имени', output: 'Готово, я придумал ревьюера.' }),
  )

  const modal = await openNew(page)
  await modal.getByLabel(/Просьба к «Чудо-юдо»/).fill('Ревьюер ветки')
  await modal.getByRole('button', { name: 'Завести с помощью «Чудо-юдо»' }).click()

  const alert = modal.getByRole('alert')
  await expect(alert).toContainText('не заполнил поля')
  await expect(alert).toContainText('Готово, я придумал ревьюера.')
  await expect(modal.getByLabel('Имя')).toHaveValue('')
  await expect(modal.getByLabel(/Просьба к «Чудо-юдо»/)).toHaveValue('Ревьюер ветки')

  panel.reply(ndjson({ type: 'drafted', text: '---', fields: drafted, durationMs: 4000 }))
  await modal.getByRole('button', { name: 'Попросить снова' }).click()
  await expect(modal.getByLabel('Имя')).toHaveValue('reviewer')
  expect(panel.posts).toHaveLength(2)
})

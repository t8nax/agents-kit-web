import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

const agents = 'D:\\Projects\\app-knowledge\\agents'

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
async function mockApi(page: Page, performers: unknown[] = []) {
  const saved: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as { name: string }
      saved.push(request)
      // Копию не выбирают: файл ложится в каталог исполнителей базы проекта.
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
  const panel = await mockAgentPanel(page, 'performer', '/api/performers/draft')
  return { panel, saved }
}

async function openNew(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
  await page.getByRole('button', { name: 'Новый исполнитель' }).click()
  return page.getByRole('dialog')
}

test('оператор описывает исполнителя словами, а основу пишет Чудо-Юдо', async ({ page }) => {
  const { panel, saved } = await mockApi(page)
  panel.reply(
    ndjson(
      { type: 'step', text: 'читает flow.md' },
      { type: 'drafted', text: '---', fields: drafted, durationMs: 72000 },
    ),
  )

  const modal = await openNew(page)
  // До ответа поля пусты: их можно вписать руками (B-198), но без имени и задания сохранить нечего.
  await expect(modal.getByLabel('Имя')).toHaveValue('')
  await expect(modal.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await modal.getByLabel(/Просьба к Чудо-Юдо/).fill('Читает дифф ветки и возвращает вердикт')
  await modal.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }).click()

  await expect(modal.getByLabel('Имя')).toHaveValue('reviewer')
  await expect(modal.getByLabel('Описание')).toHaveValue('Читает дифф ветки задачи и возвращает вердикт.')
  await expect(modal.getByLabel('Модель')).toHaveValue('opus')
  await expect(modal.getByRole('button', { name: 'Только чтение' })).toHaveAttribute('aria-pressed', 'true')
  await expect(modal.getByText('Основу написал Чудо-Юдо')).toBeVisible()
  await modal.getByRole('button', { name: 'Показать задание' }).click()
  const task = page.getByRole('dialog', { name: /Задание/ })
  await expect(task.getByText('Ты читаешь дифф ветки целиком и возвращаешь вердикт.')).toBeVisible()
  await task.getByRole('button', { name: 'Закрыть', exact: true }).click()
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
      editing: null,
    },
  ])
})

test('закрытое окно не останавливает агента: поля ждут в шапке и приходят оттуда', async ({ page }) => {
  const { panel } = await mockApi(page)

  const modal = await openNew(page)
  await modal.getByLabel(/Просьба к Чудо-Юдо/).fill('Ревьюер ветки')
  await modal.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }).click()
  await expect(modal.getByRole('status')).toContainText('заводит исполнителя')

  // Оператор закрыл окно и занялся другим: агент работает дальше.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  panel.reply(ndjson({ type: 'drafted', text: '---', fields: drafted, durationMs: 12000 }))
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо завёл исполнителя Agents Kit Web/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog')
  await expect(reopened.getByLabel('Имя')).toHaveValue('reviewer')
  await expect(reopened.getByLabel('Описание')).toHaveValue('Читает дифф ветки задачи и возвращает вердикт.')
  expect(panel.posts).toHaveLength(1)
})

test('неудача агента сказана одной строкой, просьба остаётся, поля пусты', async ({ page }) => {
  const { panel } = await mockApi(page)
  panel.reply(
    ndjson({ type: 'error', text: 'Чудо-Юдо вернул исполнителя без имени', output: 'Готово, я придумал ревьюера.' }),
  )

  const modal = await openNew(page)
  await modal.getByLabel(/Просьба к Чудо-Юдо/).fill('Ревьюер ветки')
  await modal.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }).click()

  const alert = modal.getByRole('alert')
  await expect(alert).toHaveText('Чудо-Юдо не ответил: Чудо-Юдо вернул исполнителя без имени')
  // Вывод агента — подсказкой строки, а не второй строкой в окне.
  await expect(alert).toHaveAttribute('title', 'Готово, я придумал ревьюера.')
  await expect(modal.getByLabel('Имя')).toHaveValue('')
  await expect(modal.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await expect(modal.getByLabel(/Просьба к Чудо-Юдо/)).toHaveValue('Ревьюер ветки')

  panel.reply(ndjson({ type: 'drafted', text: '---', fields: drafted, durationMs: 4000 }))
  await modal.getByRole('button', { name: 'Попросить снова' }).click()
  await expect(modal.getByLabel('Имя')).toHaveValue('reviewer')
  expect(panel.posts).toHaveLength(2)
})

test('итог переписывания из шапки открывается в правке того же исполнителя', async ({ page }) => {
  const reviewer = { ...drafted, path: `${agents}\\reviewer.md` }
  const { panel } = await mockApi(page, [reviewer])

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Исполнители' }).click()
  await page.getByRole('button', { name: 'reviewer, Agents Kit Web' }).click()
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  await modal.getByLabel(/Просьба к Чудо-Юдо/).fill('Пусть ещё сверяет с критериями')
  await modal.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }).click()
  await expect(modal.getByRole('status')).toContainText('переписывает исполнителя')

  // Оператор закрыл окно, пока агент работает: итог ждёт в шапке и называет, кого переписали.
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  panel.reply(
    ndjson({
      type: 'drafted',
      text: '---',
      fields: { ...drafted, description: 'Сверяет дифф с критериями.' },
      durationMs: 9000,
    }),
  )
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо переписал исполнителя reviewer/ })
  await expect(done).toBeVisible()

  await done.click()

  // Итог открывается правкой reviewer, а не окном нового, где его имя было бы занято.
  const reopened = page.getByRole('dialog', { name: 'reviewer' })
  await expect(reopened.getByLabel('Описание')).toHaveValue('Сверяет дифф с критериями.')
  await expect(reopened.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  expect(panel.posts).toHaveLength(1)
})

import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

type Step = { title: string; executor: string; output: string; skip: string | null; description: string | null }

const criterion: Step = {
  title: 'Критерий',
  executor: 'оркестратор',
  output: 'критерий закрытия в памяти',
  skip: null,
  description: '1.1. Написать критерий.',
}
const merge: Step = { title: 'Мерж', executor: 'оркестратор', output: 'sha в dev', skip: null, description: null }
const review: Step = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha, записанный оркестратором',
  skip: 'правка только в текстах',
  description: '2.1. Собрать дифф всей ветки.',
}


// /api подменяется: настоящая просьба запустила бы агента в живой базе, а запись ушла бы в её flow.md.
const flowBase = 'D:\\Projects\\app-knowledge'

async function mockApi(page: Page) {
  const calls: { save: unknown[] } = { save: [] }

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/presets', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/flow', (route) => {
    if (route.request().method() === 'POST') {
      calls.save.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2' } })
    }
    return route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          steps: [criterion, merge],
          activeTasks: 0,
          version: 'v1',
          error: null,
          icons: {},
        },
      ],
    })
  })
  const panel = await mockAgentPanel(page, 'flow', '/api/flow/rewrite')
  return { save: calls.save, panel }
}

async function openFlow(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  const region = page.getByRole('region', { name: 'Agents Kit Web' })
  await expect(region.getByRole('button', { name: 'Шаг 1: Критерий' })).toBeVisible()
  return region
}

test('оператор просит переписать флоу словами, смотрит разбор и берёт правки в схему', async ({ page }) => {
  const calls = await mockApi(page)
  calls.panel.reply(
    ndjson(
      // Ход работы агента приходит теми же строками, что в окнах вопроса и записи.
      { type: 'step', text: 'читает flow.md' },
      {
        type: 'rewritten',
        text: '',
        steps: [criterion, review, { ...merge, output: 'sha в dev после вердикта ревью' }],
        version: 'v1',
        durationMs: 18000,
      },
    ),
  )

  const region = await openFlow(page)
  await page.getByRole('button', { name: 'Переписать с Чудо-юдо' }).click()

  const dialog = page.getByRole('dialog', { name: 'Переписать флоу' })
  await dialog.getByLabel('Что поменять во флоу').fill('Добавь шаг ревью перед мержем')
  await dialog.getByRole('button', { name: 'Переписать' }).click()

  const changes = dialog.getByLabel('Что изменилось во флоу')
  await expect(changes.getByText('добавлен')).toBeVisible()
  await expect(changes.getByText('изменён')).toBeVisible()
  await expect(changes.getByText('sha в dev после вердикта ревью')).toBeVisible()
  await expect(changes.getByText('18 с')).toBeVisible()
  expect(calls.panel.posts).toEqual([{ base: flowBase, wish: 'Добавь шаг ревью перед мержем' }])

  // Описание нового шага не пересказано: его открывает своё окно поверх разбора.
  await expect(dialog.getByText('Собрать дифф всей ветки')).toHaveCount(0)
  await changes.getByRole('button', { name: 'Открыть описание' }).click()
  const description = page.getByRole('dialog', { name: 'Описание шага «Ревью»' })
  await expect(description).toContainText('2.1. Собрать дифф всей ветки.')
  await description.getByRole('button', { name: 'Закрыть' }).click()

  await dialog.getByRole('button', { name: 'Взять правки в схему' }).click()
  await expect(dialog).toHaveCount(0)

  // Правки легли в схему несохранёнными: флоу базы панель пока не трогала.
  await expect(region.getByRole('button', { name: 'Шаг 2: Ревью' })).toBeVisible()
  await expect(page.getByText('есть несохранённые правки')).toBeVisible()
  expect(calls.save).toEqual([])

  await page.getByRole('button', { name: 'Сохранить' }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.save).toHaveLength(1)
  expect((calls.save[0] as { steps: Step[] }).steps.map((s) => s.title)).toEqual(['Критерий', 'Ревью', 'Мерж'])
})

test('отказ оставляет флоу как был, а неудачу агента видно словами', async ({ page }) => {
  const calls = await mockApi(page)
  calls.panel.reply(
    ndjson({
      type: 'error',
      text: 'Агент вернул не флоу: шагов в его ответе нет',
      output: 'Готово, я добавил шаг ревью.',
    }),
  )

  const region = await openFlow(page)
  await page.getByRole('button', { name: 'Переписать с Чудо-юдо' }).click()

  const dialog = page.getByRole('dialog', { name: 'Переписать флоу' })
  await dialog.getByLabel('Что поменять во флоу').fill('Добавь ревью')
  await dialog.getByRole('button', { name: 'Переписать' }).click()

  await expect(dialog.getByRole('alert')).toContainText('Агент вернул не флоу')
  await expect(dialog.getByRole('alert')).toContainText('Готово, я добавил шаг ревью.')

  // Просьба возвращается в поле, а не набирается заново.
  await dialog.getByRole('button', { name: 'Изменить просьбу' }).click()
  await expect(dialog.getByLabel('Что поменять во флоу')).toHaveValue('Добавь ревью')

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(region.getByRole('button', { name: 'Шаг 2: Мерж' })).toBeVisible()
  await expect(page.getByText('есть несохранённые правки')).toHaveCount(0)
  expect(calls.save).toEqual([])
})

test('пока агент переписывает, идёт счётчик, а «Отменить» возвращает просьбу в поле', async ({ page }) => {
  const calls = await mockApi(page)

  await openFlow(page)
  await page.getByRole('button', { name: 'Переписать с Чудо-юдо' }).click()

  const dialog = page.getByRole('dialog', { name: 'Переписать флоу' })
  await dialog.getByLabel('Что поменять во флоу').fill('Добавь ревью')
  await dialog.getByRole('button', { name: 'Переписать' }).click()

  const waiting = dialog.getByRole('status')
  await expect(waiting).toContainText('Чудо-юдо переписывает флоу Agents Kit Web…')
  await expect(waiting.getByLabel('Прошло времени')).toBeVisible()

  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await expect(dialog.getByLabel('Что поменять во флоу')).toHaveValue('Добавь ревью')
  expect(calls.panel.deletes).toBe(1)
})

test('закрытое окно не останавливает агента: разбор ждёт в шапке и открывается оттуда', async ({ page }) => {
  const calls = await mockApi(page)

  await openFlow(page)
  await page.getByRole('button', { name: 'Переписать с Чудо-юдо' }).click()
  const dialog = page.getByRole('dialog', { name: 'Переписать флоу' })
  await dialog.getByLabel('Что поменять во флоу').fill('Добавь ревью')
  await dialog.getByRole('button', { name: 'Переписать' }).click()
  await expect(dialog.getByRole('status')).toContainText('Чудо-юдо переписывает флоу Agents Kit Web…')

  // Оператор ушёл смотреть копии: агент дописывает флоу без него.
  await page.keyboard.press('Escape')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Рабочие копии' }).click()
  expect(calls.panel.deletes).toBe(0)

  calls.panel.reply(
    ndjson({
      type: 'rewritten',
      text: '',
      steps: [criterion, review, { ...merge, output: 'sha в dev после вердикта ревью' }],
      version: 'v1',
    }),
  )
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-юдо переписал флоу/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog', { name: 'Переписать флоу' })
  await expect(reopened.getByLabel('Что изменилось во флоу').getByText('добавлен')).toBeVisible()
  await reopened.getByRole('button', { name: 'Взять правки в схему' }).click()
  const region = page.getByRole('region', { name: 'Agents Kit Web' })
  await expect(region.getByRole('button', { name: 'Шаг 2: Ревью' })).toBeVisible()
  expect(calls.panel.posts).toHaveLength(1)
})

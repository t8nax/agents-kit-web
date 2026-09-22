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

/** Ещё трое: четырёх хватает, чтобы увидеть, что карточки стоят по три в ряд. */
const others: Performer[] = ['designer', 'test-runner', 'code-reader'].map((name) => ({
  name,
  description: `${name} делает своё дело.`,
  model: null,
  tools: null,
  prompt: `Ты ${name}.`,
  path: `${agents}\\${name}.md`,
}))

/**
 * /api подменяется: прогон работает с живыми базами оператора, и запись исполнителя положила бы
 * файл в живую базу знаний и закоммитила бы его туда.
 */
async function mockApi(page: Page, options: { taken?: boolean; performers?: Performer[] } = {}) {
  const saved: unknown[] = []
  let performers: Performer[] = options.performers ?? [reviewer, ...others]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/agent/requests', (route) => route.fulfill({ json: [] }))

  await page.route('**/api/performers', (route) => {
    if (route.request().method() === 'POST') {
      const request = route.request().postDataJSON() as Performer & { editing: string | null }
      if (options.taken) return route.fulfill({ status: 409, json: { problem: 'name-taken' } })
      saved.push(request)
      performers = performers.map((p) =>
        p.name === request.editing
          ? { ...p, description: request.description, model: request.model, tools: request.tools, prompt: request.prompt }
          : p,
      )
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

const card = (page: Page, name: string) => page.getByRole('button', { name: `${name}, Agents Kit Web` })

test('исполнители стоят карточками по три в ряд, без пути, инструментов и «Править»', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await expect(card(page, 'reviewer')).toBeVisible()
  await expect(card(page, 'reviewer')).toContainText('Читает дифф ветки задачи и возвращает вердикт.')
  await expect(card(page, 'reviewer')).toContainText('opus')
  await expect(page.getByText(`${agents}\\reviewer.md`)).toHaveCount(0)
  await expect(page.getByText('Read, Glob, Grep')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Править' })).toHaveCount(0)

  // Первые три карточки — один ряд, четвёртая уходит на следующий. Замер повторяется, пока грузится шрифт.
  await expect(async () => {
    const [a, b, c, d] = await Promise.all(
      ['reviewer', 'designer', 'test-runner', 'code-reader'].map(async (name) => (await card(page, name).boundingBox())!.y),
    )
    expect(b).toBe(a)
    expect(c).toBe(a)
    expect(d).toBeGreaterThan(a)
  }).toPass()
})

test('клик по карточке открывает окно, где правятся модель и инструменты', async ({ page }) => {
  const { saved } = await mockApi(page)
  await openPerformers(page)

  await card(page, 'reviewer').click()
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  await expect(modal).toBeVisible()
  await expect(modal.getByLabel('Описание')).toHaveValue('Читает дифф ветки задачи и возвращает вердикт.')
  // Стрелка списка модели — 14px, как в принятом макете, а не 18px общих значков окон.
  const arrow = modal.locator('.pf-select-wrap svg').first()
  await expect(async () => expect((await arrow.boundingBox())!.width).toBe(14)).toPass()

  await modal.getByLabel('Модель').selectOption('haiku')
  await modal.getByRole('button', { name: 'Только чтение' }).click()
  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  // Про перенос по копиям панель молчит: единственное, что она говорит, — с какой сессии звать
  await expect(page.getByText('reviewer записан. Звать его можно со следующей сессии.')).toBeVisible()
  await expect(card(page, 'reviewer')).toContainText('записан')
  expect(saved).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      name: 'reviewer',
      description: 'Читает дифф ветки задачи и возвращает вердикт.',
      model: 'haiku',
      tools: null,
      prompt: 'Ты читаешь дифф ветки целиком.',
      editing: 'reviewer',
    },
  ])
})

test('задание открывается своим окном только для чтения', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)

  await card(page, 'reviewer').click()
  await page.getByRole('dialog', { name: 'reviewer' }).getByRole('button', { name: 'Показать задание' }).click()

  const task = page.getByRole('dialog', { name: /Задание/ })
  await expect(task.getByText('Ты читаешь дифф ветки целиком.')).toBeVisible()
  await expect(task.getByRole('textbox')).toHaveCount(0)

  // Окно задания сверху: фокус в нём.
  await expect(task.getByRole('button', { name: 'Закрыть', exact: true })).toBeFocused()

  // Escape закрывает верхнее окно, а окно исполнителя остаётся, и фокус возвращается на кнопку задания.
  await page.keyboard.press('Escape')
  await expect(task).toHaveCount(0)
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  await expect(modal).toBeVisible()
  await expect(modal.getByRole('button', { name: 'Показать задание' })).toBeFocused()

  // То же — кнопкой «Закрыть».
  await modal.getByRole('button', { name: 'Показать задание' }).click()
  await task.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(modal.getByRole('button', { name: 'Показать задание' })).toBeFocused()
})

test('отказ записи виден словами, а окно остаётся открытым', async ({ page }) => {
  await mockApi(page, { taken: true })
  await openPerformers(page)

  await card(page, 'reviewer').click()
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  await modal.getByLabel('Модель').selectOption('sonnet')
  await modal.getByRole('button', { name: 'Сохранить' }).click()

  await expect(modal.getByRole('alert')).toContainText('уже есть')
  await expect(modal.getByLabel('Модель')).toHaveValue('sonnet')
})

test('проект выбирается выпадающим списком над сеткой, а не чипами', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/agent/requests', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/performers', (route) =>
    route.fulfill({
      json: [
        { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web', directory: agents, performers: [reviewer], error: null },
        {
          base: 'D:\\Projects\\nota-knowledge',
          project: 'Nota',
          directory: 'D:\\Projects\\nota-knowledge\\agents',
          performers: [{ ...others[0], path: 'D:\\Projects\\nota-knowledge\\agents\\designer.md' }],
          error: null,
        },
      ],
    }),
  )
  await openPerformers(page)

  const select = page.getByRole('combobox', { name: 'Проект' })
  await expect(select).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Все' })).toHaveCount(0)
  await expect(card(page, 'reviewer')).toBeVisible()

  await select.selectOption({ label: 'Nota' })
  await expect(card(page, 'reviewer')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'designer, Nota' })).toBeVisible()
})

test('описание в карточке обрезано по трём строкам', async ({ page }) => {
  const long = 'Читает дифф ветки задачи, сверяет его с критерием закрытия и решениями базы, '.repeat(6)
  await mockApi(page, { performers: [{ ...reviewer, description: long }, ...others] })
  await openPerformers(page)

  const description = card(page, 'reviewer').locator('.performer-desc')
  await expect(description).toBeVisible()
  // Видно ровно три строки: высота — три строки текста, а остальное срезано. Замер повторяется, пока грузится шрифт.
  await expect(async () => {
    const { height, full, line } = await description.evaluate((el) => ({
      height: el.clientHeight,
      full: el.scrollHeight,
      line: parseFloat(getComputedStyle(el).lineHeight),
    }))
    expect(Math.round(height / line)).toBe(3)
    expect(full).toBeGreaterThan(height)
  }).toPass()
})

test('карточка добавления стоит последней в сетке и ростом с соседнюю', async ({ page }) => {
  // У соседки описание в три строки: она выше общей нижней границы роста карточек, и равенство что-то значит.
  const tall = 'Читает дифф ветки задачи, сверяет его с критерием закрытия и решениями базы, '.repeat(6)
  await mockApi(page, {
    performers: [reviewer, ...others.map((p) => (p.name === 'code-reader' ? { ...p, description: tall } : p))],
  })
  await openPerformers(page)

  const add = page.getByRole('button', { name: 'Новый исполнитель' })
  await expect(add).toBeVisible()
  await expect(page.locator('.performer-grid > :last-child')).toHaveText('Новый исполнитель')
  // Четыре исполнителя: четвёртый и карточка добавления стоят во втором ряду рядом и одного роста.
  await expect(async () => {
    const [neighbour, box] = await Promise.all([card(page, 'code-reader').boundingBox(), add.boundingBox()])
    expect(box!.y).toBe(neighbour!.y)
    expect(neighbour!.height).toBeGreaterThan(112)
    expect(box!.height).toBe(neighbour!.height)
    expect(box!.x).toBeGreaterThan(neighbour!.x)
  }).toPass()
})

test('окно задания стоит во весь рост экрана, и поле правки его заполняет', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)
  await card(page, 'reviewer').click()
  await page.getByRole('dialog', { name: 'reviewer' }).getByRole('button', { name: 'Показать задание' }).click()

  const task = page.getByRole('dialog', { name: /Задание/ })
  const viewport = page.viewportSize()!.height
  // Короткое задание окно не сжимает: высота — девять десятых экрана (замечание оператора на приёмке B-198).
  await expect(async () => {
    const box = (await task.boundingBox())!
    expect(Math.abs(box.height - viewport * 0.9)).toBeLessThanOrEqual(1)
  }).toPass()

  await task.getByRole('button', { name: 'Редактировать' }).click()
  const field = task.getByRole('textbox', { name: 'Задание' })
  await expect(async () => {
    const box = (await field.boundingBox())!
    expect(box.height).toBeGreaterThan(viewport * 0.6)
  }).toPass()
})

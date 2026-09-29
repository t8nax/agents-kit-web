import { expect, test, type Page } from '@playwright/test'

type Performer = {
  name: string
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
  path: string
  calledBy?: string[]
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
  const deleted: string[] = []
  let performers: Performer[] = options.performers ?? [reviewer, ...others]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/agent/requests', (route) => route.fulfill({ json: [] }))

  // Удаление называет базу и имя строкой запроса: исполнитель уходит из списка, как ушёл бы из базы.
  await page.route('**/api/performers?*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback()
    const name = new URL(route.request().url()).searchParams.get('name')!
    deleted.push(name)
    performers = performers.filter((p) => p.name !== name)
    return route.fulfill({ status: 204 })
  })

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
  return { saved, deleted }
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
  // Прочие значки окна — общие 18px окон: выносом общих стилей в Modal.css они было сжались до 16px (B-199)
  const close = modal.getByRole('button', { name: 'Закрыть' }).locator('svg')
  await expect(async () => expect((await close.boundingBox())!.width).toBe(18)).toPass()

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

test('исполнитель удаляется из окна через окно подтверждения, и его карточка уходит', async ({ page }) => {
  const { deleted } = await mockApi(page)
  await openPerformers(page)

  await card(page, 'reviewer').click()
  const modal = page.getByRole('dialog', { name: 'reviewer' })
  const remove = modal.getByRole('button', { name: 'Удалить исполнителя' })
  // Кнопка — слева в подвале, отдельно от «Сохранить», как «Удалить этап» во «Флоу»; в покое контурная (макет B-83).
  await expect(async () => {
    const [left, save] = await Promise.all([remove.boundingBox(), modal.getByRole('button', { name: 'Сохранить' }).boundingBox()])
    expect(left!.x).toBeLessThan(save!.x)
    expect(left!.y).toBe(save!.y)
  }).toPass()
  expect(await remove.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')

  await remove.click()
  const confirm = page.getByRole('dialog', { name: 'Удалить исполнителя' })
  await expect(confirm).toContainText('Исполнитель reviewer проекта Agents Kit Web уйдёт из базы.')
  // Кнопка, которая удаляет, залита цветом ошибки, как «Удалить копию»: её не спутать с «Отменой».
  const [danger, cancel] = await Promise.all([
    confirm.getByRole('button', { name: 'Удалить исполнителя' }).evaluate((el) => getComputedStyle(el).backgroundColor),
    confirm.getByRole('button', { name: 'Отмена' }).evaluate((el) => getComputedStyle(el).backgroundColor),
  ])
  expect(danger).not.toBe(cancel)

  await confirm.getByRole('button', { name: 'Удалить исполнителя' }).click()

  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(card(page, 'reviewer')).toHaveCount(0)
  await expect(card(page, 'designer')).toBeVisible()
  expect(deleted).toEqual(['reviewer'])
})

test('исполнителя, которого зовут этапы флоу, удалить нельзя', async ({ page }) => {
  await mockApi(page, { performers: [{ ...reviewer, calledBy: ['Дизайн', 'Ревью'] }, ...others] })
  await openPerformers(page)

  await card(page, 'reviewer').click()
  const remove = page.getByRole('dialog', { name: 'reviewer' }).getByRole('button', { name: 'Удалить исполнителя' })
  await expect(remove).toBeDisabled()
  await expect(remove).toHaveAttribute('title', 'Его зовут этапы: Дизайн, Ревью')
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

test('окно задания стоит во весь рост экрана, а просмотр и поле правки заполняют его тело', async ({ page }) => {
  await mockApi(page)
  await openPerformers(page)
  await card(page, 'reviewer').click()
  await page.getByRole('dialog', { name: 'reviewer' }).getByRole('button', { name: 'Показать задание' }).click()

  const task = page.getByRole('dialog', { name: /Задание/ })
  const body = task.locator('.ask-body')
  const viewport = page.viewportSize()!.height
  /** Низ блока стоит у низа тела окна, за вычетом его нижнего отступа: блок растянут на всё тело. */
  const fillsBody = async (block: ReturnType<typeof task.locator>) => {
    const [inner, outer, padding] = await Promise.all([
      block.boundingBox(),
      body.boundingBox(),
      body.evaluate((el) => parseFloat(getComputedStyle(el).paddingBottom)),
    ])
    expect(Math.abs(inner!.y + inner!.height - (outer!.y + outer!.height - padding))).toBeLessThanOrEqual(1)
  }

  // Короткое задание окно не сжимает: высота — девять десятых экрана (замечание оператора на приёмке B-198).
  await expect(async () => {
    const box = (await task.boundingBox())!
    expect(Math.abs(box.height - viewport * 0.9)).toBeLessThanOrEqual(1)
    await fillsBody(task.locator('.pf-task-view'))
  }).toPass()

  await task.getByRole('button', { name: 'Редактировать' }).click()
  await expect(async () => fillsBody(task.getByRole('textbox', { name: 'Задание' }))).toPass()
})

test('длинное задание прокручивается в теле окна, а кнопки подвала остаются на месте', async ({ page }) => {
  const long = Array.from({ length: 120 }, (_, i) => `Строка задания ${i + 1}.`).join('\n\n')
  await mockApi(page, { performers: [{ ...reviewer, prompt: long }, ...others] })
  await openPerformers(page)
  await card(page, 'reviewer').click()
  await page.getByRole('dialog', { name: 'reviewer' }).getByRole('button', { name: 'Показать задание' }).click()

  const task = page.getByRole('dialog', { name: /Задание/ })
  await expect(task.getByText('Строка задания 120.')).toBeAttached()
  await expect(async () => {
    const scroll = await task.locator('.ask-body').evaluate((el) => el.scrollHeight - el.clientHeight)
    expect(scroll).toBeGreaterThan(0)
    const [box, edit] = await Promise.all([task.boundingBox(), task.getByRole('button', { name: 'Редактировать' }).boundingBox()])
    expect(edit!.y + edit!.height).toBeLessThanOrEqual(box!.y + box!.height)
  }).toPass()
})

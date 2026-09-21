import { expect, test, type Page } from '@playwright/test'

type Stage = {
  title: string
  executor: string
  output: string
  skip: string | null
  description: string | null
  helpers?: string[]
  slug?: string | null
}

type Flow = { name: string; when: string | null; entries: { stage: string; returns?: { condition: string; stage: string }[] }[] }

const stages: Stage[] = [
  {
    title: 'Критерий',
    executor: 'оркестратор',
    output: 'критерий закрытия в памяти',
    skip: null,
    description: '1. Написать критерий.',
    helpers: [],
    slug: 'criterion',
  },
  {
    title: 'Ревью',
    // Стадия зовёт исполнителя тем же именем, каким назван его файл в базе
    executor: 'reviewer',
    output: 'вердикт по sha',
    skip: 'правка только в текстах',
    description: '1. Собрать дифф.',
    helpers: [],
    slug: 'review',
  },
  {
    title: 'Приёмка',
    executor: 'оператор',
    output: 'ответ оператора «принято»',
    skip: null,
    description: null,
    helpers: [],
    slug: 'acceptance',
  },
]

const flows: Flow[] = [
  {
    name: 'полный',
    when: 'новая возможность',
    entries: [
      { stage: 'Критерий', returns: [] },
      { stage: 'Ревью', returns: [] },
      { stage: 'Приёмка', returns: [{ condition: 'есть замечания', stage: 'Ревью' }] },
    ],
  },
  { name: 'мелкий', when: 'правка в одном месте', entries: [{ stage: 'Ревью', returns: [] }, { stage: 'Приёмка', returns: [] }] },
]

// /api подменяется: прогон работает с живыми базами оператора, и запись флоу или пресета попала бы в них.
async function mockApi(page: Page, activeTasks = 0, own: { stages: Stage[]; flows: Flow[] } = { stages, flows }) {
  const calls: { flow: unknown[]; presets: unknown[]; open: unknown[] } = { flow: [], presets: [], open: [] }
  let presets: (Stage & { id: string })[] = []

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/flow', (route) => {
    if (route.request().method() === 'POST') {
      calls.flow.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2' } })
    }
    return route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          ...own,
          activeTasks,
          version: 'v1',
          error: null,
          icons: { Критерий: 'target' },
        },
        {
          base: 'D:\\Projects\\nota-knowledge',
          project: 'Nota',
          stages: [],
          flows: [],
          activeTasks: 0,
          version: 'v0',
          error: null,
          icons: {},
        },
      ],
    })
  })
  await page.route('**/api/flow/open', (route) => {
    calls.open.push(route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  // Раздел спрашивает заведённых исполнителей: из них стадии выбирают субагента.
  await page.route('**/api/performers', (route) =>
    route.fulfill({
      json: [
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          directory: 'D:\\Projects\\app-knowledge\\agents',
          performers: [
            {
              name: 'reviewer',
              description: null,
              model: null,
              tools: null,
              prompt: '',
              path: 'D:\\Projects\\app-knowledge\\agents\\reviewer.md',
            },
          ],
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/presets', (route) => {
    if (route.request().method() === 'POST') {
      const preset = { ...(route.request().postDataJSON() as Stage), id: `p${presets.length + 1}` }
      calls.presets.push(preset)
      presets = [...presets, preset]
      return route.fulfill({ json: preset })
    }
    return route.fulfill({ json: presets })
  })
  return calls
}

async function openFlow(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toBeVisible()
  // Мышь уходит с сайдбара разделов: под ней он раскрыт и накрывает левый край раздела.
  await page.mouse.move(900, 400)
  const region = page.getByRole('region', { name: 'Флоу «полный»' })
  await expect(region.getByRole('button', { name: 'Стадия 1: Критерий' })).toBeVisible()
  return region
}

test('вкладка «Флоу»: узел старта и блоки по центру ленты, флоу выбирается в углу холста', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  // Заголовок, вкладки, проект и «…» стоят одной строкой
  const title = await page.getByRole('heading', { name: 'Флоу', level: 2 }).boundingBox()
  const tab = await page.getByRole('tab', { name: 'Стадии' }).boundingBox()
  const project = await page.getByRole('button', { name: 'Проект: Agents Kit Web' }).boundingBox()
  expect(Math.abs(title!.y + title!.height / 2 - (tab!.y + tab!.height / 2))).toBeLessThan(6)
  expect(Math.abs(title!.y + title!.height / 2 - (project!.y + project!.height / 2))).toBeLessThan(6)

  const review = region.getByRole('button', { name: 'Стадия 2: Ревью' })
  await expect(review).toHaveText(/^Ревьюсубагент reviewer$/)
  await expect(review.locator('.flow-node-skip')).toBeVisible()
  await expect(page.getByText('вердикт по sha')).toHaveCount(0)

  // Узел старта, стрелки и блок «Добавить стадию» стоят по центру блоков
  const block = await region.getByRole('button', { name: 'Стадия 1: Критерий' }).boundingBox()
  const start = await region.getByRole('button', { name: 'Флоу «полный»: название и «когда»' }).boundingBox()
  const arrow = await region.locator('.flow-arrow').first().boundingBox()
  const add = await page.getByRole('button', { name: 'Добавить стадию' }).boundingBox()
  for (const box of [start, arrow, add])
    expect(Math.abs(block!.x + block!.width / 2 - (box!.x + box!.width / 2))).toBeLessThan(1)
  // Выбор флоу — в левом верхнем углу холста, левее ленты
  const picker = await page.getByRole('button', { name: 'Флоу: полный' }).boundingBox()
  expect(picker!.x + picker!.width).toBeLessThan(block!.x)

  await page.getByRole('button', { name: 'Флоу: полный' }).click()
  await expect(page.getByRole('listbox', { name: 'Флоу' }).getByRole('option')).toHaveText(['полный', 'мелкий'])
  await page.getByRole('option', { name: 'мелкий' }).click()
  await expect(page.getByRole('region', { name: 'Флоу «мелкий»' }).getByRole('button', { name: /^Стадия 1: Ревью/ })).toBeVisible()

  // Редкие действия раздела — в меню «…» шапки; переписывания в нём нет
  await page.getByRole('button', { name: 'Ещё действия' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Обновить', 'Открыть в VS Code'])
  await page.getByRole('menuitem', { name: 'Открыть в VS Code' }).click()
  await expect.poll(() => calls.open).toEqual([{ base: 'D:\\Projects\\app-knowledge' }])
})

test('сайдбар стадии справа от схемы, дуги возвратов слева от ленты, название ведёт к правке стадии', async ({
  page,
}) => {
  await mockApi(page)
  const region = await openFlow(page)

  const arc = region.locator('.flow-arc').first()
  await expect(arc).toBeVisible()
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)
  await expect(async () => {
    const line = await arc.boundingBox()
    const node = await region.getByRole('button', { name: /^Стадия 2: Ревью/ }).boundingBox()
    expect(line && node && line.x + line.width).toBeLessThanOrEqual((node?.x ?? 0) + 2)
  }).toPass()

  await region.getByRole('button', { name: /^Стадия 3: Приёмка/ }).click()
  const drawer = page.getByRole('complementary')
  await expect(region.locator('.flow-arc-open')).toHaveCount(1)
  await expect(region.getByText('есть замечания')).toBeVisible()
  const node = await region.getByRole('button', { name: /^Стадия 3: Приёмка/ }).boundingBox()
  expect((await drawer.boundingBox())!.x).toBeGreaterThan(node!.x + node!.width)
  // В сайдбаре стадии во флоу — только её возвраты
  await expect(drawer.getByRole('textbox', { name: 'Условие возврата 1' })).toHaveValue('есть замечания')
  await expect(drawer.getByRole('textbox', { name: 'Выход стадии' })).toHaveCount(0)

  await drawer.getByRole('button', { name: 'Править стадию «Приёмка»' }).click()
  await expect(page.getByRole('tab', { name: 'Стадии' })).toHaveAttribute('aria-selected', 'true')
  await expect(
    page.getByRole('region', { name: 'Стадия «Приёмка»' }).getByRole('textbox', { name: 'Выход стадии' }),
  ).toHaveValue('ответ оператора «принято»')
})

test('вкладка «Стадии»: список слева, правка стадии на всю ширину до него, значок из списка значков', async ({
  page,
}) => {
  const calls = await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Стадии' }).click()

  const list = page.getByRole('list', { name: 'Стадии базы' })
  await expect(list.getByRole('button')).toHaveCount(3)
  const edit = page.getByRole('region', { name: 'Стадия «Критерий»' })
  const listBox = await page.locator('.flow-stage-list').boundingBox()
  const editBox = await edit.boundingBox()
  const main = await page.getByRole('main').boundingBox()
  // Правка стоит вплотную к списку и доходит до правого края раздела
  expect(Math.abs(editBox!.x - (listBox!.x + listBox!.width))).toBeLessThan(2)
  expect(Math.abs(editBox!.x + editBox!.width - (main!.x + main!.width))).toBeLessThan(2)
  // Стадию, стоящую во флоу, не удалить
  await expect(edit.getByRole('button', { name: 'Удалить стадию' })).toBeDisabled()

  await list.getByRole('button', { name: /^Приёмка/ }).click()
  const acceptance = page.getByRole('region', { name: 'Стадия «Приёмка»' })
  await acceptance.getByRole('textbox', { name: 'Пропуск стадии' }).fill('правка не меняет вида панели')
  await acceptance.getByRole('button', { name: 'Значок стадии' }).click()
  const icons = page.getByRole('group', { name: 'Значки стадии' })
  // В списке сами значки, а не их названия
  await expect(icons.getByRole('button')).toHaveCount(6)
  await expect(icons.getByRole('button', { name: 'Значок «проверка»' })).toHaveText('')
  await icons.getByRole('button', { name: 'Значок «проверка»' }).click()
  await expect(icons).toHaveCount(0)

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.flow).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      version: 'v1',
      stages: [stages[0], stages[1], { ...stages[2], skip: 'правка не меняет вида панели' }],
      flows,
      icons: { Критерий: 'target', Приёмка: 'check' },
    },
  ])
})

test('полоса сохранения внизу раздела: появляется с правками, причина стоит одной строкой', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)
  await expect(page.locator('.save-bar')).toHaveCount(0)

  await page.getByRole('tab', { name: 'Стадии' }).click()
  await page.getByRole('region', { name: 'Стадия «Критерий»' }).getByRole('textbox', { name: 'Выход стадии' }).fill(' ')

  const bar = page.locator('.save-bar')
  await expect(bar).toBeVisible()
  await expect(bar).toBeInViewport({ ratio: 1 })
  const main = await page.getByRole('main').boundingBox()
  const box = await bar.boundingBox()
  expect(Math.abs(box!.y + box!.height - (main!.y + main!.height))).toBeLessThan(2)
  const blocked = bar.getByText('Не сохранить: стадия «Критерий» — не указан выход')
  await expect(async () => {
    const fontSize = await blocked.evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    expect((await blocked.boundingBox())!.height).toBeLessThan(fontSize * 2)
  }).toPass()
  await expect(bar.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()

  await bar.getByRole('button', { name: 'Отменить правки' }).click()
  await expect(bar).toHaveCount(0)
})

test('блок перетаскивается мышью, при задачах в работе сохранение спрашивает подтверждение', async ({ page }) => {
  const calls = await mockApi(page, 2)
  const region = await openFlow(page)

  // Двигается «Ревью»: возврат «Приёмки» к нему по-прежнему ведёт назад, и флоу остаётся годным
  await region.getByRole('button', { name: 'Стадия 2: Ревью' }).dragTo(region.getByRole('button', { name: 'Стадия 1: Критерий' }))
  await expect(region.getByRole('button', { name: 'Стадия 1: Ревью' })).toBeVisible()

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Сохранить флоу Agents Kit Web?' })
  await expect(dialog.getByText(/На проекте 2 задачи в работе/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  const sent = calls.flow[0] as { flows: Flow[] }
  expect(sent.flows[0].entries.map((entry) => entry.stage)).toEqual(['Ревью', 'Критерий', 'Приёмка'])
})

test('раздел держится в экране: прокручивается схема, шапка и сайдбар стоят на месте', async ({ page }) => {
  await mockApi(page)
  await page.setViewportSize({ width: 1100, height: 600 })
  const region = await openFlow(page)
  await region.getByRole('button', { name: 'Стадия 1: Критерий' }).click()

  const scroll = region.locator('.flow-scroll')
  await expect.poll(async () => scroll.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true)
  await scroll.evaluate((box) => box.scrollTo(0, box.scrollHeight))

  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Ещё действия' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Флоу: полный' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('complementary')).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Убрать из флоу' })).toBeInViewport({ ratio: 1 })
})

test('окно добавления: новая стадия, стадии базы и пресеты карточками; стадия встаёт в конец флоу', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)
  await page.getByRole('button', { name: 'Флоу: полный' }).click()
  await page.getByRole('option', { name: 'мелкий' }).click()
  const region = page.getByRole('region', { name: 'Флоу «мелкий»' })

  await page.getByRole('button', { name: 'Добавить стадию' }).click()
  const adding = page.getByRole('dialog', { name: 'Добавить стадию во флоу «мелкий»' })
  await expect(adding.getByText('Пресетов пока нет.')).toBeVisible()
  // Стадии в окне выделены карточками, а не идут сплошным списком
  await expect(adding.getByRole('button', { name: /^Новая стадия/ })).toHaveCSS('border-top-style', 'solid')
  await expect(adding.getByRole('group', { name: 'Стадии базы' }).getByRole('button')).toHaveText([/^Критерий/])
  await adding.getByRole('button', { name: /^Критерий/ }).click()

  await expect(region.getByRole('button', { name: 'Стадия 3: Критерий' })).toBeVisible()
  await expect(page.getByRole('complementary')).toHaveAttribute('aria-label', 'Стадия 3: Критерий')
})

test('описание стадии правится в окне по кнопке со вкладки «Стадии»', async ({ page }) => {
  const calls = await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Стадии' }).click()

  await page.getByRole('region', { name: 'Стадия «Критерий»' }).getByRole('button', { name: /Редактировать описание/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Описание стадии «Критерий»' })
  const text = dialog.getByRole('textbox', { name: 'Описание стадии' })
  await expect(text).toBeFocused()
  await expect(text).toHaveValue('1. Написать критерий.')

  // Описание свободным текстом: абзац, пустая строка, списки «-» и «1.»
  await text.press('ControlOrMeta+Home')
  await text.pressSequentially('Критерий пишется до кода.')
  await text.press('Enter')
  await text.press('Enter')
  await text.pressSequentially('- проверяемый;')
  await text.press('Enter')
  await dialog.getByRole('button', { name: 'Готово' }).click()
  await expect(dialog).toHaveCount(0)

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect((calls.flow[0] as { stages: Stage[] }).stages[0].description).toBe(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. Написать критерий.',
  )
})

test('исполнитель, которого нет в базе, помечен на схеме и в стадии, и флоу не сохранить', async ({ page }) => {
  await mockApi(page, 0, { stages: [stages[0], { ...stages[1], executor: 'doc-writer' }, stages[2]], flows })
  const region = await openFlow(page)

  const review = region.getByRole('button', { name: 'Стадия 2: Ревью' })
  await expect(review.locator('.flow-node-missing')).toBeVisible()
  await expect(page.locator('.save-bar').getByText(/Не сохранить: стадия «Ревью»/)).toContainText('исполнителя нет в базе')

  await page.getByRole('tab', { name: 'Стадии' }).click()
  await page.getByRole('list', { name: 'Стадии базы' }).getByRole('button', { name: /^Ревью/ }).click()
  const edit = page.getByRole('region', { name: 'Стадия «Ревью»' })
  await expect(edit.getByRole('status')).toContainText('Выберите исполнителя из заведённых')
  // Имя руками не вписывается: в списке только заведённые в базе
  await edit.getByLabel('Имя субагента').selectOption('reviewer')
  await expect(page.locator('.save-bar').getByText(/Не сохранить/)).toHaveCount(0)
})

test('проект без флоу — пустое состояние по центру раздела и одна кнопка', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)

  await page.getByRole('button', { name: 'Проект: Agents Kit Web' }).click()
  await page.getByRole('listbox', { name: 'Проект' }).getByRole('option', { name: 'Nota' }).click()

  const heading = page.getByRole('heading', { name: 'В этом проекте нет флоу' })
  await expect(heading).toBeVisible()
  await expect(page.getByRole('tab')).toHaveCount(0)
  const empty = await page.locator('.flow-empty').boundingBox()
  const main = await page.getByRole('main').boundingBox()
  const box = await heading.boundingBox()
  // По центру раздела под строкой заголовка
  expect(Math.abs(box!.x + box!.width / 2 - (main!.x + main!.width / 2))).toBeLessThan(2)
  expect(Math.abs(empty!.y + empty!.height - (main!.y + main!.height))).toBeLessThan(2)
  await expect(page.locator('.flow-empty').getByRole('button')).toHaveText(['Создать первый флоу'])

  await page.getByRole('button', { name: 'Создать первый флоу' }).click()
  await expect(page.getByRole('region', { name: 'Флоу «новый флоу»' })).toBeVisible()
  await expect(page.getByRole('complementary').getByRole('textbox', { name: 'Название флоу' })).toHaveValue('новый флоу')
})

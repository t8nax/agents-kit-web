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

// /api подменяется: прогон работает с живыми базами оператора, и запись флоу попала бы в них.
type FlowTask = { task: string; flow: string | null }

async function mockApi(page: Page, tasks: FlowTask[] = [], own: { stages: Stage[]; flows: Flow[] } = { stages, flows }) {
  const calls: { flow: unknown[]; open: unknown[] } = { flow: [], open: [] }

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
          tasks,
          version: 'v1',
          error: null,
          icons: { Критерий: 'target' },
        },
        {
          base: 'D:\\Projects\\nota-knowledge',
          project: 'Nota',
          stages: [],
          flows: [],
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
  return calls
}

async function openFlow(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toBeVisible()
  // Мышь уходит с сайдбара разделов: под ней он раскрыт и накрывает левый край раздела.
  await page.mouse.move(900, 400)
  const region = page.getByRole('region', { name: 'Сценарий «полный»' })
  await expect(region.getByRole('button', { name: 'Этап 1: Критерий' })).toBeVisible()
  return region
}

test('вкладка «Флоу»: узел старта и блоки по центру ленты, флоу выбирается в углу холста', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  // Заголовок, вкладки, проект и «…» стоят одной строкой
  const title = await page.getByRole('heading', { name: 'Флоу', level: 2 }).boundingBox()
  const tab = await page.getByRole('tab', { name: 'Этапы' }).boundingBox()
  const project = await page.getByRole('button', { name: 'Проект: Agents Kit Web' }).boundingBox()
  expect(Math.abs(title!.y + title!.height / 2 - (tab!.y + tab!.height / 2))).toBeLessThan(6)
  expect(Math.abs(title!.y + title!.height / 2 - (project!.y + project!.height / 2))).toBeLessThan(6)

  const review = region.getByRole('button', { name: 'Этап 2: Ревью' })
  await expect(review).toHaveText(/^Ревьюсубагент reviewer$/)
  await expect(review.locator('.flow-node-skip')).toBeVisible()
  await expect(page.getByText('вердикт по sha')).toHaveCount(0)

  // Узел старта, стрелки и блок «Добавить этап» стоят по центру блоков
  const block = await region.getByRole('button', { name: 'Этап 1: Критерий' }).boundingBox()
  const start = await region.getByRole('button', { name: 'Сценарий «полный»: название и «когда»' }).boundingBox()
  const arrow = await region.locator('.flow-arrow').first().boundingBox()
  const add = await page.getByRole('button', { name: 'Добавить этап' }).boundingBox()
  for (const box of [start, arrow, add])
    expect(Math.abs(block!.x + block!.width / 2 - (box!.x + box!.width / 2))).toBeLessThan(1)
  // Выбор флоу — в левом верхнем углу холста, левее ленты
  const picker = await page.getByRole('button', { name: 'Сценарий: полный' }).boundingBox()
  expect(picker!.x + picker!.width).toBeLessThan(block!.x)

  await page.getByRole('button', { name: 'Сценарий: полный' }).click()
  await expect(page.getByRole('listbox', { name: 'Сценарий' }).getByRole('option')).toHaveText(['полный', 'мелкий'])
  await page.getByRole('option', { name: 'мелкий' }).click()
  await expect(page.getByRole('region', { name: 'Сценарий «мелкий»' }).getByRole('button', { name: /^Этап 1: Ревью/ })).toBeVisible()

  // Редкие действия раздела — в меню «…» шапки; переписывание стадий с Чудо-Юдо — первым
  await page.getByRole('button', { name: 'Ещё действия' }).click()
  await expect(page.getByRole('menuitem')).toHaveText(['Переписать с Чудо-Юдо', 'Обновить', 'Открыть в VS Code'])
  await page.getByRole('menuitem', { name: 'Открыть в VS Code' }).click()
  await expect.poll(() => calls.open).toEqual([{ base: 'D:\\Projects\\app-knowledge' }])
})

test('меню стадии встаёт у курсора, окна возвратов и правки открываются поверх схемы и возвращают фокус блоку', async ({
  page,
}) => {
  await mockApi(page)
  const region = await openFlow(page)

  const arc = region.locator('.flow-arc').first()
  await expect(arc).toBeVisible()
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)
  await expect(async () => {
    const line = await arc.boundingBox()
    const node = await region.getByRole('button', { name: /^Этап 2: Ревью/ }).boundingBox()
    expect(line && node && line.x + line.width).toBeLessThanOrEqual((node?.x ?? 0) + 2)
  }).toPass()

  // Левый щелчок, Enter и пробел по блоку ничего не открывают: меню — только по правому щелчку
  const block = region.getByRole('button', { name: /^Этап 3: Приёмка/ })
  await block.click()
  await expect(block).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  for (const key of ['Enter', ' ']) {
    await page.keyboard.press(key)
    await expect(page.getByRole('menu')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(block).toBeFocused()
  }
  await expect(page.getByRole('complementary')).toHaveCount(0)

  // Щелчок по самому блоку закрывает его открытое меню
  await block.click({ button: 'right' })
  await expect(page.getByRole('menu')).toHaveCount(1)
  await block.click({ position: { x: 10, y: 10 } })
  await expect(page.getByRole('menu')).toHaveCount(0)

  // Правый щелчок ставит меню у курсора
  const first = region.getByRole('button', { name: 'Этап 1: Критерий' })
  await first.click({ button: 'right', position: { x: 60, y: 40 } })
  const node = (await first.boundingBox())!
  const box = (await page.getByRole('menu', { name: 'Этап «Критерий»' }).boundingBox())!
  expect(Math.abs(box.x - (node.x + 60))).toBeLessThanOrEqual(1)
  expect(Math.abs(box.y - (node.y + 40))).toBeLessThanOrEqual(1)
  // Прокрутка схемы после открытия закрывает меню: оно стоит у точки экрана, а блок уехал бы
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await region.locator('.flow-scroll').dispatchEvent('scroll')
  await expect(page.getByRole('menu')).toHaveCount(0)

  // У нижнего края меню поднимается вверх и целиком остаётся в окне
  await block.click({ button: 'right', position: { x: 60, y: 120 } })
  const menu = page.getByRole('menu', { name: 'Этап «Приёмка»' })
  await expect(menu).toBeInViewport({ ratio: 1 })
  await expect(menu.getByRole('menuitem', { name: 'Возвраты' })).toBeFocused()

  // Окно возвратов — поверх схемы: дуга стадии подсвечена, под окном Tab не уходит к разделу
  await menu.getByRole('menuitem', { name: 'Возвраты' }).click()
  const returns = page.getByRole('dialog', { name: 'Возвраты этапа «Приёмка»' })
  await expect(returns.getByRole('textbox', { name: 'Условие возврата 1' })).toHaveValue('есть замечания')
  await expect(returns.getByRole('textbox', { name: 'Выход этапа' })).toHaveCount(0)
  // Окно возвратов — 560px, как на макете; карточки — во всю ширину его тела, без колонки подписи слева
  await expect(async () => {
    expect(Math.round((await returns.boundingBox())!.width)).toBe(560)
    const body = await returns.locator('.ask-body').evaluate((el) => {
      const style = getComputedStyle(el)
      return el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    })
    const card = (await returns.locator('.flow-return').first().boundingBox())!
    expect(Math.abs(card.width - body)).toBeLessThanOrEqual(1)
  }).toPass()
  // Поля карточек — крупные, как на макете, а не плотные поля окна правки
  await expect(returns.getByRole('textbox', { name: 'Условие возврата 1' })).toHaveCSS('padding', '11px 14px')
  await expect(returns.getByRole('textbox', { name: 'Условие возврата 1' })).toHaveCSS('font-size', '14px')
  // Между карточками 16px, как на макете; причина «не сохранить» — вровень с карточками, без отступа строк окна правки
  await returns.getByRole('button', { name: 'Добавить возврат' }).click()
  const error = returns.locator('.flow-step-error')
  await expect(error).toBeVisible()
  await expect(async () => {
    const [first, second] = [
      (await returns.locator('.flow-return').nth(0).boundingBox())!,
      (await returns.locator('.flow-return').nth(1).boundingBox())!,
    ]
    expect(Math.round(second.y - (first.y + first.height))).toBe(16)
    expect(Math.abs((await error.boundingBox())!.x - first.x)).toBeLessThanOrEqual(1)
  }).toPass()
  await expect(error).toHaveCSS('padding-left', '0px')
  await returns.getByRole('button', { name: 'Убрать возврат 2' }).click()
  await expect(error).toHaveCount(0)
  await expect(region.locator('.flow-arc-open')).toHaveCount(1)
  await returns.getByRole('textbox', { name: 'Условие возврата 1' }).fill('замечания оператора')
  const under = () => page.evaluate(() => Boolean(document.activeElement?.closest('.vc-head, .flow-canvas')))
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab')
    expect(await under()).toBe(false)
  }
  await returns.getByRole('textbox', { name: 'Условие возврата 1' }).focus()
  // С правкой Escape спрашивает; «Не сохранять» закрывает окно, фокус — на блоке
  await page.keyboard.press('Escape')
  await page.getByRole('alertdialog', { name: 'Закрыть без сохранения?' }).getByRole('button', { name: 'Не сохранять' }).click()
  await expect(returns).toHaveCount(0)
  await expect(block).toBeFocused()

  // С клавиатуры — Shift+F10 на блоке; «Править стадию» открывает окно правки, вкладка не меняется
  await page.keyboard.press('Shift+F10')
  await expect(menu).toBeVisible()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const stage = page.getByRole('dialog', { name: 'Этап «Приёмка»' })
  await expect(stage.getByRole('textbox', { name: 'Выход этапа' })).toHaveValue('ответ оператора «принято»')
  await expect(page.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  await expect(stage.getByText('Этап стоит в сценариях «полный» и «мелкий» — правка изменит его в обоих.')).toBeVisible()
  // Ничего не правили — «Отмена» закрывает окно без вопроса
  await stage.getByRole('button', { name: 'Отмена' }).click()
  await expect(stage).toHaveCount(0)
  await expect(block).toBeFocused()
})

test('возвраты блока подсвечены под мышью и под курсором клавиатуры, ведущие в него — нет', async ({ page }) => {
  // У «Ревью» возврат к «Критерию», у «Приёмки» — к «Ревью» и к «Критерию»
  await mockApi(page, [], {
    stages,
    flows: [
      {
        name: 'полный',
        when: 'новая возможность',
        entries: [
          { stage: 'Критерий', returns: [] },
          { stage: 'Ревью', returns: [{ condition: 'нет критерия', stage: 'Критерий' }] },
          {
            stage: 'Приёмка',
            returns: [
              { condition: 'замечания', stage: 'Ревью' },
              { condition: 'другое', stage: 'Критерий' },
            ],
          },
        ],
      },
    ],
  })
  const region = await openFlow(page)
  const labels = region.locator('.flow-arc-open .flow-arc-label')
  const review = region.getByRole('button', { name: /^Этап 2: Ревью/ })
  const acceptance = region.getByRole('button', { name: /^Этап 3: Приёмка/ })
  await expect(region.locator('.flow-arc')).toHaveCount(3)
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)

  // Мышь над «Приёмкой» — обе её дуги подписаны условием; увёл — погасли
  await acceptance.hover()
  await expect(labels).toHaveText(['замечания', 'другое'])
  await page.mouse.move(900, 40)
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)

  // Мышь над «Ревью» — только его дуга, возврат «Приёмки» в него приглушён
  await review.hover()
  await expect(labels).toHaveText(['нет критерия'])
  await page.mouse.move(900, 40)
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)

  // Tab ставит курсор клавиатуры на блок — его дуги подсвечены, ушёл дальше — погасли
  await region.getByRole('button', { name: 'Сценарий «полный»: название и «когда»' }).focus()
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect(region.getByRole('button', { name: 'Этап 1: Критерий' })).toBeFocused()
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)
  // Между блоками — кнопка «ниже» первой стадии: «выше» у неё погашена
  await page.keyboard.press('Tab')
  await expect(region.getByRole('button', { name: 'Этап 1 ниже' })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(review).toBeFocused()
  await expect(labels).toHaveText(['нет критерия'])
  await page.keyboard.press('Tab')
  await expect(review).not.toBeFocused()
  await expect(region.locator('.flow-arc-open')).toHaveCount(0)

  // Левый щелчок ставит курсор и ничего не открывает; мышь над другим блоком добавляет его дуги
  await review.click()
  await expect(review).toBeFocused()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await acceptance.hover()
  await expect(region.locator('.flow-arc-open')).toHaveCount(3)
  // Подсвеченные дуги нарисованы поверх приглушённых: последними в схеме
  await page.mouse.move(900, 40)
  await expect(region.locator('.flow-arc').last()).toHaveClass(/flow-arc-open/)
})

test('описание стадии из меню — оформленным текстом во весь рост; закрытое возвращает фокус блоку', async ({ page }) => {
  await mockApi(page)
  const region = await openFlow(page)
  const block = region.getByRole('button', { name: 'Этап 2: Ревью' })

  await block.click({ button: 'right' })
  await page.getByRole('menu').getByRole('menuitem', { name: 'Редактировать описание' }).click()
  const description = page.getByRole('dialog', { name: 'Описание этапа «Ревью»' })
  await expect(description.getByRole('listitem')).toHaveText('Собрать дифф.')
  await expect(description.getByText(/^Этап стоит в сценариях/)).toBeVisible()
  // Окно во весь рост, как окно задания исполнителя
  await expect(async () => {
    const height = (await description.boundingBox())!.height
    expect(height).toBeGreaterThan(page.viewportSize()!.height * 0.85)
  }).toPass()

  await description.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(description).toHaveCount(0)
  await expect(block).toBeFocused()
})

test('вкладка «Этапы»: стадии карточками по три в ряд, «Новый этап» последней, значок из списка значков', async ({
  page,
}) => {
  const calls = await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()

  const list = page.getByRole('list', { name: 'Этапы базы' })
  const cards = list.getByRole('button')
  await expect(cards).toHaveCount(4)
  await expect(cards.last()).toHaveText('Новый этап')
  await expect(cards.last()).toHaveCSS('border-top-style', 'dashed')
  // Три в ряд: первые три — одной строкой, четвёртая — под первой
  const boxes = await Promise.all([0, 1, 2, 3].map((i) => cards.nth(i).boundingBox()))
  expect(Math.abs(boxes[0]!.y - boxes[2]!.y)).toBeLessThan(2)
  expect(boxes[1]!.x).toBeGreaterThan(boxes[0]!.x + boxes[0]!.width)
  expect(Math.abs(boxes[3]!.x - boxes[0]!.x)).toBeLessThan(2)
  expect(boxes[3]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height)

  await cards.first().click()
  const edit = page.getByRole('dialog', { name: 'Этап «Критерий»' })
  // Правка — окном ограниченной ширины по центру, а не во всю ширину раздела; фокус — в названии
  await expect(edit.getByRole('textbox', { name: 'Название этапа' })).toBeFocused()
  const editBox = await edit.boundingBox()
  const viewport = page.viewportSize()!
  expect(editBox!.width).toBeLessThanOrEqual(800)
  expect(Math.abs(editBox!.x + editBox!.width / 2 - viewport.width / 2)).toBeLessThan(2)
  // Кнопка удаления в покое контурная, не красная заливка; у стадии во флоу она объясняет, почему не удалить
  const remove = edit.getByRole('button', { name: 'Удалить этап' })
  await expect(remove).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await remove.click()
  const note = edit.locator('.flow-delete-note')
  await expect(note).toContainText('Этап «Критерий» нельзя удалить.')
  // Пояснение — над подвалом окна, во всю его ширину за вычетом отступов
  const [noteBox, footBox] = await Promise.all([note.boundingBox(), edit.locator('.flow-stage-foot').boundingBox()])
  expect(noteBox!.y + noteBox!.height).toBeLessThanOrEqual(footBox!.y + 1)
  // «Отмена» без правок закрывает окно, фокус возвращается на карточку
  await edit.getByRole('button', { name: 'Отмена' }).click()
  await expect(edit).toHaveCount(0)
  await expect(cards.first()).toBeFocused()

  await list.getByRole('button', { name: /^Приёмка/ }).click()
  const acceptance = page.getByRole('dialog', { name: 'Этап «Приёмка»' })
  await acceptance.getByRole('textbox', { name: 'Пропуск этапа' }).fill('правка не меняет вида панели')
  await acceptance.getByRole('button', { name: 'Значок этапа' }).click()
  const icons = page.getByRole('group', { name: 'Значки этапа' })
  // В списке сами значки, а не их названия
  await expect(icons.getByRole('button')).toHaveCount(6)
  await expect(icons.getByRole('button', { name: 'Значок «проверка»' })).toHaveText('')
  await icons.getByRole('button', { name: 'Значок «проверка»' }).click()
  await expect(icons).toHaveCount(0)
  await acceptance.getByRole('button', { name: 'Сохранить' }).click()

  // Окно пишет стадию само и закрывается; сообщения о записи нет — замечание оператора к макету B-226
  await expect(acceptance).toHaveCount(0)
  await expect.poll(() => calls.flow.length).toBe(1)
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toHaveCount(0)
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

test('окно стадии: полосы внизу раздела нет, «Сохранить» погашена, пока стадию не записать, причина — в окне', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)

  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ }).click()
  const edit = page.getByRole('dialog', { name: 'Этап «Критерий»' })
  await expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await edit.getByRole('textbox', { name: 'Выход этапа' }).fill(' ')

  await expect(edit.getByText('Этап не сохранить: не указан выход.')).toBeVisible()
  await expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  await expect(page.locator('.save-bar')).toHaveCount(0)
  // «Отмена» и «Сохранить» — у правого края подвала, удаление — у левого
  const [remove, cancel, save] = await Promise.all(
    ['Удалить этап', 'Отмена', 'Сохранить'].map((name) => edit.getByRole('button', { name }).boundingBox()),
  )
  expect(remove!.x).toBeLessThan(cancel!.x)
  expect(cancel!.x).toBeLessThan(save!.x)
  expect(save!.x - (cancel!.x + cancel!.width)).toBeLessThan(20)
})

test('блок перетаскивается мышью, и перестановка пишется сразу', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  // Двигается «Ревью»: возврат «Приёмки» к нему по-прежнему ведёт назад, и флоу остаётся годным
  await region.getByRole('button', { name: 'Этап 2: Ревью' }).dragTo(region.getByRole('button', { name: 'Этап 1: Критерий' }))
  await expect(region.getByRole('button', { name: 'Этап 1: Ревью' })).toBeVisible()
  // Перетаскивание — не щелчок: меню блока не открывается
  await expect(page.getByRole('menu')).toHaveCount(0)

  await expect.poll(() => calls.flow.length).toBe(1)
  const sent = calls.flow[0] as { flows: Flow[] }
  expect(sent.flows[0].entries.map((entry) => entry.stage)).toEqual(['Ревью', 'Критерий', 'Приёмка'])
})

test('сценарий, по которому идут задачи: строка с номерами над схемой, у блоков нет ручки, и они не перетаскиваются', async ({ page }) => {
  const calls = await mockApi(page, [
    { task: 'B-7', flow: 'полный' },
    { task: 'B-9', flow: 'полный' },
  ])
  const region = await openFlow(page)

  const lock = page.locator('.flow-lock')
  await expect(lock).toHaveText('Правка сценария закрыта — по нему идут задачи B-7, B-9')
  // Строка — между верхом раздела и холстом, во всю его ширину
  const [lockBox, canvas] = await Promise.all([lock.boundingBox(), page.locator('.flow-canvas').boundingBox()])
  expect(lockBox!.y + lockBox!.height).toBeLessThanOrEqual(canvas!.y + 1)
  await expect(page.locator('.flow-task-tag')).toHaveCount(2)

  const block = region.getByRole('button', { name: 'Этап 2: Ревью' })
  await expect(block.locator('.flow-grip')).toBeHidden()
  await expect(block).toHaveAttribute('draggable', 'false')
  await block.dragTo(region.getByRole('button', { name: 'Этап 1: Критерий' }))
  await expect(region.getByRole('button', { name: 'Этап 2: Ревью' })).toBeVisible()
  expect(calls.flow).toHaveLength(0)

  // На вкладке «Этапы» — замок и номера на карточках занятых стадий
  await page.getByRole('tab', { name: 'Этапы' }).click()
  const card = page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ })
  await expect(card.locator('.flow-card-lock')).toHaveText('B-7, B-9')
  await expect(card.locator('.flow-card-lock svg')).toBeVisible()
})

test('раздел держится в экране: прокручивается схема, шапка и сайдбар стоят на месте', async ({ page }) => {
  await mockApi(page)
  await page.setViewportSize({ width: 1100, height: 600 })
  const region = await openFlow(page)
  await region.getByRole('button', { name: /^Сценарий «полный»/ }).click()

  const scroll = region.locator('.flow-scroll')
  await expect.poll(async () => scroll.evaluate((box) => box.scrollHeight > box.clientHeight)).toBe(true)
  await scroll.evaluate((box) => box.scrollTo(0, box.scrollHeight))

  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Ещё действия' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Сценарий: полный' })).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('complementary')).toBeInViewport({ ratio: 1 })
  await expect(page.getByRole('button', { name: 'Удалить сценарий' })).toBeInViewport({ ratio: 1 })
})

test('подвал сайдбара сценария — в одну строку: «Удалить сценарий» не переносится', async ({ page }) => {
  await mockApi(page)
  // Без въезда сбоку: сайдбар меряется там, где встал, а не на полпути
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const region = await openFlow(page)
  await region.getByRole('button', { name: /^Сценарий «полный»/ }).click()

  // Название сайдбара идёт за набранным названием сценария
  const drawer = page.getByRole('complementary', { name: /^Сценарий «полный/ })
  await expect(async () => {
    const [remove, cancel, save] = (
      await Promise.all(
        ['Удалить сценарий', 'Отмена', 'Сохранить'].map((name) => drawer.getByRole('button', { name }).boundingBox()),
      )
    ).map((box) => box!)
    const edge = (await drawer.boundingBox())!
    // Одна высота у всех трёх — надпись не ушла на вторую строку; один верх — кнопки стоят в ряд, не налезая
    // и не вылезая за край сайдбара
    expect(remove.x).toBeGreaterThanOrEqual(edge.x)
    expect(save.x + save.width).toBeLessThanOrEqual(edge.x + edge.width)
    expect(remove.height).toBe(save.height)
    expect(cancel.y).toBe(remove.y)
    expect(save.y).toBe(remove.y)
    expect(remove.x + remove.width).toBeLessThan(cancel.x)
    expect(cancel.x + cancel.width).toBeLessThan(save.x)
  }).toPass()

  // «Сохранение…» на время записи длиннее «Сохранить», но подвал за край не выводит
  let release = () => {}
  await page.route('**/api/flow', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback()
    await new Promise<void>((resolve) => (release = resolve))
    return route.fulfill({ json: { version: 'v2' } })
  })
  await drawer.getByRole('textbox', { name: 'Название сценария' }).fill('полный сценарий')
  await drawer.getByRole('button', { name: 'Сохранить' }).click()
  const saving = drawer.getByRole('button', { name: 'Сохранение…' })
  await expect(saving).toBeVisible()
  const edge = (await drawer.boundingBox())!
  const box = (await saving.boundingBox())!
  const remove = (await drawer.getByRole('button', { name: 'Удалить сценарий' }).boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width)
  expect(box.y).toBe(remove.y)
  release()
})

test('в узком окне подвал сайдбара сценария переносится, а не вылезает за край', async ({ page }) => {
  await mockApi(page)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  // Холст уже сайдбара: сайдбар сжимается по нему, а кнопкам подвала в ряд места нет
  await page.setViewportSize({ width: 480, height: 700 })
  const region = await openFlow(page)
  await region.getByRole('button', { name: /^Сценарий «полный»/ }).click()

  const drawer = page.getByRole('complementary', { name: 'Сценарий «полный»' })
  await expect(async () => {
    const edge = (await drawer.boundingBox())!
    expect(edge.width).toBeLessThan(470)
    for (const name of ['Удалить сценарий', 'Отмена', 'Сохранить']) {
      const box = (await drawer.getByRole('button', { name }).boundingBox())!
      expect(box.x).toBeGreaterThanOrEqual(edge.x)
      expect(box.x + box.width).toBeLessThanOrEqual(edge.x + edge.width)
    }
  }).toPass()
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно добавления в теме ${theme}: рамка соседних окон, стадии строками; стадия встаёт в конец флоу`, async ({
    page,
  }) => {
    await mockApi(page)
    await page.emulateMedia({ colorScheme: theme })
    await openFlow(page)
    await page.getByRole('button', { name: 'Сценарий: полный' }).click()
    await page.getByRole('option', { name: 'мелкий' }).click()
    const region = page.getByRole('region', { name: 'Сценарий «мелкий»' })

    await page.getByRole('button', { name: 'Добавить этап' }).click()
    const adding = page.getByRole('dialog', { name: 'Добавить этап в сценарий «мелкий»' })
    // Рамка окон правки стадии и возвратов: шапка с крестиком, подвал с «Отменой» (B-209)
    await expect(adding).toHaveClass(/modal-wizard/)
    await expect(adding.getByRole('heading', { name: 'Добавить этап' })).toBeVisible()
    await expect(adding.getByRole('button', { name: 'Закрыть' })).toBeVisible()
    await expect(adding.getByRole('button', { name: 'Отмена' })).toBeVisible()
    // Пресетов в окне больше нет (B-226)
    await expect(adding.getByRole('group', { name: 'Пресеты стадий' })).toHaveCount(0)
    // «Новый этап» — пунктирной строкой, стадии базы — карточками с рамкой
    const fresh = adding.getByRole('button', { name: 'Новый этап' })
    await expect(fresh).toHaveCSS('border-top-style', 'dashed')
    const own = adding.getByRole('group', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ })
    await expect(own).toHaveCSS('border-top-style', 'solid')
    await expect(own).not.toContainText('выход')
    // Список: строка во всю ширину окна под «Новым этапом», а не плитка сетки
    const [top, row] = await Promise.all([fresh.boundingBox(), own.boundingBox()])
    expect(row!.y).toBeGreaterThan(top!.y)
    expect(Math.abs(row!.width - top!.width)).toBeLessThan(2)
    // Цвет — из токенов темы: окно не сливается с подложкой, текст — с окном
    const [surface, text] = await Promise.all([
      adding.evaluate((el) => getComputedStyle(el).backgroundColor),
      own.evaluate((el) => getComputedStyle(el).color),
    ])
    expect(text).not.toBe(surface)
    // Плюс в шапке — одним кольцом: рамка значка карточки погашена
    await expect(adding.locator('.ask-title .flow-card-mark')).toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')
    // Значки своего размера: общее `.modal-overlay svg` их не перебивает
    await expect(async () => {
      expect(Math.round((await fresh.locator('svg').boundingBox())!.width)).toBe(18)
      expect(Math.round((await own.locator('.flow-card-mark svg').boundingBox())!.width)).toBe(15)
    }).toPass()
    await page.screenshot({ path: `test-results/flow-add-stage-${theme}.png` })

    await own.click()
    await expect(region.getByRole('button', { name: 'Этап 3: Критерий' })).toBeVisible()
    await expect(region.getByRole('button', { name: 'Этап 3: Критерий' })).toBeFocused()
  })
}

test('окно стадии возвращает фокус: к описанию — после его окна, к карточке — на вкладке «Этапы»', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()

  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Приёмка/ }).click()
  const stage = page.getByRole('dialog', { name: 'Этап «Приёмка»' })
  await stage.getByRole('button', { name: /Редактировать описание/ }).click()
  // Пустое описание открыто в правке: «Отмена» без набранного закрывает окно
  await page.getByRole('dialog', { name: /^Описание этапа/ }).getByRole('button', { name: 'Отмена' }).click()
  await expect(stage.getByRole('button', { name: /Редактировать описание/ })).toBeFocused()
  await stage.getByRole('button', { name: 'Отмена' }).click()
  await expect(stage).toHaveCount(0)
  await expect(page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Приёмка/ })).toBeFocused()
})

test('окно стадии накрывает и сайдбар разделов: его затемнение лежит поверх всей панели', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ }).click()
  await expect(page.getByRole('dialog', { name: 'Этап «Критерий»' })).toBeVisible()

  // Проявление раздела после загрузки не оставляет своего слоя отрисовки: иначе окно внутри раздела
  // уходило под сайдбар, и щелчок по разделу уводил из «Флоу» с несохранёнными правками (B-201).
  const box = (await page.locator('.sidebar').boundingBox())!
  await expect(async () => {
    const onTop = await page.evaluate(
      ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.modal-overlay')),
      [box.x + box.width / 2, box.y + box.height / 2],
    )
    expect(onTop).toBe(true)
  }).toPass()
})

test('окно стадии: Escape закрывает верхнее окно, под окнами Tab не проходит к разделу, значки своего размера', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ }).click()
  const stage = page.getByRole('dialog', { name: 'Этап «Критерий»' })

  // Значки в окне — своего размера, общее `.modal-overlay svg` их не перебивает
  for (const mark of [stage.locator('.ask-title .flow-card-mark svg'), stage.locator('.flow-icon-toggle .flow-node-mark svg')])
    await expect(async () => {
      const box = (await mark.boundingBox())!
      expect(Math.round(box.width)).toBe(15)
    }).toPass()

  // Под окном стадии Tab не попадает на вкладки, проект и карточки раздела
  await stage.getByRole('textbox', { name: 'Выход этапа' }).fill('критерий в памяти задачи')
  const under = () => page.evaluate(() => Boolean(document.activeElement?.closest('.vc-head, .flow-stage-grid')))
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    expect(await under()).toBe(false)
  }
  await stage.getByRole('textbox', { name: 'Выход этапа' }).focus()

  // Открытый список значков Escape закрывает первым
  await stage.getByRole('button', { name: 'Значок этапа' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('group', { name: 'Значки этапа' })).toHaveCount(0)
  await expect(stage).toBeVisible()

  // Поверх — окно описания: под ним окно стадии недоступно, Escape закрывает только описание
  await stage.getByRole('button', { name: /Редактировать описание/ }).click()
  const description = page.getByRole('dialog', { name: /^Описание этапа/ })
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press('Tab')
    expect(await stage.evaluate((el) => el.contains(document.activeElement))).toBe(false)
  }
  await description.getByRole('button', { name: 'Закрыть', exact: true }).focus()
  await page.keyboard.press('Escape')
  await expect(description).toHaveCount(0)
  await expect(stage).toBeVisible()

  // С правкой Escape спрашивает: вопрос встаёт поверх окна и держит фокус, его Escape — «Вернуться»
  await page.keyboard.press('Escape')
  const asked = page.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })
  await expect(asked).toBeVisible()
  await expect(asked.getByRole('button', { name: 'Не сохранять' })).toBeFocused()
  const box = (await asked.boundingBox())!
  const onTop = await page.evaluate(
    ([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.flow-confirm')),
    [box.x + box.width / 2, box.y + box.height / 2],
  )
  expect(onTop).toBe(true)
  await page.keyboard.press('Escape')
  await expect(asked).toHaveCount(0)
  await expect(stage).toBeVisible()
  await expect(stage.getByRole('textbox', { name: 'Выход этапа' })).toHaveValue('критерий в памяти задачи')

  await page.keyboard.press('Escape')
  await asked.getByRole('button', { name: 'Не сохранять' }).click()
  await expect(stage).toHaveCount(0)
})

test('описание стадии правится в окне по кнопке со вкладки «Этапы»', async ({ page }) => {
  const calls = await mockApi(page)
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Критерий/ }).click()

  const stage = page.getByRole('dialog', { name: 'Этап «Критерий»' })
  await stage.getByRole('button', { name: /Редактировать описание/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Описание этапа «Критерий»' })
  // Описание открыто оформленным текстом; править — по «Редактировать»
  await expect(dialog.getByRole('listitem')).toHaveText('Написать критерий.')
  await dialog.getByRole('button', { name: 'Редактировать' }).click()
  const text = dialog.getByRole('textbox', { name: 'Описание этапа' })
  await expect(text).toBeFocused()
  await expect(text).toHaveValue('1. Написать критерий.')

  // Описание свободным текстом: абзац, пустая строка, списки «-» и «1.»
  await text.press('ControlOrMeta+Home')
  await text.pressSequentially('Критерий пишется до кода.')
  await text.press('Enter')
  await text.press('Enter')
  await text.pressSequentially('- проверяемый;')
  await text.press('Enter')
  // «Сохранить» пишет описание сразу и возвращает к просмотру
  await dialog.getByRole('button', { name: 'Сохранить' }).click()
  await expect(dialog.getByText('Критерий пишется до кода.')).toBeVisible()
  await expect.poll(() => calls.flow.length).toBe(1)
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  await stage.getByRole('button', { name: 'Отмена' }).click()
  await expect(stage).toHaveCount(0)
  expect((calls.flow[0] as { stages: Stage[] }).stages[0].description).toBe(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. Написать критерий.',
  )
})

test('исполнитель, которого нет в базе, помечен на схеме и в стадии, и флоу не сохранить', async ({ page }) => {
  await mockApi(page, [], { stages: [stages[0], { ...stages[1], executor: 'doc-writer' }, stages[2]], flows })
  const region = await openFlow(page)

  const review = region.getByRole('button', { name: 'Этап 2: Ревью' })
  await expect(review.locator('.flow-node-missing')).toBeVisible()
  await expect(page.getByText(/Не сохранить: этап «Ревью»/)).toContainText('исполнителя нет в базе')

  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Ревью/ }).click()
  const edit = page.getByRole('dialog', { name: 'Этап «Ревью»' })
  await expect(edit.getByRole('status')).toContainText('Выберите исполнителя из заведённых')
  // Имя руками не вписывается: в списке только заведённые в базе
  await edit.getByLabel('Имя субагента').selectOption('reviewer')
  await expect(page.getByText(/Не сохранить/)).toHaveCount(0)
})

test('проект без стадий и сценариев — вкладки на месте, пустое состояние по центру своей вкладки', async ({ page }) => {
  await mockApi(page)
  await openFlow(page)

  await page.getByRole('button', { name: 'Проект: Agents Kit Web' }).click()
  await page.getByRole('listbox', { name: 'Проект' }).getByRole('option', { name: 'Nota' }).click()

  const heading = page.getByRole('heading', { name: 'В этом проекте нет сценариев' })
  await expect(heading).toBeVisible()
  await expect(page.getByRole('tab')).toHaveText(['Этапы', 'Сценарии'])
  await expect(page.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  // По центру раздела под строкой заголовка; замер — до совпадения: шрифт грузится после первой отрисовки
  const centered = () =>
    expect(async () => {
      const empty = await page.locator('.flow-empty').boundingBox()
      const main = await page.getByRole('main').boundingBox()
      const box = await page.locator('.flow-empty h3').boundingBox()
      expect(Math.abs(box!.x + box!.width / 2 - (main!.x + main!.width / 2))).toBeLessThan(2)
      expect(Math.abs(empty!.y + empty!.height - (main!.y + main!.height))).toBeLessThan(2)
    }).toPass()
  await centered()
  await expect(page.locator('.flow-empty').getByRole('button')).toHaveText(['Создать первый сценарий'])

  await page.getByRole('tab', { name: 'Этапы' }).click()
  await expect(page.getByRole('heading', { name: 'В этом проекте нет этапов' })).toBeVisible()
  await centered()
  await expect(page.locator('.flow-empty').getByRole('button')).toHaveText(['Создать первый этап'])

  await page.getByRole('tab', { name: 'Сценарии' }).click()
  // Пустой сценарий кит не примет: «Создать первый сценарий» открывает окно, а без стадий записать нечего
  await page.getByRole('button', { name: 'Создать первый сценарий' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новый сценарий' })
  await expect(dialog.getByText(/В проекте нет этапов. Заведите первый на вкладке «Этапы»/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('в сайдбаре сценария название набирается целиком: правка запирает схему, но не сам сайдбар', async ({ page }) => {
  await mockApi(page)
  const region = await openFlow(page)
  await region.getByRole('button', { name: 'Сценарий «полный»: название и «когда»' }).click()
  const drawer = page.getByRole('complementary')
  const name = drawer.getByRole('textbox', { name: 'Название сценария' })

  await name.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' большой')

  await expect(name).toHaveValue('полный большой')
  await expect(name).toBeFocused()
  await expect(drawer.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  // Схема и «Новый сценарий» доступны, но первый щелчок лишь спрашивает, закрыть ли сайдбар с правкой
  await page.getByRole('button', { name: 'Новый сценарий' }).click()
  await expect(page.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })).toBeVisible()
  await expect(page.getByRole('dialog', { name: 'Новый сценарий' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Вернуться' }).click()
  await name.focus()

  // Под вопросом о несохранённом заперт и сайдбар; «Вернуться» отдаёт фокус полю, где набирали
  await page.keyboard.press('Escape')
  const asked = page.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })
  await expect(asked).toBeVisible()
  expect(await drawer.evaluate((el) => el.closest('[inert]') !== null)).toBe(true)
  await asked.getByRole('button', { name: 'Вернуться' }).click()
  await expect(name).toBeFocused()
  await expect(name).toHaveValue('полный большой')
})

test('кнопка «Удалить» в вопросе при наведении остаётся красной заливкой', async ({ page }) => {
  // Стадия вне сценариев: её можно удалить
  await mockApi(page, [], { stages: [...stages, { ...stages[2], title: 'Запас', slug: 'spare' }], flows })
  await openFlow(page)
  await page.getByRole('tab', { name: 'Этапы' }).click()
  await page.getByRole('list', { name: 'Этапы базы' }).getByRole('button', { name: /^Запас/ }).click()
  await page.getByRole('dialog', { name: 'Этап «Запас»' }).getByRole('button', { name: 'Удалить этап' }).click()
  const remove = page.getByRole('alertdialog', { name: 'Удалить этап «Запас»?' }).getByRole('button', { name: 'Удалить' })

  const rest = await remove.evaluate((el) => getComputedStyle(el).backgroundColor)
  await remove.hover()
  await expect(remove).toHaveCSS('background-color', rest)
})

test('при правке в сайдбаре ни клавиатура, ни перетаскивание на схеме не пишут: сначала вопрос о сайдбаре', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)
  await region.getByRole('button', { name: 'Сценарий «полный»: название и «когда»' }).click()
  const drawer = page.getByRole('complementary')
  await drawer.getByRole('textbox', { name: 'Когда брать сценарий' }).fill('крупная правка')
  const asked = page.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })

  // Enter на «выше»
  await region.getByRole('button', { name: 'Этап 3 выше' }).focus()
  await page.keyboard.press('Enter')
  await expect(asked).toBeVisible()
  await asked.getByRole('button', { name: 'Вернуться' }).click()

  // Shift+F10 на блоке — меню блока не открывается
  await region.getByRole('button', { name: 'Этап 2: Ревью' }).focus()
  await page.keyboard.press('Shift+F10')
  await expect(asked).toBeVisible()
  await expect(page.getByRole('menu')).toHaveCount(0)
  await asked.getByRole('button', { name: 'Вернуться' }).click()

  // Перетаскивание
  await region.getByRole('button', { name: 'Этап 2: Ревью' }).dragTo(region.getByRole('button', { name: 'Этап 1: Критерий' }))
  await expect(asked).toBeVisible()
  await asked.getByRole('button', { name: 'Вернуться' }).click()

  await expect(region.getByRole('button', { name: 'Этап 1: Критерий' })).toBeVisible()
  expect(calls.flow).toHaveLength(0)
  await expect(drawer.getByRole('textbox', { name: 'Когда брать сценарий' })).toHaveValue('крупная правка')
})

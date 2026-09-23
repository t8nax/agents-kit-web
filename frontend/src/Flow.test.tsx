import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Flow, { type BaseFlow, type FlowStage, type NamedFlow } from './Flow'

afterEach(() => vi.unstubAllGlobals())

const criterion: FlowStage = {
  title: 'Критерий',
  executor: 'оркестратор',
  output: 'критерий закрытия в памяти',
  skip: null,
  description: '- Написать критерий до первой строчки кода.',
  helpers: [],
  slug: 'criterion',
}
const review: FlowStage = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha',
  skip: 'правка только в текстах',
  description: '1. Собрать дифф всей ветки.',
  helpers: [],
  slug: 'review',
}
const acceptance: FlowStage = {
  title: 'Приёмка',
  executor: 'оператор',
  output: 'ответ оператора «принято»',
  skip: null,
  description: null,
  helpers: [],
  slug: 'acceptance',
}
// Стадия базы, которая не стоит ни в одном флоу: кит её допускает, и видна она на вкладке «Стадии».
const spare: FlowStage = {
  title: 'Запас',
  executor: 'оператор',
  output: 'ничего',
  skip: null,
  description: null,
  helpers: [],
  slug: 'spare',
}

const full: NamedFlow = {
  name: 'полный',
  when: 'новая возможность',
  entries: [{ stage: 'Критерий' }, { stage: 'Ревью' }, { stage: 'Приёмка', returns: [] }],
}
const small: NamedFlow = {
  name: 'мелкий',
  when: 'правка в одном месте',
  entries: [{ stage: 'Ревью', returns: [] }, { stage: 'Приёмка', returns: [{ condition: 'замечания', stage: 'Ревью' }] }],
}

const app: BaseFlow = {
  base: 'D:\\Projects\\app-knowledge',
  project: 'Agents Kit Web',
  stages: [criterion, review, acceptance, spare],
  flows: [full, small],
  version: 'v1',
  error: null,
  icons: { Критерий: 'target' },
}
const nota: BaseFlow = {
  base: 'D:\\Projects\\nota-knowledge',
  project: 'Nota',
  stages: [],
  flows: [],
  version: 'v2',
  error: null,
  icons: {},
}

type Handler = (init?: RequestInit) => Response

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    const handler = handlers[key]
    if (!handler) throw new Error(`Нет обработчика ${key}`)
    return Promise.resolve(handler(init))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

/**
 * Заведённые в базе проекта исполнители: ровно из них стадии выбирают субагента. Имя во флоу и имя
 * в списке — одно и то же, поэтому сверяются они напрямую.
 */
const performers = (names: string[]) => [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    directory: 'D:\\Projects\\app-knowledge\\agents',
    performers: names.map((name) => ({
      name,
      description: null,
      model: null,
      tools: null,
      prompt: '',
      path: `D:\\Projects\\app-knowledge\\agents\\${name}.md`,
    })),
    error: null,
  },
]

const api = (flows: BaseFlow[], extra: Record<string, Handler> = {}) => ({
  'GET /api/flow': () => json(flows),
  // Флоу, зовущий незаведённого исполнителя, не сохраняется — поэтому по умолчанию заведены все, кого зовут стадии.
  'GET /api/performers': () => json(performers(['reviewer', 'scout', 'check-runner', 'e2e-runner'])),
  ...extra,
})

const saved = () => ({ 'POST /api/flow': () => json({ version: 'v3' }) })

/** Тело последнего такого запроса: каждое действие на схеме пишет флоу своей записью. */
const body = (fetchMock: ReturnType<typeof stubApi>, key: string) => {
  const call = fetchMock.mock.calls.findLast(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
  return call ? JSON.parse(String(call[1]?.body)) : undefined
}

const posts = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls.filter(([url, init]) => url === '/api/flow' && init?.method === 'POST').length

/** Запись кончилась и флоу перечитан: раздел больше не занят и снова принимает действия. */
const settled = () => vi.waitFor(() => expect(document.querySelector('[aria-busy="true"]')).toBeNull())

/** Раздел открывается вкладкой «Флоу» на первом флоу базы. */
async function renderFlow(props: { onPerformers?: () => void } = {}, flowName = 'полный') {
  render(<Flow {...props} />)
  const region = within(await screen.findByRole('region', { name: `Сценарий «${flowName}»` }))
  return region
}

/** Сайдбар сценария: открывается кликом по узлу старта схемы. */
async function open(region: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.click(region.getByRole('button', { name }))
  return within(await screen.findByRole('complementary'))
}

/** Меню блока стадии: открывается правым щелчком по блоку схемы (B-202). */
function menuOf(region: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.contextMenu(region.getByRole('button', { name }), { clientX: 120, clientY: 80 })
  return within(screen.getByRole('menu', { name: /^Стадия «/ }))
}

/** Окно возвратов стадии — пунктом «Возвраты» её меню. */
async function returnsOf(region: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.click(menuOf(region, name).getByRole('menuitem', { name: 'Возвраты' }))
  return within(await screen.findByRole('dialog', { name: /^Возвраты стадии «/ }))
}

const items = (menu: ReturnType<typeof within>) => menu.getAllByRole('menuitem').map((item: HTMLElement) => item.textContent)

/** Вкладка «Стадии» с открытым окном правки стадии. */
async function stagesTab(title?: string) {
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  const list = within(screen.getByRole('list', { name: 'Стадии базы' }))
  // Правка открывается окном по щелчку на карточке; без названия — первая карточка.
  fireEvent.click(title ? list.getByRole('button', { name: new RegExp(`^${title}`) }) : list.getAllByRole('button')[0])
  return within(await screen.findByRole('dialog', { name: title ? `Стадия «${title}»` : /^Стадия «/ }))
}

/** Пункт меню «…» шапки: редкие действия раздела живут в нём, меню открывается по требованию. */
function moreItem(name: string) {
  const more = screen.getByRole('button', { name: 'Ещё действия' })
  if (more.getAttribute('aria-expanded') !== 'true') fireEvent.click(more)
  return screen.getByRole('menuitem', { name })
}

const nodes = (region: ReturnType<typeof within>): HTMLElement[] =>
  region
    .getAllByRole('button')
    .filter(
      (button: HTMLElement) =>
        button.classList.contains('flow-node') && !button.classList.contains('flow-node-add'),
    )

const labels = (region: ReturnType<typeof within>) => nodes(region).map((node) => node.getAttribute('aria-label'))

/**
 * Запись: у открытого окна или сайдбара — его «Сохранить», действие на схеме пишется само (B-226). Ждёт, пока
 * запись ушла и окно закрылось, и отдаёт её тело.
 */
async function saveAndRead(fetchMock: ReturnType<typeof stubApi>) {
  const before = posts(fetchMock)
  const window =
    screen.queryByRole('dialog', { name: /^(Стадия|Возвраты стадии) «|^Новый сценарий$/ }) ??
    screen.queryByRole('complementary')
  if (window) fireEvent.click(within(window).getByRole('button', { name: 'Сохранить' }))
  await vi.waitFor(() => expect(posts(fetchMock)).toBeGreaterThan(window ? before : 0))
  if (window?.getAttribute('role') === 'dialog') await vi.waitFor(() => expect(window).not.toBeInTheDocument())
  // Запись кончилась, флоу перечитан: раздел снова принимает действия
  await settled()
  return body(fetchMock, 'POST /api/flow')
}

test('верх раздела: заголовок, за ним справа вкладки «Стадии» и «Сценарии», проект и «…»', async () => {
  stubApi(api([app, nota]))

  await renderFlow()

  const head = screen.getByRole('heading', { name: 'Флоу', level: 2 }).parentElement!
  const order = [
    screen.getByRole('heading', { name: 'Флоу', level: 2 }),
    screen.getByRole('tablist', { name: 'Части флоу' }),
    screen.getByRole('button', { name: /^Проект/ }),
    screen.getByRole('button', { name: 'Ещё действия' }),
  ]
  order.forEach((element) => expect(head).toContainElement(element))
  order.slice(1).forEach((element, i) =>
    expect(order[i].compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(),
  )
  expect(within(screen.getByRole('tablist')).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Стадии', 'Сценарии'])
})

test('пока флоу читается, на месте схемы заготовка, а заголовок и «…» уже видны', async () => {
  const handlers: Record<string, Handler> = api([app, nota])
  let answer: () => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) =>
      input === '/api/flow'
        ? new Promise<Response>((resolve) => (answer = () => resolve(handlers['GET /api/flow']())))
        : Promise.resolve(handlers[`GET ${input}`]()),
    ),
  )

  render(<Flow />)

  expect(screen.getByRole('status', { name: 'Загрузка флоу' })).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByText(/Загрузка/)).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Флоу', level: 2 })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Ещё действия' })).toBeInTheDocument()

  answer()

  expect(await screen.findByRole('region', { name: 'Сценарий «полный»' })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: 'Загрузка флоу' })).not.toBeInTheDocument()
})

test('вкладка «Флоу»: узел старта с именем флоу и стадии блоками — значок, название и исполнитель, без номера', async () => {
  stubApi(api([app, nota]))

  const region = await renderFlow()

  expect(screen.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  expect(region.getByRole('button', { name: 'Сценарий «полный»: название и «когда»' })).toHaveTextContent('полный')
  const stages = nodes(region)
  expect(labels(region)).toEqual(['Стадия 1: Критерий', 'Стадия 2: Ревью', 'Стадия 3: Приёмка'])
  expect(within(stages[1]).getByText('субагент reviewer')).toBeInTheDocument()
  expect(stages[0]).toHaveTextContent(/^Критерий/)
  expect(region.queryByText('вердикт по sha')).not.toBeInTheDocument()
  // Флажок стоит у стадии с условием пропуска
  expect(stages[1].querySelector('.flow-node-skip')).not.toBeNull()
  expect(stages[0].querySelector('.flow-node-skip')).toBeNull()
  expect(stages[2].querySelector('.flow-mark-operator')).not.toBeNull()
  // Сохранять нечего — полосы сохранения нет
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
})

test('флоу выбирается списком в углу холста: в списке только названия', async () => {
  stubApi(api([app]))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  const list = within(screen.getByRole('listbox', { name: 'Сценарий' }))
  expect(list.getAllByRole('option').map((option) => option.textContent)).toEqual(['полный', 'мелкий'])
  expect(list.getByRole('option', { name: 'полный' })).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(list.getByRole('option', { name: 'мелкий' }))

  const region = within(screen.getByRole('region', { name: 'Сценарий «мелкий»' }))
  expect(labels(region)).toEqual(['Стадия 1: Ревью', 'Стадия 2: Приёмка, возврат к стадии Ревью'])
})

test('узел старта открывает сайдбар флоу: название и «когда» правятся, флоу удаляется', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()

  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')
  expect(drawer.getByRole('textbox', { name: 'Название сценария' })).toHaveValue('полный')
  expect(drawer.getByRole('textbox', { name: 'Когда брать сценарий' })).toHaveValue('новая возможность')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'большой' } })
  fireEvent.change(drawer.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'правка в нескольких местах' } })

  expect(screen.getByRole('region', { name: 'Сценарий «большой»' })).toBeInTheDocument()
  // Правка в сайдбаре сама не пишется: её записывает «Сохранить» сайдбара, полосы внизу раздела нет (B-226)
  expect(posts(fetchMock)).toBe(0)
  expect(screen.queryByText('есть несохранённые правки')).not.toBeInTheDocument()
  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[0]).toMatchObject({ name: 'большой', when: 'правка в нескольких местах' })

  // Удаление спрашивает с названием и пишется сразу
  fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Удалить сценарий' }))
  const asked = within(screen.getByRole('alertdialog', { name: 'Удалить сценарий «большой»?' }))
  fireEvent.click(asked.getByRole('button', { name: 'Удалить' }))
  expect(await screen.findByRole('region', { name: 'Сценарий «мелкий»' })).toBeInTheDocument()
  expect(posts(fetchMock)).toBe(2)
  expect(body(fetchMock, 'POST /api/flow').flows.map((f: NamedFlow) => f.name)).toEqual(['мелкий'])
})

test('закрыть сайдбар с несохранённым можно только через вопрос; «Вернуться» оставляет правку', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'большой' } })

  fireEvent.click(drawer.getByRole('button', { name: 'Закрыть сайдбар' }))
  const asked = within(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' }))
  expect(asked.getByText('Изменения сценария «большой» не будут сохранены.')).toBeInTheDocument()
  fireEvent.click(asked.getByRole('button', { name: 'Вернуться' }))
  expect(drawer.getByRole('textbox', { name: 'Название сценария' })).toHaveValue('большой')

  fireEvent.click(drawer.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Сценарий «полный»' })).toBeInTheDocument()
  expect(posts(fetchMock)).toBe(0)
})

test('новый сценарий заводится окном с названием, «когда» и первой стадией и пишется его «Сохранить»', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))

  // Пустого сценария на схеме нет: кит его не примет (B-226)
  const dialog = within(screen.getByRole('dialog', { name: 'Новый сценарий' }))
  expect(screen.getByRole('region', { name: 'Сценарий «полный»' })).toBeInTheDocument()
  expect(dialog.getByRole('textbox', { name: 'Когда брать сценарий' })).toHaveAttribute('placeholder', 'какие задачи вести этим сценарием')
  expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  const first = within(dialog.getByRole('radiogroup', { name: 'Первая стадия' }))
  expect(first.getAllByRole('radio')).toHaveLength(4)

  fireEvent.change(dialog.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'срочный' } })
  expect(dialog.getByText(/Сценарий не сохранить: не указано «когда», не выбрана первая стадия/)).toBeInTheDocument()
  fireEvent.change(dialog.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'ошибка на панели' } })
  fireEvent.click(first.getByRole('radio', { name: /Запас/ }))

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows.at(-1)).toEqual({ name: 'срочный', when: 'ошибка на панели', entries: [{ stage: 'Запас', returns: [] }] })
  // Записанный сценарий открыт на схеме
  expect(await screen.findByRole('region', { name: 'Сценарий «срочный»' })).toBeInTheDocument()
})

test('при двух сценариях у каждого нужно «когда»: окно нового сценария называет прежний без него', async () => {
  stubApi(api([{ ...app, flows: [{ ...full, when: null }] }]))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Новый сценарий' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'срочный' } })
  expect(dialog.getByText(/у сценария «полный» не указано «когда»/)).toBeInTheDocument()

  // Закрыть с набранным — через вопрос
  fireEvent.keyDown(screen.getByRole('dialog', { name: 'Новый сценарий' }), { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  expect(screen.queryByRole('dialog', { name: 'Новый сценарий' })).not.toBeInTheDocument()
})

test('левый щелчок по блоку стадии ничего не открывает, правый открывает у курсора меню её правки', async () => {
  stubApi(api([app]))
  const region = await renderFlow()
  const block = region.getByRole('button', { name: 'Стадия 2: Ревью' })

  // Сайдбара стадии нет, а меню — только по правому щелчку: левый щелчок ничего не открывает — решение
  // оператора на приёмке. Enter и пробел, которые нажимают кнопку, проверяет e2e: jsdom щелчка из них не делает
  for (const detail of [1, 0]) {
    fireEvent.click(block, { clientX: 50, clientY: 60, detail })
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  }

  const menu = menuOf(region, 'Стадия 2: Ревью')
  expect(screen.getByRole('menu')).toHaveAccessibleName('Стадия «Ревью»')
  expect(items(menu)).toEqual(['Возвраты', 'Править стадию «Ревью»', 'Редактировать описание', 'Убрать из сценария'])
  // «Убрать из сценария» — за чертой
  expect(menu.getByRole('separator')).toBeInTheDocument()
  expect(block).toHaveAttribute('aria-expanded', 'true')
  // Меню встаёт у курсора
  expect(screen.getByRole('menu')).toHaveStyle({ left: '120px', top: '80px' })

  // Фокус — на первом пункте, стрелки ходят по пунктам по кругу
  expect(menu.getByRole('menuitem', { name: 'Возвраты' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' })
  expect(menu.getByRole('menuitem', { name: 'Править стадию «Ревью»' })).toHaveFocus()
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  fireEvent.keyDown(document.activeElement!, { key: 'ArrowUp' })
  expect(menu.getByRole('menuitem', { name: 'Убрать из сценария' })).toHaveFocus()

  // Escape закрывает меню и возвращает фокус блоку
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(block).toHaveFocus()
  expect(block).toHaveAttribute('aria-expanded', 'false')
})

test('с клавиатуры меню блока открывается Shift+F10 и клавишей меню, закрывается Tab и щелчком мимо', async () => {
  stubApi(api([app]))
  const region = await renderFlow()
  const block = region.getByRole('button', { name: 'Стадия 1: Критерий' })

  fireEvent.keyDown(block, { key: 'F10', shiftKey: true })
  expect(screen.getByRole('menu', { name: 'Стадия «Критерий»' })).toBeInTheDocument()
  // Браузер следом шлёт contextmenu: меню остаётся там, где встало
  fireEvent.contextMenu(block, { clientX: 300, clientY: 300 })
  expect(screen.getByRole('menu')).not.toHaveStyle({ left: '300px' })
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()

  // Нажатие на сам блок с открытым меню тоже закрывает его, а правый щелчок по соседнему открывает меню соседа
  menuOf(region, 'Стадия 1: Критерий')
  fireEvent.mouseDown(block)
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  menuOf(region, 'Стадия 1: Критерий')
  fireEvent.mouseDown(region.getByRole('button', { name: 'Стадия 2: Ревью' }))
  menuOf(region, 'Стадия 2: Ревью')
  expect(screen.getAllByRole('menu')).toHaveLength(1)
  expect(screen.getByRole('menu')).toHaveAccessibleName('Стадия «Ревью»')

  fireEvent.keyDown(block, { key: 'ContextMenu' })
  expect(screen.getByRole('menu', { name: 'Стадия «Критерий»' })).toBeInTheDocument()
  fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
  expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  expect(block).toHaveFocus()
})

test('у первой стадии сценария пункт «Возвраты» приглушён: вернуться ей некуда', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  const first = menuOf(region, 'Стадия 1: Критерий')
  expect(first.getByRole('menuitem', { name: 'Возвраты' })).toBeDisabled()
  // Правка стадии остаётся, и фокус встаёт на неё, минуя приглушённый пункт
  expect(first.getByRole('menuitem', { name: 'Править стадию «Критерий»' })).toHaveFocus()
})

test('возврат из файла у первой стадии виден в окне возвратов: его можно убрать, и флоу снова сохраняется', async () => {
  stubApi(
    api([{ ...app, flows: [{ ...full, entries: [{ stage: 'Критерий', returns: [{ condition: 'заново', stage: 'Приёмка' }] }, ...full.entries.slice(1)] }] }]),
  )
  const region = await renderFlow()
  expect(screen.getByText(/Не сохранить: флоу «полный», стадия «Критерий»/)).toBeInTheDocument()

  const first = await returnsOf(region, /^Стадия 1: Критерий/)
  expect(first.getByRole('textbox', { name: 'Условие возврата 1' })).toHaveValue('заново')
  // Добавить новый некуда, а убрать тот, что в файле, — можно
  expect(first.queryByRole('button', { name: 'Добавить возврат' })).not.toBeInTheDocument()
  fireEvent.click(first.getByRole('button', { name: 'Убрать возврат 1' }))
  expect(first.queryByRole('textbox', { name: 'Условие возврата 1' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('пункт «Возвраты» следует за местом стадии: гаснет, когда она встала первой, и загорается снова', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  expect(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Возвраты' })).toBeEnabled()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

  fireEvent.click(region.getByRole('button', { name: 'Стадия 2 выше' }))
  expect(menuOf(region, 'Стадия 1: Ревью').getByRole('menuitem', { name: 'Возвраты' })).toBeDisabled()
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })

  fireEvent.click(region.getByRole('button', { name: 'Стадия 1 ниже' }))
  expect(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Возвраты' })).toBeEnabled()
})

test('возвраты правятся окном поверх схемы и пишутся его «Сохранить»; фокус — на блоке', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()

  const dialog = await returnsOf(region, 'Стадия 2: Ревью')
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Возвраты стадии «Ревью»')
  expect(dialog.getByText('сценарий «полный»')).toBeInTheDocument()
  // Вкладка не меняется, а полей самой стадии в окне нет
  expect(screen.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  expect(dialog.queryByRole('textbox', { name: 'Выход стадии' })).not.toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: 'Добавить возврат' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Условие возврата 1' }), { target: { value: 'не то' } })
  const target = dialog.getByRole('combobox', { name: 'Стадия возврата 1' })
  fireEvent.change(target, {
    target: { value: within(target).getByRole('option', { name: 'Критерий' }).getAttribute('value') },
  })
  expect(posts(fetchMock)).toBe(0)

  expect((await saveAndRead(fetchMock)).flows[0].entries[1].returns).toEqual([{ condition: 'не то', stage: 'Критерий' }])
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(region.getByRole('button', { name: 'Стадия 2: Ревью, возврат к стадии Критерий' })).toHaveFocus()

  // Escape с несохранённым спрашивает; «Не сохранять» закрывает окно без записи
  const again = await returnsOf(region, /^Стадия 2: Ревью/)
  fireEvent.change(again.getByRole('textbox', { name: 'Условие возврата 1' }), { target: { value: 'иначе' } })
  fireEvent.keyDown(again.getByRole('textbox', { name: 'Условие возврата 1' }), { key: 'Escape' })
  const asked = within(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' }))
  expect(asked.getByText('Изменения возвратов стадии «Ревью» не будут сохранены.')).toBeInTheDocument()
  fireEvent.click(asked.getByRole('button', { name: 'Не сохранять' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(posts(fetchMock)).toBe(1)
})

test('«Править стадию» из меню открывает окно правки поверх сценария, не уходя на вкладку «Стадии»', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()

  fireEvent.click(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Править стадию «Ревью»' }))

  const dialog = within(await screen.findByRole('dialog', { name: 'Стадия «Ревью»' }))
  expect(screen.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  // Ревью стоит и в «мелком»: окно говорит, что правка заденет оба сценария
  expect(dialog.getByText('Стадия стоит в сценариях «полный» и «мелкий» — правка изменит её в обоих.')).toBeInTheDocument()
  fireEvent.change(dialog.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  expect((await saveAndRead(fetchMock)).stages[1].output).toBe('вердикт')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(region.getByRole('button', { name: 'Стадия 2: Ревью' })).toHaveFocus()

  // Стадия одного сценария задевает только его — предупреждения нет
  fireEvent.click(menuOf(region, 'Стадия 1: Критерий').getByRole('menuitem', { name: 'Править стадию «Критерий»' }))
  const single = within(await screen.findByRole('dialog', { name: 'Стадия «Критерий»' }))
  expect(single.queryByText(/Стадия стоит в сценариях/)).not.toBeInTheDocument()
})

test('предупреждение называет все сценарии, где стоит стадия', async () => {
  const third: NamedFlow = { name: 'срочный', when: 'горит', entries: [{ stage: 'Ревью', returns: [] }] }
  stubApi(api([{ ...app, flows: [full, small, third] }]))
  const region = await renderFlow()

  fireEvent.click(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Редактировать описание' }))

  const dialog = within(await screen.findByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  expect(
    dialog.getByText('Стадия стоит в сценариях «полный», «мелкий» и «срочный» — правка изменит её во всех трёх.'),
  ).toBeInTheDocument()
})

test('описание стадии открывается из меню поверх сценария с предупреждением, закрытое — возвращает фокус блоку', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  fireEvent.click(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Редактировать описание' }))

  const dialog = within(await screen.findByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  expect(screen.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  expect(dialog.getByText('Стадия стоит в сценариях «полный» и «мелкий» — правка изменит её в обоих.')).toBeInTheDocument()
  // Окна правки стадии под описанием нет
  expect(screen.queryByRole('dialog', { name: 'Стадия «Ревью»' })).not.toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(region.getByRole('button', { name: 'Стадия 2: Ревью' })).toHaveFocus()
})

test('возвращённый блоку фокус не прыгает на него снова, когда вкладку «Сценарии» открыли заново', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  menuOf(region, 'Стадия 2: Ревью')
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(region.getByRole('button', { name: 'Стадия 2: Ревью' })).toHaveFocus()
  ;(document.activeElement as HTMLElement).blur()

  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  const again = within(screen.getByRole('region', { name: 'Сценарий «полный»' }))
  expect(again.getByRole('button', { name: 'Стадия 2: Ревью' })).not.toHaveFocus()
})

test('Escape в правке описания спрашивает, бросить ли набранное, и закрывает окно без записи', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()

  // У Приёмки описания нет — окно открыто сразу в правке
  fireEvent.click(menuOf(region, 'Стадия 3: Приёмка').getByRole('menuitem', { name: 'Редактировать описание' }))
  const text = await screen.findByRole('textbox', { name: 'Описание стадии' })
  fireEvent.change(text, { target: { value: 'черновик' } })
  fireEvent.keyDown(text, { key: 'Escape' })

  const asked = within(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' }))
  expect(asked.getByText('Изменения описания стадии «Приёмка» не будут сохранены.')).toBeInTheDocument()
  fireEvent.click(asked.getByRole('button', { name: 'Не сохранять' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(posts(fetchMock)).toBe(0)
  expect(region.getByRole('button', { name: 'Стадия 3: Приёмка' })).toHaveFocus()
})

test('возврат правится у стадии в своём флоу: цель — только стадии этого флоу, стоящие раньше', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  const drawer = await returnsOf(region, 'Стадия 3: Приёмка')

  fireEvent.click(drawer.getByRole('button', { name: 'Добавить возврат' }))
  fireEvent.change(drawer.getByRole('textbox', { name: 'Условие возврата 1' }), { target: { value: 'есть замечания' } })
  const target = drawer.getByRole('combobox', { name: 'Стадия возврата 1' })
  expect(within(target).getAllByRole('option').map((option) => option.textContent)).toEqual([
    'стадия…',
    'Критерий',
    'Ревью',
  ])
  fireEvent.change(target, {
    target: { value: within(target).getByRole('option', { name: 'Критерий' }).getAttribute('value') },
  })

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[0].entries[2].returns).toEqual([{ condition: 'есть замечания', stage: 'Критерий' }])
  // У той же стадии во флоу «мелкий» возврат свой и не тронут
  expect(sent.flows[1].entries[1].returns).toEqual([{ condition: 'замечания', stage: 'Ревью' }])
})

test('возврат без цели не даёт сохранить флоу, и сказано, где чинить', async () => {
  stubApi(api([{ ...app, flows: [{ ...full, entries: [...full.entries.slice(0, 2), { stage: 'Приёмка', returns: [{ condition: 'замечания', stage: 'Сборка' }] }] }] }]))
  const region = await renderFlow()

  expect(screen.getByText(/Не сохранить: флоу «полный», стадия «Приёмка»/)).toHaveTextContent(
    'возврат ведёт на стадию, которой во флоу нет',
  )
  expect(nodes(region)[2]).toHaveClass('invalid')

  const drawer = await returnsOf(region, /^Стадия 3: Приёмка/)
  fireEvent.click(drawer.getByRole('button', { name: 'Убрать возврат 1' }))
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('возвраты нарисованы дугами: у стадии с открытым окном возвратов дуга подсвечена и подписана условием', async () => {
  stubApi(api([app]))
  await renderFlow()
  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  fireEvent.click(screen.getByRole('option', { name: 'мелкий' }))
  const region = within(screen.getByRole('region', { name: 'Сценарий «мелкий»' }))

  expect(document.querySelectorAll('.flow-arc')).toHaveLength(1)
  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(0)

  await returnsOf(region, /^Стадия 2: Приёмка/)

  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(1)
  expect(document.querySelector('.flow-arc-label')).toHaveTextContent('замечания')
})

// Флоу с кругами: у «Ревью» возврат к «Критерию», у «Приёмки» — два, к «Ревью» и к «Критерию».
const circles: NamedFlow = {
  name: 'круги',
  when: 'много возвратов',
  entries: [
    { stage: 'Критерий' },
    { stage: 'Ревью', returns: [{ condition: 'нет критерия', stage: 'Критерий' }] },
    {
      stage: 'Приёмка',
      returns: [
        { condition: 'замечания', stage: 'Ревью' },
        { condition: 'другое', stage: 'Критерий' },
      ],
    },
  ],
}
const lit = () => [...document.querySelectorAll('.flow-arc-open .flow-arc-label')].map((label) => label.textContent)

test('мышь над блоком подсвечивает и подписывает только его возвраты, увёл — погасли', async () => {
  stubApi(api([{ ...app, flows: [circles] }]))
  const region = await renderFlow({}, 'круги')
  const [, review, acceptance] = nodes(region)
  expect(document.querySelectorAll('.flow-arc')).toHaveLength(3)
  expect(lit()).toEqual([])

  fireEvent.mouseEnter(acceptance)
  expect(lit().sort()).toEqual(['другое', 'замечания'])

  // Возврат «Приёмки» ведёт в «Ревью», но у «Ревью» подсвечен только свой
  fireEvent.mouseLeave(acceptance)
  fireEvent.mouseEnter(review)
  expect(lit()).toEqual(['нет критерия'])

  fireEvent.mouseLeave(review)
  expect(lit()).toEqual([])
})

test('открытое меню блока держит его возвраты подсвеченными, мышь над другим добавляет его возвраты', async () => {
  stubApi(api([{ ...app, flows: [circles] }]))
  const region = await renderFlow({}, 'круги')
  const [, review, acceptance] = nodes(region)

  fireEvent.mouseEnter(review)
  menuOf(region, /^Стадия 2: Ревью/)
  fireEvent.mouseLeave(review)
  expect(lit()).toEqual(['нет критерия'])

  fireEvent.mouseEnter(acceptance)
  expect(lit().sort()).toEqual(['другое', 'замечания', 'нет критерия'])
  // Выделены все три дуги: «Ревью» держит меню, «Приёмка» — под мышью
  const arcs = [...document.querySelectorAll('.flow-arc')]
  expect(arcs.every((arc) => arc.classList.contains('flow-arc-open'))).toBe(true)

  fireEvent.mouseLeave(acceptance)
  fireEvent.keyDown(screen.getByRole('menu', { name: /^Стадия «/ }), { key: 'Escape' })
  expect(screen.queryByRole('menu', { name: /^Стадия «/ })).not.toBeInTheDocument()
})

test('курсор клавиатуры на блоке подсвечивает его возвраты, ушёл — погасли; приглушённые дуги идут первыми', async () => {
  stubApi(api([{ ...app, flows: [circles] }]))
  const region = await renderFlow({}, 'круги')
  const [, review] = nodes(region)

  act(() => review.focus())
  expect(lit()).toEqual(['нет критерия'])
  const arcs = [...document.querySelectorAll('.flow-arc')]
  expect(arcs.map((arc) => arc.classList.contains('flow-arc-open'))).toEqual([false, false, true])

  act(() => review.blur())
  expect(lit()).toEqual([])
})

test('стадии флоу переставляются перетаскиванием и кнопками с клавиатуры, и каждая перестановка пишется сразу', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  const [first, , third] = nodes(region)
  const data: Record<string, string> = {}
  const dataTransfer = {
    effectAllowed: '',
    setData: (key: string, value: string) => (data[key] = value),
    getData: (key: string) => data[key],
  }

  fireEvent.dragStart(third, { dataTransfer })
  fireEvent.dragOver(first, { dataTransfer })
  fireEvent.drop(first, { dataTransfer })
  expect(labels(region)).toEqual(['Стадия 1: Приёмка', 'Стадия 2: Критерий', 'Стадия 3: Ревью'])
  const dropped = await saveAndRead(fetchMock)
  expect(dropped.flows[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Приёмка', 'Критерий', 'Ревью'])

  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))
  expect(labels(region)).toEqual(['Стадия 1: Приёмка', 'Стадия 2: Ревью', 'Стадия 3: Критерий'])
  expect(region.getByRole('button', { name: 'Стадия 1 выше' })).toBeDisabled()

  await vi.waitFor(() => expect(posts(fetchMock)).toBe(2))
  const sent = body(fetchMock, 'POST /api/flow')
  expect(sent.flows[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Приёмка', 'Ревью', 'Критерий'])
  // Стадии базы не переписаны: поменялся только порядок во флоу
  expect(sent.stages).toEqual(app.stages)
})

test('действие на схеме, которое не записалось, возвращает схему к базе и называет отказ', async () => {
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  const region = await renderFlow()

  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))

  expect(await screen.findByText('Флоу не сохранён: его изменили в базе. Раздел перечитал флоу — повторите действие.')).toBeInTheDocument()
  expect(labels(region)).toEqual(['Стадия 1: Критерий', 'Стадия 2: Ревью', 'Стадия 3: Приёмка'])
})

test('стадия убирается из флоу пунктом меню, а в базе остаётся', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()

  fireEvent.click(menuOf(region, 'Стадия 1: Критерий').getByRole('menuitem', { name: 'Убрать из сценария' }))

  // Без вопроса — замечание оператора к макету B-226 — и сразу записью
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(posts(fetchMock)).toBe(1)
  expect(labels(region)).toEqual(['Стадия 1: Ревью', 'Стадия 2: Приёмка'])
  // Блока убранной стадии нет — фокус на соседнем
  expect(region.getByRole('button', { name: 'Стадия 1: Ревью' })).toHaveFocus()
  const sent = await saveAndRead(fetchMock)
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toContain('Критерий')
})

test('вкладка «Стадии»: все стадии базы, и правка стадии видна во всех флоу, где она стоит', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  const edit = await stagesTab('Ревью')
  const list = within(screen.getByRole('list', { name: 'Стадии базы' }))
  // Список — все стадии базы, в том числе не стоящая ни в одном флоу
  expect(list.getAllByRole('button').map((item) => item.textContent)).toEqual([
    'Критерийоркестратор',
    'Ревьюсубагент reviewer',
    'Приёмкаоператор',
    'Запасоператор',
    'Новая стадия',
  ])
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Вычитка' } })
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  expect(labels(within(screen.getByRole('region', { name: 'Сценарий «полный»' })))).toContain('Стадия 2: Вычитка')

  const sent = await saveAndRead(fetchMock)
  expect(sent.stages[1]).toEqual({ ...review, title: 'Вычитка', output: 'вердикт' })
  // Пункты и возвраты обоих флоу идут за новым названием
  expect(sent.flows[0].entries[1].stage).toBe('Вычитка')
  expect(sent.flows[1].entries[1].returns).toEqual([{ condition: 'замечания', stage: 'Вычитка' }])
  expect(sent.icons).toEqual({ Критерий: 'target' })
})

test('стадию, стоящую во флоу, не удалить — окно говорит почему; стоящую вне флоу — удалить после вопроса', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  const used = await stagesTab('Ревью')
  // Кнопка нажимается, но не удаляет: раскрывает пояснение со сценариями (B-226)
  const remove = used.getByRole('button', { name: 'Удалить стадию' })
  expect(remove).toBeEnabled()
  fireEvent.click(remove)
  expect(remove).toHaveAttribute('aria-expanded', 'true')
  const note = within(used.getByRole('status'))
  expect(note.getByText('Стадию «Ревью» нельзя удалить.')).toBeInTheDocument()
  expect(note.getAllByRole('listitem').map((item) => item.textContent)).toEqual(['полный', 'мелкий'])
  expect(note.getByText('Сначала уберите её из этих сценариев на вкладке «Сценарии».')).toBeInTheDocument()
  fireEvent.click(note.getByRole('button', { name: 'Скрыть пояснение' }))
  expect(used.queryByRole('status')).not.toBeInTheDocument()
  expect(posts(fetchMock)).toBe(0)
  fireEvent.click(used.getByRole('button', { name: 'Отмена' }))

  const free = await stagesTab('Запас')
  fireEvent.click(free.getByRole('button', { name: 'Удалить стадию' }))
  const asked = within(screen.getByRole('alertdialog', { name: 'Удалить стадию «Запас»?' }))
  // Без пояснений: только вопрос и кнопки — замечание оператора к макету
  expect(asked.queryByText(/коммит/)).not.toBeInTheDocument()
  fireEvent.click(asked.getByRole('button', { name: 'Удалить' }))

  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  expect(body(fetchMock, 'POST /api/flow').stages.map((stage: FlowStage) => stage.title)).toEqual(['Критерий', 'Ревью', 'Приёмка'])
  await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).queryByText('Запас')).not.toBeInTheDocument()
})

test('новая стадия заводится на вкладке «Стадии» и без названия и выхода не сохраняется', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))

  fireEvent.click(screen.getByRole('button', { name: 'Новая стадия' }))

  const edit = within(screen.getByRole('dialog', { name: 'Стадия «без названия»' }))
  expect(screen.getByText('Не сохранить: стадия «без названия» — нет названия, не указан выход')).toBeInTheDocument()
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Мерж' } })
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'sha в dev' } })

  const sent = await saveAndRead(fetchMock)
  expect(sent.stages[4]).toEqual({
    title: 'Мерж',
    executor: 'оркестратор',
    output: 'sha в dev',
    skip: null,
    description: null,
    helpers: [],
    slug: null,
  })
})

test('две стадии с одним названием не сохранить', async () => {
  stubApi(api([app]))
  await renderFlow()

  const edit = await stagesTab('Запас')
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'ревью ' } })

  expect(screen.getByText(/^Не сохранить: стадия «Ревью» — стадия с таким названием уже есть/)).toBeInTheDocument()
})

test('стадия правится окном по щелчку на карточке и пишется его «Сохранить»; закрыть с правкой — через вопрос', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  // Пока карточку не выбрали, окна нет
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  const edit = await stagesTab('Ревью')
  // В шапке окна — название и исполнитель, в окне — все поля стадии
  expect(edit.getByRole('heading', { name: 'Ревью' })).toBeInTheDocument()
  expect(edit.getByText('субагент reviewer')).toBeInTheDocument()
  for (const name of ['Название стадии', 'Выход стадии', 'Пропуск стадии'])
    expect(edit.getByRole('textbox', { name })).toBeInTheDocument()
  expect(edit.getByRole('combobox', { name: 'Исполнитель стадии' })).toBeInTheDocument()
  expect(edit.getByRole('button', { name: 'Значок стадии' })).toBeInTheDocument()
  // «Готово» нет: внизу «Отмена» и «Сохранить», и нечего сохранять, пока ничего не правили
  expect(edit.queryByRole('button', { name: 'Готово' })).not.toBeInTheDocument()
  expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  // Крестик с правкой спрашивает; «Вернуться» оставляет окно как было
  fireEvent.click(edit.getByRole('button', { name: 'Закрыть' }))
  const asked = within(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' }))
  expect(asked.getByText('Изменения стадии «Ревью» не будут сохранены.')).toBeInTheDocument()
  fireEvent.click(asked.getByRole('button', { name: 'Вернуться' }))
  expect(edit.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт')
  expect(posts(fetchMock)).toBe(0)

  // Escape закрывает верхнее окно: сначала описание, потом правку
  fireEvent.click(edit.getByRole('button', { name: /Редактировать описание/ }))
  const description = within(screen.getByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  fireEvent.keyDown(description.getByRole('button', { name: 'Закрыть' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: /^Описание стадии/ })).not.toBeInTheDocument()
  const stage = screen.getByRole('dialog', { name: 'Стадия «Ревью»' })
  // Открытый список значков Escape закрывает первым, окно остаётся
  fireEvent.click(within(stage).getByRole('button', { name: 'Значок стадии' }))
  fireEvent.keyDown(within(stage).getByRole('button', { name: 'Значок «код»' }), { key: 'Escape' })
  expect(within(stage).queryByRole('group', { name: 'Значки стадии' })).not.toBeInTheDocument()
  expect(stage).toBeInTheDocument()

  expect((await saveAndRead(fetchMock)).stages[1].output).toBe('вердикт')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('отказ записи из окна стадии назван в самом окне, а правка остаётся в полях', async () => {
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'not-committed', detail: 'hook отказал' }, 502) }))
  await renderFlow()
  const edit = await stagesTab('Ревью')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  fireEvent.click(edit.getByRole('button', { name: 'Сохранить' }))

  expect(await edit.findByRole('alert')).toHaveTextContent('Флоу не сохранён: коммит в базу не прошёл, файлы оставлены как были. hook отказал')
  expect(edit.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт')
})

test('описание стадии показано оформленным, правится по «Редактировать» и пишется «Сохранить»; у стадии без описания кнопка приглушена', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  const empty = (await stagesTab('Приёмка')).getByRole('button', { name: /Редактировать описание/ })
  expect(empty).toHaveClass('flow-description-empty')
  // Пустое описание открывается сразу в правке, а «Отмена» без набранного закрывает окно
  fireEvent.click(empty)
  const blank = within(screen.getByRole('dialog', { name: 'Описание стадии «Приёмка»' }))
  expect(blank.getByRole('textbox', { name: 'Описание стадии' })).toHaveFocus()
  fireEvent.click(blank.getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('dialog', { name: /^Описание стадии/ })).not.toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Стадия «Приёмка»' })).getByRole('button', { name: 'Отмена' }))

  const edit = await stagesTab('Ревью')
  fireEvent.click(edit.getByRole('button', { name: /Редактировать описание/ }))
  const dialog = within(screen.getByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  // Разметка оформлена: пункт списка, а не исходный текст; на вкладке «Стадии» предупреждения нет
  expect(dialog.getByRole('listitem')).toHaveTextContent('Собрать дифф всей ветки.')
  expect(dialog.queryByRole('textbox')).not.toBeInTheDocument()
  expect(dialog.queryByText(/Стадия стоит в сценариях/)).not.toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Закрыть' })).toHaveFocus()

  // «Отмена» с набранным спрашивает и бросает правку, возвращая к просмотру
  fireEvent.click(dialog.getByRole('button', { name: 'Редактировать' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Описание стадии' }), { target: { value: 'черновик' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  expect(dialog.getByRole('listitem')).toHaveTextContent('Собрать дифф всей ветки.')

  fireEvent.click(dialog.getByRole('button', { name: 'Редактировать' }))
  const text = dialog.getByRole('textbox', { name: 'Описание стадии' })
  expect(text).toHaveValue('1. Собрать дифф всей ветки.')
  fireEvent.change(text, { target: { value: 'Ревью по диффу.\n\n1. Собрать дифф.' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Сохранить' }))

  // «Сохранить» пишет описание в базу сразу и возвращает к просмотру уже с правкой
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  expect(body(fetchMock, 'POST /api/flow').stages[1].description).toBe('Ревью по диффу.\n\n1. Собрать дифф.')
  expect(await dialog.findByText('Ревью по диффу.')).toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name: /^Описание стадии/ })).not.toBeInTheDocument()
  // Окно стадии под ним записанное описание не считает своей несохранённой правкой
  expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('значок стадии выбирается из списка значков и уходит в запись', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()
  const edit = await stagesTab('Приёмка')

  fireEvent.click(edit.getByRole('button', { name: 'Значок стадии' }))
  const menu = within(screen.getByRole('group', { name: 'Значки стадии' }))
  // В списке сами значки, а не их названия
  expect(menu.getAllByRole('button').map((button) => button.textContent)).toEqual(['', '', '', '', '', ''])
  fireEvent.click(menu.getByRole('button', { name: 'Значок «проверка»' }))

  expect((await saveAndRead(fetchMock)).icons).toEqual({ Критерий: 'target', Приёмка: 'check' })
})

test('в окне добавления — новая стадия и стадии базы, которых во флоу нет', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  await open(region, 'Сценарий «полный»: название и «когда»')
  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  fireEvent.click(screen.getByRole('option', { name: 'мелкий' }))

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Добавить стадию в сценарий «мелкий»' }))
  const own = within(dialog.getByRole('group', { name: 'Стадии базы' }))
  expect(own.getAllByRole('button').map((button) => button.querySelector('.flow-stage-item-title')?.textContent)).toEqual([
    'Критерий',
    'Запас',
  ])
  // Строка без выхода: значок, название и исполнитель (B-209)
  expect(own.getByRole('button', { name: /^Критерий/ })).not.toHaveTextContent('выход')
  // Первой в окне — «Новая стадия», фокус на ней
  expect(dialog.getAllByRole('button')[1]).toHaveAccessibleName('Новая стадия')
  expect(dialog.getByRole('button', { name: 'Новая стадия' })).toHaveFocus()
  fireEvent.click(own.getByRole('button', { name: /^Критерий/ }))

  const small = within(screen.getByRole('region', { name: 'Сценарий «мелкий»' }))
  expect(labels(small)).toContain('Стадия 3: Критерий')
  // Фокус — на блоке добавленной стадии
  expect(small.getByRole('button', { name: 'Стадия 3: Критерий' })).toHaveFocus()

  // Пресетов в окне нет: их убрали из панели на B-226
  expect(screen.queryByRole('group', { name: 'Пресеты стадий' })).not.toBeInTheDocument()

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[1].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Ревью', 'Приёмка', 'Критерий'])
  // Стадия базы в базе новой не заводится
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toEqual(['Критерий', 'Ревью', 'Приёмка', 'Запас'])
})

test('«Новая стадия» из окна добавления открывается на вкладке «Стадии» и пишется вместе со своим местом в сценарии', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: /^Добавить стадию/ })).getByRole('button', { name: /^Новая стадия/ }))

  expect(screen.getByRole('tab', { name: 'Стадии' })).toHaveAttribute('aria-selected', 'true')
  const edit = within(screen.getByRole('dialog', { name: 'Стадия «без названия»' }))
  expect(posts(fetchMock)).toBe(0)
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Мерж' } })
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'sha в dev' } })

  const sent = await saveAndRead(fetchMock)
  expect(sent.stages.at(-1)).toMatchObject({ title: 'Мерж', output: 'sha в dev', slug: null })
  expect(sent.flows[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Критерий', 'Ревью', 'Приёмка', 'Мерж'])
})

test('«Отмена» у новой стадии со схемы не оставляет ни стадии, ни места в сценарии', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(within(screen.getByRole('dialog', { name: /^Добавить стадию/ })).getByRole('button', { name: /^Новая стадия/ }))
  const edit = within(screen.getByRole('dialog', { name: 'Стадия «без названия»' }))
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Мерж' } })
  fireEvent.click(edit.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))

  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).queryByText('Мерж')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  expect(labels(within(screen.getByRole('region', { name: 'Сценарий «полный»' })))).toHaveLength(3)
  expect(posts(fetchMock)).toBe(0)
})

test('окно добавления закрывают крестик, «Отмена» и Escape, ничего не добавив', async () => {
  stubApi(api([app]))
  const region = await renderFlow()
  const before = labels(region)
  const name = 'Добавить стадию в сценарий «полный»'

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(within(screen.getByRole('dialog', { name })).getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(within(screen.getByRole('dialog', { name })).getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()

  // Щелчок мимо окна — по подложке
  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.mouseDown(screen.getByRole('dialog', { name }).parentElement!)
  expect(screen.queryByRole('dialog', { name })).not.toBeInTheDocument()

  expect(labels(region)).toEqual(before)
})

test('в окне добавления нет группы «Стадии базы», когда все стадии базы уже в сценарии', async () => {
  stubApi(api([{ ...app, stages: [criterion, review, acceptance] }]))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Добавить стадию в сценарий «полный»' }))
  expect(dialog.queryByRole('group', { name: 'Стадии базы' })).not.toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Новая стадия' })).toBeInTheDocument()
})

test('исполнитель стадии выбирается из заведённых, незаведённый не даёт сохранить флоу', async () => {
  stubApi(api([app], { 'GET /api/performers': () => json(performers(['e2e-runner'])) }))
  const onPerformers = vi.fn()
  const region = await renderFlow({ onPerformers })

  // Незнакомое имя видно на схеме, не открывая стадию
  expect(await within(nodes(region)[1]).findByLabelText('Исполнителя reviewer нет в базе')).toBeInTheDocument()
  expect(screen.getByText(/Не сохранить: стадия «Ревью»/)).toHaveTextContent('исполнителя нет в базе')

  const edit = await stagesTab('Ревью')
  expect(await edit.findByRole('status')).toHaveTextContent('Выберите исполнителя из заведённых')
  const picker = edit.getByRole('combobox', { name: 'Имя субагента' })
  expect(picker).toHaveDisplayValue('reviewer — в базе нет')
  expect(edit.queryByRole('textbox', { name: 'Имя субагента' })).not.toBeInTheDocument()

  fireEvent.click(edit.getByRole('button', { name: 'Завести исполнителя' }))
  expect(onPerformers).toHaveBeenCalled()

  fireEvent.change(picker, { target: { value: 'e2e-runner' } })
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('отказ чтения исполнителей не метит стадии незаведёнными', async () => {
  stubApi(api([app], { 'GET /api/performers': () => new Response('', { status: 500 }) }))
  const region = await renderFlow()

  expect(await screen.findByText(/Список исполнителей не прочитан/)).toBeInTheDocument()
  expect(nodes(region)[1].querySelector('.flow-node-missing')).toBeNull()
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
  expect((await stagesTab('Ревью')).getByRole('combobox', { name: 'Имя субагента' })).toHaveDisplayValue('reviewer')
})

test('помощники есть только у стадии оркестратора и стираются при смене исполнителя', async () => {
  const fetchMock = stubApi(api([{ ...app, stages: [{ ...criterion, helpers: ['scout'] }, review, acceptance, spare] }], saved()))
  await renderFlow()
  const edit = await stagesTab('Критерий')

  expect(edit.getByText('scout')).toBeInTheDocument()
  fireEvent.change(edit.getByRole('combobox', { name: 'Добавить помощника' }), { target: { value: 'check-runner' } })
  expect((await saveAndRead(fetchMock)).stages[0].helpers).toEqual(['scout', 'check-runner'])

  fireEvent.change(edit.getByRole('combobox', { name: 'Исполнитель стадии' }), { target: { value: 'оператор' } })
  expect(edit.queryByRole('combobox', { name: 'Добавить помощника' })).not.toBeInTheDocument()
  expect(edit.queryByText('scout')).not.toBeInTheDocument()
})

test('помощник, которого нет в базе, отмечен янтарём и сохранить флоу не даёт', async () => {
  stubApi(api([{ ...app, stages: [{ ...criterion, helpers: ['doc-writer'] }, review, acceptance, spare] }]))
  await renderFlow()
  const edit = await stagesTab('Критерий')

  expect(await edit.findByTitle('Исполнителя doc-writer нет в базе')).toBeInTheDocument()
  expect(screen.getByText(/Не сохранить: стадия «Критерий»/)).toHaveTextContent('помощника нет в базе')
})

test('запись уходит целиком: база, отпечаток, стадии, флоу и значки', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()
  const edit = await stagesTab('Приёмка')
  fireEvent.change(edit.getByRole('textbox', { name: 'Пропуск стадии' }), { target: { value: 'правка без вида' } })

  expect(await saveAndRead(fetchMock)).toEqual({
    base: app.base,
    version: 'v1',
    stages: [criterion, review, { ...acceptance, skip: 'правка без вида' }, spare],
    flows: [
      { ...full, entries: full.entries.map((entry) => ({ stage: entry.stage, returns: [] })) },
      small,
    ],
    icons: { Критерий: 'target' },
  })
})

test('пока в окне несохранённое, проект не переключить и базу не перечитать', async () => {
  stubApi(api([app, nota]))
  await renderFlow()
  const edit = await stagesTab('Критерий')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })

  expect(screen.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeDisabled()
  expect(moreItem('Обновить')).toBeDisabled()
})

test('отказы записи названы словами, а правки остаются', async () => {
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'not-committed', detail: 'сверка: флоу не прошёл' }, 502) }))
  await renderFlow()
  const edit = await stagesTab('Критерий')
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Критерий закрытия' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(
    await screen.findByText('Флоу не сохранён: коммит в базу не прошёл, файлы оставлены как были. сверка: флоу не прошёл'),
  ).toBeInTheDocument()
  expect(edit.getByRole('textbox', { name: 'Название стадии' })).toHaveValue('Критерий закрытия')
})

test('отказ API по форме кита назван с флоу и стадией; изменённый в базе флоу не перезаписан молча', async () => {
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'stage-twice', flow: 'мелкий', stage: 'Ревью' }, 400) }))
  await renderFlow()
  fireEvent.change((await stagesTab('Критерий')).getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(
    await screen.findByText('Флоу не сохранён: флоу «мелкий», стадия «Ревью» — стадия дважды в одном флоу'),
  ).toBeInTheDocument()

  vi.unstubAllGlobals()
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(
    await screen.findByText(
      'Флоу не сохранён: его изменили в базе, пока окно было открыто. Закройте окна без сохранения — когда они закрыты, раздел перечитает флоу, и правку можно будет сделать заново.',
    ),
  ).toBeInTheDocument()
})

test('проект без стадий и сценариев — вкладки на месте, пустое состояние у каждой своё', async () => {
  stubApi(api([nota]))
  render(<Flow />)

  // Первой открыта вкладка «Сценарии», пустое состояние — только на ней
  expect(await screen.findByRole('heading', { name: 'В этом проекте нет сценариев' })).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Сценарии' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getAllByRole('tab')).toHaveLength(2)
  // Открывать в VS Code нечего, а переписать стадии словами можно
  expect(moreItem('Обновить')).toBeEnabled()
  expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Переписать с Чудо-Юдо', 'Обновить'])
  fireEvent.click(screen.getByRole('button', { name: 'Ещё действия' }))

  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  expect(screen.getByRole('heading', { name: 'В этом проекте нет стадий' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'В этом проекте нет сценариев' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Создать первую стадию' }))
  const blank = within(await screen.findByRole('dialog', { name: 'Стадия «без названия»' }))
  // Стадия в окне — вкладка «Стадии» за ним уже обычная, с карточкой и «Новой стадией»
  expect(screen.queryByRole('heading', { name: 'В этом проекте нет стадий' })).not.toBeInTheDocument()
  // Нетронутая новая стадия закрывается без вопроса и в базу не уходит — пустое состояние возвращается
  fireEvent.click(blank.getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'В этом проекте нет стадий' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  fireEvent.click(screen.getByRole('button', { name: 'Создать первый сценарий' }))

  // Сценарий без стадий кит не примет: окно говорит, откуда взять первую
  const dialog = within(await screen.findByRole('dialog', { name: 'Новый сценарий' }))
  expect(dialog.getByText(/В проекте нет стадий\. Заведите первую на вкладке «Стадии»/)).toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('стадии проекта без сценариев видны на вкладке «Стадии», правятся и сохраняются', async () => {
  const fetchMock = stubApi(api([{ ...app, flows: [] }], saved()))
  render(<Flow />)

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет сценариев' })).toBeInTheDocument()
  // Пока правок нет, полосы сохранения нет
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()

  const edit = await stagesTab('Запас')
  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).getAllByRole('button')).toHaveLength(5)
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'отчёт' } })

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows).toEqual([])
  expect(sent.stages.find((stage: FlowStage) => stage.title === 'Запас')?.output).toBe('отчёт')
})

test('база, которую панель не прочитала, названа словами', async () => {
  stubApi(api([{ ...nota, version: null, error: 'База не найдена на диске' }]))
  render(<Flow />)

  expect(await screen.findByText('База не найдена на диске')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'В этом проекте нет сценариев' })).not.toBeInTheDocument()
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
})

test('с отметки в шапке у непрочитанного флоу раздел говорит, почему окна переписывания нет', async () => {
  stubApi(api([app, { ...nota, version: null, error: 'База не найдена на диске' }], rewriteApi([])))
  render(<Flow baseFor={nota.base} rewriteAt={1} />)

  expect(
    await screen.findByText(
      'Окно «Переписать с Чудо-Юдо» не открыть, пока флоу проекта не прочитан: правки было бы не на что положить.',
    ),
  ).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).not.toBeInTheDocument()

  // Верх раздела не заперт: проект меняется, и окно на другом проекте само не встаёт.
  fireEvent.click(screen.getByRole('button', { name: 'Проект: Nota' }))
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Проект' })).getByRole('option', { name: 'Agents Kit Web' }))
  expect(await screen.findByRole('region', { name: 'Сценарий «полный»' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).not.toBeInTheDocument()
})

test('проект выбирается списком в шапке', async () => {
  stubApi(api([app, nota]))
  await renderFlow()

  expect(moreItem('Открыть в VS Code')).toBeEnabled()

  fireEvent.click(screen.getByRole('button', { name: 'Проект: Agents Kit Web' }))
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Проект' })).getByRole('option', { name: 'Nota' }))

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет сценариев' })).toBeInTheDocument()
})

/** Панель с просьбой переписывания: POST её заводит, поток сразу отдаёт итог events. */
const rewriteApi = (events: unknown[]) => ({
  'GET /api/agent/requests': () => json([]),
  'POST /api/flow/rewrite': () =>
    json({ kind: 'flow', id: 'r1', base: app.base, project: app.project, text: 'просьба', elapsedMs: 0, state: 'running', subject: null }),
  'GET /api/agent/flow/stream?id=r1&from=0': () =>
    new Response(events.map((event) => JSON.stringify(event) + '\n').join(''), {
      headers: { 'Content-Type': 'application/x-ndjson' },
    }),
  'DELETE /api/agent/flow': () => new Response(null, { status: 204 }),
})

test('«Переписать с Чудо-Юдо» в меню «…» шлёт стадии базы, а «Принять правки» сразу записывает переписанные', async () => {
  const rewritten = [
    { of: 'Ревью', stage: { ...review, title: 'Проверка', output: 'вердикт по sha и тестам' } },
    // Новая стадия приходит без of: пустые поля API не пишет.
    { stage: { ...spare, title: 'Документация', executor: 'оператор', output: 'раздел', slug: null } },
  ]
  const fetchMock = stubApi(api([app], { ...saved(), ...rewriteApi([{ type: 'rewritten', text: '', stages: rewritten }]) }))
  await renderFlow()

  fireEvent.click(moreItem('Переписать с Чудо-Юдо'))
  const modal = within(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' }))
  fireEvent.change(modal.getByLabelText('Что поменять в стадиях'), { target: { value: 'Переименуй ревью и заведи документацию' } })
  fireEvent.click(modal.getByRole('button', { name: 'Стадии' }))
  fireEvent.click(within(modal.getByRole('listbox', { name: 'Стадии проекта' })).getByRole('option', { name: /Ревью/ }))
  fireEvent.click(modal.getByRole('button', { name: 'Переписать' }))

  const changes = within(await modal.findByLabelText('Что изменилось в стадиях'))
  // Ревью стоит в обоих сценариях: карточка говорит, что правка заденет оба.
  expect(changes.getByText(/Стадия стоит в сценариях «полный» и «мелкий»/)).toBeInTheDocument()
  const sent = body(fetchMock, 'POST /api/flow/rewrite')
  expect(sent.base).toBe(app.base)
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toEqual(['Ревью'])
  expect(sent.titles).toEqual(['Критерий', 'Ревью', 'Приёмка', 'Запас'])
  expect(posts(fetchMock)).toBe(0)

  fireEvent.click(modal.getByRole('button', { name: 'Принять правки' }))

  // Правки записаны сразу, одной записью (B-226); новая стадия встаёт карточкой в конце вкладки «Стадии».
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  const list = within(await screen.findByRole('list', { name: 'Стадии базы' }))
  expect(list.getByRole('button', { name: /^Документация/ })).toBeInTheDocument()
  expect(list.getByRole('button', { name: /^Проверка/ })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).not.toBeInTheDocument()

  const written = body(fetchMock, 'POST /api/flow')
  // Переименование держит файл стадии и идёт за ней в сценарии и возвраты, как ручное.
  expect(written.stages.find((stage: FlowStage) => stage.title === 'Проверка')).toMatchObject({
    slug: 'review',
    output: 'вердикт по sha и тестам',
  })
  expect(written.stages.find((stage: FlowStage) => stage.title === 'Документация')).toMatchObject({ slug: null })
  expect(written.flows[1].entries).toEqual([
    { stage: 'Проверка', returns: [] },
    { stage: 'Приёмка', returns: [{ condition: 'замечания', stage: 'Проверка' }] },
  ])
})

test('«Отказаться» в окне переписывания ничего не пишет в базу и новой стадии не заводит', async () => {
  const rewritten = [{ of: null, stage: { ...spare, title: 'Документация', slug: null } }]
  const fetchMock = stubApi(api([app], { ...saved(), ...rewriteApi([{ type: 'rewritten', text: '', stages: rewritten }]) }))
  await renderFlow()

  fireEvent.click(moreItem('Переписать с Чудо-Юдо'))
  const modal = within(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' }))
  fireEvent.change(modal.getByLabelText('Что поменять в стадиях'), { target: { value: 'Заведи документацию' } })
  fireEvent.click(modal.getByRole('button', { name: 'Написать стадию' }))
  fireEvent.click(await modal.findByRole('button', { name: 'Отказаться' }))

  await vi.waitFor(() => expect(screen.queryByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).not.toBeInTheDocument())
  expect(posts(fetchMock)).toBe(0)
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).queryByText('Документация')).not.toBeInTheDocument()
})

test('раздел, открытый с отметки просьбы в шапке, сразу показывает окно переписывания', async () => {
  stubApi(api([app], rewriteApi([])))
  render(<Flow baseFor={app.base} rewriteAt={1} />)

  expect(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()
})

test('отметка в шапке при открытом разделе открывает окно переписывания, не бросая правку в открытом окне', async () => {
  stubApi(api([app], rewriteApi([])))
  const view = render(<Flow />)
  await screen.findByRole('region', { name: 'Сценарий «полный»' })
  const edit = await stagesTab('Критерий')
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Критерий закрытия' } })

  view.rerender(<Flow baseFor={app.base} rewriteAt={2} />)

  expect(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Название стадии' })).toHaveValue('Критерий закрытия')
})

/** Просьба переписать стадии Nota, дождавшаяся оператора: к ней ведёт отметка в шапке. */
const notaRewrite = {
  ...rewriteApi([]),
  'GET /api/agent/requests': () =>
    json([{ kind: 'flow', id: 'r1', base: nota.base, project: nota.project, text: 'просьба', elapsedMs: 0, state: 'done' }]),
}

test('отметка в шапке без несохранённых правок переключает раздел на проект просьбы', async () => {
  stubApi(api([app, nota], notaRewrite))
  const view = render(<Flow />)
  await screen.findByRole('region', { name: 'Сценарий «полный»' })

  view.rerender(<Flow baseFor={nota.base} rewriteAt={2} />)

  expect(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Проект: Nota' })).toBeInTheDocument()
})

test('отметка в шапке с правкой в открытом окне оставляет раздел на своём проекте и предупреждает о чужой просьбе', async () => {
  stubApi(api([app, nota], notaRewrite))
  const view = render(<Flow />)
  await screen.findByRole('region', { name: 'Сценарий «полный»' })
  const edit = await stagesTab('Критерий')
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Критерий закрытия' } })

  view.rerender(<Flow baseFor={nota.base} rewriteAt={2} />)

  const modal = within(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' }))
  expect(
    await modal.findByText('Чудо-Юдо уже переписал стадии Nota: новая просьба отсюда уберёт этот ответ.'),
  ).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Название стадии' })).toHaveValue('Критерий закрытия')
})

test('«Открыть в VS Code» просит API открыть флоу этой базы', async () => {
  const fetchMock = stubApi(api([app], { 'POST /api/flow/open': () => new Response(null, { status: 204 }) }))
  await renderFlow()

  fireEvent.click(moreItem('Открыть в VS Code'))

  await vi.waitFor(() => expect(body(fetchMock, 'POST /api/flow/open')).toEqual({ base: app.base }))
})

test('стадии стоят карточками в порядке флоу, а не по именам файлов; стадии вне флоу и «Новая стадия» — в конце', async () => {
  stubApi(api([{ ...app, stages: [spare, acceptance, criterion, review] }]))
  await renderFlow()

  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))

  const list = within(screen.getByRole('list', { name: 'Стадии базы' }))
  const cards = list.getAllByRole('button')
  expect(cards.map((item) => item.querySelector('.flow-stage-item-title')?.textContent ?? item.textContent)).toEqual([
    'Критерий',
    'Ревью',
    'Приёмка',
    'Запас',
    'Новая стадия',
  ])
  // На карточке — значок, название и исполнитель
  expect(cards[1].querySelector('.flow-stage-badge')).toHaveTextContent('субагент reviewer')
  // Имя субагента — моноширинным, как в карточке исполнителя
  expect(within(cards[1]).getByText('reviewer')).toHaveClass('mono')
})

test('удалённый единственный сценарий пишется сразу, и раздел показывает пустое состояние, а стадии на месте', async () => {
  const fetchMock = stubApi(api([{ ...app, flows: [full] }], saved()))
  const region = await renderFlow()

  fireEvent.click((await open(region, /^Сценарий «полный»/)).getByRole('button', { name: 'Удалить сценарий' }))
  // «Отмена» в вопросе ничего не удаляет
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Отмена' }))
  expect(posts(fetchMock)).toBe(0)
  fireEvent.click(within(screen.getByRole('complementary')).getByRole('button', { name: 'Удалить сценарий' }))
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Удалить' }))

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет сценариев' })).toBeInTheDocument()
  expect(body(fetchMock, 'POST /api/flow').flows).toEqual([])
  // Раздел не пропал: стадии на своей вкладке
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).getByRole('button', { name: /^Запас/ })).toBeInTheDocument()
})

test('строки файлов флоу, которые панель не сохранит, названы над разделом и запирают запись', async () => {
  stubApi(api([{ ...app, unread: ['flow/flow.md, строка 14: «3. Мерж»'] }]))
  const region = await renderFlow()

  expect(
    screen.getByText(
      'Не сохранить: в файлах флоу есть строка, которую панель не сохранит, — flow/flow.md, строка 14: «3. Мерж». Поправьте её в файле: «…» → «Открыть в VS Code»',
    ),
  ).toBeInTheDocument()
  // Действия на схеме недоступны
  expect(region.getByRole('button', { name: 'Стадия 2 выше' })).toBeDisabled()
  expect(region.getByRole('button', { name: 'Добавить стадию' })).toBeDisabled()
  // Правки в окне не отпирают запись: строку чинят в самом файле
  fireEvent.change((await stagesTab('Критерий')).getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('после сохранения раздел остаётся на своей вкладке и выбранном флоу', async () => {
  let version = 1
  const fetchMock = stubApi({
    ...api([app]),
    // Записанный флоу перечитывается с новым отпечатком и собирается в форму заново
    'GET /api/flow': () => json([{ ...app, version: `v${version}` }]),
    'POST /api/flow': () => {
      version++
      return json({ version: `v${version}` })
    },
  })
  await renderFlow()
  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  fireEvent.click(screen.getByRole('option', { name: 'мелкий' }))
  const edit = await stagesTab('Ревью')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  await saveAndRead(fetchMock)
  await vi.waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/flow').length).toBe(3))

  // Окно правки закрыто перед записью, а раздел остаётся на вкладке «Стадии» и на флоу «мелкий»
  expect(screen.getByRole('tab', { name: 'Стадии' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  expect(screen.getByRole('region', { name: 'Сценарий «мелкий»' })).toBeInTheDocument()
})

test('скобки и кавычки в названии стадии не пускаются: ими пишется ссылка и возврат', async () => {
  stubApi(api([app]))
  await renderFlow()

  const edit = await stagesTab('Запас')
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Запас [черновик]' } })

  expect(screen.getByText(/^Не сохранить: стадия «Запас \[черновик\]» — в названии скобки \[ \] или кавычки « »/)).toBeInTheDocument()
})

test('сорванная запись файла названа своим текстом, а не отказом коммита', async () => {
  stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'not-written', detail: 'Файл занят.' }, 502) }))
  await renderFlow()
  fireEvent.change((await stagesTab('Критерий')).getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(
    await screen.findByText('Флоу не сохранён: файл флоу не записался, файлы возвращены как были. Файл занят.'),
  ).toBeInTheDocument()
})

test('сценарий, по которому идёт задача, только для чтения: строка называет задачи, действия на схеме погашены', async () => {
  const fetchMock = stubApi(api([{ ...app, tasks: [{ task: 'B-7', flow: 'полный' }, { task: 'B-9', flow: 'полный' }] }], saved()))
  const region = await renderFlow()

  expect(screen.getByText(/^Правка сценария закрыта — по нему идут задачи/)).toHaveTextContent(
    'Правка сценария закрыта — по нему идут задачи B-7, B-9',
  )
  expect(region.getByRole('button', { name: 'Стадия 2 выше' })).toBeDisabled()
  expect(region.getByRole('button', { name: 'Добавить стадию' })).toBeDisabled()
  expect(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Убрать из сценария' })).toBeDisabled()
  // «Новый сценарий» не занят никем
  expect(screen.getByRole('button', { name: 'Новый сценарий' })).toBeEnabled()

  // Окна открываются, но только для чтения
  fireEvent.click(screen.getByRole('menuitem', { name: 'Править стадию «Ревью»' }))
  const stage = within(await screen.findByRole('dialog', { name: 'Стадия «Ревью»' }))
  expect(stage.getByText(/^Правка закрыта: по сценарию «полный» идут задачи/)).toBeInTheDocument()
  expect(stage.getByRole('textbox', { name: 'Выход стадии' })).toBeDisabled()
  expect(stage.getByRole('textbox', { name: 'Название стадии' })).toBeDisabled()
  expect(stage.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
  expect(stage.queryByRole('button', { name: 'Удалить стадию' })).not.toBeInTheDocument()
  // Крестик в шапке и «Закрыть» в подвале; фокус — на подвальной
  const close = stage.getAllByRole('button', { name: 'Закрыть' }).at(-1)!
  expect(close).toHaveFocus()
  fireEvent.click(close)

  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')
  expect(drawer.getByRole('textbox', { name: 'Название сценария' })).toBeDisabled()
  expect(drawer.queryByRole('button', { name: 'Удалить сценарий' })).not.toBeInTheDocument()
  expect(drawer.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
  fireEvent.click(drawer.getByRole('button', { name: 'Закрыть сайдбар' }))

  const returns = await returnsOf(region, /^Стадия 3: Приёмка/)
  expect(returns.getByRole('button', { name: 'Добавить возврат' })).toBeDisabled()
  expect(returns.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
  fireEvent.click(returns.getAllByRole('button', { name: 'Закрыть' }).at(-1)!)

  fireEvent.click(menuOf(region, 'Стадия 2: Ревью').getByRole('menuitem', { name: 'Редактировать описание' }))
  const description = within(await screen.findByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  expect(description.queryByRole('button', { name: 'Редактировать' })).not.toBeInTheDocument()
  expect(posts(fetchMock)).toBe(0)
})

test('на вкладке «Стадии» занятые стадии с замком и задачами открываются для чтения, свободные правятся', async () => {
  stubApi(api([{ ...app, tasks: [{ task: 'B-7', flow: 'мелкий' }] }]))
  await renderFlow()
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))

  const list = within(screen.getByRole('list', { name: 'Стадии базы' }))
  // Ревью и Приёмка стоят в «мелком», Критерий и Запас — нет
  expect(list.getAllByLabelText('Правка закрыта: по сценарию «мелкий» идёт задача B-7')).toHaveLength(2)
  expect(within(list.getByRole('button', { name: /^Критерий/ })).queryByText('B-7')).not.toBeInTheDocument()
  // Строки над разделом на вкладке «Стадии» нет: сценарий назван, закрыт не весь проект
  expect(screen.queryByText(/^Правка стадий и сценариев закрыта/)).not.toBeInTheDocument()

  const free = await stagesTab('Запас')
  expect(free.getByRole('textbox', { name: 'Выход стадии' })).toBeEnabled()
  fireEvent.click(free.getByRole('button', { name: 'Отмена' }))
  const held = await stagesTab('Приёмка')
  expect(held.getByRole('textbox', { name: 'Выход стадии' })).toBeDisabled()
})

test('задача с неузнанным сценарием закрывает правку всего проекта, а новые стадия и сценарий заводятся', async () => {
  stubApi(api([{ ...app, tasks: [{ task: 'B-130', flow: null }] }]))
  const region = await renderFlow()

  expect(screen.getByText(/^Правка стадий и сценариев закрыта/)).toHaveTextContent(
    'Правка стадий и сценариев закрыта — задача B-130 не называет своего сценария',
  )
  expect(region.getByRole('button', { name: 'Стадия 2 выше' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Новый сценарий' })).toBeEnabled()

  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  expect(screen.getByText(/^Правка стадий и сценариев закрыта/)).toBeInTheDocument()
  // Замок на каждой карточке, и на стадии вне сценариев тоже
  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).getAllByText('B-130')).toHaveLength(4)
  fireEvent.click(screen.getByRole('button', { name: 'Новая стадия' }))
  const blank = within(await screen.findByRole('dialog', { name: 'Стадия «без названия»' }))
  expect(blank.getByRole('textbox', { name: 'Название стадии' })).toBeEnabled()
})

test('задача, пошедшая по сценарию, пока окно было открыто: отказ записи назван задачами', async () => {
  const fetchMock = stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'busy', flow: 'полный', stage: 'Ревью', detail: 'B-7' }, 409) }))
  await renderFlow()
  const edit = await stagesTab('Ревью')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  fireEvent.click(edit.getByRole('button', { name: 'Сохранить' }))

  expect(await edit.findByRole('alert')).toHaveTextContent(
    'Флоу не сохранён: по сценарию «полный» идёт задача B-7. Пока она в работе, сценарий и его стадии не правятся. Закройте окна — когда они закрыты, раздел перечитает флоу.',
  )
  // Набранное в окне остаётся, а флоу до закрытия окна не перечитывается
  expect(edit.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт')
  const reads = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/flow' && !init?.method).length
  expect(reads()).toBe(1)
  fireEvent.click(edit.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  await vi.waitFor(() => expect(reads()).toBe(2))
})

test('после отказа записи окно держит набранное, а флоу перечитывается, когда окно закрыли', async () => {
  const fetchMock = stubApi(api([app], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  await renderFlow()
  const reads = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/flow' && !init?.method).length
  const edit = await stagesTab('Ревью')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  fireEvent.click(edit.getByRole('button', { name: 'Сохранить' }))
  await edit.findByRole('alert')
  expect(edit.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт')
  expect(reads()).toBe(1)

  fireEvent.click(edit.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  await vi.waitFor(() => expect(reads()).toBe(2))
})

test('в окне Чудо-Юдо стадии занятого сценария погашены с задачами', async () => {
  stubApi(api([{ ...app, tasks: [{ task: 'B-7', flow: 'мелкий' }] }], rewriteApi([])))
  await renderFlow()

  fireEvent.click(moreItem('Переписать с Чудо-Юдо'))
  const modal = within(await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' }))
  fireEvent.click(modal.getByRole('button', { name: 'Стадии' }))
  const list = within(modal.getByRole('listbox', { name: 'Стадии проекта' }))

  expect(list.getByRole('option', { name: /Ревью/ })).toHaveAttribute('aria-disabled', 'true')
  expect(list.getByRole('option', { name: /Ревью/ })).toHaveTextContent('занята: B-7')
  expect(list.getByRole('option', { name: /Критерий/ })).not.toHaveAttribute('aria-disabled')
})

test('сайдбар после «Сохранить» остаётся открытым и дальше считает свои правки: пишет их и спрашивает при закрытии', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'большой' } })
  await saveAndRead(fetchMock)

  expect(drawer.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.change(drawer.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'крупная правка' } })
  expect(drawer.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  // Схема под сайдбаром с несохранённым заперта: перестановка записала бы и его правку
  expect(region.getByRole('button', { name: 'Стадия 3 выше' }).closest('[inert]')).not.toBeNull()
  fireEvent.click(drawer.getByRole('button', { name: 'Закрыть сайдбар' }))
  expect(screen.getByRole('alertdialog', { name: 'Закрыть без сохранения?' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Вернуться' }))

  expect((await saveAndRead(fetchMock)).flows[0]).toMatchObject({ name: 'большой', when: 'крупная правка' })
})

test('действие на схеме при открытом сайдбаре без правок не делает его правку несохранённой', async () => {
  const fetchMock = stubApi(api([app], saved()))
  const region = await renderFlow()
  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')

  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  await settled()

  expect(drawer.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.click(drawer.getByRole('button', { name: 'Закрыть сайдбар' }))
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
})

test('у новой, ещё не записанной стадии удалять нечего, а записанное описание не делает окно несохранённым', async () => {
  const fetchMock = stubApi(api([app], saved()))
  await renderFlow()
  fireEvent.click(screen.getByRole('tab', { name: 'Стадии' }))
  fireEvent.click(screen.getByRole('button', { name: 'Новая стадия' }))
  const edit = within(await screen.findByRole('dialog', { name: 'Стадия «без названия»' }))
  expect(edit.queryByRole('button', { name: 'Удалить стадию' })).not.toBeInTheDocument()
  fireEvent.change(edit.getByRole('textbox', { name: 'Название стадии' }), { target: { value: 'Мерж' } })
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'sha в dev' } })

  fireEvent.click(edit.getByRole('button', { name: /Редактировать описание/ }))
  const description = within(screen.getByRole('dialog', { name: 'Описание стадии «Мерж»' }))
  fireEvent.change(description.getByRole('textbox', { name: 'Описание стадии' }), { target: { value: 'Смержить в dev.' } })
  fireEvent.click(description.getByRole('button', { name: 'Сохранить' }))
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  expect(body(fetchMock, 'POST /api/flow').stages.at(-1)).toMatchObject({ title: 'Мерж', description: 'Смержить в dev.' })
  await settled()
  fireEvent.click(description.getByRole('button', { name: 'Закрыть' }))

  expect(edit.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('задача, чей сценарий назван, но его в проекте нет, названа так, как на макете', async () => {
  stubApi(api([{ ...app, tasks: [{ task: 'B-130', flow: null, named: 'Старый' }] }]))
  await renderFlow()

  expect(screen.getByText(/^Правка стадий и сценариев закрыта/)).toHaveTextContent(
    'Правка стадий и сценариев закрыта — задача B-130 идёт по сценарию, которого в проекте нет',
  )
})

test('действие, после которого флоу остался бы с ошибкой, не пишется и называет её; действие, которое её убирает, пишется', async () => {
  const broken: NamedFlow = { ...full, entries: [...full.entries, { stage: 'Сборка' }] }
  const fetchMock = stubApi(api([{ ...app, flows: [broken, small] }], saved()))
  const region = await renderFlow()
  expect(screen.getByText(/^Не сохранить: флоу «полный», стадия «Сборка» — стадии нет в базе/)).toBeInTheDocument()

  // Перестановка ошибку не убирает — записи нет, отказ назван
  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))
  // Над разделом — строка о флоу, а отказ действия её не повторяет
  expect(await screen.findByText('Действие не записано: флоу остался бы с ошибкой, названной выше.')).toBeInTheDocument()
  expect(screen.getAllByText(/^Не сохранить: флоу «полный», стадия «Сборка»/)).toHaveLength(1)
  expect(posts(fetchMock)).toBe(0)

  // Уборка стадии, которой нет в базе, флоу чинит — пишется
  fireEvent.click(menuOf(region, /^Стадия 4: Сборка/).getByRole('menuitem', { name: 'Убрать из сценария' }))
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(1))
  expect(body(fetchMock, 'POST /api/flow').flows[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual([
    'Критерий',
    'Ревью',
    'Приёмка',
  ])
})

test('ошибка в занятой стадии не запирает запись остального проекта', async () => {
  const fetchMock = stubApi(
    api([{ ...app, stages: [criterion, { ...review, executor: 'doc-writer' }, acceptance, spare], tasks: [{ task: 'B-7', flow: 'мелкий' }] }], saved()),
  )
  await renderFlow()
  // Ревью стоит в занятом «мелком»: её не починить, пока задача идёт, — и её ошибка не останавливает остальное
  expect(screen.queryByText(/^Не сохранить/)).not.toBeInTheDocument()

  const free = await stagesTab('Запас')
  fireEvent.change(free.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'кое-что' } })
  expect((await saveAndRead(fetchMock)).stages[3].output).toBe('кое-что')
})

test('у единственного сценария без «когда», по которому идёт задача, «когда» вписывается в окне нового сценария', async () => {
  const fetchMock = stubApi(api([{ ...app, flows: [{ ...full, when: null }], tasks: [{ task: 'B-7', flow: 'полный' }] }], saved()))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Новый сценарий' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'срочный' } })
  fireEvent.change(dialog.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'ошибка на панели' } })
  fireEvent.click(within(dialog.getByRole('radiogroup', { name: 'Первая стадия' })).getByRole('radio', { name: /Запас/ }))
  expect(dialog.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.change(dialog.getByRole('textbox', { name: 'Когда брать сценарий «полный»' }), { target: { value: 'обычная задача' } })

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows.map((f: NamedFlow) => [f.name, f.when])).toEqual([
    ['полный', 'обычная задача'],
    ['срочный', 'ошибка на панели'],
  ])
  // Порядок и стадии занятого сценария не тронуты
  expect(sent.flows[0].entries).toEqual(full.entries.map((entry) => ({ stage: entry.stage, returns: entry.returns ?? [] })))
})

test('незаписанный новый сценарий и описание со схемы уходят с окном: следующее действие их не записывает', async () => {
  let refuse = true
  const fetchMock = stubApi(
    api([app], { 'POST /api/flow': () => (refuse ? json({ problem: 'not-committed', detail: 'hook' }, 502) : json({ version: 'v3' })) }),
  )
  const region = await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Новый сценарий' }))
  fireEvent.change(dialog.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'срочный' } })
  fireEvent.change(dialog.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'ошибка' } })
  fireEvent.click(within(dialog.getByRole('radiogroup', { name: 'Первая стадия' })).getByRole('radio', { name: /Запас/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Сохранить' }))
  await dialog.findByRole('alert')
  fireEvent.click(dialog.getByRole('button', { name: 'Отмена' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))

  fireEvent.click(menuOf(region, 'Стадия 3: Приёмка').getByRole('menuitem', { name: 'Редактировать описание' }))
  const text = await screen.findByRole('textbox', { name: 'Описание стадии' })
  fireEvent.change(text, { target: { value: 'черновик' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByRole('alert')
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть описание' }))
  fireEvent.click(screen.getByRole('button', { name: 'Не сохранять' }))
  await settled()

  refuse = false
  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))
  await vi.waitFor(() => expect(posts(fetchMock)).toBe(3))
  const sent = body(fetchMock, 'POST /api/flow')
  expect(sent.flows.map((f: NamedFlow) => f.name)).toEqual(['полный', 'мелкий'])
  expect(sent.stages.find((stage: FlowStage) => stage.title === 'Приёмка').description).toBeNull()
})

test('ошибку формы кита в занятой стадии видно заранее: её не обойдёт и API', async () => {
  stubApi(api([{ ...app, stages: [criterion, { ...review, output: '' }, acceptance, spare], tasks: [{ task: 'B-7', flow: 'мелкий' }] }]))
  await renderFlow()

  expect(screen.getByText('Не сохранить: стадия «Ревью» — не указан выход')).toBeInTheDocument()
})

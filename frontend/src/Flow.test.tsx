import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Flow, { type BaseFlow, type FlowStage, type NamedFlow, type StagePreset } from './Flow'

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
  activeTasks: 0,
  version: 'v1',
  error: null,
  icons: { Критерий: 'target' },
}
const nota: BaseFlow = {
  base: 'D:\\Projects\\nota-knowledge',
  project: 'Nota',
  stages: [],
  flows: [],
  activeTasks: 0,
  version: 'v2',
  error: null,
  icons: {},
}

type Handler = (init?: RequestInit) => Response

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    const handler = handlers[key] ?? (key.startsWith('DELETE /api/presets/') ? handlers['DELETE /api/presets'] : undefined)
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

const api = (flows: BaseFlow[], presets: StagePreset[] = [], extra: Record<string, Handler> = {}) => ({
  'GET /api/flow': () => json(flows),
  'GET /api/presets': () => json(presets),
  // Флоу, зовущий незаведённого исполнителя, не сохраняется — поэтому по умолчанию заведены все, кого зовут стадии.
  'GET /api/performers': () => json(performers(['reviewer', 'scout', 'check-runner', 'e2e-runner'])),
  ...extra,
})

const saved = () => ({ 'POST /api/flow': () => json({ version: 'v3' }) })

const body = (fetchMock: ReturnType<typeof stubApi>, key: string) => {
  const call = fetchMock.mock.calls.find(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
  return call ? JSON.parse(String(call[1]?.body)) : undefined
}

/** Раздел открывается вкладкой «Флоу» на первом флоу базы. */
async function renderFlow(props: { onPerformers?: () => void } = {}, flowName = 'полный') {
  render(<Flow {...props} />)
  const region = within(await screen.findByRole('region', { name: `Сценарий «${flowName}»` }))
  return region
}

/** Сайдбар стадии или флоу: открывается кликом по блоку схемы. */
async function open(region: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.click(region.getByRole('button', { name }))
  return within(await screen.findByRole('complementary'))
}

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

/** Окно правки стадии закрывается «Готово»: правки остаются в полосе сохранения, а она — под окном. */
function closeStage() {
  const stage = screen.queryByRole('dialog', { name: /^Стадия «/ })
  if (stage) fireEvent.click(within(stage).getByRole('button', { name: 'Готово' }))
}

async function saveAndRead(fetchMock: ReturnType<typeof stubApi>) {
  closeStage()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
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
  const fetchMock = stubApi(api([app], [], saved()))
  const region = await renderFlow()

  const drawer = await open(region, 'Сценарий «полный»: название и «когда»')
  expect(drawer.getByRole('textbox', { name: 'Название сценария' })).toHaveValue('полный')
  expect(drawer.getByRole('textbox', { name: 'Когда брать сценарий' })).toHaveValue('новая возможность')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название сценария' }), { target: { value: 'большой' } })
  fireEvent.change(drawer.getByRole('textbox', { name: 'Когда брать сценарий' }), { target: { value: 'правка в нескольких местах' } })

  expect(screen.getByRole('region', { name: 'Сценарий «большой»' })).toBeInTheDocument()
  expect(screen.getByText('есть несохранённые правки')).toBeInTheDocument()
  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[0]).toMatchObject({ name: 'большой', when: 'правка в нескольких местах' })

  const renamed = within(screen.getByRole('region', { name: 'Сценарий «большой»' }))
  fireEvent.click((await open(renamed, /^Сценарий «большой»/)).getByRole('button', { name: 'Удалить сценарий' }))
  expect(await screen.findByRole('region', { name: 'Сценарий «мелкий»' })).toBeInTheDocument()
})

test('новый сценарий заводится у списка флоу и открыт в сайдбаре; пустой не сохранить', async () => {
  stubApi(api([app]))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))

  const region = within(await screen.findByRole('region', { name: 'Сценарий «новый сценарий»' }))
  expect(nodes(region)).toHaveLength(0)
  const drawer = within(screen.getByRole('complementary'))
  expect(drawer.getByRole('textbox', { name: 'Название сценария' })).toHaveValue('новый сценарий')
  // На вкладке «Сценарии» конкретный флоу зовётся сценарием
  expect(drawer.getByText('Название сценария')).toBeInTheDocument()
  expect(drawer.getByText('сценарий')).toBeInTheDocument()
  expect(drawer.getByRole('textbox', { name: 'Когда брать сценарий' })).toHaveAttribute('placeholder', 'какие задачи вести этим сценарием')
  expect(drawer.getByRole('button', { name: 'Удалить сценарий' })).toBeInTheDocument()
  expect(screen.getByText(/Не сохранить: флоу «новый сценарий» — не указано «когда», во флоу нет стадий/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('при двух флоу у каждого нужно «когда», при одном — нет', async () => {
  stubApi(api([{ ...app, flows: [{ ...full, when: null }] }]))
  const region = await renderFlow()
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Новый сценарий' }))
  expect(screen.getByText(/Не сохранить: флоу «полный» — не указано «когда»/)).toBeInTheDocument()
  expect(region).toBeDefined()
})

test('стадия во флоу открывает сайдбар с её возвратами в этом флоу, а кнопка после возвратов ведёт к её правке', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  const drawer = await open(region, 'Стадия 2: Ревью')

  expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Стадия 2: Ревью')
  // Поля самой стадии правятся на вкладке «Стадии», а не здесь
  expect(drawer.queryByRole('textbox', { name: 'Выход стадии' })).not.toBeInTheDocument()
  // Название в шапке — не ссылка: к правке ведёт кнопка сразу после возвратов
  expect(within(drawer.getByRole('heading', { name: 'Ревью' })).queryByRole('button')).not.toBeInTheDocument()
  const add = drawer.getByRole('button', { name: 'Добавить возврат' })
  const edit = drawer.getByRole('button', { name: 'Править стадию «Ревью»' })
  expect(add.compareDocumentPosition(edit) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(drawer.getByRole('button', { name: 'Закрыть сайдбар' })).toBeInTheDocument()

  fireEvent.click(edit)

  expect(screen.getByRole('tab', { name: 'Стадии' })).toHaveAttribute('aria-selected', 'true')
  const dialog = within(screen.getByRole('dialog', { name: 'Стадия «Ревью»' }))
  expect(dialog.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт по sha')
})

test('возврат правится у стадии в своём флоу: цель — только стадии этого флоу, стоящие раньше', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
  const region = await renderFlow()
  const drawer = await open(region, 'Стадия 3: Приёмка')

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

  const drawer = await open(region, /^Стадия 3: Приёмка/)
  fireEvent.click(drawer.getByRole('button', { name: 'Убрать возврат 1' }))
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('возвраты нарисованы дугами: у открытой стадии дуга подсвечена и подписана условием', async () => {
  stubApi(api([app]))
  await renderFlow()
  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  fireEvent.click(screen.getByRole('option', { name: 'мелкий' }))
  const region = within(screen.getByRole('region', { name: 'Сценарий «мелкий»' }))

  expect(document.querySelectorAll('.flow-arc')).toHaveLength(1)
  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(0)

  await open(region, /^Стадия 2: Приёмка/)

  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(1)
  expect(document.querySelector('.flow-arc-label')).toHaveTextContent('замечания')
})

test('стадии флоу переставляются перетаскиванием и кнопками с клавиатуры', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
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

  fireEvent.click(region.getByRole('button', { name: 'Стадия 3 выше' }))
  expect(labels(region)).toEqual(['Стадия 1: Приёмка', 'Стадия 2: Ревью', 'Стадия 3: Критерий'])
  expect(region.getByRole('button', { name: 'Стадия 1 выше' })).toBeDisabled()

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[0].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Приёмка', 'Ревью', 'Критерий'])
  // Стадии базы не переписаны: поменялся только порядок во флоу
  expect(sent.stages).toEqual(app.stages)
})

test('стадия убирается из флоу, а в базе остаётся', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
  const region = await renderFlow()

  fireEvent.click((await open(region, 'Стадия 1: Критерий')).getByRole('button', { name: 'Убрать из сценария' }))

  expect(labels(region)).toEqual(['Стадия 1: Ревью', 'Стадия 2: Приёмка'])
  const sent = await saveAndRead(fetchMock)
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toContain('Критерий')
})

test('вкладка «Стадии»: все стадии базы, и правка стадии видна во всех флоу, где она стоит', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
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

test('стадию, стоящую во флоу, не удалить; стоящую вне флоу — удалить', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
  await renderFlow()

  const used = await stagesTab('Ревью')
  expect(used.getByRole('button', { name: 'Удалить стадию' })).toBeDisabled()

  const free = await stagesTab('Запас')
  fireEvent.click(free.getByRole('button', { name: 'Удалить стадию' }))

  expect(within(screen.getByRole('list', { name: 'Стадии базы' })).queryByText('Запас')).not.toBeInTheDocument()
  const sent = await saveAndRead(fetchMock)
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toEqual(['Критерий', 'Ревью', 'Приёмка'])
})

test('новая стадия заводится на вкладке «Стадии» и без названия и выхода не сохраняется', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
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

test('стадия правится окном по щелчку на карточке: «Готово» закрывает окно, правка ждёт в полосе сохранения', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
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
  expect(edit.getByRole('button', { name: 'В пресеты' })).toBeInTheDocument()
  expect(edit.getByRole('button', { name: 'Удалить стадию' })).toBeDisabled()
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'вердикт' } })

  fireEvent.click(edit.getByRole('button', { name: 'Готово' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByText('есть несохранённые правки')).toBeInTheDocument()
  // Окно ничего не пишет само: запись — кнопкой полосы
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()

  // Escape закрывает верхнее окно: сначала описание, потом правку
  const again = await stagesTab('Ревью')
  expect(again.getByRole('textbox', { name: 'Выход стадии' })).toHaveValue('вердикт')
  fireEvent.click(again.getByRole('button', { name: /Редактировать описание/ }))
  fireEvent.keyDown(screen.getByRole('textbox', { name: 'Описание стадии' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: /^Описание стадии/ })).not.toBeInTheDocument()
  const stage = screen.getByRole('dialog', { name: 'Стадия «Ревью»' })
  // Открытый список значков Escape закрывает первым, окно остаётся
  fireEvent.click(within(stage).getByRole('button', { name: 'Значок стадии' }))
  fireEvent.keyDown(within(stage).getByRole('button', { name: 'Значок «код»' }), { key: 'Escape' })
  expect(within(stage).queryByRole('group', { name: 'Значки стадии' })).not.toBeInTheDocument()
  expect(stage).toBeInTheDocument()
  fireEvent.keyDown(within(stage).getByRole('textbox', { name: 'Выход стадии' }), { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  expect((await saveAndRead(fetchMock)).stages[1].output).toBe('вердикт')
})

test('описание стадии правится в окне по кнопке, у стадии без описания кнопка приглушена', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
  await renderFlow()

  const empty = (await stagesTab('Приёмка')).getByRole('button', { name: /Редактировать описание/ })
  expect(empty).toHaveClass('flow-description-empty')

  const edit = await stagesTab('Ревью')
  fireEvent.click(edit.getByRole('button', { name: /Редактировать описание/ }))
  const dialog = within(screen.getByRole('dialog', { name: 'Описание стадии «Ревью»' }))
  const text = dialog.getByRole('textbox', { name: 'Описание стадии' })
  expect(text).toHaveValue('1. Собрать дифф всей ветки.')
  fireEvent.change(text, { target: { value: 'Ревью по диффу.\n\n1. Собрать дифф.' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Готово' }))

  expect(screen.queryByRole('dialog', { name: /^Описание стадии/ })).not.toBeInTheDocument()
  expect((await saveAndRead(fetchMock)).stages[1].description).toBe('Ревью по диффу.\n\n1. Собрать дифф.')
})

test('значок стадии выбирается из списка значков и уходит в запись', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
  await renderFlow()
  const edit = await stagesTab('Приёмка')

  fireEvent.click(edit.getByRole('button', { name: 'Значок стадии' }))
  const menu = within(screen.getByRole('group', { name: 'Значки стадии' }))
  // В списке сами значки, а не их названия
  expect(menu.getAllByRole('button').map((button) => button.textContent)).toEqual(['', '', '', '', '', ''])
  fireEvent.click(menu.getByRole('button', { name: 'Значок «проверка»' }))

  expect((await saveAndRead(fetchMock)).icons).toEqual({ Критерий: 'target', Приёмка: 'check' })
})

test('в окне добавления — новая стадия, стадии базы, которых во флоу нет, и пресеты', async () => {
  const fetchMock = stubApi(api([app], [{ ...spare, title: 'Мерж', output: 'sha в dev', slug: null, id: 'p1' }], saved()))
  const region = await renderFlow()
  await open(region, 'Сценарий «полный»: название и «когда»')
  fireEvent.click(screen.getByRole('button', { name: 'Сценарий: полный' }))
  fireEvent.click(screen.getByRole('option', { name: 'мелкий' }))

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Добавить стадию в сценарий «мелкий»' }))
  const own = within(dialog.getByRole('group', { name: 'Стадии базы' }))
  expect(own.getAllByRole('button').map((button) => button.querySelector('.flow-preset-title')?.textContent)).toEqual([
    'Критерий',
    'Запас',
  ])
  fireEvent.click(own.getByRole('button', { name: /^Критерий/ }))

  const small = within(screen.getByRole('region', { name: 'Сценарий «мелкий»' }))
  expect(labels(small)).toContain('Стадия 3: Критерий')
  // Добавленная стадия сразу открыта в сайдбаре
  expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Стадия 3: Критерий')

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Пресеты стадий' })).getByRole('button', { name: /^Мерж/ }))
  expect(labels(small)).toContain('Стадия 4: Мерж')

  const sent = await saveAndRead(fetchMock)
  expect(sent.flows[1].entries.map((entry: { stage: string }) => entry.stage)).toEqual(['Ревью', 'Приёмка', 'Критерий', 'Мерж'])
  // Стадия из пресета заводится в базе новой, стадия базы — нет
  expect(sent.stages.map((stage: FlowStage) => stage.title)).toEqual(['Критерий', 'Ревью', 'Приёмка', 'Запас', 'Мерж'])
  expect(sent.stages[4].slug).toBeNull()
})

test('«Новая стадия» из окна добавления ставится во флоу и открывается на вкладке «Стадии»', async () => {
  stubApi(api([app]))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Добавить стадию в сценарий «полный»' }))
  expect(dialog.getByText('Пресетов пока нет.')).toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: /^Новая стадия/ }))

  expect(screen.getByRole('tab', { name: 'Стадии' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('dialog', { name: 'Стадия «без названия»' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  expect(labels(within(screen.getByRole('region', { name: 'Сценарий «полный»' })))).toContain('Стадия 4: без названия')
})

test('пресет сохраняется со вкладки «Стадии» без помощников и удаляется из окна добавления', async () => {
  const fetchMock = stubApi(
    api([{ ...app, stages: [{ ...criterion, helpers: ['scout'] }, review, acceptance, spare] }], [], {
      'POST /api/presets': () => json({ ...criterion, helpers: [], slug: null, id: 'p1' }),
      'DELETE /api/presets': () => new Response(null, { status: 204 }),
    }),
  )
  await renderFlow()
  const edit = await stagesTab('Критерий')

  fireEvent.click(edit.getByRole('button', { name: 'В пресеты' }))

  expect(await screen.findByRole('button', { name: 'Стадия в пресетах' })).toBeDisabled()
  expect(body(fetchMock, 'POST /api/presets')).toMatchObject({ title: 'Критерий', helpers: [], slug: null })

  fireEvent.click(screen.getByRole('tab', { name: 'Сценарии' }))
  fireEvent.click(screen.getByRole('button', { name: 'Добавить стадию' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить пресет Критерий' }))
  await vi.waitFor(() => expect(screen.queryByRole('button', { name: 'Удалить пресет Критерий' })).not.toBeInTheDocument())
})

test('исполнитель стадии выбирается из заведённых, незаведённый не даёт сохранить флоу', async () => {
  stubApi(api([app], [], { 'GET /api/performers': () => json(performers(['e2e-runner'])) }))
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
  stubApi(api([app], [], { 'GET /api/performers': () => new Response('', { status: 500 }) }))
  const region = await renderFlow()

  expect(await screen.findByText(/Список исполнителей не прочитан/)).toBeInTheDocument()
  expect(nodes(region)[1].querySelector('.flow-node-missing')).toBeNull()
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
  expect((await stagesTab('Ревью')).getByRole('combobox', { name: 'Имя субагента' })).toHaveDisplayValue('reviewer')
})

test('помощники есть только у стадии оркестратора и стираются при смене исполнителя', async () => {
  const fetchMock = stubApi(api([{ ...app, stages: [{ ...criterion, helpers: ['scout'] }, review, acceptance, spare] }], [], saved()))
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

test('при задачах в работе сохранение спрашивает подтверждение и говорит, сколько их', async () => {
  const fetchMock = stubApi(api([{ ...app, activeTasks: 2 }], [], saved()))
  await renderFlow()
  const edit = await stagesTab('Критерий')
  fireEvent.change(edit.getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий в памяти' } })
  closeStage()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Сохранить флоу Agents Kit Web?' }))
  expect(dialog.getByText(/На проекте 2 задачи в работе\. Они дойдут по старым стадиям/)).toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'Отмена' }))
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Сохранить' }))
  expect(await screen.findByText('Флоу сохранён и закоммичен в базу')).toBeInTheDocument()
})

test('запись уходит целиком: база, отпечаток, стадии, флоу и значки', async () => {
  const fetchMock = stubApi(api([app], [], saved()))
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

test('«Отменить правки» возвращает флоу базы и убирает полосу сохранения', async () => {
  const fetchMock = stubApi(api([app]))
  const region = await renderFlow()

  fireEvent.click((await open(region, 'Стадия 3: Приёмка')).getByRole('button', { name: 'Убрать из сценария' }))
  expect(nodes(region)).toHaveLength(2)
  // Пока правки не записаны, проект не переключить и базу не перечитать
  expect(screen.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeDisabled()
  expect(moreItem('Обновить')).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Отменить правки' }))

  expect(nodes(region)).toHaveLength(3)
  expect(screen.queryByText('есть несохранённые правки')).not.toBeInTheDocument()
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()
})

test('отказы записи названы словами, а правки остаются', async () => {
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'not-committed', detail: 'сверка: флоу не прошёл' }, 502) }))
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
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'stage-twice', flow: 'мелкий', stage: 'Ревью' }, 400) }))
  await renderFlow()
  fireEvent.change((await stagesTab('Критерий')).getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(
    await screen.findByText('Флоу не сохранён: флоу «мелкий», стадия «Ревью» — стадия дважды в одном флоу'),
  ).toBeInTheDocument()

  vi.unstubAllGlobals()
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  expect(await screen.findByText(/флоу изменился в базе, пока вы его правили/)).toBeInTheDocument()
})

test('проект без флоу — пустое состояние с одной кнопкой «Создать первый флоу»', async () => {
  stubApi(api([nota]))
  render(<Flow />)

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет флоу' })).toBeInTheDocument()
  expect(screen.queryByRole('tab')).not.toBeInTheDocument()
  // Открывать в VS Code нечего: в меню одно «Обновить»
  expect(moreItem('Обновить')).toBeEnabled()
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Создать первый флоу' }))

  expect(await screen.findByRole('region', { name: 'Сценарий «новый сценарий»' })).toBeInTheDocument()
  expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Сценарий «новый сценарий»')
  // Одному флоу «когда» не нужно, но стадия нужна
  expect(screen.getByText('Не сохранить: флоу «новый сценарий» — во флоу нет стадий')).toBeInTheDocument()
})

test('база, которую панель не прочитала, названа словами', async () => {
  stubApi(api([{ ...nota, version: null, error: 'База не найдена на диске' }]))
  render(<Flow />)

  expect(await screen.findByText('База не найдена на диске')).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'В этом проекте нет флоу' })).not.toBeInTheDocument()
})

test('проект выбирается списком в шапке; «Переписать с Чудо-Юдо» в меню нет', async () => {
  stubApi(api([app, nota]))
  await renderFlow()

  expect(moreItem('Открыть в VS Code')).toBeEnabled()
  expect(screen.queryByRole('menuitem', { name: /Переписать/ })).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Проект: Agents Kit Web' }))
  fireEvent.click(within(screen.getByRole('listbox', { name: 'Проект' })).getByRole('option', { name: 'Nota' }))

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет флоу' })).toBeInTheDocument()
})

test('«Открыть в VS Code» просит API открыть флоу этой базы', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow/open': () => new Response(null, { status: 204 }) }))
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

test('удалённый единственный флоу сохраняется или отменяется из полосы внизу пустого состояния', async () => {
  const fetchMock = stubApi(api([{ ...app, flows: [full] }], [], saved()))
  const region = await renderFlow()

  fireEvent.click((await open(region, /^Сценарий «полный»/)).getByRole('button', { name: 'Удалить сценарий' }))

  expect(await screen.findByRole('heading', { name: 'В этом проекте нет флоу' })).toBeInTheDocument()
  expect(screen.getByText('есть несохранённые правки')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Отменить правки' }))
  expect(await screen.findByRole('region', { name: 'Сценарий «полный»' })).toBeInTheDocument()

  fireEvent.click((await open(within(screen.getByRole('region', { name: 'Сценарий «полный»' })), /^Сценарий «полный»/)).getByRole('button', { name: 'Удалить сценарий' }))
  expect((await saveAndRead(fetchMock)).flows).toEqual([])
})

test('строки файлов флоу, которые панель не сохранит, названы в полосе и запирают запись', async () => {
  stubApi(api([{ ...app, unread: ['flow/flow.md, строка 14: «3. Мерж»'] }]))
  await renderFlow()

  expect(
    screen.getByText(
      'Не сохранить: в файлах флоу есть строка, которую панель не сохранит, — flow/flow.md, строка 14: «3. Мерж». Поправьте её в файле: «…» → «Открыть в VS Code»',
    ),
  ).toBeInTheDocument()
  // Правки в форме не отпирают запись: строку чинят в самом файле
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
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'not-written', detail: 'Файл занят.' }, 502) }))
  await renderFlow()
  fireEvent.change((await stagesTab('Критерий')).getByRole('textbox', { name: 'Выход стадии' }), { target: { value: 'критерий' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(
    await screen.findByText('Флоу не сохранён: файл флоу не записался, файлы возвращены как были. Файл занят.'),
  ).toBeInTheDocument()
})

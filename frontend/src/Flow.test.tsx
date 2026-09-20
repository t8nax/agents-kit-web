import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Flow, { type BaseFlow, type FlowStep, type StepPreset } from './Flow'

afterEach(() => vi.unstubAllGlobals())

const criterion: FlowStep = {
  title: 'Критерий',
  executor: 'оркестратор',
  output: 'критерий закрытия в памяти',
  skip: null,
  description: '1.1. Написать критерий до первой строчки кода.',
  returns: [],
  helpers: [],
}
const review: FlowStep = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha',
  skip: 'правка только в текстах',
  description: '2.1. Собрать дифф всей ветки.',
  returns: [],
  helpers: [],
}
const acceptance: FlowStep = {
  title: 'Приёмка',
  executor: 'оператор',
  output: 'ответ оператора «принято»',
  skip: null,
  description: null,
  returns: [],
  helpers: [],
}

const app: BaseFlow = {
  base: 'D:\\Projects\\app-knowledge',
  project: 'Agents Kit Web',
  steps: [criterion, review, acceptance],
  activeTasks: 0,
  version: 'v1',
  error: null,
  icons: { Критерий: 'target' },
}
const nota: BaseFlow = {
  base: 'D:\\Projects\\nota-knowledge',
  project: 'Nota',
  steps: [],
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

const api = (flows: BaseFlow[], presets: StepPreset[] = [], extra: Record<string, Handler> = {}) => ({
  'GET /api/flow': () => json(flows),
  'GET /api/presets': () => json(presets),
  // Раздел спрашивает заведённых в базе исполнителей: из них шагу выбирают субагента, и флоу,
  // зовущий незаведённого, не сохраняется — поэтому по умолчанию заведены все, кого зовут шаги.
  'GET /api/performers': () => json(performers(['reviewer', 'scout', 'check-runner', 'e2e-runner'])),
  // Окно переписывания спрашивает панель, не идёт ли уже такая просьба.
  'GET /api/agent/requests': () => json([]),
  ...extra,
})

const body = (fetchMock: ReturnType<typeof stubApi>, key: string) => {
  const call = fetchMock.mock.calls.find(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
  return call ? JSON.parse(String(call[1]?.body)) : undefined
}

async function renderFlow(withSteps = true, props: { onPerformers?: () => void } = {}) {
  render(<Flow {...props} />)
  const region = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  // Шаги базы кладутся в форму после отрисовки раздела: без них блоков на схеме ещё нет.
  if (withSteps) await screen.findByRole('button', { name: /^Шаг 1: / })
  return region
}

/** Сайдбар шага: открывается кликом по блоку схемы. */
async function openStep(region: ReturnType<typeof within>, name: string | RegExp) {
  fireEvent.click(region.getByRole('button', { name }))
  return within(await screen.findByRole('complementary'))
}

const nodes = (region: ReturnType<typeof within>): HTMLElement[] =>
  region
    .getAllByRole('button')
    .filter(
      (button: HTMLElement) =>
        button.classList.contains('flow-node') && !button.classList.contains('flow-node-add'),
    )

test('шаги показаны блоками схемы: значок, название и исполнитель, без номера', async () => {
  stubApi(api([{ ...app, activeTasks: 2 }, nota]))

  const region = await renderFlow()

  const steps = nodes(region)
  expect(steps.map((step: HTMLElement) => step.getAttribute('aria-label'))).toEqual([
    'Шаг 1: Критерий',
    'Шаг 2: Ревью',
    'Шаг 3: Приёмка',
  ])
  expect(within(steps[1]).getByText('субагент reviewer')).toBeInTheDocument()
  // Номера шага на блоке нет, как и выхода с пропуском — они в сайдбаре
  expect(steps[0]).toHaveTextContent(/^Критерий/)
  expect(region.queryByText('вердикт по sha')).not.toBeInTheDocument()
  // Флажок стоит у шага с условием пропуска
  expect(steps[1].querySelector('.flow-node-skip')).not.toBeNull()
  expect(steps[0].querySelector('.flow-node-skip')).toBeNull()
  // Значок шага — выбранный оператором, у остальных — по исполнителю
  expect(steps[0].querySelector('.flow-mark-orchestrator')).not.toBeNull()
  expect(steps[2].querySelector('.flow-mark-operator')).not.toBeNull()
})

test('клик по блоку открывает сайдбар с выходом, пропуском и описанием шага', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  const drawer = await openStep(region, 'Шаг 2: Ревью')

  expect(screen.getByRole('complementary')).toHaveAttribute('aria-label', 'Шаг 2: Ревью')
  expect(drawer.getByRole('textbox', { name: 'Название шага' })).toHaveValue('Ревью')
  expect(drawer.getByRole('combobox', { name: 'Имя субагента' })).toHaveValue('reviewer')
  expect(drawer.getByRole('textbox', { name: 'Выход шага' })).toHaveValue('вердикт по sha')
  expect(drawer.getByRole('textbox', { name: 'Пропуск шага' })).toHaveValue('правка только в текстах')
  // Описание правится своим окном, а не полем сайдбара
  expect(drawer.queryByRole('textbox', { name: 'Описание шага' })).not.toBeInTheDocument()

  fireEvent.click(drawer.getByRole('button', { name: 'Закрыть сайдбар' }))
  expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
})

test('описание шага правится в окне по кнопке, у шага без описания кнопка приглушена', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await renderFlow()

  const empty = (await openStep(region, 'Шаг 3: Приёмка')).getByRole('button', { name: /Редактировать описание/ })
  expect(empty).toHaveClass('flow-description-empty')
  expect(empty).toHaveAttribute('title', 'Описания нет — добавить')

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  const button = drawer.getByRole('button', { name: /Редактировать описание/ })
  expect(button).not.toHaveClass('flow-description-empty')
  fireEvent.click(button)

  const dialog = within(screen.getByRole('dialog', { name: 'Описание шага «Ревью»' }))
  const text = dialog.getByRole('textbox', { name: 'Описание шага' })
  expect(text).toHaveValue('2.1. Собрать дифф всей ветки.')
  fireEvent.change(text, { target: { value: 'Ревью по диффу.\n\n2.1. Собрать дифф всей ветки.' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Готово' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[1].description).toBe(
    'Ревью по диффу.\n\n2.1. Собрать дифф всей ветки.',
  )
})

test('проект выбирается чипами, база без шагов названа словами', async () => {
  stubApi(api([app, nota]))
  await renderFlow()


  fireEvent.click(screen.getByRole('button', { name: 'Nota' }))

  const region = within(screen.getByRole('region', { name: 'Nota' }))
  expect(region.getByText(/Во флоу пока нет шагов/)).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
})

test('база без файла флоу названа словами, и править её нечего', async () => {
  stubApi(api([{ ...app, steps: [], version: null, error: 'В базе нет flow.md' }]))

  const region = await renderFlow(false)

  expect(region.getByText(/В базе нет файла флоу/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Открыть в VS Code' })).not.toBeInTheDocument()
})

test('«Открыть в VS Code» просит API открыть флоу этой базы', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow/open': () => new Response(null, { status: 204 }) }))
  await renderFlow(false)

  fireEvent.click(screen.getByRole('button', { name: 'Открыть в VS Code' }))

  await vi.waitFor(() => expect(body(fetchMock, 'POST /api/flow/open')).toEqual({ base: app.base }))
})

test('шаг правится в сайдбаре сразу, без режима правки: появляются «Сохранить» и «Отменить правки»', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await renderFlow()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  const drawer = await openStep(region, 'Шаг 1: Критерий')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название шага' }), { target: { value: 'Критерий закрытия' } })

  expect(screen.getByText('есть несохранённые правки')).toBeInTheDocument()
  expect(nodes(region)[0]).toHaveTextContent(/^Критерий закрытия/)
  // Пока правки не записаны, флоу другого проекта не откроешь и файл базы не перечитаешь
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeDisabled()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Флоу сохранён и закоммичен в базу')).toBeInTheDocument()
  expect(body(fetchMock, 'POST /api/flow')).toEqual({
    base: app.base,
    version: 'v1',
    steps: [{ ...criterion, title: 'Критерий закрытия' }, review, acceptance],
    // Значок остаётся у шага: переименование в панели его не теряет
    icons: { 'Критерий закрытия': 'target' },
  })
})

test('«Отменить правки» возвращает шаги базы', async () => {
  const fetchMock = stubApi(api([app]))
  const region = await renderFlow()

  const drawer = await openStep(region, 'Шаг 3: Приёмка')
  fireEvent.click(drawer.getByRole('button', { name: 'Удалить шаг' }))
  expect(nodes(region)).toHaveLength(2)

  fireEvent.click(screen.getByRole('button', { name: 'Отменить правки' }))

  expect(nodes(region)).toHaveLength(3)
  expect(screen.queryByText('есть несохранённые правки')).not.toBeInTheDocument()
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()
})

test('значок шага выбирается из списка значков и уходит в запись', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 3: Приёмка')

  fireEvent.click(drawer.getByRole('button', { name: 'Значок шага' }))
  const menu = within(screen.getByRole('group', { name: 'Значки шага' }))
  // В списке сами значки, а не их названия
  expect(menu.getAllByRole('button').map((button) => button.textContent)).toEqual(['', '', '', '', '', ''])
  fireEvent.click(menu.getByRole('button', { name: 'Значок «проверка»' }))

  expect(screen.queryByRole('group', { name: 'Значки шага' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').icons).toEqual({ Критерий: 'target', Приёмка: 'check' })
})

test('шаг переставляется перетаскиванием блока, номера пунктов описания идут за шагом', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
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

  expect(nodes(region).map((node: HTMLElement) => node.getAttribute('aria-label'))).toEqual([
    'Шаг 1: Приёмка',
    'Шаг 2: Критерий',
    'Шаг 3: Ревью',
  ])
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  const steps: FlowStep[] = body(fetchMock, 'POST /api/flow').steps
  expect(steps.map((step) => step.title)).toEqual(['Приёмка', 'Критерий', 'Ревью'])
  expect(steps[1].description).toBe('2.1. Написать критерий до первой строчки кода.')
  expect(steps[2].description).toBe('3.1. Собрать дифф всей ветки.')
})

test('шаг двигается кнопками с клавиатуры', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  fireEvent.click(region.getByRole('button', { name: 'Шаг 2 выше' }))

  expect(nodes(region).map((node: HTMLElement) => node.getAttribute('aria-label'))).toEqual([
    'Шаг 1: Ревью',
    'Шаг 2: Критерий',
    'Шаг 3: Приёмка',
  ])
  expect(region.getByRole('button', { name: 'Шаг 1 выше' })).toBeDisabled()
  expect(region.getByRole('button', { name: 'Шаг 3 ниже' })).toBeDisabled()
})

test('шаг без выхода или без имени субагента не сохранить, и сказано почему', async () => {
  stubApi(api([app]))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 2: Ревью')

  fireEvent.change(drawer.getByRole('textbox', { name: 'Выход шага' }), { target: { value: ' ' } })
  fireEvent.change(drawer.getByRole('combobox', { name: 'Имя субагента' }), { target: { value: '' } })

  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  expect(screen.getByText('Не сохранить: шаг 2 — не указано имя субагента, не указан выход')).toBeInTheDocument()
  expect(nodes(region)[1]).toHaveClass('invalid')

  fireEvent.change(drawer.getByRole('combobox', { name: 'Исполнитель шага' }), { target: { value: 'оператор' } })
  fireEvent.change(drawer.getByRole('textbox', { name: 'Выход шага' }), { target: { value: 'вердикт' } })
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
})

test('при задачах в работе сохранение спрашивает подтверждение и говорит, сколько их', async () => {
  const fetchMock = stubApi(api([{ ...app, activeTasks: 2 }], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Выход шага' }), { target: { value: 'критерий в памяти' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Сохранить флоу Agents Kit Web?' }))
  expect(dialog.getByText(/На проекте 2 задачи в работе\. Они дойдут по старым шагам/)).toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Сохранить' }))
  expect(await screen.findByText('Флоу сохранён и закоммичен в базу')).toBeInTheDocument()
})

test('отказы записи названы словами, а правки остаются на схеме', async () => {
  stubApi(
    api([app], [], {
      'POST /api/flow': () => json({ problem: 'not-committed', detail: 'сверка: флоу не прошёл' }, 502),
    }),
  )
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название шага' }), { target: { value: 'Критерий закрытия' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(
    await screen.findByText('Флоу не сохранён: коммит в базу не прошёл, файл оставлен как был. сверка: флоу не прошёл'),
  ).toBeInTheDocument()
  expect(nodes(region)[0]).toHaveTextContent(/^Критерий закрытия/)
})

test('флоу, изменённый в базе во время правки, не перезаписывается молча', async () => {
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')
  fireEvent.change(drawer.getByRole('textbox', { name: 'Название шага' }), { target: { value: 'Критерий закрытия' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText(/файл флоу изменился в базе, пока вы его правили/)).toBeInTheDocument()
})

test('пресеты: список начинается пустым, шаг сохраняется из сайдбара и добавляется блоком «Добавить шаг»', async () => {
  const saved: StepPreset = { ...review, id: 'p1' }
  const fetchMock = stubApi(
    api([app], [], {
      'POST /api/presets': () => json(saved),
      'POST /api/flow': () => json({ version: 'v3' }),
    }),
  )
  const region = await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  // Шаг выбирается своим окном, а не списком под блоком
  const adding = within(screen.getByRole('dialog', { name: 'Добавить шаг' }))
  expect(adding.getByText(/Пресетов пока нет/)).toBeInTheDocument()
  fireEvent.click(adding.getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  fireEvent.click(drawer.getByRole('button', { name: 'В пресеты' }))
  expect(await screen.findByRole('button', { name: 'Шаг в пресетах' })).toBeDisabled()
  expect(body(fetchMock, 'POST /api/presets')).toEqual(review)

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Пресеты шагов' })).getByRole('button', { name: /^Ревью/ }))

  // Добавленный шаг сразу открыт в сайдбаре
  expect(within(screen.getByRole('complementary')).getByRole('textbox', { name: 'Название шага' })).toHaveValue('Ревью')
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[3]).toEqual({ ...review, description: '4.1. Собрать дифф всей ветки.' })
})

test('пустой шаг добавляется в конец, пресет удаляется из списка', async () => {
  const fetchMock = stubApi(
    api([app], [{ ...acceptance, id: 'p9' }], { 'DELETE /api/presets': () => new Response(null, { status: 204 }) }),
  )
  const region = await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить пресет Приёмка' }))
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/presets/p9' && init?.method === 'DELETE')).toBe(true),
  )
  await vi.waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Удалить пресет Приёмка' })).not.toBeInTheDocument(),
  )

  fireEvent.click(screen.getByRole('button', { name: /^Пустой шаг/ }))

  expect(nodes(region)[3]).toHaveTextContent(/^без названия/)
  expect(screen.getByText('Не сохранить: шаг 4 — нет названия, не указан выход')).toBeInTheDocument()
})

test('переписанный агентом флоу ложится в схему правками, а не записью в базу', async () => {
  const rewritten: FlowStep[] = [criterion, { ...review, output: 'вердикт по sha всей ветки' }, acceptance]
  const stream = new Response(
    new TextEncoder().encode(
      JSON.stringify({ type: 'rewritten', text: '', steps: rewritten, version: 'v1', durationMs: 12000 }) + '\n',
    ),
    { headers: { 'Content-Type': 'application/x-ndjson' } },
  )
  const summary = {
    kind: 'flow',
    id: 'r1',
    base: app.base,
    project: app.project,
    text: 'Ревью смотрит дифф всей ветки',
    elapsedMs: 0,
    state: 'running',
  }
  const fetchMock = stubApi(
    api([app], [], {
      'POST /api/flow/rewrite': () => json(summary),
      'GET /api/agent/flow/stream?id=r1&from=0': () => stream,
      'DELETE /api/agent/flow': () => new Response(null, { status: 204 }),
    }),
  )
  const region = await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Переписать с Чудо-Юдо' }))
  fireEvent.change(await screen.findByLabelText('Что поменять во флоу'), {
    target: { value: 'Ревью смотрит дифф всей ветки' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Взять правки в схему' }))

  // Итог просьбы забирается вместе с правками, поэтому схема их получает следующим ходом.
  expect(await screen.findByText('Правки Чудо-Юдо в схеме — их ещё нужно сохранить')).toBeInTheDocument()
  expect(screen.getByText('есть несохранённые правки')).toBeInTheDocument()
  // Флоу базы записывает не окно, а прежняя кнопка «Сохранить».
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()

  const drawer = await openStep(region, /^Шаг 2: /)
  expect(drawer.getByLabelText('выход')).toHaveValue('вердикт по sha всей ветки')
})

test('со своими несохранёнными правками переписывать нельзя: агент читает файл базы', async () => {
  stubApi(api([app]))
  const region = await renderFlow()

  const drawer = await openStep(region, /^Шаг 1: /)
  fireEvent.change(drawer.getByLabelText('выход'), { target: { value: 'критерий и ответ оператора' } })

  expect(screen.getByRole('button', { name: 'Переписать с Чудо-Юдо' })).toBeDisabled()
})

/**
 * Заведённые в базе проекта исполнители: ровно из них шагу выбирают субагента. Имена во флоу и
 * в списке одни и те же — приставки проекта у них больше нет.
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

const withPerformers = (steps: FlowStep[] = [criterion, review, acceptance]) => ({ ...app, steps })

test('исполнитель шага выбирается из заведённых в базе', async () => {
  const fetchMock = stubApi(
    api([withPerformers()], [], {
      'GET /api/performers': () => json(performers(['reviewer', 'e2e-runner'])),
      'POST /api/flow': () => json({ version: 'v2' }),
    }),
  )
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 2: Ревью')

  // Имя в файле и имя в списке — одно и то же: сверять их можно напрямую
  const picker = await drawer.findByRole('combobox', { name: 'Имя субагента' })
  expect(picker).toHaveValue('reviewer')
  expect(within(nodes(region)[1]).getByText('субагент reviewer')).toBeInTheDocument()
  expect(drawer.queryByRole('textbox', { name: 'Имя субагента' })).not.toBeInTheDocument()

  fireEvent.change(picker, { target: { value: 'e2e-runner' } })

  expect(within(nodes(region)[1]).getByText('субагент e2e-runner')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[1].executor).toBe('e2e-runner')
})

test('шаг с заведённым в базе исполнителем незнакомым не помечен', async () => {
  stubApi(api([withPerformers()], [], { 'GET /api/performers': () => json(performers(['reviewer'])) }))
  const region = await renderFlow()

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  await drawer.findByRole('combobox', { name: 'Имя субагента' })

  expect(nodes(region)[1].querySelector('.flow-node-missing')).toBeNull()
  expect(drawer.queryByRole('status')).not.toBeInTheDocument()
})

test('отказ чтения исполнителей не метит шаги незаведёнными', async () => {
  stubApi(
    api([withPerformers()], [], {
      'GET /api/performers': () => new Response('', { status: 500 }),
      'POST /api/flow': () => json({ version: 'v2' }),
    }),
  )
  const region = await renderFlow()

  // Список не прочитан — судить о шагах не по чему, и сохранение запирать нечем
  const drawer = await openStep(region, 'Шаг 2: Ревью')
  expect(nodes(region)[1].querySelector('.flow-node-missing')).toBeNull()
  expect(drawer.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('шаг с именем, которого нет в базе, сохранить флоу не даёт', async () => {
  stubApi(
    api([withPerformers()], [], {
      'GET /api/performers': () => json(performers(['e2e-runner'])),
      'POST /api/flow': () => json({ version: 'v2' }),
    }),
  )
  const region = await renderFlow(true, { onPerformers: vi.fn() })

  // Незнакомое имя видно на схеме, не открывая шаг
  expect(await within(nodes(region)[1]).findByLabelText('Исполнителя reviewer нет в базе')).toBeInTheDocument()

  // Такого исполнителя агент не позовёт, поэтому флоу с ним не записывается
  expect(screen.getByText(/Не сохранить: шаг 2/)).toHaveTextContent('исполнителя нет в базе')
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  expect(await drawer.findByRole('status')).toHaveTextContent('Выберите исполнителя из заведённых')
  // Имя остаётся в списке, чтобы шаг не потерял исполнителя молча
  expect(drawer.getByRole('combobox', { name: 'Имя субагента' })).toHaveDisplayValue('reviewer — в базе нет')

  // Заменили заведённым — и флоу снова записывается
  fireEvent.change(drawer.getByRole('combobox', { name: 'Имя субагента' }), { target: { value: 'e2e-runner' } })
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('помощник, уже стоящий у шага, второй раз не предлагается', async () => {
  const withHelpers = withPerformers([{ ...criterion, helpers: ['scout'] }, review, acceptance])
  stubApi(api([withHelpers], [], { 'GET /api/performers': () => json(performers(['scout'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')

  expect(await drawer.findByText('scout')).toBeInTheDocument()
  expect(drawer.queryByRole('combobox', { name: 'Добавить помощника' })).not.toBeInTheDocument()
})

test('от шага с незнакомым исполнителем есть переход в раздел «Исполнители»', async () => {
  stubApi(api([withPerformers()], [], { 'GET /api/performers': () => json(performers(['e2e-runner'])) }))
  const onPerformers = vi.fn()
  const region = await renderFlow(true, { onPerformers })

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  expect(await drawer.findByRole('status')).toHaveTextContent('нет в базе проекта')

  fireEvent.click(drawer.getByRole('button', { name: 'Завести исполнителя' }))
  expect(onPerformers).toHaveBeenCalled()
})

test('имя субагента руками не вписывается: выбор только из заведённых', async () => {
  stubApi(api([withPerformers()], [], { 'GET /api/performers': () => json(performers(['reviewer', 'e2e-runner'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 2: Ревью')

  const picker = await drawer.findByRole('combobox', { name: 'Имя субагента' })
  expect(within(picker).getAllByRole('option').map((option) => option.textContent)).toEqual([
    'reviewer',
    'e2e-runner',
  ])
  expect(drawer.queryByRole('textbox', { name: 'Имя субагента' })).not.toBeInTheDocument()
})

test('возврат шага правится в сайдбаре: условие и шаг, к которому работа идёт заново', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v2' }) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 3: Приёмка')

  fireEvent.click(drawer.getByRole('button', { name: 'Добавить возврат' }))
  fireEvent.change(drawer.getByRole('textbox', { name: 'Условие возврата 1' }), {
    target: { value: 'есть замечания' },
  })
  const target = drawer.getByRole('combobox', { name: 'Шаг возврата 1' })
  // Вернуться можно только на шаг, стоящий раньше: свой и следующие в списке не предлагаются
  expect(within(target).getAllByRole('option').map((option) => option.textContent)).toEqual([
    'шаг…',
    'Критерий',
    'Ревью',
  ])
  fireEvent.change(target, { target: { value: 'Ревью' } })

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[2].returns).toEqual([
    { condition: 'есть замечания', step: 'Ревью' },
  ])
})

test('возврат без цели не даёт сохранить флоу, и сказано, какой шаг чинить', async () => {
  const withReturn = { ...app, steps: [criterion, review, { ...acceptance, returns: [{ condition: 'есть замечания', step: 'Сборка' }] }] }
  stubApi(api([withReturn]))
  const region = await renderFlow()

  expect(screen.getByText(/Не сохранить: шаг 3/)).toHaveTextContent('возврат ведёт на шаг, которого во флоу нет')
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  // Возврат убирается там же, где правится, — и флоу снова записывается
  const drawer = await openStep(region, /^Шаг 3: Приёмка/)
  fireEvent.click(drawer.getByRole('button', { name: 'Убрать возврат 1' }))
  expect(screen.queryByText(/Не сохранить/)).not.toBeInTheDocument()
})

test('помощники есть только у шага оркестратора и стираются при смене исполнителя', async () => {
  const withHelpers = withPerformers([{ ...criterion, helpers: ['scout'] }, review, acceptance])
  const fetchMock = stubApi(
    api([withHelpers], [], {
      'GET /api/performers': () => json(performers(['reviewer', 'scout', 'check-runner'])),
      'POST /api/flow': () => json({ version: 'v2' }),
    }),
  )
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')

  // Помощник, заведённый в базе, стоит обычным чипом
  expect(await drawer.findByText('scout')).toBeInTheDocument()
  expect(drawer.queryByTitle(/нет в базе/)).not.toBeInTheDocument()

  fireEvent.change(drawer.getByRole('combobox', { name: 'Добавить помощника' }), {
    target: { value: 'check-runner' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[0].helpers).toEqual(['scout', 'check-runner'])

  // У шага оператора помощников не бывает: поле исчезает вместе с ними
  fireEvent.change(drawer.getByRole('combobox', { name: 'Исполнитель шага' }), { target: { value: 'оператор' } })
  expect(drawer.queryByRole('combobox', { name: 'Добавить помощника' })).not.toBeInTheDocument()
  expect(drawer.queryByText('scout')).not.toBeInTheDocument()
})

test('помощник, которого нет в базе, сохранить флоу не даёт', async () => {
  const withHelpers = withPerformers([{ ...criterion, helpers: ['doc-writer'] }, review, acceptance])
  stubApi(api([withHelpers], [], { 'GET /api/performers': () => json(performers(['reviewer', 'scout'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')

  // Помощника зовёт оркестратор внутри своего шага — незаведённого он не найдёт так же, как исполнителя
  expect(await drawer.findByTitle('Исполнителя doc-writer нет в базе')).toBeInTheDocument()
  expect(screen.getByText(/Не сохранить: шаг 1/)).toHaveTextContent('помощника нет в базе')
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('помощник, которого нет в базе, отмечен в сайдбаре янтарём', async () => {
  const withHelpers = withPerformers([{ ...criterion, helpers: ['scout'] }, review, acceptance])
  stubApi(api([withHelpers], [], { 'GET /api/performers': () => json(performers(['e2e-runner'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')

  expect(await drawer.findByTitle('Исполнителя scout нет в базе')).toBeInTheDocument()
})

test('в сохранённый шаг возврат и помощники не уходят', async () => {
  const steps = [{ ...criterion, helpers: ['scout'], returns: [] }, review, acceptance]
  const fetchMock = stubApi(
    api([{ ...app, steps }], [], {
      'GET /api/performers': () => json(performers(['scout'])),
      'POST /api/presets': () => json({ id: 'p1', ...criterion }),
    }),
  )
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 1: Критерий')

  fireEvent.click(drawer.getByRole('button', { name: 'В пресеты' }))
  await screen.findByRole('button', { name: 'Шаг в пресетах' })
  expect(body(fetchMock, 'POST /api/presets')).toMatchObject({ helpers: [], returns: [] })
})

test('пресет и шаг из него зовут исполнителя тем же именем', async () => {
  const saved: StepPreset = { ...review, executor: 'reviewer', id: 'p2' }
  const fetchMock = stubApi(
    api([withPerformers()], [], {
      'GET /api/performers': () => json(performers(['reviewer'])),
      'POST /api/presets': () => json(saved),
      'POST /api/flow': () => json({ version: 'v2' }),
    }),
  )
  const region = await renderFlow()

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  await drawer.findByRole('combobox', { name: 'Имя субагента' })
  fireEvent.click(drawer.getByRole('button', { name: 'В пресеты' }))

  expect(body(fetchMock, 'POST /api/presets').executor).toBe('reviewer')
  await screen.findByRole('button', { name: 'Шаг в пресетах' })

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  fireEvent.click(
    within(screen.getByRole('group', { name: 'Пресеты шагов' })).getByRole('button', { name: /^Ревью/ }),
  )

  expect(within(nodes(region)[3]).getByText('субагент reviewer')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[3].executor).toBe('reviewer')
})

test('возвраты нарисованы дугами: у открытого шага дуга подсвечена и подписана условием', async () => {
  const steps = [
    criterion,
    review,
    { ...acceptance, returns: [{ condition: 'есть замечания', step: 'Ревью' }] },
  ]
  stubApi(api([{ ...app, steps }]))
  const region = await renderFlow()

  // Круг виден и без открытого шага, только приглушённо
  expect(document.querySelectorAll('.flow-arc')).toHaveLength(1)
  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(0)

  await openStep(region, /^Шаг 3: Приёмка/)

  expect(document.querySelectorAll('.flow-arc-open')).toHaveLength(1)
  expect(document.querySelector('.flow-arc-label')).toHaveTextContent('есть замечания')
})

test('возврат, которому некуда вести, дугой не рисуется', async () => {
  const steps = [criterion, review, { ...acceptance, returns: [{ condition: 'есть замечания', step: 'Сборка' }] }]
  stubApi(api([{ ...app, steps }]))
  await renderFlow()

  expect(document.querySelectorAll('.flow-arc')).toHaveLength(0)
})

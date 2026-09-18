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
}
const review: FlowStep = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha',
  skip: 'правка только в текстах',
  description: '2.1. Собрать дифф всей ветки.',
}
const acceptance: FlowStep = {
  title: 'Приёмка',
  executor: 'оператор',
  output: 'ответ оператора «принято»',
  skip: null,
  description: null,
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
  // Раздел спрашивает заведённых исполнителей: из них шагу выбирают субагента.
  'GET /api/performers': () => json([]),
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
  expect(drawer.getByRole('textbox', { name: 'Имя субагента' })).toHaveValue('reviewer')
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
  fireEvent.change(drawer.getByRole('textbox', { name: 'Имя субагента' }), { target: { value: '' } })

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

  fireEvent.click(screen.getByRole('button', { name: 'Переписать с Чудо-юдо' }))
  fireEvent.change(await screen.findByLabelText('Что поменять во флоу'), {
    target: { value: 'Ревью смотрит дифф всей ветки' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Взять правки в схему' }))

  // Итог просьбы забирается вместе с правками, поэтому схема их получает следующим ходом.
  expect(await screen.findByText('Правки Чудо-юдо в схеме — их ещё нужно сохранить')).toBeInTheDocument()
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

  expect(screen.getByRole('button', { name: 'Переписать с Чудо-юдо' })).toBeDisabled()
})

/** Заведённые исполнители проекта: из них шагу выбирают субагента. */
const performers = (names: string[]) => [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    copies: [],
    performers: names.map((name) => ({
      name,
      description: null,
      model: null,
      tools: null,
      prompt: '',
      path: `D:\\Projects\\agents-kit-web\\.claude\\agents\\${name}.md`,
      source: 'copy' as const,
      copy: 'D:\\Projects\\agents-kit-web',
    })),
    error: null,
  },
]

test('исполнитель шага выбирается из заведённых', async () => {
  stubApi(api([app], [], { 'GET /api/performers': () => json(performers(['reviewer', 'e2e-runner'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 2: Ревью')

  const picker = await drawer.findByRole('combobox', { name: 'Имя субагента' })
  expect(picker).toHaveValue('reviewer')
  expect(drawer.queryByRole('textbox', { name: 'Имя субагента' })).not.toBeInTheDocument()

  fireEvent.change(picker, { target: { value: 'e2e-runner' } })

  expect(within(nodes(region)[1]).getByText('субагент e2e-runner')).toBeInTheDocument()
})

test('шаг, чьего исполнителя нет на диске, отмечен на схеме и объяснён в сайдбаре', async () => {
  stubApi(api([app], [], { 'GET /api/performers': () => json(performers(['e2e-runner'])) }))
  const onPerformers = vi.fn()
  const region = await renderFlow(true, { onPerformers })

  // Ненайденного видно на схеме, не открывая шаг
  const node = await within(nodes(region)[1]).findByLabelText('Исполнителя reviewer нет на диске')
  expect(node).toBeInTheDocument()

  const drawer = await openStep(region, 'Шаг 2: Ревью')
  expect(drawer.getByRole('status')).toHaveTextContent('Сессия дойдёт до шага и спросит вас')
  // Имя остаётся в списке, чтобы шаг не потерял исполнителя молча
  expect(await drawer.findByRole('combobox', { name: 'Имя субагента' })).toHaveValue('reviewer')
  fireEvent.click(drawer.getByRole('button', { name: 'Завести исполнителя' }))
  expect(onPerformers).toHaveBeenCalled()
})

test('«вписать имя…» возвращает поле для чужого имени', async () => {
  stubApi(api([app], [], { 'GET /api/performers': () => json(performers(['reviewer'])) }))
  const region = await renderFlow()
  const drawer = await openStep(region, 'Шаг 2: Ревью')

  fireEvent.change(await drawer.findByRole('combobox', { name: 'Имя субагента' }), {
    target: { value: '__custom__' },
  })
  fireEvent.change(drawer.getByRole('textbox', { name: 'Имя субагента' }), { target: { value: 'doc-writer' } })

  expect(within(nodes(region)[1]).getByText('субагент doc-writer')).toBeInTheDocument()
  expect(drawer.getByRole('status')).toHaveTextContent('нет на диске')
})

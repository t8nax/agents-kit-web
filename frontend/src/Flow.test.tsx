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
}
const nota: BaseFlow = {
  base: 'D:\\Projects\\nota-knowledge',
  project: 'Nota',
  steps: [],
  activeTasks: 0,
  version: 'v2',
  error: null,
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
  ...extra,
})

const body = (fetchMock: ReturnType<typeof stubApi>, key: string) => {
  const call = fetchMock.mock.calls.find(([url, init]) => `${init?.method ?? 'GET'} ${url}` === key)
  return call ? JSON.parse(String(call[1]?.body)) : undefined
}

async function renderFlow() {
  render(<Flow />)
  return within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
}

async function startEditing() {
  const region = await renderFlow()
  fireEvent.click(screen.getByRole('button', { name: 'Править' }))
  await screen.findByRole('heading', { name: 'Правка флоу' })
  return region
}

test('показывает шаги флоу выбранной базы: номер, название, исполнитель, выход и пропуск', async () => {
  stubApi(api([{ ...app, activeTasks: 2 }, nota]))

  const region = await renderFlow()

  const steps = region.getAllByRole('article')
  expect(steps.map((step) => step.getAttribute('aria-label'))).toEqual([
    'Шаг 1: Критерий',
    'Шаг 2: Ревью',
    'Шаг 3: Приёмка',
  ])
  const second = within(steps[1])
  expect(second.getByText('субагент reviewer')).toBeInTheDocument()
  expect(second.getByText('вердикт по sha')).toBeInTheDocument()
  expect(second.getByText('правка только в текстах')).toBeInTheDocument()
  expect(within(steps[0]).getByText('нет — шаг проходится всегда')).toBeInTheDocument()
  expect(region.getByText('2 задачи в работе')).toBeInTheDocument()
  // Описание шага в панели не показывается
  expect(screen.queryByText(/Написать критерий/)).not.toBeInTheDocument()
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

  const region = await renderFlow()

  expect(region.getByText(/В базе нет файла флоу/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Править' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Открыть в VS Code' })).not.toBeInTheDocument()
})

test('«Открыть в VS Code» просит API открыть флоу этой базы', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow/open': () => new Response(null, { status: 204 }) }))
  await renderFlow()

  fireEvent.click(screen.getByRole('button', { name: 'Открыть в VS Code' }))

  await vi.waitFor(() => expect(body(fetchMock, 'POST /api/flow/open')).toEqual({ base: app.base }))
})

test('правка: шаг переименовывается, двигается кнопками и удаляется, номера идут подряд, описания уходят как были', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await startEditing()

  fireEvent.change(region.getByRole('textbox', { name: 'Название шага 1' }), { target: { value: 'Критерий закрытия' } })
  fireEvent.click(region.getByRole('button', { name: 'Шаг 1 ниже' }))
  fireEvent.click(region.getByRole('button', { name: 'Удалить шаг 3' }))

  expect(region.getAllByRole('article').map((step) => step.getAttribute('aria-label'))).toEqual(['Шаг 1', 'Шаг 2'])
  expect(region.getByRole('textbox', { name: 'Название шага 1' })).toHaveValue('Ревью')
  expect(region.getByRole('textbox', { name: 'Название шага 2' })).toHaveValue('Критерий закрытия')

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Флоу сохранён и закоммичен в базу')).toBeInTheDocument()
  // Задач в работе нет — окна подтверждения нет
  expect(body(fetchMock, 'POST /api/flow')).toEqual({
    base: app.base,
    version: 'v1',
    steps: [review, { ...criterion, title: 'Критерий закрытия' }],
  })
})

test('шаг переставляется перетаскиванием за ручку', async () => {
  const fetchMock = stubApi(api([app], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  const region = await startEditing()
  const [first, , third] = region.getAllByRole('article')
  const dataTransfer = { effectAllowed: '', setData: vi.fn() }

  fireEvent.dragStart(third.querySelector('.flow-grip')!, { dataTransfer })
  fireEvent.dragOver(first, { dataTransfer })
  fireEvent.drop(first, { dataTransfer })

  expect(region.getByRole('textbox', { name: 'Название шага 1' })).toHaveValue('Приёмка')
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps.map((step: FlowStep) => step.title)).toEqual([
    'Приёмка',
    'Критерий',
    'Ревью',
  ])
})

test('шаг без выхода или без имени субагента не сохранить, и сказано почему', async () => {
  stubApi(api([app]))
  const region = await startEditing()

  fireEvent.change(region.getByRole('textbox', { name: 'Выход шага 2' }), { target: { value: ' ' } })
  fireEvent.change(region.getByRole('textbox', { name: 'Имя субагента шага 2' }), { target: { value: '' } })

  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  expect(screen.getByText('Не сохранить: шаг 2 — не указано имя субагента, не указан выход')).toBeInTheDocument()

  fireEvent.change(region.getByRole('combobox', { name: 'Исполнитель шага 2' }), { target: { value: 'оператор' } })
  fireEvent.change(region.getByRole('textbox', { name: 'Выход шага 2' }), { target: { value: 'вердикт' } })
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
})

test('при задачах в работе сохранение спрашивает подтверждение и говорит, сколько их', async () => {
  const fetchMock = stubApi(api([{ ...app, activeTasks: 2 }], [], { 'POST /api/flow': () => json({ version: 'v3' }) }))
  await startEditing()

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

test('отказы записи названы словами, а правка остаётся открытой', async () => {
  stubApi(
    api([app], [], {
      'POST /api/flow': () => json({ problem: 'not-committed', detail: 'сверка: флоу не прошёл' }, 502),
    }),
  )
  await startEditing()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(
    await screen.findByText('Флоу не сохранён: коммит в базу не прошёл, файл оставлен как был. сверка: флоу не прошёл'),
  ).toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Правка флоу' })).toBeInTheDocument()
})

test('флоу, изменённый в базе во время правки, не перезаписывается молча', async () => {
  stubApi(api([app], [], { 'POST /api/flow': () => json({ problem: 'changed' }, 409) }))
  await startEditing()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText(/файл флоу изменился в базе, пока вы его правили/)).toBeInTheDocument()
})

test('пресеты: список начинается пустым, шаг сохраняется как пресет и добавляется из него с описанием', async () => {
  const saved: StepPreset = { ...review, id: 'p1' }
  const fetchMock = stubApi(
    api([app], [], {
      'POST /api/presets': () => json(saved),
      'POST /api/flow': () => json({ version: 'v3' }),
    }),
  )
  const region = await startEditing()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  expect(within(screen.getByRole('group', { name: 'Пресеты шагов' })).getByText(/Пресетов пока нет/)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))

  fireEvent.click(region.getByRole('button', { name: 'Сохранить шаг 2 как пресет' }))
  expect(await region.findByRole('button', { name: 'Сохранить шаг 2 как пресет', pressed: true })).toBeDisabled()
  expect(body(fetchMock, 'POST /api/presets')).toEqual(review)

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  fireEvent.click(within(screen.getByRole('group', { name: 'Пресеты шагов' })).getByRole('button', { name: /^Ревью/ }))

  expect(region.getByRole('textbox', { name: 'Название шага 4' })).toHaveValue('Ревью')
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await screen.findByText('Флоу сохранён и закоммичен в базу')
  expect(body(fetchMock, 'POST /api/flow').steps[3]).toEqual(review)
})

test('пустой шаг добавляется в конец, пресет удаляется из списка', async () => {
  const fetchMock = stubApi(
    api([app], [{ ...acceptance, id: 'p9' }], { 'DELETE /api/presets': () => new Response(null, { status: 204 }) }),
  )
  const region = await startEditing()

  fireEvent.click(screen.getByRole('button', { name: 'Добавить шаг' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить пресет Приёмка' }))
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/presets/p9' && init?.method === 'DELETE')).toBe(true),
  )
  await vi.waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Удалить пресет Приёмка' })).not.toBeInTheDocument(),
  )

  fireEvent.click(screen.getByRole('button', { name: /^Пустой шаг/ }))
  expect(region.getByRole('textbox', { name: 'Название шага 4' })).toHaveValue('')
  expect(screen.getByText('Не сохранить: шаг 4 — нет названия, не указан выход')).toBeInTheDocument()
})

test('«Отмена» закрывает правку без записи', async () => {
  const fetchMock = stubApi(api([app]))
  const region = await startEditing()

  fireEvent.click(region.getByRole('button', { name: 'Удалить шаг 1' }))
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

  expect(screen.getByRole('heading', { name: 'Флоу' })).toBeInTheDocument()
  expect(region.getAllByRole('article')).toHaveLength(3)
  expect(body(fetchMock, 'POST /api/flow')).toBeUndefined()
})

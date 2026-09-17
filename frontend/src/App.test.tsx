import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'
import { applyChosenTheme } from './theme'

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  visibility = 'visible'
  localStorage.clear()
  delete document.documentElement.dataset.theme
})

function setVisibility(value: DocumentVisibilityState) {
  visibility = value
  fireEvent(document, new Event('visibilitychange'))
}

async function tick(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms)
  })
}

// Таймер опроса подделывается, setTimeout остаётся настоящим — на нём ждут findBy*
function fakeInterval() {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
}

// Строки таблицы без заголовков групп: шапка колонок и строки копий
async function findTableRows() {
  const all = await screen.findAllByRole('row')
  return all.filter((row) => within(row).queryByRole('rowheader') === null)
}

const rows: WorkspaceRow[] = [
  {
    project: 'app-knowledge',
    base: 'D:\\Projects\\app-knowledge',
    path: 'D:\\Projects\\app',
    branch: 'feat/table',
    task: 'Таблица рабочих копий',
    flowStep: 'Реализация',
    progress: 33,
    status: 'waiting',
    error: null,
  },
  {
    project: 'app-knowledge',
    base: 'D:\\Projects\\app-knowledge',
    path: 'D:\\Projects\\app-wt',
    branch: 'dev',
    task: null,
    flowStep: null,
    progress: null,
    status: 'free',
    error: null,
  },
  {
    project: 'app-knowledge',
    base: 'D:\\Projects\\app-knowledge',
    path: 'E:\\gone',
    branch: null,
    task: null,
    flowStep: null,
    progress: null,
    status: null,
    error: 'Копия не найдена на диске',
  },
]

test('показывает рабочие копии из /api/workspaces', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)

  const tableRows = await findTableRows()
  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces')
  expect(screen.getByRole('heading', { name: 'Agents Kit Web' })).toBeInTheDocument()
  expect(tableRows).toHaveLength(4)

  const waiting = within(tableRows[1])
  // Проект назван в заголовке группы, в строке — имя копии и ветка
  expect(waiting.getByText('app')).toBeInTheDocument()
  expect(waiting.getByText('feat/table')).toBeInTheDocument()
  expect(waiting.queryByText('app-knowledge')).not.toBeInTheDocument()
  expect(waiting.getByText('Таблица рабочих копий')).toBeInTheDocument()
  expect(waiting.getByText('Реализация')).toBeInTheDocument()
  expect(waiting.getByText('33%')).toBeInTheDocument()
  expect(waiting.getByText('Ждёт оператора')).toBeInTheDocument()
  expect(waiting.getByRole('button', { name: 'Ответить' })).toBeInTheDocument()

  const free = within(tableRows[2])
  expect(free.getByText('Свободна')).toBeInTheDocument()
  expect(free.queryByRole('button', { name: 'Ответить' })).not.toBeInTheDocument()
  expect(free.queryByText(/%$/)).not.toBeInTheDocument()

  expect(within(tableRows[3]).getByText('Копия не найдена на диске')).toBeInTheDocument()
  expect(screen.queryByText('pong')).not.toBeInTheDocument()
})

const otherBase: WorkspaceRow = {
  ...rows[1],
  project: 'Nota',
  base: 'D:\\Projects\\nota-knowledge',
  path: 'D:\\Projects\\nota',
  branch: 'main',
  status: 'waiting',
}

test('копии собраны под заголовками своих проектов в порядке API', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([...rows, otherBase]), { status: 200 })))

  render(<App />)
  const all = await screen.findAllByRole('row')

  // Шапка колонок, группа app-knowledge с тремя копиями, группа Nota с одной
  const heads = all.map((row) => within(row).queryByRole('rowheader')?.textContent ?? null)
  expect(heads).toEqual([
    null,
    'app-knowledge3 копии · 1 ждёт оператора',
    null,
    null,
    null,
    'Nota1 копия · 1 ждёт оператора',
    null,
  ])
  expect(within(all[5]).getByRole('rowheader')).toHaveAttribute('colspan', '8')
  expect(within(all[6]).getByText('nota')).toBeInTheDocument()
})

test('группа сворачивается, свёрнутая помнится браузером и показывает, что в ней ждут', async () => {
  // Таблица рендерится дважды, а тело ответа читается один раз — на каждый запрос свой ответ
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([...rows, otherBase]), { status: 200 })))

  const { unmount } = render(<App />)
  const toggle = await screen.findByRole('button', { name: 'Свернуть app-knowledge' })
  expect(toggle).toHaveAttribute('aria-expanded', 'true')
  expect(document.querySelector('.group-waiting-dot')).toBeNull()

  fireEvent.click(toggle)

  expect(screen.getByRole('button', { name: 'Развернуть app-knowledge' })).toHaveAttribute('aria-expanded', 'false')
  expect(screen.queryByText('Таблица рабочих копий')).not.toBeInTheDocument()
  expect(screen.getByText('nota')).toBeInTheDocument()
  expect(document.querySelectorAll('.group-waiting-dot')).toHaveLength(1)
  expect(localStorage.getItem('agents-kit-web.collapsed-groups')).toBe(JSON.stringify(['D:\\Projects\\app-knowledge']))

  unmount()
  render(<App />)
  expect(await screen.findByRole('button', { name: 'Развернуть app-knowledge' })).toBeInTheDocument()
  expect(screen.queryByText('Таблица рабочих копий')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Развернуть app-knowledge' }))
  expect(screen.getByText('Таблица рабочих копий')).toBeInTheDocument()
  expect(localStorage.getItem('agents-kit-web.collapsed-groups')).toBe('[]')
})

test('номер задачи из бэклога стоит своей колонкой, без номера и без задачи — прочерк', async () => {
  const numbered: WorkspaceRow = { ...rows[0], task: 'B-24 Номер задачи отдельной колонкой' }
  const unnumbered: WorkspaceRow = { ...rows[0], path: 'D:\\Projects\\app-2', task: 'Задача не из бэклога' }
  const table = [numbered, unnumbered, rows[1], rows[2]]
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(table), { status: 200 })))

  render(<App />)

  const tableRows = await findTableRows()
  const headers = within(tableRows[0]).getAllByRole('columnheader').map((header) => header.textContent)
  expect(headers.slice(0, 3)).toEqual(['Копия', '№', 'Задача'])

  const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent)
  expect(cells(tableRows[1]).slice(1, 3)).toEqual(['B-24', 'Номер задачи отдельной колонкой'])
  expect(within(tableRows[1]).getByText('B-24')).toHaveClass('num-chip')
  expect(cells(tableRows[2]).slice(1, 3)).toEqual(['—', 'Задача не из бэклога'])
  expect(cells(tableRows[3]).slice(1, 3)).toEqual(['—', '—'])
  // Строка с ошибкой накрывает и колонку номера: ячеек в ней столько же, сколько колонок
  expect(within(tableRows[4]).getAllByRole('cell')[1]).toHaveAttribute('colspan', '5')
})

test('кнопка «Открыть в VS Code» стоит у прочитанных копий и открывает ту, чью строку нажали', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/workspace/open'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  // Строка с ошибкой открывать нечего — у неё кнопки нет
  expect(within(tableRows[1]).getByRole('button', { name: 'Открыть D:\\Projects\\app в VS Code' })).toBeInTheDocument()
  expect(within(tableRows[2]).getByRole('button', { name: /Открыть .* в VS Code/ })).toBeInTheDocument()
  expect(within(tableRows[3]).queryByRole('button', { name: /в VS Code/ })).not.toBeInTheDocument()

  await act(async () => {
    fireEvent.click(within(tableRows[2]).getByRole('button', { name: /в VS Code/ }))
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/workspace/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app-wt' }),
  })
})

test('копия не открылась — панель говорит об этом строкой', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/workspace/open'
      ? new Response(JSON.stringify({ problem: 'not-opened' }), { status: 502 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  await act(async () => {
    fireEvent.click(within(tableRows[2]).getByRole('button', { name: /в VS Code/ }))
  })

  expect(
    await screen.findByText('Не удалось открыть VS Code на D:\\Projects\\app-wt'),
  ).toBeInTheDocument()
})

test('сайдбар переключает разделы, среди них «Проблемы баз» и «Настройки»', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/backlog' || url === '/api/bases') return new Response(JSON.stringify([]), { status: 200 })
    if (url === '/api/kit') return new Response(JSON.stringify({ path: null, found: false }), { status: 200 })
    if (url === '/api/health')
      return new Response(JSON.stringify({ pending: false, kit: 'ok', bases: [], checkedAt: null }), { status: 200 })
    return new Response(JSON.stringify(rows), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const sidebar = within(screen.getByRole('navigation', { name: 'Разделы панели' }))

  // Копия с неотвеченным вопросом считается в сайдбаре — в свёрнутой полосе счёт в имени кнопки
  expect(await sidebar.findByRole('button', { name: 'Рабочие копии, 1 ждёт' })).toBeInTheDocument()
  expect(await screen.findByRole('table')).toBeInTheDocument()

  fireEvent.click(sidebar.getByRole('button', { name: /Бэклог/ }))
  expect(await screen.findByRole('heading', { name: 'Бэклог' })).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/backlog')

  fireEvent.click(sidebar.getByRole('button', { name: /Рабочие копии/ }))
  expect(await screen.findByRole('table')).toBeInTheDocument()

  fireEvent.click(sidebar.getByRole('button', { name: 'Проблемы баз' }))
  expect(await screen.findByRole('heading', { name: 'Проблемы баз' })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/health')

  fireEvent.click(sidebar.getByRole('button', { name: 'Настройки' }))
  expect(await screen.findByRole('heading', { name: 'Настройки' })).toBeInTheDocument()
  expect(sidebar.getByRole('button', { name: 'Настройки' })).toHaveAttribute('aria-current', 'page')
  // Кнопки «Базы знаний» больше нет: базы живут в разделе «Настройки»
  expect(sidebar.queryByRole('button', { name: 'Базы знаний' })).not.toBeInTheDocument()
})

const checked = (baseProblems: number, problems: number): Partial<WorkspaceRow> => ({
  problemsState: 'checked',
  baseProblems,
  problems,
})

// Заголовок группы по названию проекта
function groupHeader(project: string) {
  const header = screen
    .getAllByRole('rowheader')
    .find((candidate) => candidate.querySelector('.group-name')?.textContent === project)
  if (!header) throw new Error(`нет группы ${project}`)
  return header
}

const otherProject = (project: string): Partial<WorkspaceRow> => ({
  project,
  base: `D:\\Projects\\${project}-knowledge`,
  path: `D:\\Projects\\${project}`,
})

test('проблемы базы стоят в заголовке группы, у копии — только её проблемы связи, числа ведут в «Проблемы баз»', async () => {
  const tableRows: WorkspaceRow[] = [
    { ...rows[0], ...checked(2, 1) },
    { ...rows[1], ...checked(2, 0) },
    rows[2],
    { ...rows[1], ...otherProject('clean'), ...checked(0, 0) },
    { ...rows[1], ...otherProject('failed'), problemsState: 'failed', problems: null },
    { ...rows[1], ...otherProject('pending'), problemsState: 'pending', problems: null },
  ]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/health'
        ? new Response(JSON.stringify({ pending: false, kit: 'ok', bases: [], checkedAt: null }), { status: 200 })
        : new Response(JSON.stringify(tableRows), { status: 200 }),
    ),
  )

  render(<App />)
  const [, brokenLink, healthy, missing, clean, failed, pending] = await findTableRows()

  // Проблемы базы — одним числом в заголовке группы, а не в каждой строке её копий
  expect(
    within(groupHeader('app-knowledge')).getByRole('button', { name: '2 проблемы базы — открыть «Проблемы баз»' }),
  ).toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: /базы — открыть «Проблемы баз»/ })).toHaveLength(1)
  expect(within(groupHeader('clean')).getAllByRole('button')).toHaveLength(1)

  // Колонка «Проблемы» — седьмая в строке: у копии только её проблемы связи, у здоровой пусто
  expect(within(brokenLink).getAllByRole('cell')[6]).toHaveTextContent(/^1$/)
  for (const row of [healthy, clean, failed, pending]) expect(within(row).getAllByRole('cell')[6]).toBeEmptyDOMElement()
  // Строке с ошибкой проверять нечего: копии нет на диске, её называет сверка базы
  expect(within(missing).queryByRole('button', { name: /открыть «Проблемы баз»/ })).not.toBeInTheDocument()

  // Почему чисел нет — словами в заголовке группы
  expect(within(groupHeader('failed')).getByText('сверка не выполнена')).toBeInTheDocument()
  expect(within(groupHeader('pending')).getByText('проверяется')).toBeInTheDocument()
  expect(screen.queryByText(/Проблемы баз не проверяются/)).not.toBeInTheDocument()

  fireEvent.click(within(brokenLink).getByRole('button', { name: '1 проблема копии — открыть «Проблемы баз»' }))
  expect(await screen.findByRole('heading', { name: 'Проблемы баз' })).toBeInTheDocument()
})

test('без пути к киту таблица говорит об этом в заголовке группы и плашкой, плашка ведёт в «Настройки»', async () => {
  const tableRows: WorkspaceRow[] = [{ ...rows[0], problemsState: 'kit-not-set', problems: null }]
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/bases') return new Response(JSON.stringify([]), { status: 200 })
      if (url === '/api/kit') return new Response(JSON.stringify({ path: null, found: false }), { status: 200 })
      return new Response(JSON.stringify(tableRows), { status: 200 })
    }),
  )

  render(<App />)
  await findTableRows()

  expect(within(groupHeader('app-knowledge')).getByText('кит не задан')).toBeInTheDocument()
  expect(screen.getByText('Проблемы баз не проверяются: не задан путь к киту.')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Открыть настройки' }))
  expect(await screen.findByRole('heading', { name: 'Настройки' })).toBeInTheDocument()
})

test('сайдбар стоит полосой значков и разъезжается под мышью', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const nav = screen.getByRole('navigation', { name: 'Разделы панели' })
  const sidebar = within(nav)

  // Свёрнутая полоса: подписей нет, ждущая ответа копия отмечена точкой у значка
  const workspaces = await sidebar.findByRole('button', { name: 'Рабочие копии, 1 ждёт' })
  expect(sidebar.queryByText('Рабочие копии')).not.toBeInTheDocument()
  expect(sidebar.queryByText('1 ждёт')).not.toBeInTheDocument()
  expect(nav.querySelector('.side-dot')).toBeInTheDocument()

  fireEvent.mouseEnter(nav)
  expect(sidebar.getByText('Рабочие копии')).toBeInTheDocument()
  expect(sidebar.getByText('Бэклог')).toBeInTheDocument()
  expect(sidebar.getByText('Проблемы баз')).toBeInTheDocument()
  expect(sidebar.getByText('Настройки')).toBeInTheDocument()
  expect(sidebar.getByText('1 ждёт')).toBeInTheDocument()
  // Раздел сам не сменился: на месте по-прежнему таблица копий
  expect(screen.getByRole('table')).toBeInTheDocument()

  fireEvent.mouseLeave(nav)
  expect(sidebar.queryByText('Рабочие копии')).not.toBeInTheDocument()
  expect(screen.getByRole('table')).toBeInTheDocument()

  // Клавиатура разворачивает сайдбар так же, как мышь
  fireEvent.focus(workspaces)
  expect(sidebar.getByText('Бэклог')).toBeInTheDocument()
  fireEvent.blur(workspaces)
  expect(sidebar.queryByText('Бэклог')).not.toBeInTheDocument()
})

test('сообщает, что API недоступен', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))

  render(<App />)

  expect(await screen.findByText('Нет связи с API')).toBeInTheDocument()
  expect(screen.queryByRole('table')).not.toBeInTheDocument()
})

test('перечитывает список раз в 3 секунды без перезагрузки страницы', async () => {
  fakeInterval()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify([rows[1]]), { status: 200 }))
    .mockResolvedValue(new Response(JSON.stringify([rows[0]]), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  expect(await screen.findByText('Свободна')).toBeInTheDocument()

  await tick(2999)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await tick(1)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(screen.queryByText('Свободна')).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('не опрашивает API на скрытой вкладке и перечитывает при возврате', async () => {
  fakeInterval()
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(rows), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  await findTableRows()
  expect(fetchMock).toHaveBeenCalledTimes(1)

  setVisibility('hidden')
  await tick(30000)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await act(async () => setVisibility('visible'))
  expect(fetchMock).toHaveBeenCalledTimes(2)

  await tick(3000)
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

test('при сбое опроса оставляет таблицу и продолжает опрос', async () => {
  fakeInterval()
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify(rows), { status: 200 }))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  await findTableRows()

  await tick(3000)
  expect(await screen.findByText('Нет связи с API')).toBeInTheDocument()
  expect(screen.getByRole('table')).toBeInTheDocument()

  await tick(3000)
  await vi.waitFor(() => expect(screen.queryByText('Нет связи с API')).not.toBeInTheDocument())
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

type ShownNotification = { title: string; options?: NotificationOptions; onclick: (() => void) | null; close: () => void }

function stubNotification(permission: NotificationPermission, requestResult: NotificationPermission = permission) {
  const shown: ShownNotification[] = []
  class FakeNotification {
    static permission = permission
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = requestResult
      return requestResult
    })
    onclick: (() => void) | null = null
    close = vi.fn()
    title: string
    options?: NotificationOptions
    constructor(title: string, options?: NotificationOptions) {
      this.title = title
      this.options = options
      shown.push(this)
    }
  }
  vi.stubGlobal('Notification', FakeNotification)
  return { shown, FakeNotification }
}

function workspaceResponses(...lists: WorkspaceRow[][]) {
  const fetchMock = vi.fn()
  lists.forEach((list) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(list), { status: 200 })))
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(lists[lists.length - 1]), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const inWork: WorkspaceRow = { ...rows[0], status: 'in-work' }

test('без поддержки уведомлений браузером шапка их не предлагает', async () => {
  workspaceResponses(rows)

  render(<App />)

  await findTableRows()
  expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Уведомления/)).not.toBeInTheDocument()
})

test('кнопка в шапке запрашивает разрешение на уведомления', async () => {
  const { FakeNotification } = stubNotification('default', 'granted')
  workspaceResponses(rows)

  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }))

  expect(await screen.findByRole('button', { name: 'Выключить уведомления' })).toBeInTheDocument()
  expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument()
})

test('выключенные из шапки уведомления не показываются и не держат опрос скрытой вкладки', async () => {
  fakeInterval()
  const { shown, FakeNotification } = stubNotification('granted')
  const fetchMock = workspaceResponses([inWork], [rows[0]])

  render(<App />)
  await screen.findByText('В работе')
  fireEvent.click(screen.getByRole('button', { name: 'Выключить уведомления' }))
  expect(screen.getByRole('button', { name: 'Включить уведомления' })).toBeInTheDocument()

  setVisibility('hidden')
  await tick(30000)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await act(async () => setVisibility('visible'))
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(0)
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
})

test('уведомления включаются обратно без нового запроса разрешения, выбор помнится', async () => {
  fakeInterval()
  const { shown, FakeNotification } = stubNotification('granted')
  workspaceResponses(rows)

  const { unmount } = render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Выключить уведомления' }))
  unmount()

  workspaceResponses([inWork], [rows[0]])
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }))
  expect(screen.getByRole('button', { name: 'Выключить уведомления' })).toBeInTheDocument()
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()

  await screen.findByText('В работе')
  await tick(3000)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(1)
})

test('при отказе в разрешении шапка это показывает, а таблица работает', async () => {
  stubNotification('default', 'denied')
  workspaceResponses(rows)

  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }))

  expect(await screen.findByText('Уведомления запрещены в браузере')).toBeInTheDocument()
  expect(await findTableRows()).toHaveLength(4)
})

test('уведомляет, когда копия начала ждать оператора, и не шлёт на первом опросе', async () => {
  fakeInterval()
  const { shown } = stubNotification('granted')
  workspaceResponses([inWork, rows[1]], [rows[0], rows[1]])

  render(<App />)
  expect(await screen.findByText('В работе')).toBeInTheDocument()
  expect(shown).toHaveLength(0)

  await tick(3000)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(1)
  expect(shown[0].title).toBe('app-knowledge: ждёт оператора')
  expect(shown[0].options?.body).toBe('D:\\Projects\\app\nТаблица рабочих копий')

  await tick(3000)
  expect(shown).toHaveLength(1)
})

test('уведомляет, когда копия освободилась, клик переводит на вкладку панели', async () => {
  fakeInterval()
  const { shown } = stubNotification('granted')
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})
  const freed: WorkspaceRow = { ...rows[0], task: null, flowStep: null, progress: null, status: 'free' }
  workspaceResponses([rows[0]], [freed])

  render(<App />)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()

  await tick(3000)
  expect(await screen.findByText('Свободна')).toBeInTheDocument()
  expect(shown).toHaveLength(1)
  expect(shown[0].title).toBe('app-knowledge: копия свободна')
  expect(shown[0].options?.body).toBe('D:\\Projects\\app')

  shown[0].onclick?.()
  expect(focus).toHaveBeenCalled()
  expect(shown[0].close).toHaveBeenCalled()
  focus.mockRestore()
})

test('с разрешёнными уведомлениями опрашивает и скрытую вкладку и уведомляет с неё', async () => {
  fakeInterval()
  const { shown } = stubNotification('granted')
  const fetchMock = workspaceResponses([inWork], [rows[0]])

  render(<App />)
  await screen.findByText('В работе')

  setVisibility('hidden')
  await tick(3000)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  await vi.waitFor(() => expect(shown).toHaveLength(1))
  expect(shown[0].title).toBe('app-knowledge: ждёт оператора')
})

test('без разрешения смены статуса уведомлений не шлют', async () => {
  fakeInterval()
  const { shown } = stubNotification('denied')
  workspaceResponses([inWork], [rows[0]])

  render(<App />)
  await screen.findByText('В работе')
  await tick(3000)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(0)
})

test('переключатель ставит тему и браузер её помнит', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() }))
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 })))

  const first = render(<App />)
  // Без своего выбора тема тёмная по системе, атрибута на странице нет
  expect(document.documentElement.dataset.theme).toBeUndefined()

  fireEvent.click(await screen.findByRole('button', { name: 'Светлая тема' }))
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(localStorage.getItem('agents-kit-web.theme')).toBe('light')
  expect(screen.getByRole('button', { name: 'Тёмная тема' })).toBeInTheDocument()

  // Выбранная тема переживает перезагрузку страницы
  first.unmount()
  delete document.documentElement.dataset.theme
  applyChosenTheme()
  render(<App />)
  expect(document.documentElement.dataset.theme).toBe('light')
  expect(await screen.findByRole('button', { name: 'Тёмная тема' })).toBeInTheDocument()
})

test('опрос не закрывает окно ответа и не сбрасывает введённое', async () => {
  fakeInterval()
  const questions = {
    project: 'app-knowledge',
    copy: 'D:\\Projects\\app',
    task: 'Таблица рабочих копий',
    criteria: [],
    outOfScope: null,
    questions: [{ title: 'Какой интервал?', context: null, variants: [], answer: null }],
  }
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/workspaces'
      ? new Response(JSON.stringify(rows), { status: 200 })
      : new Response(JSON.stringify(questions), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
  const dialog = await screen.findByRole('dialog')
  const input = await within(dialog).findByRole('textbox')
  fireEvent.change(input, { target: { value: 'три секунды' } })

  for (let i = 0; i < 3; i++) await tick(3000)
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/workspaces')).toHaveLength(4)
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('textbox')).toHaveValue('три секунды')
})

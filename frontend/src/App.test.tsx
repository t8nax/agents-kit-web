import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'
import { type AgentKind, type AgentRequestSummary } from './agentRequest'
import NotificationsCard from './NotificationsCard'
import { applyChosenTheme } from './theme'

// Индикатор просьб к агенту опрашивает панель сам и проверяется своим тестом: здесь он молчит,
// иначе его опрос путался бы со счётом опросов таблицы копий. Возврат к просьбе зовут сами тесты —
// мок отдаёт им обработчик отметки в шапке.
let openRequest: ((request: AgentRequestSummary) => void) | null = null
vi.mock('./AgentBar', () => ({
  default: ({ onOpen }: { onOpen: (request: AgentRequestSummary) => void }) => {
    openRequest = onOpen
    return null
  },
}))

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
    sessionState: 'idle',
    backgroundSession: true,
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
    sessionState: 'working',
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

test('до первого опроса таблица копий стоит заготовкой под шапкой колонок, а не пустой', async () => {
  let answer: () => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (answer = () => resolve(Response.json(rows))))),
  )

  render(<App />)

  const skeleton = screen.getByRole('status', { name: 'Загрузка рабочих копий' })
  expect(skeleton).toHaveAttribute('aria-busy', 'true')
  expect(within(skeleton.querySelector('thead')!).getAllByRole('columnheader', { hidden: true })).toHaveLength(8)
  expect(screen.getByRole('button', { name: 'Новая копия' })).toBeDisabled()

  await act(async () => answer())

  expect(screen.queryByRole('status', { name: 'Загрузка рабочих копий' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Agents Kit Web' })).toBeInTheDocument()
})

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

test('точка у имени копии говорит, что делает её сессия', async () => {
  // Копия без сессии — та, где задачу ведут, а сессию уже закрыли: её видно среди работающих
  const abandoned: WorkspaceRow = { ...rows[0], path: 'D:\\Projects\\left', status: 'in-work', sessionState: null }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([...rows, abandoned]), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()

  // Статус копии считается по памяти и остаётся прежним — состояние сессии читается рядом с ним
  expect(within(tableRows[1]).getByLabelText('сессия стоит без дела')).toBeInTheDocument()
  expect(within(tableRows[1]).getByText('Ждёт оператора')).toBeInTheDocument()
  expect(within(tableRows[2]).getByLabelText('сессия работает')).toBeInTheDocument()
  expect(within(tableRows[4]).getByLabelText('сессии нет')).toBeInTheDocument()
  expect(within(tableRows[4]).getByText('В работе')).toBeInTheDocument()

  // Строке с ошибкой точку ставить не о чем: копии на диске нет
  expect(within(tableRows[3]).queryByRole('img')).not.toBeInTheDocument()

  // Подпись точки — метка, а не текст: содержимое ячейки остаётся именем копии и её веткой
  expect(within(tableRows[1]).getAllByRole('cell')[0]).toHaveTextContent(/^appfeat\/table$/)

  // Слова состояния держит подсказка точки, отдельной легенды под таблицей нет
  expect(within(tableRows[1]).getByRole('img')).toHaveAttribute('title', 'сессия стоит без дела')
  expect(screen.queryByText('Точка у имени копии:')).not.toBeInTheDocument()
})

test('сессия, ждущая оператора в терминале, отмечена своей точкой', async () => {
  const asking: WorkspaceRow = { ...rows[1], sessionState: 'waiting' }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([asking]), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()

  expect(within(tableRows[1]).getByLabelText('сессия ждёт вас в терминале')).toBeInTheDocument()
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

  // Шапка колонок, группа app-knowledge с тремя копиями, группа Nota с одной; в заголовке только название —
  // сводку «3 копии · 1 ждёт оператора» оператор убрал на приёмке
  const heads = all.map((row) => within(row).queryByRole('rowheader')?.textContent ?? null)
  expect(heads).toEqual([null, 'app-knowledge', null, null, null, 'Nota', null])
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

test('группа сворачивается кликом по любому месту шапки, а число проблем базы её не сворачивает', async () => {
  const withProblems: WorkspaceRow[] = rows.map((row) => ({ ...row, problemsState: 'checked', baseProblems: 2, problems: 0 }))
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/health'
        ? new Response(JSON.stringify({ pending: false, kit: 'ok', bases: [], checkedAt: null }), { status: 200 })
        : new Response(JSON.stringify(withProblems), { status: 200 }),
    ),
  )

  render(<App />)
  const header = await screen.findByRole('rowheader')

  fireEvent.click(within(header).getByText('app-knowledge'))
  expect(screen.queryByText('Таблица рабочих копий')).not.toBeInTheDocument()
  expect(within(header).getByRole('button', { name: 'Развернуть app-knowledge' })).toHaveAttribute('aria-expanded', 'false')

  fireEvent.click(header)
  expect(screen.getByText('Таблица рабочих копий')).toBeInTheDocument()

  // Кнопка-стрелка сворачивает ровно один раз: её клик не складывается с кликом шапки
  fireEvent.click(within(header).getByRole('button', { name: 'Свернуть app-knowledge' }))
  expect(screen.queryByText('Таблица рабочих копий')).not.toBeInTheDocument()
  fireEvent.click(within(header).getByRole('button', { name: 'Развернуть app-knowledge' }))

  fireEvent.click(within(header).getByRole('button', { name: '2 проблемы базы — открыть «Проблемы баз»' }))
  expect(await screen.findByRole('heading', { name: 'Проблемы баз' })).toBeInTheDocument()
  expect(localStorage.getItem('agents-kit-web.collapsed-groups')).toBe('[]')
})

test('номер задачи из бэклога стоит своей колонкой, без номера и без задачи — прочерк', async () => {
  const numbered: WorkspaceRow = { ...rows[0], task: 'B-24 Номер задачи отдельной колонкой', letters: 'B' }
  const unnumbered: WorkspaceRow = { ...rows[0], path: 'D:\\Projects\\app-2', task: 'Задача не из бэклога', letters: 'B' }
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
  // У свободной копии задачи нет, и на её месте стоит запуск
  expect(cells(tableRows[3]).slice(1, 3)).toEqual(['—', '—'])
  // Строка с ошибкой накрывает и колонку номера: ячеек в ней столько же, сколько колонок
  expect(within(tableRows[4]).getAllByRole('cell')[1]).toHaveAttribute('colspan', '5')
})

test('номер задачи отделяется по буквам её проекта, слово с другими буквами номером не становится', async () => {
  const orders: WorkspaceRow = { ...rows[0], task: 'ORD-12 Выгрузка заказов за период', letters: 'ORD' }
  const utf: WorkspaceRow = { ...rows[0], path: 'D:\\Projects\\orders-2', task: 'UTF-8 в именах файлов ломает выгрузку', letters: 'ORD' }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([orders, utf])))

  render(<App />)

  const tableRows = await findTableRows()
  const cells = (row: HTMLElement) => within(row).getAllByRole('cell').map((cell) => cell.textContent)
  expect(cells(tableRows[1]).slice(1, 3)).toEqual(['ORD-12', 'Выгрузка заказов за период'])
  expect(within(tableRows[1]).getByText('ORD-12')).toHaveClass('num-chip')
  expect(cells(tableRows[2]).slice(1, 3)).toEqual(['—', 'UTF-8 в именах файлов ломает выгрузку'])
})

// Меню действий строки: кнопка «⋯» открывает его, пункт — действие над копией этой строки
async function openRowMenu(row: HTMLElement) {
  await act(async () => {
    fireEvent.click(within(row).getByRole('button', { name: /Действия с / }))
  })
  return within(row).getByRole('menu')
}

test('меню действий стоит у прочитанных копий и открывает в VS Code ту, чью строку нажали', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/workspace/open'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  // Строка с ошибкой открывать нечего — у неё меню нет
  expect(within(tableRows[1]).getByRole('button', { name: 'Действия с app' })).toBeInTheDocument()
  expect(within(tableRows[3]).queryByRole('button', { name: /Действия с / })).not.toBeInTheDocument()

  const menu = await openRowMenu(tableRows[2])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Открыть в VS Code' }))
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/workspace/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app-wt' }),
  })
  // Выбранный пункт закрывает меню: строка снова показывает одну кнопку действий
  expect(within(tableRows[2]).queryByRole('menu')).not.toBeInTheDocument()
})

test('«Открыть в терминале» ведёт в фоновую сессию копии, а без неё приглушено', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/session/terminal'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  // У свободной копии фоновой сессии нет: пункт виден, но не нажимается и говорит почему
  const free = await openRowMenu(tableRows[2])
  // Подписи о причине у приглушённого пункта нет — оператор убрал её на приёмке
  const disabled = within(free).getByRole('menuitem', { name: 'Открыть в терминале' })
  expect(disabled).toBeDisabled()
  expect(disabled).toHaveTextContent('Открыть в терминале')

  const menu = await openRowMenu(tableRows[1])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Открыть в терминале' }))
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/session/terminal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app' }),
  })
})

test('терминал не открылся — панель говорит об этом строкой', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/session/terminal'
      ? new Response(JSON.stringify({ problem: 'no-session' }), { status: 409 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  const menu = await openRowMenu(tableRows[1])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Открыть в терминале' }))
  })

  expect(await screen.findByText('Сессия в app уже не идёт в фоне')).toBeInTheDocument()
})

test('«Удалить копию» стоит у свободной копии, приглушён у занятой и не стоит у основной', async () => {
  // Основная копия проекта — та, от которой кит заводит новые: её строку выдаёт copiesDir
  const main: WorkspaceRow = { ...rows[1], path: 'D:\\Projects\\app-main', status: 'free', copiesDir: 'D:\\Projects' }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([...rows, main]), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()

  const free = await openRowMenu(tableRows[2])
  expect(within(free).getByRole('menuitem', { name: 'Удалить копию' })).toBeEnabled()

  // В копии идёт задача: её память живёт в базе, и панель копию не убирает
  const busy = await openRowMenu(tableRows[1])
  expect(within(busy).getByRole('menuitem', { name: 'Удалить копию' })).toBeDisabled()

  const mainMenu = await openRowMenu(tableRows[4])
  expect(within(mainMenu).queryByRole('menuitem', { name: 'Удалить копию' })).not.toBeInTheDocument()
})

test('плашка «Основная» стоит у основной копии проекта и только у неё', async () => {
  const main: WorkspaceRow = { ...rows[1], path: 'D:\\Projects\\app-main', status: 'free', copiesDir: 'D:\\Projects' }
  // У второго проекта копия одна, и она же основная: плашка стоит и там — решение оператора на B-133
  const lone: WorkspaceRow = { ...otherBase, copiesDir: 'D:\\Projects' }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify([...rows, main, lone]), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()

  expect(within(tableRows[4]).getByText('Основная')).toBeInTheDocument()
  expect(within(tableRows[2]).queryByText('Основная')).toBeNull()
  expect(within(tableRows[5]).getByText('Основная')).toBeInTheDocument()
})

test('удаление копии открывает окно, а после удачи таблица перечитывается и гаснет сообщение', async () => {
  fakeInterval()
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/workspace/remove'
      ? new Response(null, { status: 204 })
      : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()

  const menu = await openRowMenu(tableRows[2])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Удалить копию' }))
  })

  const dialog = await screen.findByRole('dialog', { name: 'Удалить рабочую копию' })
  expect(dialog).toHaveTextContent('Копия app-wt проекта')
  const polls = fetchMock.mock.calls.filter(([url]) => url === '/api/workspaces').length

  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: 'Удалить копию' }))
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/workspace/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app-wt' }),
  })
  expect(screen.queryByRole('dialog', { name: 'Удалить рабочую копию' })).not.toBeInTheDocument()
  // Опрос не ждут: таблица перечитывается сразу
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/workspaces').length).toBeGreaterThan(polls)

  // Сообщение гаснет своим таймером — тем же, что у сообщения о запущенной задаче
  expect(await screen.findByRole('status')).toHaveTextContent('Копия app-wt удалена')
})

test('задачу из таблицы копий не берут: запуск живёт в разделе «Бэклог»', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(rows)))

  render(<App />)
  const tableRows = await findTableRows()

  // Кнопки нет ни у свободной копии, ни у занятой — решение оператора на B-86
  expect(screen.queryByRole('button', { name: 'Взять задачу' })).toBeNull()
  // На её месте у свободной копии прочерк, остальная строка прежняя
  const taskCell = within(tableRows[2]).getAllByRole('cell')[2]
  expect(taskCell).toHaveTextContent('—')
})

test('запущенная задача стоит в строке копии до памяти: номер, заголовок и «Запускается»', async () => {
  const starting: WorkspaceRow = {
    ...rows[1],
    task: 'B-7 Панель показывает задачу сразу',
    letters: 'B',
    status: 'starting',
    sessionState: 'working',
    backgroundSession: true,
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json([starting])))

  render(<App />)

  const row = (await findTableRows())[1]
  const cells = within(row).getAllByRole('cell').map((cell) => cell.textContent)
  // Номер с заголовком записи — всё, что панель знает о задаче; шага флоу и прогресса ещё нет
  expect(cells.slice(1, 6)).toEqual(['B-7', 'Панель показывает задачу сразу', '—', '—', 'Запускается'])
  expect(within(row).getByText('Запускается')).toHaveClass('status-starting')
})

test('«Новая копия» открывает окно, заведённая копия отмечена в таблице и уведомлением', async () => {
  const source: WorkspaceRow = { ...rows[1], copiesDir: 'D:\\Projects' }
  const created: WorkspaceRow = { ...rows[1], path: 'D:\\Projects\\quiet-cedar', branch: 'quiet-cedar' }
  let copyCreated = false
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/workspaces' && init?.method === 'POST') {
      copyCreated = true
      return Response.json({ name: 'quiet-cedar' })
    }
    return Response.json(copyCreated ? [rows[0], source, created] : [rows[0], source])
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  await screen.findAllByRole('row')
  fireEvent.click(screen.getByRole('button', { name: 'Новая копия' }))

  const dialog = screen.getByRole('dialog', { name: 'Новая рабочая копия' })
  fireEvent.change(within(dialog).getByLabelText(/Имя копии/), { target: { value: 'quiet-cedar' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Завести копию' }))

  expect(await screen.findByRole('status')).toHaveTextContent('Копия quiet-cedar заведена')
  expect(screen.queryByRole('dialog')).toBeNull()
  const fresh = (await screen.findByText('новая')).closest('tr')!
  expect(fresh).toHaveClass('row-fresh')
  // Путь копии в строке не пишется — он в подсказке ячейки с её именем
  expect(within(fresh).getAllByRole('cell')[0]).toHaveAttribute('title', 'D:\\Projects\\quiet-cedar')
  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces', expect.objectContaining({ method: 'POST' }))
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

  const menu = await openRowMenu(tableRows[2])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Открыть в VS Code' }))
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

test('шапка уведомлениями не управляет: их включают в «Настройках»', async () => {
  stubNotification('default')
  workspaceResponses(rows)

  render(<App />)

  await findTableRows()
  expect(screen.queryByRole('button', { name: /уведомления/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
  expect(screen.queryByText('Уведомления запрещены в браузере')).not.toBeInTheDocument()
})

test('выключенные в «Настройках» уведомления не показываются и не держат опрос скрытой вкладки', async () => {
  fakeInterval()
  // Так переключатель карточки «Уведомления» помнит, что уведомления выключены
  localStorage.setItem('agents-kit-web.notifications-muted', 'true')
  const { shown } = stubNotification('granted')
  const fetchMock = workspaceResponses([inWork], [rows[0]])

  render(<App />)
  await screen.findByText('В работе')

  setVisibility('hidden')
  await tick(30000)
  expect(fetchMock).toHaveBeenCalledTimes(1)

  await act(async () => setVisibility('visible'))
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(0)
})

test('выключенные и снова включённые переключателем уведомления приходят без нового запроса разрешения', async () => {
  fakeInterval()
  const { shown, FakeNotification } = stubNotification('granted')
  workspaceResponses([inWork], [rows[0]])

  // Карточка «Уведомления» стоит в «Настройках»; здесь она рядом с таблицей, чтобы щелчок по ней шёл в ту же панель
  render(
    <>
      <App />
      <NotificationsCard />
    </>,
  )
  await screen.findByText('В работе')
  const toggle = screen.getByRole('switch', { name: 'Показывать уведомления' })
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-checked', 'true')

  await tick(3000)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()
  expect(shown).toHaveLength(1)
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
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
    artifacts: [],
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


const backlogs = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'app-knowledge',
    entries: [{ number: 'B-1', title: 'Запись своего проекта', text: null }],
    error: null,
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    entries: [{ number: 'B-2', title: 'Запись соседнего проекта', text: null }],
    error: null,
  },
]

const flows = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'app-knowledge',
    stages: [],
    flows: [],
    version: 'v1',
    error: null,
    icons: {},
  },
]

const performers = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'app-knowledge',
    copies: [{ path: 'D:\\Projects\\app', name: 'app', branch: 'master', main: true }],
    performers: [],
    error: null,
  },
]

// Разделы, к которым ведёт возврат к просьбе, читают каждый своё; окна просьб — /api/agent/requests
function stubSections() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === '/api/backlog') return new Response(JSON.stringify(backlogs), { status: 200 })
    if (url === '/api/flow') return new Response(JSON.stringify(flows), { status: 200 })
    if (url === '/api/performers') return new Response(JSON.stringify(performers), { status: 200 })
    if (url === '/api/workspaces') return new Response(JSON.stringify(rows), { status: 200 })
    return new Response(JSON.stringify([]), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

// Оператор вернулся к просьбе отметкой в шапке: панель открывает её раздел с её окном
function returnToRequest(kind: AgentKind, base: string) {
  act(() => {
    openRequest?.({ kind, id: 'r1', base, project: 'app-knowledge', text: 'запиши', elapsedMs: 0, state: 'running' })
  })
}

function sidebarButtons() {
  return within(screen.getByRole('navigation', { name: 'Разделы панели' }))
}

test('«Бэклог» из сайдбара открывается списком, а не окном Чудо-Юдо после возврата к просьбе', async () => {
  stubSections()
  render(<App />)
  await screen.findByRole('table')

  returnToRequest('backlog', 'D:\\Projects\\app-knowledge')
  expect(await screen.findByRole('dialog', { name: 'Чудо-Юдо' })).toBeInTheDocument()

  const sidebar = sidebarButtons()
  fireEvent.click(sidebar.getByRole('button', { name: /Рабочие копии/ }))
  fireEvent.click(sidebar.getByRole('button', { name: /Бэклог/ }))

  expect(await screen.findByRole('heading', { name: 'Бэклог' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog', { name: 'Чудо-Юдо' })).not.toBeInTheDocument()
  // Фильтр по проекту забыт вместе с окном: в списке снова все проекты
  expect(await screen.findByText('Запись соседнего проекта')).toBeInTheDocument()
})

test('возврат к просьбе о флоу открывает раздел «Флоу» с окном переписывания, а сайдбар — без него', async () => {
  stubSections()
  render(<App />)
  await screen.findByRole('table')

  returnToRequest('flow', 'D:\\Projects\\app-knowledge')

  expect(await screen.findByRole('heading', { name: 'Флоу' })).toBeInTheDocument()
  expect(await screen.findByRole('heading', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()

  const sidebar = sidebarButtons()
  fireEvent.click(sidebar.getByRole('button', { name: /Рабочие копии/ }))
  fireEvent.click(sidebar.getByRole('button', { name: /Флоу/ }))

  expect(await screen.findByRole('heading', { name: 'Флоу' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Переписать с Чудо-Юдо' })).not.toBeInTheDocument()
})

test('«Исполнители» из сайдбара открываются списком, а не окном заведения после возврата к просьбе', async () => {
  stubSections()
  render(<App />)
  await screen.findByRole('table')

  returnToRequest('performer', 'D:\\Projects\\app-knowledge')
  expect(await screen.findByRole('heading', { name: 'Новый исполнитель' })).toBeInTheDocument()

  const sidebar = sidebarButtons()
  fireEvent.click(sidebar.getByRole('button', { name: /Рабочие копии/ }))
  fireEvent.click(sidebar.getByRole('button', { name: /Исполнители/ }))

  expect(await screen.findByRole('heading', { name: 'Исполнители' })).toBeInTheDocument()
  expect(screen.queryByRole('heading', { name: 'Новый исполнитель' })).not.toBeInTheDocument()
})

test('возврат к просьбе из шапки открывает раздел с окном на её базе сколько угодно раз', async () => {
  stubSections()
  render(<App />)
  await screen.findByRole('table')

  returnToRequest('backlog', 'D:\\Projects\\app-knowledge')
  expect(await screen.findByRole('dialog', { name: 'Чудо-Юдо' })).toBeInTheDocument()

  fireEvent.click(sidebarButtons().getByRole('button', { name: /Рабочие копии/ }))
  await screen.findByRole('table')

  returnToRequest('backlog', 'D:\\Projects\\app-knowledge')
  expect(await screen.findByRole('dialog', { name: 'Чудо-Юдо' })).toBeInTheDocument()
  // Раздел встал на базе просьбы: записи соседнего проекта список не показывает
  expect(screen.queryByText('Запись соседнего проекта')).not.toBeInTheDocument()
})

// Ответ записан, а прочесть его некому — B-106
const unread: WorkspaceRow = {
  ...rows[0],
  status: 'unread',
  sessionState: null,
  backgroundSession: false,
}

test('копия с непрочитанным ответом стоит плашкой, считается ждущей и держит точку свёрнутой группы', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([unread, rows[1]]), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()
  const row = within(tableRows[1])
  expect(row.getByText('Ответ не прочитан')).toHaveClass('status-badge', 'status-unread')
  expect(row.queryByRole('button', { name: 'Ответить' })).not.toBeInTheDocument()
  expect(document.querySelector('.progress-fill.waiting')).not.toBeNull()

  const sidebar = within(screen.getByRole('navigation', { name: 'Разделы панели' }))
  expect(sidebar.getByRole('button', { name: 'Рабочие копии, 1 ждёт' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Свернуть app-knowledge' }))
  expect(document.querySelectorAll('.group-waiting-dot')).toHaveLength(1)
})

test('уведомляет, когда ответ в копии остался непрочитанным', async () => {
  fakeInterval()
  const { shown } = stubNotification('granted')
  workspaceResponses([rows[0], rows[1]], [unread, rows[1]])

  render(<App />)
  expect(await screen.findByText('Ждёт оператора')).toBeInTheDocument()

  await tick(3000)
  expect(await screen.findByText('Ответ не прочитан')).toBeInTheDocument()
  expect(shown).toHaveLength(1)
  expect(shown[0].title).toBe('app-knowledge: ответ не прочитан')
  expect(shown[0].options?.body).toBe('D:\\Projects\\app\nТаблица рабочих копий')
})

test('«Завести сессию задачи» открыт у копии с задачей без сессии и приглушён у остальных', async () => {
  // Сессия задачи жива — фоновая или в VS Code — заводить нечего; свободной копии продолжать нечего
  const withBackground: WorkspaceRow = { ...rows[0], path: 'D:\\Projects\\app-bg' }
  const withVsCode: WorkspaceRow = { ...unread, path: 'D:\\Projects\\app-vs', status: 'in-work', vsCodeSession: true }
  // Сессия умерла посреди работы, вопросов не было — например после перезагрузки (B-217)
  const deadInWork: WorkspaceRow = { ...unread, path: 'D:\\Projects\\app-dead', status: 'in-work' }
  const list = [unread, rows[1], withBackground, withVsCode, deadInWork]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(list), { status: 200 })))

  render(<App />)
  const tableRows = await findTableRows()

  const start = (menu: HTMLElement) => within(menu).getByRole('menuitem', { name: 'Завести сессию задачи' })
  expect(start(await openRowMenu(tableRows[1]))).toBeEnabled()
  expect(start(await openRowMenu(tableRows[2]))).toBeDisabled()
  expect(start(await openRowMenu(tableRows[3]))).toBeDisabled()
  expect(start(await openRowMenu(tableRows[4]))).toBeDisabled()
  expect(start(await openRowMenu(tableRows[5]))).toBeEnabled()
})

test('заведённая сессия так и не показалась — точка перестаёт мигать, и панель говорит об этом строкой', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/api/tasks/session'
      ? new Response(JSON.stringify({ session: '7339dced' }), { status: 200 })
      : new Response(JSON.stringify([unread, rows[1]]), { status: 200 }),
  ))

  render(<App />)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
  const tableRows = screen.getAllByRole('row').filter((row) => within(row).queryByRole('rowheader') === null)
  fireEvent.click(within(tableRows[1]).getByRole('button', { name: 'Действия с app' }))
  await act(async () => {
    fireEvent.click(within(tableRows[1]).getByRole('menuitem', { name: 'Завести сессию задачи' }))
    await vi.advanceTimersByTimeAsync(0)
  })
  expect(within(tableRows[1]).getByLabelText('сессия заводится')).toBeInTheDocument()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000)
  })
  expect(screen.getByText('Сессия в app заведена, но в перечне живых сессий так и не показалась')).toBeInTheDocument()
  expect(within(tableRows[1]).getByLabelText('сессии нет')).toBeInTheDocument()
})

test('«Завести сессию задачи» заводит сессию молча, и точка копии мигает, пока сессия не покажется', async () => {
  fakeInterval()
  const alive: WorkspaceRow = { ...unread, status: 'in-work', sessionState: 'working', backgroundSession: true }
  let list = [unread, rows[1]]
  const fetchMock = vi.fn(async (url: string) =>
    url === '/api/tasks/session'
      ? new Response(JSON.stringify({ session: '7339dced' }), { status: 200 })
      : new Response(JSON.stringify(list), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(<App />)
  const tableRows = await findTableRows()
  const menu = await openRowMenu(tableRows[1])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Завести сессию задачи' }))
  })

  expect(fetchMock).toHaveBeenCalledWith('/api/tasks/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\app' }),
  })
  // Окна терминала панель не открывает — решение оператора
  expect(fetchMock).not.toHaveBeenCalledWith('/api/session/terminal', expect.anything())
  expect(within(tableRows[1]).getByLabelText('сессия заводится')).toHaveClass('session-starting')

  list = [alive, rows[1]]
  await tick(3000)
  const row = within((await findTableRows())[1])
  expect(await row.findByLabelText('сессия работает')).toBeInTheDocument()
  expect(row.getByText('В работе')).toBeInTheDocument()
})

test('сессия задачи не завелась — панель говорит об этом строкой, и точка не мигает', async () => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    url === '/api/tasks/session'
      ? new Response(JSON.stringify({ problem: 'session-alive' }), { status: 400 })
      : new Response(JSON.stringify([unread, rows[1]]), { status: 200 }),
  ))

  render(<App />)
  const tableRows = await findTableRows()
  const menu = await openRowMenu(tableRows[1])
  await act(async () => {
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Завести сессию задачи' }))
  })

  expect(await screen.findByText('В app сессия задачи уже идёт')).toBeInTheDocument()
  expect(within(tableRows[1]).getByLabelText('сессии нет')).toBeInTheDocument()
})

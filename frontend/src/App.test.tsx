import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'

let visibility: DocumentVisibilityState = 'visible'
Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  visibility = 'visible'
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

  const tableRows = await screen.findAllByRole('row')
  expect(fetchMock).toHaveBeenCalledWith('/api/workspaces')
  expect(tableRows).toHaveLength(4)

  const waiting = within(tableRows[1])
  expect(waiting.getByText('feat/table · D:\\Projects\\app')).toBeInTheDocument()
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
  await screen.findAllByRole('row')
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
  await screen.findAllByRole('row')

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
    constructor(
      public title: string,
      public options?: NotificationOptions,
    ) {
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

  await screen.findAllByRole('row')
  expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Уведомления/)).not.toBeInTheDocument()
})

test('кнопка в шапке запрашивает разрешение на уведомления', async () => {
  const { FakeNotification } = stubNotification('default', 'granted')
  workspaceResponses(rows)

  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }))

  expect(await screen.findByText('Уведомления включены')).toBeInTheDocument()
  expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
  expect(screen.queryByRole('button', { name: 'Включить уведомления' })).not.toBeInTheDocument()
})

test('при отказе в разрешении шапка это показывает, а таблица работает', async () => {
  stubNotification('default', 'denied')
  workspaceResponses(rows)

  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Включить уведомления' }))

  expect(await screen.findByText('Уведомления запрещены в браузере')).toBeInTheDocument()
  expect(screen.getAllByRole('row')).toHaveLength(4)
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

test('опрос не закрывает окно ответа и не сбрасывает введённое', async () => {
  fakeInterval()
  const questions = {
    project: 'app-knowledge',
    copy: 'D:\\Projects\\app',
    task: 'Таблица рабочих копий',
    criterion: [],
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

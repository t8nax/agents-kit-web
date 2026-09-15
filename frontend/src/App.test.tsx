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

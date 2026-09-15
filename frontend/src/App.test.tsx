import { render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'

afterEach(() => {
  vi.unstubAllGlobals()
})

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
})

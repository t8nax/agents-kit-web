import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import type { BaseEntry } from './BasesModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit) => Response

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input.split('?')[0]}`
    const handler = handlers[key]
    if (!handler) throw new Error(`Нет обработчика ${key}`)
    return Promise.resolve(handler(init))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const existing: BaseEntry = { path: 'D:\\Projects\\app-knowledge', copies: 2 }

async function openBases() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Базы знаний' }))
  return screen.findByRole('dialog', { name: 'Отслеживаемые базы' })
}

test('кнопка «Базы знаний» открывает окно со списком баз', async () => {
  stubApi({ 'GET /api/workspaces': () => json([]), 'GET /api/bases': () => json([existing]) })

  const dialog = await openBases()

  const list = await within(dialog).findByRole('list', { name: 'Базы знаний' })
  expect(within(list).getByText('D:\\Projects\\app-knowledge')).toBeInTheDocument()
  expect(within(list).getByText('2 коп.')).toBeInTheDocument()
  expect(within(list).getByRole('button', { name: 'Удалить D:\\Projects\\app-knowledge' })).toBeInTheDocument()
})

test('добавленная база появляется в списке, а после «Готово» таблица перечитывается', async () => {
  let posted: unknown = null
  const fetchMock = stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json([]),
    'POST /api/bases': (init) => {
      posted = JSON.parse(String(init?.body))
      return json({ path: 'D:\\Projects\\nota-knowledge', copies: 1 }, 201)
    },
  })

  const dialog = await openBases()
  fireEvent.change(await within(dialog).findByLabelText('Путь к каталогу базы'), {
    target: { value: 'D:\\Projects\\nota-knowledge' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))

  expect(await within(dialog).findByText('D:\\Projects\\nota-knowledge')).toBeInTheDocument()
  expect(posted).toEqual({ path: 'D:\\Projects\\nota-knowledge' })
  expect(within(dialog).getByLabelText('Путь к каталогу базы')).toHaveValue('')

  fireEvent.click(within(dialog).getByRole('button', { name: 'Готово' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await waitFor(() =>
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/workspaces')).toHaveLength(2),
  )
})

test.each([
  ['not-a-base', 400, 'В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.'],
  ['duplicate', 409, 'Эта база уже в списке.'],
  ['not-full-path', 400, 'Укажите полный путь, например D:\\Projects\\project-knowledge.'],
])('отказ API %s показывает причину и не меняет список', async (problem, status, text) => {
  stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json([existing]),
    'POST /api/bases': () => json({ problem }, status),
  })

  const dialog = await openBases()
  fireEvent.change(await within(dialog).findByLabelText('Путь к каталогу базы'), { target: { value: 'D:\\Projects\\x' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(text)
  expect(within(dialog).getAllByRole('listitem')).toHaveLength(1)
})

test('пустой путь не отправляется', async () => {
  const fetchMock = stubApi({ 'GET /api/workspaces': () => json([]), 'GET /api/bases': () => json([]) })

  const dialog = await openBases()
  fireEvent.change(await within(dialog).findByLabelText('Путь к каталогу базы'), { target: { value: '   ' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Добавить' }))

  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Введите путь к каталогу базы.')
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

test('«Удалить» убирает базу из списка', async () => {
  const fetchMock = stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json([existing]),
    'DELETE /api/bases': () => new Response(null, { status: 204 }),
  })

  const dialog = await openBases()
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Удалить D:\\Projects\\app-knowledge' }))

  expect(await within(dialog).findByText('Список пуст.')).toBeInTheDocument()
  const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]
  expect(deleted).toBe(`/api/bases?path=${encodeURIComponent('D:\\Projects\\app-knowledge')}`)
})

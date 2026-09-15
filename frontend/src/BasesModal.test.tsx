import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import type { BaseEntry, FolderListing } from './BasesModal'

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
  return screen.findByRole('dialog', { name: 'Базы знаний' })
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

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Введите путь к каталогу базы или выберите папку через «Обзор…».',
  )
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

const drives: FolderListing = {
  path: null,
  parent: null,
  folders: [{ name: 'D:\\', path: 'D:\\', isBase: false, copies: null }],
}

const projects: FolderListing = {
  path: 'D:\\Projects',
  parent: 'D:\\',
  folders: [
    { name: 'agents-kit-web-knowledge', path: 'D:\\Projects\\agents-kit-web-knowledge', isBase: true, copies: 2 },
    { name: 'nota-knowledge', path: 'D:\\Projects\\nota-knowledge', isBase: true, copies: 1 },
    { name: 'nota', path: 'D:\\Projects\\nota', isBase: false, copies: null },
  ],
}

test('«Обзор…» открывает диски, папки открываются, а базу из обзора можно добавить', async () => {
  const listings: Record<string, FolderListing> = {
    '': drives,
    'D:\\': { path: 'D:\\', parent: null, folders: [{ name: 'Projects', path: 'D:\\Projects', isBase: false, copies: null }] },
    'D:\\Projects': projects,
  }
  const fetchMock = stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json([{ path: 'D:\\Projects\\agents-kit-web-knowledge', copies: 2 }]),
    'GET /api/folders': () => {
      const url = String(fetchMock.mock.calls.at(-1)?.[0])
      return json(listings[new URLSearchParams(url.split('?')[1] ?? '').get('path') ?? ''])
    },
    'POST /api/bases': () => json({ path: 'D:\\Projects\\nota-knowledge', copies: 1 }, 201),
  })

  const dialog = await openBases()
  fireEvent.click(await within(dialog).findByRole('button', { name: /Обзор/ }))

  const folders = await within(dialog).findByRole('list', { name: 'Папки' })
  fireEvent.click(await within(folders).findByRole('button', { name: /D:\\/ }))
  fireEvent.click(await within(folders).findByRole('button', { name: /Projects/ }))

  expect(await within(folders).findByText('nota-knowledge')).toBeInTheDocument()
  const nav = within(dialog).getByRole('navigation', { name: 'Текущая папка' })
  expect(within(nav).getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-current', 'location')

  const listed = within(folders).getByText('agents-kit-web-knowledge').closest('li')!
  expect(within(listed).getByText('уже в списке')).toBeInTheDocument()
  expect(within(folders).queryByRole('button', { name: 'Добавить D:\\Projects\\nota' })).not.toBeInTheDocument()

  fireEvent.click(within(folders).getByRole('button', { name: 'Добавить D:\\Projects\\nota-knowledge' }))
  expect(await within(dialog).findByRole('status')).toHaveTextContent('Добавлена nota-knowledge')
  const added = within(folders).getByText('nota-knowledge').closest('li')!
  expect(within(added).getByText('уже в списке')).toBeInTheDocument()

  fireEvent.click(within(dialog).getByRole('button', { name: 'К списку баз' }))
  const list = await within(dialog).findByRole('list', { name: 'Базы знаний' })
  expect(within(list).getByText('D:\\Projects\\nota-knowledge')).toBeInTheDocument()
})

test('папка без доступа показывает причину в обзоре', async () => {
  const fetchMock = stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json([]),
    'GET /api/folders': () =>
      String(fetchMock.mock.calls.at(-1)?.[0]).includes('?')
        ? json({ problem: 'access-denied' }, 403)
        : json(drives),
  })

  const dialog = await openBases()
  fireEvent.click(await within(dialog).findByRole('button', { name: /Обзор/ }))
  fireEvent.click(await within(dialog).findByRole('button', { name: /D:\\/ }))

  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Нет доступа к этой папке.')
})

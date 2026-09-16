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

const bases: BaseEntry[] = [
  { path: 'D:\\Projects\\app-knowledge', copies: 2, project: 'App' },
  { path: 'D:\\Projects\\nota-knowledge', copies: 1, project: 'Nota' },
]

async function openNew() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Новая копия' }))
  return screen.findByRole('dialog', { name: 'Новая рабочая копия' })
}

test('окно показывает проекты отслеживаемых баз', async () => {
  stubApi({ 'GET /api/workspaces': () => json([]), 'GET /api/bases': () => json(bases) })

  const dialog = await openNew()

  const select = await within(dialog).findByLabelText('Проект')
  expect(within(select).getByRole('option', { name: 'App' })).toBeInTheDocument()
  expect(within(select).getByRole('option', { name: 'Nota' })).toBeInTheDocument()
})

test('заведение копии шлёт базу и имя, закрывает окно и перечитывает таблицу', async () => {
  let posted: unknown = null
  const fetchMock = stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json(bases),
    'POST /api/workspaces': (init) => {
      posted = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    },
  })

  const dialog = await openNew()
  fireEvent.change(await within(dialog).findByLabelText('Проект'), { target: { value: 'D:\\Projects\\nota-knowledge' } })
  fireEvent.change(within(dialog).getByLabelText('Имя копии'), { target: { value: 'quiet-cedar' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Завести копию' }))

  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Новая рабочая копия' })).not.toBeInTheDocument())
  expect(posted).toEqual({ base: 'D:\\Projects\\nota-knowledge', name: 'quiet-cedar' })
  await waitFor(() =>
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/workspaces').length).toBeGreaterThan(1),
  )
})

test('пустое имя уходит незаполненным — имя придумает кит', async () => {
  let posted: unknown = null
  stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json(bases),
    'POST /api/workspaces': (init) => {
      posted = JSON.parse(String(init?.body))
      return new Response(null, { status: 204 })
    },
  })

  const dialog = await openNew()
  fireEvent.click(await within(dialog).findByRole('button', { name: 'Завести копию' }))

  await waitFor(() => expect(posted).toEqual({ base: 'D:\\Projects\\app-knowledge', name: null }))
})

test('отказ скрипта кита показывается его же текстом, окно остаётся открытым', async () => {
  stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json(bases),
    'POST /api/workspaces': () =>
      json({ problem: 'script', message: 'ветка «quiet-cedar» уже существует — назвать копию иначе' }, 400),
  })

  const dialog = await openNew()
  fireEvent.change(await within(dialog).findByLabelText('Имя копии'), { target: { value: 'quiet-cedar' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Завести копию' }))

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'ветка «quiet-cedar» уже существует — назвать копию иначе',
  )
})

test('имя не по правилам объясняется правилом имени', async () => {
  stubApi({
    'GET /api/workspaces': () => json([]),
    'GET /api/bases': () => json(bases),
    'POST /api/workspaces': () => json({ problem: 'bad-name', message: null }, 400),
  })

  const dialog = await openNew()
  fireEvent.change(await within(dialog).findByLabelText('Имя копии'), { target: { value: 'Quiet Cedar' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Завести копию' }))

  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'Имя — строчная латиница и цифры через дефис, например quiet-cedar.',
  )
})

test('без отслеживаемых баз копию завести нечем', async () => {
  stubApi({ 'GET /api/workspaces': () => json([]), 'GET /api/bases': () => json([]) })

  const dialog = await openNew()

  expect(await within(dialog).findByText(/Нет отслеживаемых баз/)).toBeInTheDocument()
  expect(within(dialog).getByRole('button', { name: 'Завести копию' })).toBeDisabled()
})

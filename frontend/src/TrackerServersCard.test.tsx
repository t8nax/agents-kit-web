import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerServersCard, { type TrackerServer } from './TrackerServersCard'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit, url?: string) => Response | Promise<Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input.split('?')[0]}`
    const handler = handlers[key]
    if (!handler) throw new Error(`Нет обработчика ${key}`)
    return Promise.resolve(handler(init, input))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const acme: TrackerServer = { server: 'https://acme.youtrack.cloud', login: 'boris.k' }
const northwind: TrackerServer = { server: 'https://youtrack.northwind.ru', login: 'b.kuznetsov' }

async function list() {
  return screen.findByRole('list', { name: 'Серверы трекеров' })
}

function fill(server: string, key: string) {
  fireEvent.change(screen.getByLabelText('Адрес сервера'), { target: { value: server } })
  fireEvent.change(screen.getByLabelText('Ключ'), { target: { value: key } })
}

test('пустой список — «Список пуст.», ключ вводится скрытым полем', async () => {
  stubApi({ 'GET /api/trackers': () => json([]) })

  render(<TrackerServersCard />)

  expect(within(await list()).getByText('Список пуст.')).toBeInTheDocument()
  expect(screen.getByLabelText('Ключ')).toHaveAttribute('type', 'password')
})

test('битый файл серверов назван путём, а не пустым списком', async () => {
  stubApi({ 'GET /api/trackers': () => json({ problem: 'file-broken', detail: 'C:\\Users\\me\\trackers.json' }, 500) })

  render(<TrackerServersCard />)

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Файл серверов трекеров не разобран: C:\\Users\\me\\trackers.json. Поправьте или удалите его',
  )
  expect(screen.queryByText('Список пуст.')).not.toBeInTheDocument()
})

test('добавленный сервер проверяется на сервере и встаёт в список с логином владельца ключа', async () => {
  let answer: (response: Response) => void = () => {}
  let posted: unknown = null
  stubApi({
    'GET /api/trackers': () => json([]),
    'POST /api/trackers': (init) => {
      posted = JSON.parse(String(init?.body))
      return new Promise((resolve) => (answer = resolve))
    },
  })
  render(<TrackerServersCard />)
  await list()

  fill(acme.server, 'perm:ключ')
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

  expect(await screen.findByText(/Ключ проверяется на сервере/)).toHaveTextContent(`Ключ проверяется на сервере ${acme.server}…`)
  expect(screen.getByRole('button', { name: 'Добавить' })).toBeDisabled()
  expect(posted).toEqual({ server: acme.server, key: 'perm:ключ' })

  answer(json(acme))

  const row = await within(await list()).findByText(acme.server)
  expect(row).toHaveAttribute('title', acme.server)
  expect(within(row.closest('li')!).getByText('boris.k')).toBeInTheDocument()
  expect(screen.getByLabelText('Адрес сервера')).toHaveValue('')
  expect(screen.getByLabelText('Ключ')).toHaveValue('')
  expect(screen.queryByText(/Ключ проверяется/)).not.toBeInTheDocument()
})

test.each([
  ['key-rejected', undefined, 'Ключ', 'Сервер отклонил ключ, ключ не сохранён.'],
  ['server-silent', 'истекло время ожидания', 'Адрес сервера', 'Сервер не ответил: истекло время ожидания. Ключ не сохранён.'],
  ['not-address', undefined, 'Адрес сервера', 'Адрес сервера — вида https://хост'],
])('отказ «%s» — ключ не сохранён, причина под полями, поле в красной рамке', async (problem, detail, field, text) => {
  stubApi({
    'GET /api/trackers': () => json([]),
    'POST /api/trackers': () => json({ problem, detail }, 400),
  })
  render(<TrackerServersCard />)
  await list()

  fill(acme.server, 'perm:ключ')
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(text)
  expect(screen.getByLabelText(field)).toHaveAttribute('aria-invalid', 'true')
  expect(within(await list()).getByText('Список пуст.')).toBeInTheDocument()
})

test('«Заменить ключ» проверяет новый ключ и оставляет сервер на месте с новым логином', async () => {
  let put: unknown = null
  stubApi({
    'GET /api/trackers': () => json([acme, northwind]),
    'PUT /api/trackers/key': (init) => {
      put = JSON.parse(String(init?.body))
      return json({ server: acme.server, login: 'boris.new' })
    },
  })
  render(<TrackerServersCard />)
  await list()

  fireEvent.click(screen.getByRole('button', { name: `Заменить ключ ${acme.server}` }))
  fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'perm:новый' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('boris.new')).toBeInTheDocument()
  expect(put).toEqual({ server: acme.server, key: 'perm:новый' })
  expect(screen.queryByLabelText('Новый ключ')).not.toBeInTheDocument()
  const rows = within(await list()).getAllByRole('listitem')
  expect(rows.map((row) => row.querySelector('.trk-url')?.textContent)).toEqual([acme.server, northwind.server])
})

test('отказ при замене ключа — прежний ключ остаётся, причина под полем', async () => {
  stubApi({
    'GET /api/trackers': () => json([acme]),
    'PUT /api/trackers/key': () => json({ problem: 'key-rejected' }, 400),
  })
  render(<TrackerServersCard />)
  await list()

  fireEvent.click(screen.getByRole('button', { name: `Заменить ключ ${acme.server}` }))
  fireEvent.change(screen.getByLabelText('Новый ключ'), { target: { value: 'perm:плохой' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Сервер отклонил ключ')
  expect(screen.getByText('boris.k')).toBeInTheDocument()
})

test('«Удалить» открывает окно, и сервер уходит только после «Удалить сервер»', async () => {
  const fetchMock = stubApi({
    'GET /api/trackers': () => json([acme, northwind]),
    'DELETE /api/trackers': () => new Response(null, { status: 204 }),
  })
  render(<TrackerServersCard />)
  await list()

  fireEvent.click(screen.getByRole('button', { name: `Удалить ${acme.server}` }))
  const dialog = await screen.findByRole('dialog', { name: 'Удалить сервер трекера' })
  expect(dialog).toHaveTextContent(`Сервер ${acme.server} уйдёт из списка вместе с ключом пользователя boris.k.`)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: `Удалить ${acme.server}` }))
  fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Удалить сервер' }))

  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(within(await list()).queryByText(acme.server)).not.toBeInTheDocument()
  expect(within(await list()).getByText(northwind.server)).toBeInTheDocument()
  const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]
  expect(deleted).toBe(`/api/trackers?server=${encodeURIComponent(acme.server)}`)
})

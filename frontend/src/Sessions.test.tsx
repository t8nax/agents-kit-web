import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Sessions, { type SessionRow } from './Sessions'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const working: SessionRow = {
  path: 'D:\\Projects\\rustic-silver-sparrow',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: 'agents-kit b-50 drive',
  session: '540066c8',
  state: 'working',
  background: true,
  startedAt: Date.now() - 2 * 60 * 60_000,
}

const idle: SessionRow = {
  path: 'D:\\Projects\\agents-kit-web',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: 'agents-kit b-31 drive flow',
  session: 'a1c66bfd',
  state: 'idle',
  background: true,
  startedAt: Date.now() - 14 * 60 * 60_000,
}

const inEditor: SessionRow = {
  path: 'D:\\Projects\\noble-keen-walrus',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: null,
  session: null,
  state: 'idle',
  background: false,
  startedAt: Date.now() - 26 * 60 * 60_000,
}

const zebra: SessionRow = {
  path: 'D:\\Projects\\silver-misty-zebra',
  project: 'Nota',
  base: 'D:\\Projects\\nota-knowledge',
  name: 'agents-kit n-12 drive',
  session: '9919e753',
  state: 'idle',
  background: true,
  startedAt: Date.now() - 50 * 60 * 60_000,
}

/** Перечень отдаётся GET, а гашение и переход — POST; ответ на действие задаётся тестом. */
function stubSessions(rows: SessionRow[], action: Response = new Response(null, { status: 204 })) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === 'POST' ? action : new Response(JSON.stringify(rows), { status: 200 }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function openMenu(row: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Действия с сессией в ${row}` }))
}

test('сессии показаны группами по проекту', async () => {
  stubSessions([working, idle, inEditor, zebra])

  render(<Sessions />)

  expect(await screen.findByText('Agents Kit Web')).toBeInTheDocument()
  expect(screen.getByText('Nota')).toBeInTheDocument()
  expect(screen.getByText('agents-kit b-50 drive')).toBeInTheDocument()
  expect(screen.getByText('фоновая · 540066c8')).toBeInTheDocument()
  expect(screen.getByText('Работает')).toBeInTheDocument()
  expect(screen.getAllByText('Стоит без дела')).toHaveLength(3)
  expect(screen.getByText('2 ч 00 мин')).toBeInTheDocument()
  // Сессия своего окна показана, но короткого id у неё нет
  expect(screen.getByText('в своём окне')).toBeInTheDocument()
})

test('чипы оставляют сессии одной копии', async () => {
  stubSessions([working, idle, zebra])

  render(<Sessions />)

  fireEvent.click(await screen.findByRole('button', { name: 'agents-kit-web' }))

  expect(screen.getByText('agents-kit b-31 drive flow')).toBeInTheDocument()
  expect(screen.queryByText('agents-kit b-50 drive')).not.toBeInTheDocument()
  expect(screen.queryByText('Nota')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Все копии' }))
  expect(screen.getByText('agents-kit b-50 drive')).toBeInTheDocument()
})

test('группа сворачивается кликом по шапке', async () => {
  stubSessions([working, zebra])

  render(<Sessions />)

  fireEvent.click(await screen.findByRole('button', { name: 'Свернуть Agents Kit Web' }))

  expect(screen.queryByText('agents-kit b-50 drive')).not.toBeInTheDocument()
  expect(screen.getByText('agents-kit n-12 drive')).toBeInTheDocument()
})

test('простаивающая сессия гаснет одним нажатием', async () => {
  const fetchMock = stubSessions([idle])

  render(<Sessions />)
  await openMenu('agents-kit-web')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Погасить сессию' }))

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/stop', expect.objectContaining({ method: 'POST' })),
  )
  const body = fetchMock.mock.calls.find((call) => call[0] === '/api/sessions/stop')![1]!.body
  expect(JSON.parse(String(body))).toEqual({ session: 'a1c66bfd' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('работающую сессию гасят через вопрос, и отмена её не гасит', async () => {
  const fetchMock = stubSessions([working])

  render(<Sessions />)
  await openMenu('rustic-silver-sparrow')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Погасить сессию' }))

  const dialog = screen.getByRole('dialog', { name: 'Погасить сессию?' })
  expect(within(dialog).getByText(/сейчас работает/)).toBeInTheDocument()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(fetchMock.mock.calls.every((call) => call[0] !== '/api/sessions/stop')).toBe(true)

  await openMenu('rustic-silver-sparrow')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Погасить сессию' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Погасить' }))

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/stop', expect.objectContaining({ method: 'POST' })),
  )
})

test('сессию своего окна из панели не погасить и в неё не войти', async () => {
  stubSessions([inEditor])

  render(<Sessions />)
  await openMenu('noble-keen-walrus')

  expect(screen.getByRole('menuitem', { name: 'Погасить сессию' })).toBeDisabled()
  expect(screen.getByRole('menuitem', { name: 'Войти в сессию' })).toBeDisabled()
})

test('переход открывает терминал по id сессии', async () => {
  const fetchMock = stubSessions([working])

  render(<Sessions />)
  await openMenu('rustic-silver-sparrow')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Войти в сессию' }))

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/terminal', expect.objectContaining({ method: 'POST' })),
  )
})

test('неудачное гашение сказано словами агента', async () => {
  stubSessions(
    [idle],
    new Response(JSON.stringify({ problem: 'agent', message: 'no such session' }), { status: 502 }),
  )

  render(<Sessions />)
  await openMenu('agents-kit-web')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Погасить сессию' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Сессию a1c66bfd не погасить: no such session')
})

test('сессии, которой уже нет, гашение не выдумывает', async () => {
  stubSessions([idle], new Response(JSON.stringify({ problem: 'no-session' }), { status: 409 }))

  render(<Sessions />)
  await openMenu('agents-kit-web')
  fireEvent.click(screen.getByRole('menuitem', { name: 'Погасить сессию' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Сессия a1c66bfd уже не идёт')
})

test('живых сессий нет — раздел так и говорит', async () => {
  stubSessions([])

  render(<Sessions />)

  expect(await screen.findByText('Живых сессий Claude Code нет.')).toBeInTheDocument()
})

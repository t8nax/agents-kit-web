import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import NewSessionModal from './NewSessionModal'
import type { SessionRow } from './Sessions'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = 'D:\\Projects\\agents-kit-web-knowledge'

const free: WorkspaceRow = {
  project: 'Agents Kit Web',
  base,
  path: 'D:\\Projects\\rustic-silver-sparrow',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

const busy: WorkspaceRow = {
  ...free,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'B-58',
  task: 'B-58 Панель зовёт кит',
  status: 'in-work',
}

const broken: WorkspaceRow = { ...free, path: 'D:\\Projects\\gone', error: 'каталога нет' }

const session: SessionRow = {
  path: free.path,
  project: 'Agents Kit Web',
  base,
  name: 'agents-kit b-61 drive',
  session: '540066c8',
  state: 'working',
  background: true,
  startedAt: Date.now() - 60_000,
}

/** Отвечает на GET /api/workspaces копиями, на POST /api/sessions/new — переданным ответом; собирает тела POST. */
function stub(post: Response | Promise<Response>, rows: WorkspaceRow[] = [free, busy, broken]) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        expect(url).toBe('/api/sessions/new')
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(post)
      }
      expect(url).toBe('/api/workspaces')
      return Promise.resolve(Response.json(rows))
    }),
  )
  return posts
}

function renderModal() {
  const props = { onClose: vi.fn(), onStarted: vi.fn() }
  render(<NewSessionModal sessions={[session]} {...props} />)
  return props
}

test('окно показывает копии списка с ветками и числом их сессий, без недоступных', async () => {
  stub(Response.json({ session: '7339dced', terminal: true }))
  renderModal()

  const copies = await screen.findAllByRole('radio')
  expect(copies).toHaveLength(2)

  const dialog = screen.getByRole('dialog', { name: 'Новая сессия' })
  expect(within(dialog).getByText('rustic-silver-sparrow')).toBeInTheDocument()
  expect(within(dialog).getByText('ветка dev · 1 сессия')).toBeInTheDocument()
  expect(within(dialog).getByText('ветка B-58 · сессий нет')).toBeInTheDocument()
  expect(within(dialog).queryByText('gone')).not.toBeInTheDocument()
})

test('сессия запускается в выбранной копии с набранной просьбой', async () => {
  const posts = stub(Response.json({ session: '7339dced', terminal: true }))
  const props = renderModal()

  await screen.findAllByRole('radio')
  fireEvent.change(screen.getByLabelText('С чего начать — необязательно'), {
    target: { value: '  посмотри, почему падает e2e  ' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))

  await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith('7339dced', true))
  expect(posts).toEqual([{ base, copy: free.path, prompt: 'посмотри, почему падает e2e' }])
})

test('пустая просьба уходит как её отсутствие', async () => {
  const posts = stub(Response.json({ session: 'abc123', terminal: true }))
  renderModal()

  await screen.findAllByRole('radio')
  fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))

  await waitFor(() => expect(posts).toEqual([{ base, copy: free.path, prompt: null }]))
})

test('про копию с идущей задачей окно предупреждает, но запускать не мешает', async () => {
  const posts = stub(Response.json({ session: 'abc123', terminal: true }))
  renderModal()

  const copies = await screen.findAllByRole('radio')
  expect(screen.queryByText(/Новая сессия её не прервёт/)).not.toBeInTheDocument()

  fireEvent.click(copies[1])

  expect(screen.getByText(/В копии noble-keen-walrus идёт задача B-58 Панель зовёт кит/)).toBeInTheDocument()
  expect(screen.getByText('идёт задача B-58')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Запустить' })).toBeEnabled()

  fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))
  await waitFor(() => expect(posts).toEqual([{ base, copy: busy.path, prompt: null }]))
})

test('неудачный запуск остаётся в окне и не теряет набранного', async () => {
  stub(Response.json({ problem: 'agent', message: 'claude не запустился' }, { status: 400 }))
  const props = renderModal()

  await screen.findAllByRole('radio')
  fireEvent.change(screen.getByLabelText('С чего начать — необязательно'), { target: { value: 'посмотри логи' } })
  fireEvent.click(screen.getByRole('button', { name: 'Запустить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Сессия не запущена: агент не стартовал. claude не запустился')
  expect(screen.getByLabelText('С чего начать — необязательно')).toHaveValue('посмотри логи')
  expect(props.onStarted).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
})

test('без связи с API копии не читаются, и окно это говорит', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
  )
  renderModal()

  expect(await screen.findByText('Нет связи с API')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Запустить' })).toBeDisabled()
})

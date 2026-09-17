import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import type { BaseBacklog } from './Backlog'
import StartTaskModal from './StartTaskModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = 'D:\\Projects\\app-knowledge'
const row: WorkspaceRow = {
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

const backlogs: BaseBacklog[] = [
  {
    base,
    project: 'Agents Kit Web',
    entries: [
      { number: 'B-7', title: 'Панель показывает задачу сразу', text: 'Текст оператору.' },
      { number: 'B-8', title: 'Кнопка запуска', text: null },
      { number: null, title: 'Запись без номера', text: null },
    ],
    error: null,
  },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: [{ number: 'B-1', title: 'Чужая', text: null }], error: null },
]

/** Отвечает на GET /api/backlog списком, на POST /api/tasks — переданным ответом; собирает тела POST. */
function stub(post: Response | Promise<Response>, list: BaseBacklog[] = backlogs) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(post)
      }
      expect(url).toBe('/api/backlog')
      return Promise.resolve(Response.json(list))
    }),
  )
  return posts
}

function renderModal() {
  const props = { onClose: vi.fn(), onStarted: vi.fn() }
  render(<StartTaskModal row={row} {...props} />)
  return props
}

test('окно показывает копию и записи бэклога её проекта, без чужих и без записей без номера', async () => {
  stub(Response.json({ session: '7339dced' }))
  renderModal()

  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  expect(dialog).toHaveTextContent('D:\\Projects\\rustic-silver-sparrow · ветка dev')

  const records = await screen.findAllByRole('radio')
  expect(records).toHaveLength(2)
  expect(within(dialog).getByText('B-7')).toBeInTheDocument()
  expect(dialog).toHaveTextContent('Панель показывает задачу сразу')
  expect(dialog).not.toHaveTextContent('Чужая')
  expect(dialog).not.toHaveTextContent('Запись без номера')
  // Пока запись не выбрана, запускать нечего
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
})

test('выбранная запись уходит в API с базой и копией, окно отдаёт id сессии', async () => {
  const posts = stub(Response.json({ session: '7339dced' }))
  const props = renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /B-8/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith('7339dced'))
  expect(posts).toEqual([{ base, copy: row.path, number: 'B-8' }])
})

test('занятая копия: окно называет идущую в ней задачу и не закрывается', async () => {
  stub(Response.json({ problem: 'copy-busy', message: 'B-5 Прошлая задача' }, { status: 400 }))
  const props = renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /B-7/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('В копии уже идёт задача «B-5 Прошлая задача»')
  expect(props.onStarted).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
})

test('агент не стартовал: окно показывает, что сказал запуск', async () => {
  stub(Response.json({ problem: 'agent', message: 'Не удалось найти указанный файл' }, { status: 400 }))
  renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /B-7/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Задача не запущена: агент не стартовал. Не удалось найти указанный файл',
  )
})

test('запись успели взять: окно говорит, что её больше нет', async () => {
  stub(Response.json({ problem: 'record-unknown', message: null }, { status: 400 }))
  renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /B-7/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Этой записи больше нет в бэклоге')
})

test('бэклог базы не прочитан: окно говорит почему и запускать нечего', async () => {
  stub(Response.json({ session: 'x' }), [{ base, project: 'Agents Kit Web', entries: [], error: 'В базе нет backlog.md' }])
  renderModal()

  expect(await screen.findByText('В базе нет backlog.md')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
})

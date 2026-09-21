import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import StartTaskModal from './StartTaskModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = 'D:\\Projects\\app-knowledge'
const entry = { number: 'B-8', title: 'Кнопка запуска', text: null }

const free = (path: string, branch: string | null): WorkspaceRow => ({
  project: 'Agents Kit Web',
  base,
  path,
  branch,
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
})

const rows: WorkspaceRow[] = [
  free('D:\\Projects\\rustic-silver-sparrow', 'dev'),
  free('D:\\Projects\\noble-keen-walrus', null),
  { ...free('D:\\Projects\\busy-copy', 'dev'), status: 'in-work', task: 'B-5 Прошлая задача' },
  { ...free('D:\\Projects\\broken-copy', null), error: 'Копии нет на диске' },
  { ...free('D:\\Projects\\nota-copy', 'dev'), base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

const flow = (name: string, when: string | null) => ({ name, when, entries: [{ stage: 'Ветка' }] })

const flows = [
  { base, project: 'Agents Kit Web', flows: [flow('полный', 'новая возможность'), flow('мелкий', 'правка в одном месте')] },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', flows: [flow('чужой', null)] },
]

/**
 * Отвечает на GET /api/workspaces списком копий, на GET /api/flow — флоу баз, на POST /api/tasks — переданным
 * ответом; собирает тела POST.
 */
function stub(post: Response | Promise<Response>, list: WorkspaceRow[] = rows, baseFlows: unknown[] = flows) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)))
        return Promise.resolve(post)
      }
      if (url === '/api/flow')
        return Promise.resolve(baseFlows === failedFlows ? new Response('', { status: 500 }) : Response.json(baseFlows))
      expect(url).toBe('/api/workspaces')
      return Promise.resolve(Response.json(list))
    }),
  )
  return posts
}

/** Отказ API на чтение флоу. */
const failedFlows: unknown[] = []

const copies = () => within(screen.getByRole('group', { name: 'Рабочая копия' }))

function renderModal() {
  const props = { onClose: vi.fn(), onStarted: vi.fn() }
  render(<StartTaskModal base={base} entry={entry} {...props} />)
  return props
}

test('окно показывает взятую запись и свободные копии её проекта — без занятых, сломанных и чужих', async () => {
  stub(Response.json({ session: '7339dced' }))
  renderModal()

  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  expect(within(dialog).getByText('B-8')).toBeInTheDocument()
  expect(dialog).toHaveTextContent('Кнопка запуска')

  await screen.findByRole('radio', { name: /rustic-silver-sparrow/ })
  expect(copies().getAllByRole('radio')).toHaveLength(2)
  expect(dialog).toHaveTextContent('rustic-silver-sparrow')
  expect(dialog).toHaveTextContent('ветка dev')
  // Копия без ветки всё равно выбирается — ветку панель просто не знает
  expect(dialog).toHaveTextContent('ветка неизвестна')
  expect(dialog).not.toHaveTextContent('busy-copy')
  expect(dialog).not.toHaveTextContent('broken-copy')
  expect(dialog).not.toHaveTextContent('nota-copy')
  // Пока копия не выбрана, запускать некуда
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
})

test('окно показывает выбор и с одной свободной копией — сама она не запускается', async () => {
  stub(Response.json({ session: '7339dced' }), [rows[0], rows[2]])
  const props = renderModal()

  expect(await screen.findByRole('radio', { name: /rustic-silver-sparrow/ })).not.toBeChecked()
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
  expect(props.onStarted).not.toHaveBeenCalled()
})

test('выбранная копия уходит в API с базой и номером записи, окно отдаёт имя копии', async () => {
  const posts = stub(Response.json({ session: '7339dced' }))
  const props = renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /noble-keen-walrus/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(props.onStarted).toHaveBeenCalledWith('noble-keen-walrus'))
  expect(posts).toEqual([{ base, copy: 'D:\\Projects\\noble-keen-walrus', number: 'B-8', flow: 'полный' }])
})

test('копию успели занять: окно называет идущую в ней задачу и не закрывается', async () => {
  stub(Response.json({ problem: 'copy-busy', message: 'B-5 Прошлая задача' }, { status: 400 }))
  const props = renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('В копии уже идёт задача «B-5 Прошлая задача»')
  expect(props.onStarted).not.toHaveBeenCalled()
  expect(props.onClose).not.toHaveBeenCalled()
  // Выбор не теряется — повторять его не приходится
  expect(screen.getByRole('radio', { name: /rustic-silver-sparrow/ })).toBeChecked()
})

test('агент не стартовал: окно показывает, что сказал запуск', async () => {
  stub(Response.json({ problem: 'agent', message: 'Не удалось найти указанный файл' }, { status: 400 }))
  renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Задача не запущена: агент не стартовал. Не удалось найти указанный файл',
  )
})

test('запись успели взять: окно говорит, что её больше нет', async () => {
  stub(Response.json({ problem: 'record-unknown', message: null }, { status: 400 }))
  renderModal()

  fireEvent.click(await screen.findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Этой записи больше нет в бэклоге')
})

test('свободных копий не осталось: окно говорит почему и запускать нечего', async () => {
  stub(Response.json({ session: 'x' }), [rows[2]])
  renderModal()

  expect(await screen.findByText('Свободной копии у проекта сейчас нет — все заняты задачами.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
})

test('выбор флоу виден всегда: у каждого его «когда», первым выбран первый флоу проекта', async () => {
  stub(Response.json({ session: 'x' }), rows, [{ ...flows[0], flows: [flow('полный', null)] }])
  renderModal()

  const group = within(await screen.findByRole('group', { name: 'Флоу' }))
  expect(await group.findByRole('radio', { name: /полный/ })).toBeChecked()
  expect(group.getAllByRole('radio')).toHaveLength(1)
})

test('выбранный флоу уходит в API вместе с копией', async () => {
  const posts = stub(Response.json({ session: '7339dced' }))
  const props = renderModal()

  const group = within(await screen.findByRole('group', { name: 'Флоу' }))
  expect(await group.findByRole('radio', { name: /полный/ })).toBeChecked()
  expect(group.getByText('когда: правка в одном месте')).toBeInTheDocument()
  // Флоу соседнего проекта не предлагаются
  expect(group.queryByRole('radio', { name: /чужой/ })).not.toBeInTheDocument()
  fireEvent.click(group.getByRole('radio', { name: /мелкий/ }))
  fireEvent.click(await copies().findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(props.onStarted).toHaveBeenCalled())
  expect(posts).toEqual([{ base, copy: 'D:\\Projects\\rustic-silver-sparrow', number: 'B-8', flow: 'мелкий' }])
})

test('у проекта нет флоу: окно говорит, что задачу не начать, и запускать нечего', async () => {
  stub(Response.json({ session: 'x' }), rows, [{ ...flows[0], flows: [] }])
  renderModal()

  expect(await screen.findByText('У проекта нет флоу — задачу не начать, пока его не завели.')).toBeInTheDocument()
  fireEvent.click(await copies().findByRole('radio', { name: /rustic-silver-sparrow/ }))
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()
})

test('флоу успели переименовать: окно говорит, что его больше нет', async () => {
  stub(Response.json({ problem: 'flow-unknown', message: null }, { status: 400 }))
  renderModal()

  await screen.findByRole('radio', { name: /полный/ })
  fireEvent.click(await copies().findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Этого флоу в базе больше нет')
})

test('флоу не прочитались: задачу можно начать без флоу — сессия спросит его сама', async () => {
  const posts = stub(Response.json({ session: 'x' }), rows, failedFlows)
  const props = renderModal()

  expect(await screen.findByText('Флоу не загрузились: HTTP 500. Сессия спросит флоу у вас сама.')).toBeInTheDocument()
  fireEvent.click(await copies().findByRole('radio', { name: /rustic-silver-sparrow/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(props.onStarted).toHaveBeenCalled())
  expect(posts).toEqual([{ base, copy: 'D:\\Projects\\rustic-silver-sparrow', number: 'B-8', flow: null }])
})

test('флоу базы не прочитан: это отказ чтения, а не «флоу нет» — запуск остаётся', async () => {
  stub(Response.json({ session: 'x' }), rows, [{ ...flows[0], flows: [], error: 'Флоу базы не прочитан' }])
  renderModal()

  expect(await screen.findByText('Флоу не прочитан: Флоу базы не прочитан. Сессия спросит флоу у вас сама.')).toBeInTheDocument()
  expect(screen.queryByText(/У проекта нет флоу/)).not.toBeInTheDocument()
  fireEvent.click(await copies().findByRole('radio', { name: /rustic-silver-sparrow/ }))
  expect(screen.getByRole('button', { name: 'Взять в работу' })).toBeEnabled()
})

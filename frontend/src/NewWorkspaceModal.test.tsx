import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import NewWorkspaceModal from './NewWorkspaceModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = 'D:\\Projects\\app-knowledge'
const row: WorkspaceRow = {
  project: 'Agents Kit Web',
  base,
  path: 'D:\\Projects\\app',
  branch: 'master',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
  copiesDir: 'D:\\Projects',
}
const rows: WorkspaceRow[] = [
  row,
  { ...row, path: 'D:\\Projects\\noble-keen-walrus', branch: 'noble-keen-walrus', task: 'B-14 Копия', status: 'in-work', copiesDir: null },
  { ...row, project: 'Nota', base: 'D:\\Projects\\nota-knowledge', path: 'E:\\gone', branch: null, status: null, error: 'Копия не найдена на диске', copiesDir: null },
]

function stubPost(response: Response | Promise<Response>) {
  const posts: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)))
      return Promise.resolve(response)
    }),
  )
  return posts
}

function renderModal(list = rows) {
  const props = { onClose: vi.fn(), onCreated: vi.fn(), onSettings: vi.fn() }
  render(<NewWorkspaceModal rows={list} {...props} />)
  return props
}

test('проект выбран, превью показывает папку и ветки, свободная копия названа', () => {
  renderModal()

  const dialog = screen.getByRole('dialog', { name: 'Новая рабочая копия' })
  expect(within(dialog).getByRole('radio', { name: /Agents Kit Web/ })).toBeChecked()
  // У проекта без копии на диске заводить не от чего
  expect(within(dialog).getByRole('radio', { name: /Nota/ })).toBeDisabled()
  expect(within(dialog).getByRole('radio', { name: /Agents Kit Web/ }).closest('label')).toHaveTextContent('2 копии1 свободна')

  const preview = within(dialog).getByLabelText('Что будет заведено')
  expect(preview).toHaveTextContent('D:\\Projects\\<имя от кита>')
  expect(preview).toHaveTextContent('с тем же именем')
  expect(preview).toHaveTextContent('master · основная копия D:\\Projects\\app')
  expect(dialog).toHaveTextContent('У проекта уже есть свободная копия master — задачу можно взять и в ней.')

  fireEvent.change(screen.getByLabelText(/Имя копии/), { target: { value: 'quiet-cedar' } })
  expect(preview).toHaveTextContent('D:\\Projects\\quiet-cedar')
  expect(preview).toHaveTextContent('Веткаquiet-cedar')
})

test('ветка основной копии неизвестна — в «От ветки» пусто, без тире', () => {
  renderModal([{ ...row, branch: null }])

  const preview = screen.getByLabelText('Что будет заведено')
  expect(preview).toHaveTextContent('От ветки· основная копия D:\\Projects\\app')
  expect(preview).not.toHaveTextContent('—')
})

test('копия заводится: имя уходит в API, окно сообщает имя от кита', async () => {
  const posts = stubPost(Response.json({ name: 'brave-sunny-otter' }))
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Завести копию' }))

  await vi.waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(base, 'brave-sunny-otter'))
  expect(posts).toEqual([{ base, name: null }])
})

test('пока кит работает, кнопки заблокированы и видно «Заводится…»', async () => {
  let finish!: (response: Response) => void
  stubPost(new Promise<Response>((resolve) => (finish = resolve)))
  const props = renderModal()

  fireEvent.change(screen.getByLabelText(/Имя копии/), { target: { value: ' quiet-cedar ' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести копию' }))

  const busy = await screen.findByRole('button', { name: 'Заводится…' })
  expect(busy).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(props.onClose).not.toHaveBeenCalled()

  finish(Response.json({ name: 'quiet-cedar' }))
  await vi.waitFor(() => expect(props.onCreated).toHaveBeenCalledWith(base, 'quiet-cedar'))
})

test('отказ кита показан его словами, окно остаётся, повтор — «Попробовать снова»', async () => {
  stubPost(
    Response.json(
      { problem: 'refused', message: 'ветка «quiet-cedar» уже существует — назвать копию иначе' },
      { status: 400 },
    ),
  )
  const props = renderModal()

  fireEvent.change(screen.getByLabelText(/Имя копии/), { target: { value: 'quiet-cedar' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести копию' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Кит не завёл копию')
  expect(alert).toHaveTextContent('ветка «quiet-cedar» уже существует — назвать копию иначе')
  expect(screen.getByLabelText(/Имя копии/)).toHaveAttribute('aria-invalid', 'true')
  expect(screen.getByRole('button', { name: 'Попробовать снова' })).toBeEnabled()
  expect(props.onCreated).not.toHaveBeenCalled()

  fireEvent.change(screen.getByLabelText(/Имя копии/), { target: { value: 'quiet-cedar-2' } })
  expect(screen.queryByRole('alert')).toBeNull()
})

test.each([
  ['kit-not-set', null, 'Путь к киту не задан'],
  ['kit-not-found', 'D:\\kit\\scripts\\worktree-add.ps1', 'Скрипт кита не найден: D:\\kit\\scripts\\worktree-add.ps1'],
])('без кита (%s) окно объясняет и ведёт в «Настройки»', async (problem, message, text) => {
  stubPost(Response.json({ problem, message }, { status: 400 }))
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Завести копию' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent(text)
  expect(screen.getByRole('button', { name: 'Завести копию' })).toBeDisabled()
  fireEvent.click(within(alert).getByRole('button', { name: 'Открыть «Настройки»' }))
  expect(props.onSettings).toHaveBeenCalled()
})

test('кит не задан по таблице — окно говорит об этом сразу', () => {
  renderModal(rows.map((r) => ({ ...r, problemsState: 'kit-not-set' as const })))

  expect(screen.getByRole('alert')).toHaveTextContent('Путь к киту не задан')
  expect(screen.getByRole('button', { name: 'Завести копию' })).toBeDisabled()
})

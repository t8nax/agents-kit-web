import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import DeleteWorkspaceModal from './DeleteWorkspaceModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const row: WorkspaceRow = {
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\app-knowledge',
  path: 'D:\\Projects\\quiet-cedar',
  branch: 'quiet-cedar',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

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

function renderModal(which: WorkspaceRow = row) {
  const props = { onClose: vi.fn(), onRemoved: vi.fn(), onSettings: vi.fn() }
  render(<DeleteWorkspaceModal row={which} {...props} />)
  return props
}

test('окно называет копию, каталог и ветку, которая переживёт удаление', () => {
  renderModal()

  const dialog = screen.getByRole('dialog', { name: 'Удалить рабочую копию' })
  expect(dialog).toHaveTextContent('Копия quiet-cedar уйдёт с диска. Вернуть её панель не сможет.')
  const preview = within(dialog).getByLabelText('Что будет удалено')
  expect(preview).toHaveTextContent('Agents Kit Web')
  expect(preview).toHaveTextContent('D:\\Projects\\quiet-cedar')
  expect(preview).toHaveTextContent('quiet-cedar — останется')
})

test('«Удалить копию» зовёт API базой и копией, и удача закрывает окно', async () => {
  const posts = stubPost(new Response(null, { status: 204 }))
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Удалить копию' }))

  await waitFor(() => expect(props.onRemoved).toHaveBeenCalled())
  expect(posts).toEqual([{ base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\quiet-cedar' }])
  expect(props.onClose).not.toHaveBeenCalled()
})

test('отказ кита показан его словами, а копия остаётся', async () => {
  stubPost(
    new Response(
      JSON.stringify({ problem: 'refused', message: 'в копии «D:\\Projects\\quiet-cedar» незакоммиченное: src/App.tsx' }),
      { status: 400 },
    ),
  )
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Удалить копию' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Кит не убрал копию')
  expect(alert).toHaveTextContent('в копии «D:\\Projects\\quiet-cedar» незакоммиченное: src/App.tsx')
  expect(props.onRemoved).not.toHaveBeenCalled()
  // Кнопка остаётся: разобрав правки в копии, оператор нажимает её снова
  expect(screen.getByRole('button', { name: 'Удалить копию' })).toBeEnabled()
})

test('без пути к киту окно ведёт в «Настройки», а удалять не даёт', async () => {
  stubPost(new Response(JSON.stringify({ problem: 'kit-not-set', message: null }), { status: 400 }))
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Удалить копию' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Путь к киту не задан')
  fireEvent.click(within(alert).getByRole('button', { name: 'Открыть «Настройки»' }))
  expect(props.onSettings).toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Удалить копию' })).toBeDisabled()
})

test('копия, которая успела занять себя задачей, не удаляется', async () => {
  stubPost(new Response(JSON.stringify({ problem: 'in-work', message: null }), { status: 409 }))
  renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Удалить копию' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('В копии идёт задача — сначала её нужно закрыть.')
})

test('нет связи с API — окно говорит это и остаётся открытым', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  const props = renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Удалить копию' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('нет связи с API')
  expect(props.onRemoved).not.toHaveBeenCalled()
})

test('Escape и «Отмена» закрывают окно, ничего не удаляя', () => {
  const posts = stubPost(new Response(null, { status: 204 }))
  const props = renderModal()

  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

  expect(props.onClose).toHaveBeenCalledTimes(2)
  expect(posts).toEqual([])
})

test('у копии с отсоединённым HEAD вместо ветки сказано «отсоединён»', () => {
  renderModal({ ...row, branch: null })

  expect(screen.getByLabelText('Что будет удалено')).toHaveTextContent('отсоединён — останется')
})

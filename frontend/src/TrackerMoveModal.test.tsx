import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerMoveModal from './TrackerMoveModal'
import type { TrackerDraft, TrackerMoved } from './tracker'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = 'D:\\Projects\\app-knowledge'
const entry = { number: 'B-281', title: 'Экспорт истории задачи копии в markdown', text: 'Текст.' }

const draft: TrackerDraft = {
  number: 'B-281',
  title: 'Экспорт истории задачи копии в markdown',
  body: 'Нужна выгрузка истории.\n\n### Агенту\n- где: ReplyModal.tsx',
  files: [],
  original: '## B-281 Экспорт истории задачи копии в markdown\n\nНужна выгрузка истории.',
}

const issue = {
  name: 'GitHub #58',
  number: 58,
  title: 'Экспорт истории задачи копии в markdown',
  url: 'https://github.com/acme/orders/issues/58',
}

/** Отвечает сборкой задачи и переносом; тела переноса собирает — по ним видно, что ушло в API. */
function stubFetch(shown: TrackerDraft | Response, moved: TrackerMoved | Response = { issue }) {
  const posts: unknown[] = []
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/backlog/tracker/draft?'))
      return Promise.resolve(shown instanceof Response ? shown : Response.json(shown))
    expect(url).toBe('/api/backlog/tracker/move')
    posts.push(JSON.parse(String(init?.body)))
    return Promise.resolve(moved instanceof Response ? moved : Response.json(moved))
  })
  vi.stubGlobal('fetch', fetchMock)
  return Object.assign(fetchMock, { posts })
}

function renderModal() {
  const onClose = vi.fn()
  const onMoved = vi.fn()
  render(<TrackerMoveModal base={base} entry={entry} onClose={onClose} onMoved={onMoved} />)
  return { onClose, onMoved }
}

test('показывает запись, заголовок и описание будущей задачи', async () => {
  const fetchMock = stubFetch(draft)

  renderModal()

  const dialog = screen.getByRole('dialog', { name: 'Перенести в трекер' })
  expect(await screen.findByText('Нужна выгрузка истории.')).toBeInTheDocument()
  expect(dialog).toHaveTextContent('Запись бэклога')
  expect(dialog).toHaveTextContent('B-281')
  expect(screen.getByText('Заголовок задачи').nextElementSibling).toHaveTextContent('Экспорт истории задачи копии в markdown')
  expect(screen.getByRole('heading', { name: 'Агенту' })).toBeInTheDocument()
  // Поля «Куда» нет — оператор убрал его на макете
  expect(dialog).not.toHaveTextContent('Куда')
  expect(screen.queryByText(/в задачу не попадут/)).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith(`/api/backlog/tracker/draft?base=${encodeURIComponent(base)}&number=B-281`)
})

test('файлы записи названы, и сказано, что в задачу они не попадут', async () => {
  stubFetch({ ...draft, files: [{ label: 'снимок', address: 'artifacts/B-281-снимок.png' }] })

  renderModal()

  expect(await screen.findByText('Файлы в задачу не попадут и удалятся вместе с записью:')).toBeInTheDocument()
  expect(screen.getByText('снимок')).toBeInTheDocument()
  expect(screen.getByText('artifacts/B-281-снимок.png')).toBeInTheDocument()
})

test('«Отмена» закрывает окно и ничего не заводит', async () => {
  const fetchMock = stubFetch(draft)
  const { onClose, onMoved } = renderModal()
  await screen.findByText('Нужна выгрузка истории.')

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

  expect(onClose).toHaveBeenCalled()
  expect(onMoved).not.toHaveBeenCalled()
  expect(fetchMock.posts).toEqual([])
})

test('«Завести задачу» переносит запись, какой её видело окно, и показывает ссылку на задачу', async () => {
  const fetchMock = stubFetch({ ...draft, files: [{ label: 'снимок', address: 'artifacts/B-281-снимок.png' }] })
  const { onMoved } = renderModal()

  fireEvent.click(await screen.findByRole('button', { name: 'Завести задачу' }))

  expect(await screen.findByRole('dialog', { name: 'Задача заведена' })).toBeInTheDocument()
  expect(fetchMock.posts).toEqual([{ base, number: 'B-281', original: draft.original }])
  const link = screen.getByRole('link', { name: /#58 Экспорт истории задачи копии в markdown/ })
  expect(link).toHaveAttribute('href', 'https://github.com/acme/orders/issues/58')
  expect(link).toHaveAttribute('target', '_blank')
  expect(screen.getByText('github.com/acme/orders/issues/58')).toBeInTheDocument()
  expect(screen.getByText('Запись B-281 убрана из бэклога, приложенные к ней файлы удалены.')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  // Закрыть можно крестиком и кнопкой внизу; завести ещё раз — нельзя
  expect(screen.getAllByRole('button', { name: 'Закрыть' })).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Завести задачу' })).not.toBeInTheDocument()
  expect(onMoved).toHaveBeenCalledTimes(1)
})

test('пока задача заводится, кнопки погашены', async () => {
  let reply: (response: Response) => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.startsWith('/api/backlog/tracker/draft?')
        ? Promise.resolve(Response.json(draft))
        : new Promise<Response>((resolve) => (reply = resolve)),
    ),
  )
  renderModal()

  fireEvent.click(await screen.findByRole('button', { name: 'Завести задачу' }))

  expect(await screen.findByRole('button', { name: 'Заводится…' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled()
  reply(Response.json({ issue }))
  expect(await screen.findByRole('dialog', { name: 'Задача заведена' })).toBeInTheDocument()
})

test('задача заведена, а запись осталась — ссылка на задачу и красная строка', async () => {
  stubFetch(draft, { issue, error: 'Коммит не прошёл — backlog.md оставлен как был' })
  const { onMoved } = renderModal()

  fireEvent.click(await screen.findByRole('button', { name: 'Завести задачу' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Запись осталась в бэклоге')
  expect(alert).toHaveTextContent('Коммит не прошёл — backlog.md оставлен как был')
  expect(screen.getByRole('link', { name: /#58/ })).toBeInTheDocument()
  expect(screen.queryByText(/убрана из бэклога/)).not.toBeInTheDocument()
  // Повторить нечего: второй раз завелась бы вторая задача
  expect(screen.queryByRole('button', { name: 'Завести задачу' })).not.toBeInTheDocument()
  expect(onMoved).toHaveBeenCalled()
})

test('GitHub отказал — окно называет причину, а перенос можно повторить', async () => {
  stubFetch(draft, { issue: null, problem: 'gh-login' })
  const { onMoved } = renderModal()

  fireEvent.click(await screen.findByRole('button', { name: 'Завести задачу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Задача не заведена. Программа gh не вошла в аккаунт GitHub.')
  expect(screen.getByRole('dialog', { name: 'Перенести в трекер' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Завести задачу' })).toBeEnabled()
  expect(onMoved).not.toHaveBeenCalled()
})

test('чужая правка бэклога — задача не заведена, окно говорит почему', async () => {
  stubFetch(draft, { issue: null, error: 'В backlog.md личного репозитория есть незакоммиченная правка — ничего не записано' })
  renderModal()

  fireEvent.click(await screen.findByRole('button', { name: 'Завести задачу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'В backlog.md личного репозитория есть незакоммиченная правка — ничего не записано',
  )
})

test('записи больше нет — задачу не собрать, и заводить нечего', async () => {
  stubFetch(new Response(null, { status: 404 }))
  renderModal()

  expect(await screen.findByText('Этой записи больше нет в бэклоге: её взяли или удалили.')).toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Завести задачу' })).toBeDisabled())
})

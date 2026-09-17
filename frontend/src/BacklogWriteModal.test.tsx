import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import BacklogWriteModal, { type WriteBase, type WriteEvent } from './BacklogWriteModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: WriteBase[] = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

/** Поток NDJSON, который тест выдаёт по строке, когда нужно. */
function controlledStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (c) => {
      controller = c
    },
  })
  const encoder = new TextEncoder()
  return {
    body,
    send: (event: WriteEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(),
  }
}

function stubFetch(stream: ReturnType<typeof controlledStream>) {
  const posts: { url: string; body: unknown; signal: AbortSignal }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)), signal: init!.signal! })
      return Promise.resolve(new Response(stream.body, { headers: { 'Content-Type': 'application/x-ndjson' } }))
    }),
  )
  return posts
}

function renderModal(initialBase: string | null = null) {
  const onEntries = vi.fn()
  render(<BacklogWriteModal bases={bases} initialBase={initialBase} onClose={() => {}} onEntries={onEntries} />)
  return onEntries
}

function send(text: string) {
  fireEvent.change(screen.getByLabelText('Что записать'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
}

test('текст уходит в проект раздела, ход агента виден, итог показывает новые записи с текстом', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  const onEntries = renderModal('D:\\Projects\\nota-knowledge')

  expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  send('  Хочу видеть ожидание и сортировку  ')

  expect(posts[0].url).toBe('/api/backlog/write')
  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\nota-knowledge', text: 'Хочу видеть ожидание и сортировку' })
  expect(await screen.findByText('Чудо-юдо пишет в бэклог Nota…')).toBeInTheDocument()

  stream.send({ type: 'step', text: 'правит backlog.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы агента' })
  expect(within(steps).getByText('правит backlog.md')).toBeInTheDocument()

  stream.send({
    type: 'written',
    text: 'Записал.',
    entries: [
      { number: 'B-32', title: 'Таблица показывает ожидание', text: 'Сколько копия **ждёт**.' },
      { number: 'B-33', title: 'Сортировка по номеру', text: null },
    ],
    commit: '4f1c2a9',
    durationMs: 72000,
  })

  expect(await screen.findByText('Добавлено 2 записи')).toBeInTheDocument()
  expect(screen.getByText('коммит 4f1c2a9 · 1 мин 12 с')).toBeInTheDocument()
  const entries = within(screen.getByRole('list', { name: 'Новые записи' }))
  expect(entries.getByText('B-32')).toBeInTheDocument()
  expect(entries.getByText('ждёт')).toHaveProperty('tagName', 'STRONG')
  expect(entries.getByText('Описания нет')).toBeInTheDocument()
  expect(onEntries).toHaveBeenCalledWith('D:\\Projects\\nota-knowledge', ['B-32', 'B-33'])

  fireEvent.click(screen.getByRole('button', { name: 'Записать ещё' }))
  expect(screen.getByLabelText('Что записать')).toHaveValue('')
})

test('неудача называет причину и вывод агента, а текст остаётся для повторной отправки', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  const onEntries = renderModal()

  send('Мысль')
  stream.send({ type: 'error', text: 'Агент закончил, но новых записей в бэклоге нет', output: 'Правка запрещена' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Чудо-юдо не записал')).toBeInTheDocument()
  expect(within(alert).getByText('Правка запрещена')).toBeInTheDocument()
  expect(onEntries).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить текст' }))
  expect(screen.getByLabelText('Что записать')).toHaveValue('Мысль')
  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\app-knowledge', text: 'Мысль' })
})

test('незакоммиченные записи показаны при ошибке и отмечаются в списке', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const onEntries = renderModal()

  send('Мысль')
  stream.send({
    type: 'error',
    text: 'Записи появились, но backlog.md не закоммичен',
    entries: [{ number: 'B-40', title: 'Новая запись', text: null }],
  })

  await screen.findByRole('alert')
  expect(within(screen.getByRole('list', { name: 'Новые записи' })).getByText('B-40')).toBeInTheDocument()
  expect(onEntries).toHaveBeenCalledWith('D:\\Projects\\app-knowledge', ['B-40'])
})

test('оборванный без итога поток — сбой, а не вечное ожидание', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  send('Мысль')
  stream.close()

  expect(await screen.findByRole('alert')).toHaveTextContent('Запись оборвалась')
})

test('«Отменить» обрывает запрос и возвращает текст в поле', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  renderModal()

  send('Долгая мысль')
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))

  expect(posts[0].signal.aborted).toBe(true)
  expect(screen.getByLabelText('Что записать')).toHaveValue('Долгая мысль')
})

test('без текста добавить нельзя', () => {
  stubFetch(controlledStream())
  renderModal()

  expect(screen.getByRole('button', { name: 'Добавить' })).toBeDisabled()
})

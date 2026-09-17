import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AskModal, { type AskBase, type AskEvent } from './AskModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: AskBase[] = [
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
    send: (event: AskEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(),
  }
}

function stubFetch(stream: ReturnType<typeof controlledStream>) {
  const posts: { body: unknown; signal: AbortSignal }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/ask/bases') return Promise.resolve(Response.json(bases))
      posts.push({ body: JSON.parse(String(init?.body)), signal: init!.signal! })
      return Promise.resolve(new Response(stream.body, { headers: { 'Content-Type': 'application/x-ndjson' } }))
    }),
  )
  return posts
}

async function askQuestion(text: string) {
  fireEvent.change(await screen.findByLabelText('Вопрос'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))
}

test('вопрос уходит в выбранную базу, ход работы виден до ответа, ответ показан с прочитанными файлами', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))
  await askQuestion('Почему опрос?')

  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\nota-knowledge', question: 'Почему опрос?' })
  expect(await screen.findByText('Агент читает базу Nota…')).toBeInTheDocument()

  stream.send({ type: 'step', text: 'читает decisions/ui.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы агента' })
  expect(within(steps).getByText('читает decisions/ui.md')).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Так решил **оператор**.\n\n- проще всего', files: ['decisions/ui.md'], durationMs: 31000 })
  expect(await screen.findByText('оператор')).toHaveProperty('tagName', 'STRONG')
  expect(screen.getByText('decisions/ui.md')).toBeInTheDocument()
  expect(screen.getByText('31 с')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Новый вопрос' }))
  expect(screen.getByLabelText('Вопрос')).toHaveValue('')
})

test('сбой агента показан с его выводом, вопрос можно изменить', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Что за проект?')
  stream.send({ type: 'error', text: 'Агент завершился с ошибкой', output: 'Invalid API key · Please run /login' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Invalid API key · Please run /login')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить вопрос' }))
  expect(screen.getByLabelText('Вопрос')).toHaveValue('Что за проект?')
})

test('оборванный без ответа поток — сбой, а не вечное ожидание', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Вопрос')
  stream.close()

  expect(await screen.findByRole('alert')).toHaveTextContent('Ответ оборвался')
})

test('«Отменить» обрывает запрос и возвращает вопрос в поле', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Долгий вопрос')
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))

  expect(posts[0].signal.aborted).toBe(true)
  expect(screen.getByLabelText('Вопрос')).toHaveValue('Долгий вопрос')
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('закрытое окно обрывает идущий запрос', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  const { unmount } = render(<AskModal onClose={() => {}} />)

  await askQuestion('Вопрос')
  await screen.findByRole('status')
  unmount()

  expect(posts[0].signal.aborted).toBe(true)
})

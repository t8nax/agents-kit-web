import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AskModal, { type AskBase, type AskEvent } from './AskModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: AskBase[] = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

/** Базы окно читает своим вызовом: стенд панели о них не знает. */
function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  return stubPanel('ask', stream, {
    running,
    project: 'Nota',
    others: (url) => (url === '/api/ask/bases' ? Response.json(bases) : null),
  })
}

async function askQuestion(text: string) {
  fireEvent.change(await screen.findByLabelText('Вопрос'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Спросить' }))
}

test('вопрос уходит в выбранную базу, ход работы виден до ответа, ответ показан с прочитанными файлами', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))
  await askQuestion('Почему опрос?')

  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\nota-knowledge', question: 'Почему опрос?' })
  expect(await screen.findByText('Чудо-юдо читает базу Nota…')).toBeInTheDocument()

  stream.send({ type: 'step', text: 'читает decisions/ui.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-юдо' })
  expect(within(steps).getByText('читает decisions/ui.md')).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Так решил **оператор**.\n\n- проще всего', files: ['decisions/ui.md'], durationMs: 31000 })
  expect(await screen.findByText('оператор')).toHaveProperty('tagName', 'STRONG')
  expect(screen.getByText('decisions/ui.md')).toBeInTheDocument()
  expect(screen.getByText('31 с')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Новый вопрос' }))
  expect(await screen.findByLabelText('Вопрос')).toHaveValue('')
})

test('сбой агента показан с его выводом, вопрос можно изменить', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Что за проект?')
  stream.send({ type: 'error', text: 'Агент завершился с ошибкой', output: 'Invalid API key · Please run /login' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Invalid API key · Please run /login')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить вопрос' }))
  expect(await screen.findByLabelText('Вопрос')).toHaveValue('Что за проект?')
})

test('оборванный без ответа поток — сбой, а не вечное ожидание', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Вопрос')
  stream.close()

  expect(await screen.findByRole('alert')).toHaveTextContent('Ответ оборвался')
})

test('«Отменить» убирает просьбу из панели и возвращает вопрос в поле', async () => {
  const stream = controlledStream<AskEvent>()
  const { deletes } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await askQuestion('Долгий вопрос')
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))

  expect(await screen.findByLabelText('Вопрос')).toHaveValue('Долгий вопрос')
  expect(deletes).toEqual(['/api/agent/ask'])
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

test('закрытое окно не останавливает агента: просьба остаётся в панели', async () => {
  const stream = controlledStream<AskEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = render(<AskModal onClose={() => {}} />)

  await askQuestion('Вопрос')
  await screen.findByRole('status')
  unmount()

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает работу, которая шла без него', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream, runningRequest('ask', 'Почему опрос?', bases[1].base, 'Nota', 42000))
  render(<AskModal onClose={() => {}} />)

  expect(await screen.findByText('Почему опрос?')).toBeInTheDocument()
  expect(await screen.findByText('Чудо-юдо читает базу Nota…')).toBeInTheDocument()
  expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('0:42')

  stream.send({ type: 'step', text: 'читает decisions/ui.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-юдо' })
  expect(within(steps).getByText('читает decisions/ui.md')).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Так решил оператор.', files: [], durationMs: 60000 })
  expect(await screen.findByText('Так решил оператор.')).toBeInTheDocument()
  expect(posts).toEqual([])
})

test('закрытое с готовым ответом окно убирает просьбу: отметка в шапке о ней больше не говорит', async () => {
  const stream = controlledStream<AskEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = render(<AskModal onClose={() => {}} />)

  await askQuestion('Почему опрос?')
  stream.send({ type: 'answer', text: 'Так решил оператор.', files: [], durationMs: 1000 })
  await screen.findByText('Так решил оператор.')
  unmount()

  await vi.waitFor(() => expect(deletes).toEqual(['/api/agent/ask']))
})

type NodeRejections = {
  on(event: 'unhandledRejection', handler: (reason: unknown) => void): void
  off(event: 'unhandledRejection', handler: (reason: unknown) => void): void
}

test('закрытое окно молчит, когда панель не ответила на уборку просьбы', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  // Отказ отдаёт голая функция, а не vi.fn: обёртка vitest сама подписывается на промис заглушки,
  // и необработанного отказа через неё не случается — регресс такой тест бы не заметил.
  const panelFetch = globalThis.fetch
  const cleanups: string[] = []
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    if ((init?.method ?? 'GET') !== 'DELETE') return panelFetch(url, init)
    cleanups.push(url)
    return Promise.reject(new TypeError('Failed to fetch'))
  })
  // О необработанном отказе node сообщает событием, а не исключением теста. Типы node коду фронта
  // не подключены, поэтому process берётся из globalThis со своим объявлением.
  const { process: node } = globalThis as unknown as { process: NodeRejections }
  const rejections: unknown[] = []
  const catchRejection = (reason: unknown) => rejections.push(reason)
  node.on('unhandledRejection', catchRejection)

  try {
    const { unmount } = render(<AskModal onClose={() => {}} />)
    await askQuestion('Почему опрос?')
    stream.send({ type: 'answer', text: 'Так решил оператор.', files: [], durationMs: 1000 })
    await screen.findByText('Так решил оператор.')
    unmount()

    await vi.waitFor(() => expect(cleanups).toEqual(['/api/agent/ask']))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(rejections).toEqual([])
  } finally {
    node.off('unhandledRejection', catchRejection)
  }
})

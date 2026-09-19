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

/** Панель разговора: базы, следующие реплики и остановка ответа — свои вызовы окна. */
function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  const replies: string[] = []
  const stops: string[] = []
  const panel = stubPanel('ask', stream, {
    running,
    project: 'Nota',
    others: (url, init) => {
      if (url === '/api/ask/bases') return Response.json(bases)
      if (url === '/api/ask/reply') {
        replies.push(String((JSON.parse(String(init?.body)) as { text: string }).text))
        return new Response(null, { status: 204 })
      }
      if (url === '/api/ask/stop') {
        stops.push(url)
        return new Response(null, { status: 204 })
      }
      return null
    },
  })
  return { ...panel, replies, stops }
}

async function ask(text: string) {
  fireEvent.change(await screen.findByLabelText('Вопрос'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText('Следующая реплика'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

test('вопрос уходит в выбранную базу, ход работы виден до ответа, ответ показан с прочитанными файлами', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))
  await ask('Почему опрос?')

  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\nota-knowledge', question: 'Почему опрос?' })
  stream.send({ type: 'reply', text: 'Почему опрос?' })
  expect(await screen.findByText('Почему опрос?')).toBeInTheDocument()
  expect(await screen.findByText('Чудо-Юдо читает базу Nota…')).toBeInTheDocument()

  stream.send({ type: 'step', text: 'читает decisions/ui.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-Юдо' })
  expect(within(steps).getByText('читает decisions/ui.md')).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Так решил **оператор**.\n\n- проще всего', files: ['decisions/ui.md'], durationMs: 31000 })
  expect(await screen.findByText('оператор')).toHaveProperty('tagName', 'STRONG')
  expect(screen.getByText('decisions/ui.md')).toBeInTheDocument()
  expect(screen.getByText('31 с')).toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('разговор продолжается: следующая реплика уходит в него же, и вся переписка остаётся на экране', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts, replies } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Первый вопрос')
  stream.send({ type: 'reply', text: 'Первый вопрос' })
  stream.send({ type: 'answer', text: 'Первый ответ', files: [], durationMs: 1000 })
  await screen.findByText('Первый ответ')

  await say('А почему так?')
  stream.send({ type: 'reply', text: 'А почему так?' })
  stream.send({ type: 'answer', text: 'Второй ответ', files: [], durationMs: 1000 })

  expect(await screen.findByText('Второй ответ')).toBeInTheDocument()
  expect(replies).toEqual(['А почему так?'])
  // Новую просьбу реплика не заводит: разговор один.
  expect(posts.map((post) => post.url)).toEqual(['/api/ask'])
  expect(screen.getByText('Первый вопрос')).toBeInTheDocument()
  expect(screen.getByText('Первый ответ')).toBeInTheDocument()
  expect(screen.getByLabelText('Следующая реплика')).toHaveValue('')
})

/** Кнопки подвала по порядку: по ним видно, стоит ли «Отправить» на своём месте. */
function footerButtons() {
  const send = screen.queryByRole('button', { name: 'Отправить' }) ?? screen.getByRole('button', { name: 'Отменить' })
  const footer = send.parentElement as HTMLElement
  return [...footer.querySelectorAll('button')].map((button) => button.textContent)
}

test('кнопки подвала не съезжают: «Отправить» стоит на месте и до разговора, и после', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  // До первого вопроса «Новая переписка» уже на своём месте, только приглушена.
  expect(await screen.findByRole('button', { name: 'Новая переписка' })).toBeDisabled()
  expect(footerButtons()).toEqual(['Новая переписка', 'Отправить'])

  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  await screen.findByText('Вопрос')
  // Пока идёт ответ, на месте «Отправить» стоит «Отменить», а «Новая переписка» никуда не делась.
  expect(footerButtons()).toEqual(['Новая переписка', 'Отменить'])

  stream.send({ type: 'answer', text: 'Ответ', files: [], durationMs: 1000 })
  await screen.findByText('Ответ')
  expect(footerButtons()).toEqual(['Новая переписка', 'Отправить'])
  expect(screen.getByRole('button', { name: 'Новая переписка' })).toBeEnabled()
})

test('база выбирается один раз: посреди разговора кнопки проектов не нажимаются', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  expect(await screen.findByRole('button', { name: 'Nota' })).toBeEnabled()
  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  await screen.findByText('Вопрос')

  expect(screen.getByRole('button', { name: 'Nota' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Agents Kit Web' })).toBeDisabled()
})

test('сбой посреди переписки её не рушит: прежние ответы на месте, реплика вернулась в поле', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Первый вопрос')
  stream.send({ type: 'reply', text: 'Первый вопрос' })
  stream.send({ type: 'answer', text: 'Первый ответ', files: [], durationMs: 1000 })
  await screen.findByText('Первый ответ')

  await say('Второй вопрос')
  stream.send({ type: 'reply', text: 'Второй вопрос' })
  stream.send({ type: 'error', text: 'Чудо-Юдо завершился с ошибкой', output: 'Invalid API key · Please run /login' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Invalid API key · Please run /login')).toBeInTheDocument()
  expect(screen.getByText('Первый ответ')).toBeInTheDocument()
  expect(await screen.findByLabelText('Следующая реплика')).toHaveValue('Второй вопрос')
})

test('«Отменить» обрывает ответ, а переписка остаётся', async () => {
  const stream = controlledStream<AskEvent>()
  const { stops, deletes } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Долгий вопрос')
  stream.send({ type: 'reply', text: 'Долгий вопрос' })
  await screen.findByRole('status')
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
  stream.send({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })

  expect(await screen.findByText('Чудо-Юдо остановлен: ответа на эту реплику не будет')).toBeInTheDocument()
  expect(screen.getByText('Долгий вопрос')).toBeInTheDocument()
  await vi.waitFor(() => expect(stops).toEqual(['/api/ask/stop']))
  expect(deletes).toEqual([])
})

test('«Новая переписка» убирает разговор из панели и возвращает окно к первому вопросу', async () => {
  const stream = controlledStream<AskEvent>()
  const { deletes } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  stream.send({ type: 'answer', text: 'Ответ', files: [], durationMs: 1000 })
  await screen.findByText('Ответ')

  fireEvent.click(screen.getByRole('button', { name: 'Новая переписка' }))

  expect(await screen.findByLabelText('Вопрос')).toHaveValue('')
  expect(screen.queryByText('Ответ')).not.toBeInTheDocument()
  expect(deletes).toEqual(['/api/agent/ask'])
})

test('закрытое окно разговор не теряет: просьба остаётся в панели', async () => {
  const stream = controlledStream<AskEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = render(<AskModal onClose={() => {}} />)

  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  stream.send({ type: 'answer', text: 'Ответ', files: [], durationMs: 1000 })
  await screen.findByText('Ответ')
  unmount()

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает переписку, которая шла без него', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream, runningRequest('ask', 'Почему опрос?', bases[1].base, 'Nota', 42000))
  render(<AskModal onClose={() => {}} />)

  stream.send({ type: 'reply', text: 'Почему опрос?' })
  expect(await screen.findByText('Почему опрос?')).toBeInTheDocument()
  expect(await screen.findByText('Чудо-Юдо читает базу Nota…')).toBeInTheDocument()
  expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('0:42')

  stream.send({ type: 'step', text: 'читает decisions/ui.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-Юдо' })
  expect(within(steps).getByText('читает decisions/ui.md')).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Так решил оператор.', files: [], durationMs: 60000 })
  expect(await screen.findByText('Так решил оператор.')).toBeInTheDocument()
  expect(posts).toEqual([])
})

test('поток оборвался, а разговора в панели не стало — это сбой, а не вечное ожидание', async () => {
  const stream = controlledStream<AskEvent>()
  let gone = false
  stubPanel('ask', stream, {
    project: 'Nota',
    others: (url) => {
      if (url === '/api/ask/bases') return Response.json(bases)
      if (url === '/api/agent/requests' && gone) return Response.json([])
      return null
    },
  })
  render(<AskModal onClose={() => {}} />)

  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  await screen.findByRole('status')
  gone = true
  stream.close()

  expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('Ответ оборвался')
})

test('оборванный поток окно дочитывает само: разговор в панели цел', async () => {
  const first = controlledStream<AskEvent>()
  const next = controlledStream<AskEvent>()
  let reconnected = false
  stubPanel('ask', first, {
    project: 'Nota',
    others: (url) => {
      if (url === '/api/ask/bases') return Response.json(bases)
      if (url.startsWith('/api/agent/ask/stream') && reconnected) {
        return new Response(next.body, { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      return null
    },
  })
  render(<AskModal onClose={() => {}} />)

  await ask('Вопрос')
  first.send({ type: 'reply', text: 'Вопрос' })
  await screen.findByRole('status')
  reconnected = true
  first.close()

  // Ответ пришёл в дочитанный поток: окно его показывает, а сбоя не случилось.
  await vi.waitFor(() => next.send({ type: 'answer', text: 'Ответ после обрыва', files: [], durationMs: 1000 }), {
    timeout: 3000,
  })
  expect(await screen.findByText('Ответ после обрыва')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

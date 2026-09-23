import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AskModal, { type AskBase, type AskCopy, type AskEvent } from './AskModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: AskBase[] = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

/** Копии баз: у первой — основная и копия задачи, у второй — одна основная. */
const copies: Record<string, AskCopy[]> = {
  [bases[0].base]: [
    { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
    { path: 'D:\\Projects\\bright-sunny-glacier', name: 'bright-sunny-glacier', branch: 'b-130-ask-reads-code', main: false },
  ],
  [bases[1].base]: [
    { path: 'D:\\Projects\\nota', name: 'nota', branch: 'dev', main: true },
    { path: 'D:\\Projects\\nota-task', name: 'nota-task', branch: 'b-7-export', main: false },
  ],
}

/** Панель разговора: базы, их копии, следующие реплики и остановка ответа — свои вызовы окна. */
function stubFetch(
  stream: { body: ReadableStream<Uint8Array> },
  running?: ReturnType<typeof runningRequest>,
  copiesOf: Record<string, AskCopy[]> = copies,
) {
  const replies: string[] = []
  const stops: string[] = []
  const panel = stubPanel('ask', stream, {
    running,
    project: 'Nota',
    others: (url, init) => {
      if (url === '/api/ask/bases') return Response.json(bases)
      if (url.startsWith('/api/ask/copies?base=')) {
        return Response.json(copiesOf[decodeURIComponent(url.slice('/api/ask/copies?base='.length))] ?? [])
      }
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

/** Первый вопрос уходит, когда копии проекта прочитаны: до того «Отправить» приглушена. */
async function ask(text: string) {
  fireEvent.change(await screen.findByLabelText('Вопрос'), { target: { value: text } })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

/** Выбор из выпадающего списка окна: «Проект» или «Копия». */
async function pick(list: 'Проект' | 'Копия', option: string) {
  const button = await screen.findByRole('button', { name: new RegExp(`^${list}: `) })
  // Список копий открывается, когда копии проекта прочитаны.
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
  fireEvent.click(within(screen.getByRole('listbox', { name: list })).getByRole('option', { name: new RegExp(option) }))
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText('Следующая реплика'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

test('вопрос уходит в выбранную базу, ход работы виден до ответа, ответ показан с прочитанными файлами', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await pick('Проект', 'Nota')
  await ask('Почему опрос?')

  expect(posts[0].body).toEqual({
    base: 'D:\\Projects\\nota-knowledge',
    copy: 'D:\\Projects\\nota',
    question: 'Почему опрос?',
  })
  stream.send({ type: 'reply', text: 'Почему опрос?' })
  expect(await screen.findByText('Почему опрос?')).toBeInTheDocument()
  expect(await screen.findByText('Чудо-Юдо читает базу и код Nota…')).toBeInTheDocument()

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

test('база и копия выбираются один раз: посреди разговора оба списка неактивны, и надписи об этом нет', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  expect(await screen.findByRole('button', { name: 'Проект: Agents Kit Web' })).toBeEnabled()
  expect(await screen.findByRole('button', { name: 'Копия: agents-kit-web' })).toBeEnabled()
  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  await screen.findByText('Вопрос')

  expect(screen.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Копия: agents-kit-web' })).toBeDisabled()
  expect(screen.queryByText(/не меняю?тся/)).not.toBeInTheDocument()
})

test('копия: первой выбрана основная, в списке у копий ветки, выбранная уходит в разговор', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  // На свёрнутом списке — имя и плашка основной, без ветки.
  const button = await screen.findByRole('button', { name: 'Копия: agents-kit-web' })
  expect(within(button).getByText('Основная')).toBeInTheDocument()
  expect(within(button).queryByText('master')).not.toBeInTheDocument()

  fireEvent.click(button)
  const options = within(screen.getByRole('listbox', { name: 'Копия' })).getAllByRole('option')
  expect(options.map((o) => o.textContent)).toEqual([
    'agents-kit-webОсновнаяmaster',
    'bright-sunny-glacierb-130-ask-reads-code',
  ])
  expect(options[0]).toHaveAttribute('aria-selected', 'true')
  fireEvent.click(options[1])

  await ask('Что делает Program?')
  expect(posts[0].body).toEqual({
    base: bases[0].base,
    copy: 'D:\\Projects\\bright-sunny-glacier',
    question: 'Что делает Program?',
  })
})

test('сменили проект — в списке его копии, и снова выбрана основная', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await pick('Копия', 'bright-sunny-glacier')
  expect(await screen.findByRole('button', { name: 'Копия: bright-sunny-glacier' })).toBeInTheDocument()
  await pick('Проект', 'Nota')
  expect(await screen.findByRole('button', { name: 'Копия: nota' })).toBeInTheDocument()
  await pick('Проект', 'Agents Kit Web')
  expect(await screen.findByRole('button', { name: 'Копия: agents-kit-web' })).toBeInTheDocument()
})

test('копий проекта на диске нет — список пуст и неактивен, а разговор идёт по одной базе', async () => {
  const stream = controlledStream<AskEvent>()
  const { posts } = stubFetch(stream, undefined, {})
  render(<AskModal onClose={() => {}} />)

  expect(await screen.findByRole('button', { name: 'Копия: нет на диске' })).toBeDisabled()
  await ask('Вопрос')
  expect(posts[0].body).toEqual({ base: bases[0].base, question: 'Вопрос' })
})

test('ответ без открытых файлов так и говорит: «Файлы не открывались»', async () => {
  const stream = controlledStream<AskEvent>()
  stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Вопрос')
  stream.send({ type: 'reply', text: 'Вопрос' })
  stream.send({ type: 'answer', text: 'Ответ', files: [], durationMs: 1000 })

  expect(await screen.findByText('Файлы не открывались')).toBeInTheDocument()
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

  // Отменённый ответ окно ждать перестаёт: оно снова готово говорить — B-109.
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(await screen.findByLabelText('Следующая реплика')).toBeEnabled()
  expect(footerButtons()).toEqual(['Новая переписка', 'Отправить'])
  expect(screen.getByRole('button', { name: 'Новая переписка' })).toBeEnabled()
})

test('после отмены разговор продолжается: следующая реплика уходит в него же', async () => {
  const stream = controlledStream<AskEvent>()
  const { replies, posts } = stubFetch(stream)
  render(<AskModal onClose={() => {}} />)

  await ask('Долгий вопрос')
  stream.send({ type: 'reply', text: 'Долгий вопрос' })
  await screen.findByRole('status')
  fireEvent.click(screen.getByRole('button', { name: 'Отменить' }))
  stream.send({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })
  await screen.findByText('Чудо-Юдо остановлен: ответа на эту реплику не будет')

  await say('Тогда короче')
  stream.send({ type: 'note', text: 'Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит' })
  stream.send({ type: 'reply', text: 'Тогда короче' })
  stream.send({ type: 'answer', text: 'Короткий ответ', files: [], durationMs: 1000 })

  expect(await screen.findByText('Короткий ответ')).toBeInTheDocument()
  expect(screen.getByText('Чудо-Юдо отвечает заново: сказанного раньше он уже не помнит')).toBeInTheDocument()
  expect(replies).toEqual(['Тогда короче'])
  // Разговор тот же: новой просьбы реплика не заводит, вся переписка осталась на экране.
  expect(posts.map((post) => post.url)).toEqual(['/api/ask'])
  expect(screen.getByText('Долгий вопрос')).toBeInTheDocument()
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
  const { posts } = stubFetch(
    stream,
    // Копия задачи, а не основная: окно само выбрало бы основную, а показать надо ту, что у разговора.
    runningRequest('ask', 'Почему опрос?', bases[1].base, 'Nota', 42000, copies[bases[1].base][1].path),
  )
  render(<AskModal onClose={() => {}} />)

  stream.send({ type: 'reply', text: 'Почему опрос?' })
  expect(await screen.findByText('Почему опрос?')).toBeInTheDocument()
  // Проект и копия — того разговора, что шёл без окна, и выбрать другие нельзя.
  expect(screen.getByRole('button', { name: 'Проект: Nota' })).toBeDisabled()
  expect(await screen.findByRole('button', { name: 'Копия: nota-task' })).toBeDisabled()
  expect(await screen.findByText('Чудо-Юдо читает базу и код Nota…')).toBeInTheDocument()
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

  expect(await screen.findByRole('alert')).toHaveTextContent('Ответ оборвался')
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
  await vi.waitFor(() => next.send({ type: 'answer', text: 'Ответ после обрыва', files: [], durationMs: 1000 }))
  expect(await screen.findByText('Ответ после обрыва')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

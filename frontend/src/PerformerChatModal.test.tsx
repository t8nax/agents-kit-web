import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PerformerChatModal from './PerformerChatModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'
import type { DraftEvent, DraftFields } from './performerTalk'

afterEach(() => {
  vi.unstubAllGlobals()
})

const base = String.raw`D:\Projects\orders-knowledge`

const reviewer: DraftFields = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи.',
  model: 'sonnet',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф.',
}

const proposal: DraftFields = {
  ...reviewer,
  description: 'Читает дифф и сверяет его с решениями.',
  model: 'opus',
  prompt: 'Ты читаешь дифф и сверяешь его с решениями из карты мест.',
}

const empty: DraftFields = { name: '', description: '', model: '', tools: '', prompt: '' }

function stub(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  const replies: Record<string, unknown>[] = []
  const panel = stubPanel('performer', stream, {
    project: 'Orders',
    running,
    others: (url, init) => {
      if (url === '/api/performers/draft/reply') {
        replies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(null, { status: 204 })
      }
      return null
    },
  })
  return { ...panel, replies }
}

function renderChat(
  props: Partial<{ subject: string | null; current: DraftFields; kept: { model: boolean; tools: boolean } }> = {},
) {
  const onAccept = vi.fn()
  const onClose = vi.fn()
  render(
    <PerformerChatModal
      base={base}
      project="Orders"
      subject={props.subject === undefined ? 'reviewer' : props.subject}
      current={props.current ?? reviewer}
      kept={props.kept ?? { model: false, tools: false }}
      onAccept={onAccept}
      onClose={onClose}
    />,
  )
  return { onAccept, onClose }
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText(/^(Просьба|Следующая реплика)$/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

function changes() {
  fireEvent.click(screen.getByRole('tab', { name: /Изменения/ }))
  return within(screen.getByLabelText('Изменения исполнителя'))
}

function row(label: string) {
  return within(screen.getByText(label, { selector: 'dt' }).closest('.pc-row') as HTMLElement)
}

test('просьба уходит с полями окна и именем переписываемого, шапка называет исполнителя и проект', async () => {
  const stream = controlledStream<DraftEvent>()
  const { posts } = stub(stream)
  renderChat()

  expect(screen.getByRole('dialog', { name: 'Исполнитель с Чудо-Юдо' })).toBeInTheDocument()
  expect(screen.getByText('reviewer')).toHaveClass('pc-name')
  expect(screen.getByText('Orders')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Изменения' })).toBeDisabled()
  await say('  Пусть ещё сверяет с решениями  ')
  stream.send({ type: 'reply', text: 'Пусть ещё сверяет с решениями' })

  expect(await screen.findByText('Чудо-Юдо переписывает исполнителя reviewer…')).toBeInTheDocument()
  expect(posts[0]).toEqual({
    url: '/api/performers/draft',
    body: { base, wish: 'Пусть ещё сверяет с решениями', current: reviewer, subject: 'reviewer' },
  })
})

test('Чудо-Юдо переспрашивает, следующая реплика уходит в тот же разговор с нынешними полями', async () => {
  const stream = controlledStream<DraftEvent>()
  const { replies } = stub(stream)
  const current = { ...empty, prompt: 'Руками: читай дифф.' }
  renderChat({ subject: null, current })

  await say('Ревьюер ветки')
  stream.send({ type: 'reply', text: 'Ревьюер ветки' })
  stream.send({ type: 'answer', text: 'С какими решениями сверять?', durationMs: 24000 })
  expect(await screen.findByText('С какими решениями сверять?')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Изменения' })).toBeDisabled()

  await say('Только с названными в карте мест')
  expect(replies).toEqual([{ current, text: 'Только с названными в карте мест' }])
})

test('ответ с исполнителем — «В изменениях» без выбранной вручную модели, точка, поля сверены с окном', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream)
  const { onAccept } = renderChat({ kept: { model: true, tools: false } })
  await say('Сверяй с решениями')
  stream.send({ type: 'reply', text: 'Сверяй с решениями' })
  stream.send({ type: 'answer', text: 'Дописал сверку.', durationMs: 72000, proposal, changed: ['description', 'model', 'prompt'] })

  const link = await screen.findByRole('button', { name: 'описание, задание' })
  expect(screen.getByLabelText('Список изменён последним ответом')).toBeInTheDocument()
  fireEvent.click(link)

  expect(screen.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
  expect(row('Описание').getByText('изменено')).toBeInTheDocument()
  expect(row('Описание').getByText('Читает дифф ветки задачи.')).toHaveClass('rewrite-was')
  expect(row('Задание').getByText('изменено')).toHaveClass('rewrite-description-mark')
  expect(row('Модель').getByText('выбрана вручную')).toBeInTheDocument()
  expect(row('Модель').getByText('sonnet')).toBeInTheDocument()
  expect(row('Модель').getByText('Чудо-Юдо предложил opus')).toBeInTheDocument()
  expect(row('Инструменты').queryByText('изменено')).not.toBeInTheDocument()
  // Имя заведённого не меняется, и строки о нём нет.
  expect(screen.queryByText('Имя', { selector: 'dt' })).not.toBeInTheDocument()

  // Поля окна исполнителя до «Принять правки» не трогаются.
  expect(onAccept).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))
  expect(onAccept).toHaveBeenCalledWith(proposal)
})

test('«Открыть задание» показывает предложенное задание окном только для чтения', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream)
  renderChat()
  await say('Сверяй с решениями')
  stream.send({ type: 'reply', text: 'Сверяй с решениями' })
  stream.send({ type: 'answer', text: 'Дописал.', proposal, changed: ['prompt'] })
  await screen.findByRole('button', { name: 'задание' })

  changes().getByRole('button', { name: 'Открыть задание' }).click()

  const task = within(await screen.findByRole('dialog', { name: 'Задание reviewer' }))
  expect(task.getByText('Ты читаешь дифф и сверяешь его с решениями из карты мест.')).toBeInTheDocument()
  expect(task.queryByRole('button', { name: 'Редактировать' })).not.toBeInTheDocument()
  fireEvent.click(task.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name: 'Задание reviewer' })).not.toBeInTheDocument()
})

test('предложение, которое ничего не меняет в окне, принимать нечего', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream)
  renderChat({ kept: { model: true, tools: false } })
  await say('Модель opus')
  stream.send({ type: 'reply', text: 'Модель opus' })
  stream.send({ type: 'answer', text: 'Поставил opus.', proposal: { ...reviewer, model: 'opus' }, changed: ['model'] })
  await screen.findByText('Поставил opus.')

  changes()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
})

test('открытое заново окно продолжает свою переписку с того же места', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream, runningRequest('performer', 'Сверяй', base, 'Orders', 0, 'reviewer'))
  renderChat()

  stream.send({ type: 'reply', text: 'Сверяй' })
  stream.send({ type: 'answer', text: 'С какими решениями?' })

  expect(await screen.findByText('С какими решениями?')).toBeInTheDocument()
  expect(screen.getByLabelText('Следующая реплика')).toBeInTheDocument()
})

test('«Новая переписка» убирает разговор из панели', async () => {
  const stream = controlledStream<DraftEvent>()
  const { deletes } = stub(stream, runningRequest('performer', 'Сверяй', base, 'Orders', 0, 'reviewer'))
  renderChat()
  stream.send({ type: 'reply', text: 'Сверяй' })
  stream.send({ type: 'answer', text: 'С какими решениями?' })
  await screen.findByText('С какими решениями?')

  fireEvent.click(screen.getByRole('button', { name: 'Новая переписка' }))

  expect(deletes).toEqual(['/api/agent/performer'])
})

// B-193: переписка о новом исполнителе одного проекта не подхватывается окном нового исполнителя другого.
test('переписка о новом исполнителе другого проекта не подхватывается — окно предупреждает', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream, runningRequest('performer', 'Ревьюер', String.raw`D:\Projects\billing-knowledge`, 'Billing'))
  renderChat({ subject: null, current: empty })

  expect(
    await screen.findByText('Идёт переписка о новом исполнителе проекта Billing: первая реплика отсюда начнёт новую, а ту уберёт.'),
  ).toBeInTheDocument()
  stream.send({ type: 'reply', text: 'Ревьюер' })
  stream.send({ type: 'answer', text: 'Чужой ответ', proposal, changed: ['name'] })
  expect(screen.queryByText('Чужой ответ')).not.toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Изменения' })).toBeDisabled()
})

test('переписка о другом исполнителе того же проекта названа в предупреждении', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream, runningRequest('performer', 'x', base, 'Orders', 0, 'tester'))
  renderChat()

  expect(await screen.findByText(/Идёт переписка об исполнителе tester проекта Orders/)).toBeInTheDocument()
})

test('пока окно не узнало о своей переписке, реплика не уходит и не начинает новую', async () => {
  const stream = controlledStream<DraftEvent>()
  let answer: (response: Response) => void = () => {}
  const posts: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') posts.push(url)
      if (url === '/api/agent/requests') return new Promise<Response>((resolve) => (answer = resolve))
      return Promise.resolve(new Response(stream.body))
    }),
  )
  renderChat()

  fireEvent.change(screen.getByLabelText('Просьба'), { target: { value: 'Короче' } })
  expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled()
  fireEvent.keyDown(screen.getByLabelText('Просьба'), { key: 'Enter', ctrlKey: true })
  expect(posts).toEqual([])

  answer(Response.json([]))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
})

test('сбой чтения чужой переписки в этом окне не показан', async () => {
  const stream = controlledStream<DraftEvent>()
  stub(stream, runningRequest('performer', 'x', base, 'Orders', 0, 'tester'))
  renderChat()

  expect(await screen.findByText(/Идёт переписка об исполнителе tester/)).toBeInTheDocument()
  stream.close()

  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/agent/requests'))
  await new Promise((wake) => setTimeout(wake, 700))
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

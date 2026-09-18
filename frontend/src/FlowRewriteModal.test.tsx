import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FlowStep } from './Flow'
import FlowRewriteModal, { type RewriteEvent } from './FlowRewriteModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const step = (title: string, patch: Partial<FlowStep> = {}): FlowStep => ({
  title,
  executor: 'оркестратор',
  output: `выход ${title}`,
  skip: null,
  description: null,
  ...patch,
})

const current = [step('Критерий'), step('Мерж', { output: 'sha в dev' })]

const base = String.raw`D:\Projects\app-knowledge`

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
    send: (event: RewriteEvent) => controller.enqueue(encoder.encode(JSON.stringify(event) + '\n')),
    close: () => controller.close(),
  }
}

function stubFetch(stream: ReturnType<typeof controlledStream>) {
  const posts: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      posts.push({ url, body: JSON.parse(String(init?.body)) })
      return Promise.resolve(new Response(stream.body, { headers: { 'Content-Type': 'application/x-ndjson' } }))
    }),
  )
  return posts
}

function renderModal(version: string | null = 'abc123') {
  const onApply = vi.fn()
  const onClose = vi.fn()
  render(
    <FlowRewriteModal
      base={base}
      project="Agents Kit Web"
      steps={current}
      version={version}
      onApply={onApply}
      onClose={onClose}
    />,
  )
  return { onApply, onClose }
}

function ask(text: string) {
  fireEvent.change(screen.getByLabelText('Что поменять во флоу'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
}

test('просьба уходит в базу раздела, ход агента виден, разбор называет добавленный и изменённый шаги', async () => {
  const stream = controlledStream()
  const posts = stubFetch(stream)
  const { onApply } = renderModal()

  ask('  Добавь ревью перед мержем  ')

  expect(posts[0].url).toBe('/api/flow/rewrite')
  expect(posts[0].body).toEqual({ base, wish: 'Добавь ревью перед мержем' })
  expect(await screen.findByText('Чудо-юдо переписывает флоу Agents Kit Web…')).toBeInTheDocument()

  stream.send({ type: 'step', text: 'читает flow.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы агента' })
  expect(within(steps).getByText('читает flow.md')).toBeInTheDocument()

  const rewritten = [
    step('Критерий'),
    step('Ревью', { executor: 'reviewer', skip: 'правка только в текстах', description: '3.1. Собрать дифф.' }),
    step('Мерж', { output: 'sha в dev после вердикта ревью' }),
  ]
  stream.send({ type: 'rewritten', text: '', steps: rewritten, version: 'abc123', durationMs: 18000 })

  const changes = await screen.findByLabelText('Что изменилось во флоу')
  expect(within(changes).getByText('добавлен')).toBeInTheDocument()
  expect(within(changes).getByText('Ревью')).toBeInTheDocument()
  expect(within(changes).getByText('reviewer')).toBeInTheDocument()
  expect(within(changes).getByText('изменён')).toBeInTheDocument()
  expect(within(changes).getByText('sha в dev')).toBeInTheDocument()
  expect(within(changes).getByText('sha в dev после вердикта ревью')).toBeInTheDocument()
  // Шаг без правок стоит одной строкой, а не карточкой.
  expect(within(changes).getByText('Критерий')).toBeInTheDocument()
  expect(within(changes).getByText('18 с')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Взять правки в схему' }))
  expect(onApply).toHaveBeenCalledWith(rewritten)
})

test('описание шага не пересказывается: его открывает своё окно', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  ask('Добавь ревью')
  stream.send({
    type: 'rewritten',
    text: '',
    steps: [...current, step('Ревью', { description: '3.1. Собрать дифф всей ветки.' })],
    version: 'abc123',
  })

  const open = await screen.findByRole('button', { name: 'Открыть описание' })
  expect(screen.queryByText('3.1. Собрать дифф всей ветки.')).not.toBeInTheDocument()

  fireEvent.click(open)

  const window_ = await screen.findByRole('dialog', { name: 'Описание шага «Ревью»' })
  expect(within(window_).getByText('3.1. Собрать дифф всей ветки.')).toBeInTheDocument()

  fireEvent.click(within(window_).getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name: 'Описание шага «Ревью»' })).not.toBeInTheDocument()
})

test('флоу, разошедшийся с разделом, в схему не подставляется', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const { onApply } = renderModal('abc123')

  ask('Добавь ревью')
  stream.send({ type: 'rewritten', text: '', steps: [step('Ревью')], version: 'другой-отпечаток' })

  expect(await screen.findByText(/Флоу базы изменился, пока Чудо-юдо его переписывал/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Взять правки в схему' })).not.toBeInTheDocument()
  expect(onApply).not.toHaveBeenCalled()
})

test('неудача агента названа словами, а просьба возвращается в поле', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  ask('Добавь ревью')
  stream.send({ type: 'error', text: 'Агент вернул не флоу: шагов в его ответе нет', output: 'Готово!' })

  expect(await screen.findByText(/Агент вернул не флоу/)).toBeInTheDocument()
  expect(screen.getByText('Готово!')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить просьбу' }))
  expect(screen.getByLabelText('Что поменять во флоу')).toHaveValue('Добавь ревью')
})

test('оборванный без итога поток не оставляет окно в ожидании', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  ask('Добавь ревью')
  stream.close()

  expect(await screen.findByText(/API закрыл соединение без итога/)).toBeInTheDocument()
})

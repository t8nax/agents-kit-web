import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FlowStep } from './Flow'
import FlowRewriteModal, { type RewriteEvent } from './FlowRewriteModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

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

function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  return stubPanel('flow', stream, { running, project: 'Agents Kit Web' })
}

function renderModal(version: string | null = 'abc123') {
  const onApply = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <FlowRewriteModal
      base={base}
      project="Agents Kit Web"
      steps={current}
      version={version}
      onApply={onApply}
      onClose={onClose}
    />,
  )
  return { onApply, onClose, unmount: view.unmount }
}

async function ask(text: string) {
  fireEvent.change(await screen.findByLabelText('Что поменять во флоу'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
}

test('просьба уходит в базу раздела, ход агента виден, разбор называет добавленный и изменённый шаги', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  const { onApply } = renderModal()

  await ask('  Добавь ревью перед мержем  ')

  expect(await screen.findByText('Чудо-юдо переписывает флоу Agents Kit Web…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/flow/rewrite')
  expect(posts[0].body).toEqual({ base, wish: 'Добавь ревью перед мержем' })

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
  // Итог просьбы забирается вместе с правками: панель его больше не держит.
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(rewritten))
})

test('описание шага не пересказывается: его открывает своё окно', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await ask('Добавь ревью')
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

  await ask('Добавь ревью')
  stream.send({ type: 'rewritten', text: '', steps: [step('Ревью')], version: 'другой-отпечаток' })

  expect(await screen.findByText(/Флоу базы изменился, пока Чудо-юдо его переписывал/)).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Взять правки в схему' })).not.toBeInTheDocument()
  expect(onApply).not.toHaveBeenCalled()
})

test('неудача агента названа словами, а просьба возвращается в поле', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await ask('Добавь ревью')
  stream.send({ type: 'error', text: 'Агент вернул не флоу: шагов в его ответе нет', output: 'Готово!' })

  expect(await screen.findByText(/Агент вернул не флоу/)).toBeInTheDocument()
  expect(screen.getByText('Готово!')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить просьбу' }))
  expect(await screen.findByLabelText('Что поменять во флоу')).toHaveValue('Добавь ревью')
})

test('оборванный без итога поток не оставляет окно в ожидании', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await ask('Добавь ревью')
  stream.close()

  expect(await screen.findByText(/API закрыл поток без ответа агента/)).toBeInTheDocument()
})

test('закрытое окно не останавливает агента: просьба остаётся в панели', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = renderModal()

  await ask('Добавь ревью')
  await screen.findByRole('status')
  unmount()

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает переписывание, которое шло без него', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { posts } = stubFetch(stream, runningRequest('flow', 'Добавь ревью', base, 'Agents Kit Web', 65000))
  const { onApply } = renderModal()

  expect(await screen.findByText('Добавь ревью')).toBeInTheDocument()
  expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('1:05')

  const rewritten = [step('Критерий'), step('Ревью'), step('Мерж', { output: 'sha в dev' })]
  stream.send({ type: 'rewritten', text: '', steps: rewritten, version: 'abc123' })

  const changes = await screen.findByLabelText('Что изменилось во флоу')
  expect(within(changes).getByText('добавлен')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Взять правки в схему' }))
  await waitFor(() => expect(onApply).toHaveBeenCalledWith(rewritten))
  expect(posts).toEqual([])
})

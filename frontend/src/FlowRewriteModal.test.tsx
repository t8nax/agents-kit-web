import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FlowStage } from './Flow'
import FlowRewriteModal, { type RewriteEvent } from './FlowRewriteModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

afterEach(() => {
  vi.unstubAllGlobals()
})

const stage = (title: string, patch: Partial<FlowStage> = {}): FlowStage => ({
  title,
  executor: 'оркестратор',
  output: `выход ${title}`,
  skip: null,
  description: null,
  helpers: [],
  ...patch,
})

const review = stage('Ревью', { executor: 'reviewer', slug: 'review' })
const merge = stage('Мерж', { output: 'sha в dev', slug: 'merge' })
const acceptance = stage('Приёмка', { executor: 'оператор', slug: 'acceptance' })
const stages = [review, merge, acceptance]

const base = String.raw`D:\Projects\app-knowledge`

function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  return stubPanel('flow', stream, { running, project: 'Agents Kit Web' })
}

function renderModal() {
  const onApply = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <FlowRewriteModal
      base={base}
      project="Agents Kit Web"
      stages={stages}
      mark={(title) => <span data-testid={`mark-${title}`} />}
      scope={(title) =>
        title === 'Ревью' ? 'Стадия стоит в сценариях «полный» и «быстрый» — правка изменит её в обоих.' : null
      }
      onApply={onApply}
      onClose={onClose}
    />,
  )
  return { onApply, onClose, unmount: view.unmount }
}

async function write(text: string) {
  fireEvent.change(await screen.findByLabelText('Что поменять в стадиях'), { target: { value: text } })
}

function pick(...titles: string[]) {
  fireEvent.click(screen.getByRole('button', { name: 'Стадии' }))
  const list = screen.getByRole('listbox', { name: 'Стадии проекта' })
  for (const title of titles) fireEvent.click(within(list).getByRole('option', { name: new RegExp(title) }))
}

test('без стадий в контексте окно пишет новую стадию, и просьба уходит со стадиями раздела', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  renderModal()

  await write('  Заведи стадию документации  ')
  fireEvent.click(screen.getByRole('button', { name: 'Написать стадию' }))

  expect(await screen.findByText('Чудо-Юдо пишет стадию…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/flow/rewrite')
  expect(posts[0].body).toEqual({
    base,
    wish: 'Заведи стадию документации',
    stages: [],
    titles: ['Ревью', 'Мерж', 'Приёмка'],
  })

  stream.send({ type: 'step', text: 'читает flow/stages/review.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-Юдо' })
  expect(within(steps).getByText('читает flow/stages/review.md')).toBeInTheDocument()
})

test('стадии добавляются в контекст списком с поиском и снимаются крестиком', async () => {
  stubFetch(controlledStream())
  renderModal()
  await write('Поправь выходы')

  fireEvent.click(screen.getByRole('button', { name: 'Стадии' }))
  fireEvent.change(screen.getByPlaceholderText('Найти стадию'), { target: { value: 'мер' } })
  const list = screen.getByRole('listbox', { name: 'Стадии проекта' })
  expect(within(list).getAllByRole('option')).toHaveLength(1)
  fireEvent.click(within(list).getByRole('option', { name: /Мерж/ }))
  expect(within(list).getByRole('option', { name: /Мерж/ })).toHaveAttribute('aria-selected', 'true')
  fireEvent.change(screen.getByPlaceholderText('Найти стадию'), { target: { value: '' } })
  fireEvent.click(within(list).getByRole('option', { name: /Ревью/ }))

  const bar = screen.getByLabelText('Стадии к просьбе')
  expect(within(bar).getByText('Мерж')).toBeInTheDocument()
  expect(within(bar).getByText('Ревью')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Переписать' })).toBeEnabled()

  // Escape закрывает список, а не окно.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Убрать «Мерж»' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать «Ревью»' }))
  expect(screen.getByRole('button', { name: 'Написать стадию' })).toBeInTheDocument()
})

test('итог — карточка на стадию: «было → стало», задетые сценарии, новая стадия и без правок', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  const { onApply } = renderModal()

  await write('Уточни выход ревью и заведи документацию')
  pick('Ревью', 'Мерж')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))

  expect(await screen.findByText('Чудо-Юдо переписывает стадии…')).toBeInTheDocument()
  expect(posts[0].body.stages).toEqual([review, merge])

  const rewritten = { of: 'Ревью', stage: { ...review, output: 'вердикт по sha', description: '1. Собрать дифф.' } }
  const docs = { of: null, stage: stage('Документация', { executor: 'writer' }) }
  stream.send({ type: 'rewritten', text: '', stages: [rewritten, docs], durationMs: 18000 })

  const changes = await screen.findByLabelText('Что изменилось в стадиях')
  expect(within(changes).getByText('изменена')).toBeInTheDocument()
  expect(within(changes).getByText('выход Ревью')).toBeInTheDocument()
  expect(within(changes).getByText('вердикт по sha')).toBeInTheDocument()
  expect(within(changes).getByText(/правка изменит её в обоих/)).toBeInTheDocument()
  expect(within(changes).getByText('добавлена')).toBeInTheDocument()
  expect(within(changes).getByText('writer')).toBeInTheDocument()
  // Стадия контекста, которую агент не тронул, стоит строкой, а не карточкой.
  expect(within(changes).getByText('без правок')).toBeInTheDocument()
  expect(within(changes).getByText('Мерж')).toBeInTheDocument()
  expect(within(changes).getByText('18 с')).toBeInTheDocument()
  // Описание не пересказывается: его открывает своё окно.
  expect(within(changes).queryByText('1. Собрать дифф.')).not.toBeInTheDocument()
  fireEvent.click(within(changes).getByRole('button', { name: 'Открыть описание' }))
  const window_ = await screen.findByRole('dialog', { name: 'Описание стадии «Ревью»' })
  expect(within(window_).getByText('1. Собрать дифф.')).toBeInTheDocument()
  fireEvent.click(within(window_).getByRole('button', { name: 'Закрыть' }))

  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))
  // Итог просьбы забирается вместе с правками: панель его больше не держит.
  await waitFor(() => expect(onApply).toHaveBeenCalledWith([rewritten, docs]))
})

test('ответ без правок принять нечего', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const { onApply } = renderModal()

  await write('Ничего не меняй')
  pick('Мерж')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Мерж', stage: merge }] })

  expect(await screen.findByText('Стадии не изменились: ответ совпал с прежними.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
  expect(onApply).not.toHaveBeenCalled()
})

test('неудача агента названа словами, а просьба возвращается в поле', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await write('Напиши стадию')
  fireEvent.click(screen.getByRole('button', { name: 'Написать стадию' }))
  stream.send({ type: 'error', text: 'Чудо-Юдо вернул не стадию: стадий в его ответе нет', output: 'Готово!' })

  expect(await screen.findByText(/Чудо-Юдо вернул не стадию/)).toBeInTheDocument()
  expect(screen.getByText(/Стадии в базе не менялись/)).toBeInTheDocument()
  expect(screen.getByText('Готово!')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить просьбу' }))
  expect(await screen.findByLabelText('Что поменять в стадиях')).toHaveValue('Напиши стадию')
})

test('закрытое окно не останавливает агента: просьба остаётся в панели', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = renderModal()

  await write('Напиши стадию')
  fireEvent.click(screen.getByRole('button', { name: 'Написать стадию' }))
  await screen.findByRole('status')
  unmount()

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает переписывание, которое шло без него', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { posts } = stubFetch(stream, runningRequest('flow', 'Уточни выход ревью', base, 'Agents Kit Web', 65000))
  const { onApply } = renderModal()

  expect(await screen.findByText('Уточни выход ревью')).toBeInTheDocument()
  expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('1:05')

  const rewritten = { of: 'Ревью', stage: { ...review, output: 'вердикт' } }
  stream.send({ type: 'rewritten', text: '', stages: [rewritten] })

  const changes = await screen.findByLabelText('Что изменилось в стадиях')
  expect(within(changes).getByText('изменена')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))
  await waitFor(() => expect(onApply).toHaveBeenCalledWith([rewritten]))
  expect(posts).toEqual([])
})

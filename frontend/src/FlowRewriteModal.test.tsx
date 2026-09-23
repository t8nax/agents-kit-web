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
      // Приёмку держат задачи в работе: к просьбе её не добавить
      locked={(title) => (title === 'Приёмка' ? ['B-7', 'B-9'] : null)}
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

test('стадия, которую держат задачи в работе, в списке погашена, названы задачи, и к просьбе она не добавляется', async () => {
  stubFetch(controlledStream())
  renderModal()
  await write('Поправь приёмку')

  fireEvent.click(screen.getByRole('button', { name: 'Стадии' }))
  const held = within(screen.getByRole('listbox', { name: 'Стадии проекта' })).getByRole('option', { name: /Приёмка/ })
  expect(held).toHaveAttribute('aria-disabled', 'true')
  expect(held).toHaveTextContent('занята: B-7, B-9')
  fireEvent.click(held)
  fireEvent.keyDown(held, { key: 'Enter' })

  expect(held).toHaveAttribute('aria-selected', 'false')
  expect(screen.queryByRole('button', { name: 'Убрать «Приёмка»' })).not.toBeInTheDocument()
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

test('итог просьбы про другой проект окно своим не считает и предупреждает, что новая просьба его уберёт', async () => {
  const stream = controlledStream<RewriteEvent>()
  const other = String.raw`D:\Projects\other-knowledge`
  stubFetch(stream, { ...runningRequest('flow', 'Уточни выход ревью', other, 'Other', 1000), state: 'done' })
  renderModal()

  expect(
    await screen.findByText('Чудо-Юдо уже переписал стадии Other: новая просьба отсюда уберёт этот ответ.'),
  ).toBeInTheDocument()
  expect(screen.queryByText('Уточни выход ревью')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Что изменилось в стадиях')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Что поменять в стадиях')).toBeInTheDocument()
})

test('открытое заново окно помнит стадии просьбы: строка стадий, «без правок» и «Попросить снова» с ними', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream, {
    ...runningRequest('flow', 'Уточни выход ревью', base, 'Agents Kit Web', 1000),
    stages: [review, merge],
  })
  renderModal()

  expect(await screen.findByText('Чудо-Юдо переписывает стадии…')).toBeInTheDocument()
  const line = screen.getByLabelText('Стадии к просьбе')
  expect(within(line).getByText('Ревью')).toBeInTheDocument()
  expect(within(line).getByText('Мерж')).toBeInTheDocument()

  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })
  const changes = await screen.findByLabelText('Что изменилось в стадиях')
  expect(within(changes).getByText('без правок')).toBeInTheDocument()
  expect(within(changes).getByText('Мерж')).toBeInTheDocument()
})

test('после сбоя «Попросить снова» уходит с теми же стадиями, даже если окно открыто заново', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { posts } = stubFetch(stream, {
    ...runningRequest('flow', 'Уточни выход ревью', base, 'Agents Kit Web', 1000),
    stages: [review],
  })
  renderModal()

  await screen.findByText('Чудо-Юдо переписывает стадии…')
  stream.send({ type: 'error', text: 'Агент упал' })
  fireEvent.click(await screen.findByRole('button', { name: 'Попросить снова' }))

  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0].body).toMatchObject({ wish: 'Уточни выход ревью', stages: [review] })
})

test('карточка говорит, что стадию поправили или убрали в разделе, пока Чудо-Юдо работал', async () => {
  const stream = controlledStream<RewriteEvent>()
  // Ушли агенту «Ревью» и «Запас»; в разделе «Ревью» с тех пор поправили, а «Запаса» уже нет.
  stubFetch(stream, {
    ...runningRequest('flow', 'Уточни выходы', base, 'Agents Kit Web', 1000),
    stages: [{ ...review, output: 'вердикт' }, stage('Запас')],
  })
  renderModal()

  await screen.findByText('Чудо-Юдо переписывает стадии…')
  stream.send({
    type: 'rewritten',
    text: '',
    stages: [
      { of: 'Ревью', stage: { ...review, output: 'вердикт по sha' } },
      { of: 'Запас', stage: stage('Запас', { output: 'новый выход' }) },
    ],
  })

  const changes = await screen.findByLabelText('Что изменилось в стадиях')
  expect(
    within(changes).getByText('Стадию «Ревью» правили, пока Чудо-Юдо работал: «Принять правки» заменит эти правки его ответом.'),
  ).toBeInTheDocument()
  expect(within(changes).getByText('Стадии «Запас» в разделе уже нет: правка ляжет новой стадией.')).toBeInTheDocument()
})

test('стадия, которую никто не трогал, пока Чудо-Юдо работал, идёт без предупреждения', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream, { ...runningRequest('flow', 'Уточни выход', base, 'Agents Kit Web', 1000), stages: [review] })
  renderModal()

  await screen.findByText('Чудо-Юдо переписывает стадии…')
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })

  await screen.findByLabelText('Что изменилось в стадиях')
  expect(screen.queryByText(/пока Чудо-Юдо работал/)).not.toBeInTheDocument()
})

test('«Попросить снова» уходит со стадиями такими, какими их видно в разделе сейчас', async () => {
  const stream = controlledStream<RewriteEvent>()
  // Ушла прежняя «Ревью» и «Запас», которого в разделе уже нет.
  const { posts } = stubFetch(stream, {
    ...runningRequest('flow', 'Уточни выход ревью', base, 'Agents Kit Web', 1000),
    stages: [{ ...review, output: 'старый выход' }, stage('Запас')],
  })
  renderModal()

  await screen.findByText('Чудо-Юдо переписывает стадии…')
  stream.send({ type: 'error', text: 'Агент упал' })
  fireEvent.click(await screen.findByRole('button', { name: 'Попросить снова' }))

  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0].body).toMatchObject({ stages: [review, stage('Запас')] })
})

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

function renderModal(apply: () => Promise<string | null> = async () => null) {
  const onApply = vi.fn(apply)
  const onClose = vi.fn()
  const view = render(
    <FlowRewriteModal
      base={base}
      project="Agents Kit Web"
      stages={stages}
      mark={(title) => <span data-testid={`mark-${title}`} />}
      scope={(title) =>
        title === 'Ревью' ? 'Этап стоит в сценариях «полный» и «быстрый» — правка изменит его в обоих.' : null
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
  fireEvent.change(await screen.findByLabelText('Что поменять в этапах'), { target: { value: text } })
}

function pick(...titles: string[]) {
  fireEvent.click(screen.getByRole('button', { name: 'Этапы' }))
  const list = screen.getByRole('listbox', { name: 'Этапы проекта' })
  for (const title of titles) fireEvent.click(within(list).getByRole('option', { name: new RegExp(title) }))
}

test('без стадий в контексте окно пишет новую стадию, и просьба уходит со стадиями раздела', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  renderModal()

  await write('  Заведи этап документации  ')
  fireEvent.click(screen.getByRole('button', { name: 'Написать этап' }))

  expect(await screen.findByText('Чудо-Юдо пишет этап…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/flow/rewrite')
  expect(posts[0].body).toEqual({
    base,
    wish: 'Заведи этап документации',
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

  fireEvent.click(screen.getByRole('button', { name: 'Этапы' }))
  fireEvent.change(screen.getByPlaceholderText('Найти этап'), { target: { value: 'мер' } })
  const list = screen.getByRole('listbox', { name: 'Этапы проекта' })
  expect(within(list).getAllByRole('option')).toHaveLength(1)
  fireEvent.click(within(list).getByRole('option', { name: /Мерж/ }))
  expect(within(list).getByRole('option', { name: /Мерж/ })).toHaveAttribute('aria-selected', 'true')
  fireEvent.change(screen.getByPlaceholderText('Найти этап'), { target: { value: '' } })
  fireEvent.click(within(list).getByRole('option', { name: /Ревью/ }))

  const bar = screen.getByLabelText('Этапы к просьбе')
  expect(within(bar).getByText('Мерж')).toBeInTheDocument()
  expect(within(bar).getByText('Ревью')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Переписать' })).toBeEnabled()

  // Escape закрывает список, а не окно.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Убрать «Мерж»' }))
  fireEvent.click(screen.getByRole('button', { name: 'Убрать «Ревью»' }))
  expect(screen.getByRole('button', { name: 'Написать этап' })).toBeInTheDocument()
})

test('стадия, которую держат задачи в работе, в списке погашена, названы задачи, и к просьбе она не добавляется', async () => {
  stubFetch(controlledStream())
  renderModal()
  await write('Поправь приёмку')

  fireEvent.click(screen.getByRole('button', { name: 'Этапы' }))
  const held = within(screen.getByRole('listbox', { name: 'Этапы проекта' })).getByRole('option', { name: /Приёмка/ })
  expect(held).toHaveAttribute('aria-disabled', 'true')
  expect(held).toHaveTextContent('занят: B-7, B-9')
  fireEvent.click(held)
  fireEvent.keyDown(held, { key: 'Enter' })

  expect(held).toHaveAttribute('aria-selected', 'false')
  expect(screen.queryByRole('button', { name: 'Убрать «Приёмка»' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Написать этап' })).toBeInTheDocument()
})

test('итог — карточка на стадию: «было → стало», задетые сценарии, новая стадия и без правок', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  const { onApply } = renderModal()

  await write('Уточни выход ревью и заведи документацию')
  pick('Ревью', 'Мерж')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))

  expect(await screen.findByText('Чудо-Юдо переписывает этапы…')).toBeInTheDocument()
  expect(posts[0].body.stages).toEqual([review, merge])

  const rewritten = { of: 'Ревью', stage: { ...review, output: 'вердикт по sha', description: '1. Собрать дифф.' } }
  const docs = { of: null, stage: stage('Документация', { executor: 'writer' }) }
  stream.send({ type: 'rewritten', text: '', stages: [rewritten, docs], durationMs: 18000 })

  const changes = await screen.findByLabelText('Что изменилось в этапах')
  expect(within(changes).getByText('изменён')).toBeInTheDocument()
  expect(within(changes).getByText('выход Ревью')).toBeInTheDocument()
  expect(within(changes).getByText('вердикт по sha')).toBeInTheDocument()
  expect(within(changes).getByText(/правка изменит его в обоих/)).toBeInTheDocument()
  expect(within(changes).getByText('добавлен')).toBeInTheDocument()
  expect(within(changes).getByText('writer')).toBeInTheDocument()
  // Стадия контекста, которую агент не тронул, стоит строкой, а не карточкой.
  expect(within(changes).getByText('без правок')).toBeInTheDocument()
  expect(within(changes).getByText('Мерж')).toBeInTheDocument()
  expect(within(changes).getByText('18 с')).toBeInTheDocument()
  // Описание не пересказывается: его открывает своё окно.
  expect(within(changes).queryByText('1. Собрать дифф.')).not.toBeInTheDocument()
  fireEvent.click(within(changes).getByRole('button', { name: 'Открыть описание' }))
  const window_ = await screen.findByRole('dialog', { name: 'Описание этапа «Ревью»' })
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

  expect(await screen.findByText('Этапы не изменились: ответ совпал с прежними.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
  expect(onApply).not.toHaveBeenCalled()
})

test('неудача агента названа словами, а просьба возвращается в поле', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await write('Напиши этап')
  fireEvent.click(screen.getByRole('button', { name: 'Написать этап' }))
  stream.send({ type: 'error', text: 'Чудо-Юдо вернул не этап: этапов в его ответе нет', output: 'Готово!' })

  expect(await screen.findByText(/Чудо-Юдо вернул не этап/)).toBeInTheDocument()
  expect(screen.getByText(/Этапы в базе не менялись/)).toBeInTheDocument()
  expect(screen.getByText('Готово!')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить просьбу' }))
  expect(await screen.findByLabelText('Что поменять в этапах')).toHaveValue('Напиши этап')
})

test('закрытое окно не останавливает агента: просьба остаётся в панели', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { deletes } = stubFetch(stream)
  const { unmount } = renderModal()

  await write('Напиши этап')
  fireEvent.click(screen.getByRole('button', { name: 'Написать этап' }))
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

  const changes = await screen.findByLabelText('Что изменилось в этапах')
  expect(within(changes).getByText('изменён')).toBeInTheDocument()
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
    await screen.findByText('Чудо-Юдо уже переписал этапы Other: новая просьба отсюда уберёт этот ответ.'),
  ).toBeInTheDocument()
  expect(screen.queryByText('Уточни выход ревью')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Что изменилось в этапах')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Что поменять в этапах')).toBeInTheDocument()
})

test('открытое заново окно помнит стадии просьбы: строка стадий, «без правок» и «Попросить снова» с ними', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream, {
    ...runningRequest('flow', 'Уточни выход ревью', base, 'Agents Kit Web', 1000),
    stages: [review, merge],
  })
  renderModal()

  expect(await screen.findByText('Чудо-Юдо переписывает этапы…')).toBeInTheDocument()
  const line = screen.getByLabelText('Этапы к просьбе')
  expect(within(line).getByText('Ревью')).toBeInTheDocument()
  expect(within(line).getByText('Мерж')).toBeInTheDocument()

  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })
  const changes = await screen.findByLabelText('Что изменилось в этапах')
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

  await screen.findByText('Чудо-Юдо переписывает этапы…')
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

  await screen.findByText('Чудо-Юдо переписывает этапы…')
  stream.send({
    type: 'rewritten',
    text: '',
    stages: [
      { of: 'Ревью', stage: { ...review, output: 'вердикт по sha' } },
      { of: 'Запас', stage: stage('Запас', { output: 'новый выход' }) },
    ],
  })

  const changes = await screen.findByLabelText('Что изменилось в этапах')
  expect(
    within(changes).getByText('Этап «Ревью» правили, пока Чудо-Юдо работал: «Принять правки» заменит эти правки его ответом.'),
  ).toBeInTheDocument()
  expect(within(changes).getByText('Этапа «Запас» в разделе уже нет: правка ляжет новым этапом.')).toBeInTheDocument()
})

test('стадия, которую никто не трогал, пока Чудо-Юдо работал, идёт без предупреждения', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream, { ...runningRequest('flow', 'Уточни выход', base, 'Agents Kit Web', 1000), stages: [review] })
  renderModal()

  await screen.findByText('Чудо-Юдо переписывает этапы…')
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })

  await screen.findByLabelText('Что изменилось в этапах')
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

  await screen.findByText('Чудо-Юдо переписывает этапы…')
  stream.send({ type: 'error', text: 'Агент упал' })
  fireEvent.click(await screen.findByRole('button', { name: 'Попросить снова' }))

  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0].body).toMatchObject({ stages: [review, stage('Запас')] })
})

test('запись, которая не прошла, оставляет итог в окне с причиной, и принять его можно снова', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const failures = ['Флоу не сохранён: его изменили в базе, пока Чудо-Юдо работал. Раздел перечитал флоу — примите правки ещё раз.', null]
  const { onApply, onClose } = renderModal(async () => failures.shift() ?? null)

  await write('Уточни выход ревью')
  pick('Ревью')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })
  fireEvent.click(await screen.findByRole('button', { name: 'Принять правки' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Правки не записаны')
  expect(alert).toHaveTextContent('его изменили в базе')
  // Итог на месте, окно не закрыто
  expect(screen.getByLabelText('Что изменилось в этапах')).toHaveTextContent('вердикт')
  expect(onClose).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(onApply).toHaveBeenCalledTimes(2)
})

test('правку занятой стадии принять нельзя: окно называет стадию и задачи', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const { onApply } = renderModal()

  await write('Поправь всё')
  fireEvent.click(screen.getByRole('button', { name: 'Написать этап' }))
  // Агент переписал и занятую Приёмку: её он получает по названию среди стадий проекта
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Приёмка', stage: { ...acceptance, output: 'принято' } }] })

  expect(await screen.findByRole('alert')).toHaveTextContent('«Приёмка» — B-7, B-9')
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
  expect(onApply).not.toHaveBeenCalled()
})

test('пока принятые правки пишутся, окно не закрыть: ни «Отказаться», ни крестиком, ни Escape', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  let finish: (failed: string | null) => void = () => undefined
  const { onClose } = renderModal(() => new Promise((resolve) => (finish = resolve)))

  await write('Уточни выход ревью')
  pick('Ревью')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт' } }] })
  fireEvent.click(await screen.findByRole('button', { name: 'Принять правки' }))

  expect(screen.getByRole('button', { name: 'Отказаться' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Закрыть' })).toBeDisabled()
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(onClose).not.toHaveBeenCalled()

  finish('Флоу не сохранён: нет связи с API')
  expect(await screen.findByRole('alert')).toHaveTextContent('нет связи с API')
  expect(screen.getByRole('button', { name: 'Отказаться' })).toBeEnabled()
})

test('пока правки пишутся, Escape закрывает вложенное описание, но не само окно', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  let finish: (failed: string | null) => void = () => undefined
  const { onClose } = renderModal(() => new Promise((resolve) => (finish = resolve)))

  await write('Уточни ревью')
  pick('Ревью')
  fireEvent.click(screen.getByRole('button', { name: 'Переписать' }))
  stream.send({ type: 'rewritten', text: '', stages: [{ of: 'Ревью', stage: { ...review, description: '1. Собрать дифф.' } }] })
  fireEvent.click(await screen.findByRole('button', { name: 'Принять правки' }))
  fireEvent.click(screen.getByRole('button', { name: 'Открыть описание' }))
  expect(await screen.findByRole('dialog', { name: 'Описание этапа «Ревью»' })).toBeInTheDocument()

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog', { name: 'Описание этапа «Ревью»' })).not.toBeInTheDocument()
  expect(onClose).not.toHaveBeenCalled()
  finish(null)
  await waitFor(() => expect(onClose).toHaveBeenCalled())
})

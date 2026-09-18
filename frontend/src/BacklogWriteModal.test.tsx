import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import BacklogWriteModal, { type WriteBase, type WriteEvent } from './BacklogWriteModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: WriteBase[] = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  return stubPanel('backlog', stream, { running, project: 'Nota' })
}

function renderModal(initialBase: string | null = null) {
  const onEntries = vi.fn()
  const view = render(
    <BacklogWriteModal bases={bases} initialBase={initialBase} onClose={() => {}} onEntries={onEntries} />,
  )
  return Object.assign(onEntries, { unmount: view.unmount })
}

async function send(text: string) {
  fireEvent.change(await screen.findByLabelText('Что записать'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Добавить' }))
}

test('текст уходит в проект раздела, ход агента виден, итог показывает новые записи с текстом', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  const onEntries = renderModal('D:\\Projects\\nota-knowledge')

  expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  await send('  Хочу видеть ожидание и сортировку  ')

  expect(await screen.findByText('Чудо-юдо пишет в бэклог Nota…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/backlog/write')
  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\nota-knowledge', text: 'Хочу видеть ожидание и сортировку' })

  stream.send({ type: 'step', text: 'правит backlog.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-юдо' })
  expect(within(steps).getByText('правит backlog.md')).toBeInTheDocument()

  stream.send({
    type: 'written',
    text: 'Записал.',
    entries: [
      { number: 'B-32', title: 'Таблица показывает ожидание', text: 'Сколько копия **ждёт**.' },
      { number: 'B-33', title: 'Сортировка по номеру', text: null },
    ],
    commit: '4f1c2a9',
    durationMs: 72000,
  })

  expect(await screen.findByText('Добавлено 2 записи')).toBeInTheDocument()
  expect(screen.getByText('коммит 4f1c2a9 · 1 мин 12 с')).toBeInTheDocument()
  const entries = within(screen.getByRole('list', { name: 'Новые записи' }))
  expect(entries.getByText('B-32')).toBeInTheDocument()
  expect(entries.getByText('ждёт')).toHaveProperty('tagName', 'STRONG')
  expect(entries.getByText('Описания нет')).toBeInTheDocument()
  expect(onEntries).toHaveBeenCalledWith('D:\\Projects\\nota-knowledge', ['B-32', 'B-33'])

  fireEvent.click(screen.getByRole('button', { name: 'Записать ещё' }))
  expect(screen.getByLabelText('Что записать')).toHaveValue('')
})

test('неудача называет причину и вывод агента, а текст остаётся для повторной отправки', async () => {
  const stream = controlledStream()
  const { posts } = stubFetch(stream)
  const onEntries = renderModal()

  await send('Мысль')
  stream.send({ type: 'error', text: 'Агент закончил, но новых записей в бэклоге нет', output: 'Правка запрещена' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Чудо-юдо не записал')).toBeInTheDocument()
  expect(within(alert).getByText('Правка запрещена')).toBeInTheDocument()
  expect(onEntries).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Изменить текст' }))
  expect(screen.getByLabelText('Что записать')).toHaveValue('Мысль')
  expect(posts[0].body).toEqual({ base: 'D:\\Projects\\app-knowledge', text: 'Мысль' })
})

test('незакоммиченные записи показаны при ошибке и отмечаются в списке', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  const onEntries = renderModal()

  await send('Мысль')
  stream.send({
    type: 'error',
    text: 'Записи появились, но backlog.md не закоммичен',
    entries: [{ number: 'B-40', title: 'Новая запись', text: null }],
  })

  await screen.findByRole('alert')
  expect(within(screen.getByRole('list', { name: 'Новые записи' })).getByText('B-40')).toBeInTheDocument()
  expect(onEntries).toHaveBeenCalledWith('D:\\Projects\\app-knowledge', ['B-40'])
})

test('оборванный без итога поток — сбой, а не вечное ожидание', async () => {
  const stream = controlledStream()
  stubFetch(stream)
  renderModal()

  await send('Мысль')
  stream.close()

  expect(await screen.findByRole('alert')).toHaveTextContent('оборвал')
})

test('«Отменить» убирает просьбу из панели и возвращает текст в поле', async () => {
  const stream = controlledStream()
  const { deletes } = stubFetch(stream)
  renderModal()

  await send('Долгая мысль')
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))

  expect(deletes).toEqual(['/api/agent/backlog'])
  expect(await screen.findByLabelText('Что записать')).toHaveValue('Долгая мысль')
})

test('закрытое окно не останавливает агента: просьба остаётся в панели', async () => {
  const stream = controlledStream()
  const { deletes } = stubFetch(stream)
  const onEntries = renderModal()

  await send('Долгая мысль')
  await screen.findByRole('status')
  onEntries.unmount()

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает запись, которая шла без него', async () => {
  const stream = controlledStream<WriteEvent>()
  const { posts } = stubFetch(stream, runningRequest('backlog', 'Хочу ожидание', bases[1].base, 'Nota', 12000))
  const onEntries = renderModal()

  expect(await screen.findByText('Хочу ожидание')).toBeInTheDocument()
  expect(screen.getByLabelText('Прошло времени')).toHaveTextContent('0:12')

  stream.send({
    type: 'written',
    text: '',
    entries: [{ number: 'B-60', title: 'Ожидание в таблице', text: null }],
    commit: 'a1b2c3d',
  })

  expect(await screen.findByText('B-60')).toBeInTheDocument()
  expect(onEntries).toHaveBeenCalledWith(bases[0].base, ['B-60'])
  expect(posts).toEqual([])
})

test('без текста добавить нельзя', async () => {
  stubFetch(controlledStream())
  renderModal()

  expect(await screen.findByRole('button', { name: 'Добавить' })).toBeDisabled()
})

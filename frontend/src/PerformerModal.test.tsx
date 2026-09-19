import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PerformerModal, { type DraftEvent } from './PerformerModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'
import type { Performer, PerformerCopy } from './Performers'

afterEach(() => vi.unstubAllGlobals())

const copies: PerformerCopy[] = [
  { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
  { path: 'D:\\Projects\\noble-keen-walrus', name: 'noble-keen-walrus', branch: 'dev', main: false },
]

const reviewer: Performer = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком.',
  path: 'D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md',
  source: 'copy',
  copy: 'D:\\Projects\\agents-kit-web',
}

function open(editing: Performer | null = null, onSaved = vi.fn()) {
  render(
    <PerformerModal
      base={'D:\\Projects\\app-knowledge'}
      copies={copies}
      editing={editing}
      onClose={vi.fn()}
      onSaved={onSaved}
    />,
  )
  return onSaved
}

/** Тело запроса, которым панель записала исполнителя: до него окно спрашивает ещё и о своей просьбе. */
function saved(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/performers')!
  return JSON.parse(String((call[1] as RequestInit).body))
}

/** Окно спрашивает панель о своей просьбе при открытии: без просьбы ответом идёт пустой список. */
function stubFetch(response: Response) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(url === '/api/agent/requests' ? Response.json([]) : response),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('заводит исполнителя в основную копию и показывает путь его файла', async () => {
  const fetchMock = stubFetch(new Response(JSON.stringify({ path: 'x' }), { status: 200 }))
  const onSaved = open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'reviewer' } })
  fireEvent.change(screen.getByLabelText(/Описание/), { target: { value: 'Читает дифф.' } })
  fireEvent.change(screen.getByLabelText('Задание'), { target: { value: 'Ты читаешь дифф.' } })

  // Файл ложится в основную копию проекта, и путь виден до сохранения
  expect(screen.getByText('D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(fetchMock).toHaveBeenCalledWith('/api/performers', expect.objectContaining({ method: 'POST' }))
  expect(saved(fetchMock)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    name: 'reviewer',
    description: 'Читает дифф.',
    model: null,
    tools: null,
    prompt: 'Ты читаешь дифф.',
  })
})

test('копию в окне не выбирают: файл всегда ложится в основную', async () => {
  const fetchMock = stubFetch(new Response(JSON.stringify({ path: 'x' }), { status: 200 }))
  open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'e2e-runner' } })

  // Исполнитель — про проект целиком, и поля выбора копии в окне больше нет — решение оператора на B-77.
  expect(screen.queryByLabelText('Копия')).not.toBeInTheDocument()
  expect(screen.getByText('D:\\Projects\\agents-kit-web\\.claude\\agents\\e2e-runner.md')).toBeInTheDocument()
  expect(screen.getByText(/в остальные — кнопкой «Синхронизировать»/)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(saved(fetchMock).copy).toBeUndefined()
})

test('правка заведённого открывает его поля', () => {
  open(reviewer)

  expect(screen.getByLabelText('Имя')).toHaveValue('reviewer')
  expect(screen.getByLabelText(/Описание/)).toHaveValue('Читает дифф ветки задачи.')
  expect(screen.getByLabelText('Задание')).toHaveValue('Ты читаешь дифф ветки целиком.')
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Glob, Grep')
})

test('негодное имя объясняется словами, а набранное остаётся', async () => {
  stubFetch(new Response(JSON.stringify({ problem: 'invalid-name' }), { status: 400 }))
  open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Ревью Диффа' } })
  fireEvent.change(screen.getByLabelText('Задание'), { target: { value: 'Тело' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('строчная латиница')
  expect(screen.getByLabelText('Имя')).toHaveValue('Ревью Диффа')
  expect(screen.getByLabelText('Задание')).toHaveValue('Тело')
})

test('отказ коммита показан дословно', async () => {
  stubFetch(
    new Response(JSON.stringify({ problem: 'not-committed', detail: 'hook: сверка не прошла' }), { status: 409 }),
  )
  open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Файл записан, но не закоммичен')
  expect(alert).toHaveTextContent('hook: сверка не прошла')
})

test('без связи с API окно говорит об этом и не закрывается', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))
  const onSaved = open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('нет связи с API')
  expect(onSaved).not.toHaveBeenCalled()
})

test('кнопка «только чтение» ставит набор инструментов и снимает его', () => {
  open()

  fireEvent.click(screen.getByRole('button', { name: 'только чтение' }))
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Glob, Grep')

  fireEvent.click(screen.getByRole('button', { name: 'все инструменты' }))
  expect(screen.getByLabelText('Инструменты')).toHaveValue('')
})

test('просьба к Чудо-Юдо идёт из окна и заполняет его поля', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream, { project: 'Agents Kit Web' })
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Читает дифф ветки и возвращает вердикт' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  await waitFor(() => expect(panel.posts).toHaveLength(1))
  expect(panel.posts[0]).toEqual({
    url: '/api/performers/draft',
    body: {
      base: 'D:\\Projects\\app-knowledge',
      wish: 'Читает дифф ветки и возвращает вердикт',
      current: null,
    },
  })

  stream.send({ type: 'step', text: 'читает flow.md' })
  expect(await screen.findByText('читает flow.md')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('заводит исполнителя')

  stream.send({
    type: 'drafted',
    text: '---',
    fields: {
      name: 'reviewer',
      description: 'Читает дифф ветки задачи.',
      model: 'opus',
      tools: 'Read, Glob, Grep',
      prompt: 'Ты читаешь дифф ветки целиком.',
    },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Имя')).toHaveValue('reviewer'))
  expect(screen.getByLabelText(/Описание/)).toHaveValue('Читает дифф ветки задачи.')
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Glob, Grep')
  expect(screen.getByLabelText('Задание')).toHaveValue('Ты читаешь дифф ветки целиком.')
  // Файл ещё не записан: его пишет «Сохранить».
  expect(panel.posts.map((post) => post.url)).toEqual(['/api/performers/draft'])
})

test('«Вернуть как было» возвращает поля, какими они были до ответа агента', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Пусть ещё сверяет с критериями' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))

  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'reviewer', description: null, model: null, tools: null, prompt: 'Новое задание.' },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Задание')).toHaveValue('Новое задание.'))

  fireEvent.click(screen.getByRole('button', { name: 'вернуть как было' }))

  await waitFor(() => expect(screen.getByLabelText('Задание')).toHaveValue('Ты читаешь дифф ветки целиком.'))
  expect(screen.getByLabelText(/Описание/)).toHaveValue('Читает дифф ветки задачи.')
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
})

test('нынешние поля уходят агенту, когда исполнителя правят', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Пусть не чинит найденное сам' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))

  await waitFor(() => expect(panel.posts).toHaveLength(1))
  expect(panel.posts[0].body.current).toEqual({
    name: 'reviewer',
    description: 'Читает дифф ветки задачи.',
    model: 'opus',
    tools: 'Read, Glob, Grep',
    prompt: 'Ты читаешь дифф ветки целиком.',
  })
})

test('неудача агента сказана словами, поля и просьба остаются', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Ревьюер ветки' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  stream.send({ type: 'error', text: 'Чудо-Юдо вернул исполнителя без имени', output: 'Готово!' })
  stream.close()

  expect(await screen.findByRole('alert')).toHaveTextContent('Чудо-Юдо вернул исполнителя без имени')
  expect(screen.getByText('Готово!')).toBeInTheDocument()
  expect(screen.getByLabelText('Имя')).toHaveValue('')
  expect(screen.getByLabelText(/Просьба к Чудо-Юдо/)).toHaveValue('Ревьюер ветки')
  expect(screen.getByRole('button', { name: 'Попросить снова' })).toBeInTheDocument()
})

test('«Отменить» убирает просьбу из панели', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream)
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Ревьюер ветки' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  fireEvent.click(await screen.findByRole('button', { name: 'отменить' }))

  await waitFor(() => expect(panel.deletes).toEqual(['/api/agent/performer']))
})

test('идущая просьба подхватывается открытым заново окном', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream, {
    running: runningRequest('performer', 'Ревьюер ветки', 'D:\\Projects\\app-knowledge', 'Agents Kit Web'),
  })
  open()

  expect(await screen.findByText('Ревьюер ветки')).toBeInTheDocument()
  stream.send({ type: 'step', text: 'читает flow.md' })
  expect(await screen.findByText('читает flow.md')).toBeInTheDocument()
})

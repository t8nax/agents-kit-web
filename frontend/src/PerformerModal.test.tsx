import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PerformerModal from './PerformerModal'
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

function stubFetch(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('заводит исполнителя в основную копию и показывает путь его файла', async () => {
  const fetchMock = stubFetch(new Response(JSON.stringify({ path: 'x' }), { status: 200 }))
  const onSaved = open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'reviewer' } })
  fireEvent.change(screen.getByLabelText(/Описание/), { target: { value: 'Читает дифф.' } })
  fireEvent.change(screen.getByLabelText('Задание'), { target: { value: 'Ты читаешь дифф.' } })

  // Копия по умолчанию — основная, и путь файла виден до сохранения
  expect(screen.getByText('D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(fetchMock).toHaveBeenCalledWith('/api/performers', expect.objectContaining({ method: 'POST' }))
  expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\agents-kit-web',
    name: 'reviewer',
    description: 'Читает дифф.',
    model: null,
    tools: null,
    prompt: 'Ты читаешь дифф.',
  })
})

test('копию выбирают в окне, и файл ложится в неё', async () => {
  const fetchMock = stubFetch(new Response(JSON.stringify({ path: 'x' }), { status: 200 }))
  open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'e2e-runner' } })
  fireEvent.change(screen.getByLabelText('Копия'), { target: { value: 'D:\\Projects\\noble-keen-walrus' } })

  expect(screen.getByText('D:\\Projects\\noble-keen-walrus\\.claude\\agents\\e2e-runner.md')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).copy).toBe('D:\\Projects\\noble-keen-walrus')
})

test('правка заведённого открывает его поля и не даёт переехать в другую копию', () => {
  open(reviewer)

  expect(screen.getByLabelText('Имя')).toHaveValue('reviewer')
  expect(screen.getByLabelText(/Описание/)).toHaveValue('Читает дифф ветки задачи.')
  expect(screen.getByLabelText('Задание')).toHaveValue('Ты читаешь дифф ветки целиком.')
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Glob, Grep')
  expect(screen.getByLabelText('Копия')).toBeDisabled()
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

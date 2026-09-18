import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Performers, { type BasePerformers } from './Performers'

afterEach(() => vi.unstubAllGlobals())

const bases: BasePerformers[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    copies: [
      { path: 'D:\\Projects\\agents-kit-web', name: 'agents-kit-web', branch: 'master', main: true },
      { path: 'D:\\Projects\\noble-keen-walrus', name: 'noble-keen-walrus', branch: 'dev', main: false },
    ],
    performers: [
      {
        name: 'reviewer',
        description: 'Читает дифф ветки задачи и возвращает вердикт.',
        model: 'opus',
        tools: 'Read, Glob, Grep',
        prompt: 'Ты читаешь дифф ветки целиком.',
        path: 'D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md',
        source: 'copy',
        copy: 'D:\\Projects\\agents-kit-web',
        in: ['D:\\Projects\\agents-kit-web', 'D:\\Projects\\noble-keen-walrus'],
        differs: [],
        everywhere: true,
      },
      {
        name: 'spec-writer',
        description: 'Пишет спеку экрана.',
        model: null,
        tools: null,
        prompt: 'Тело.',
        path: 'C:\\Users\\me\\.claude\\agents\\spec-writer.md',
        source: 'profile',
        copy: null,
        in: [],
        differs: [],
        everywhere: true,
      },
    ],
    error: null,
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    copies: [{ path: 'D:\\Projects\\nota', name: 'nota', branch: 'main', main: true }],
    performers: [],
    error: null,
  },
]

function stubFetch(...responses: BasePerformers[][]) {
  const fetchMock = vi.fn()
  for (const response of responses)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(response), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('показывает исполнителей первого проекта — имя, описание и путь файла', async () => {
  const fetchMock = stubFetch(bases)

  render(<Performers />)

  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/performers')
  expect(screen.getByText('Читает дифф ветки задачи и возвращает вердикт.')).toBeInTheDocument()
  expect(screen.getByText('D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md')).toBeInTheDocument()
  expect(screen.getByText('opus')).toBeInTheDocument()
  expect(screen.getByText('Read, Glob, Grep')).toBeInTheDocument()
})

test('исполнитель профиля помечен и не правится из панели', async () => {
  stubFetch(bases)

  render(<Performers />)

  expect(await screen.findByText('spec-writer')).toBeInTheDocument()
  expect(screen.getByText('из профиля')).toBeInTheDocument()
  // Исполнителей копии панель правит, исполнителей профиля — только показывает
  const buttons = screen.getAllByRole('button', { name: 'Править' })
  expect(buttons[0]).toBeEnabled()
  expect(buttons[1]).toBeDisabled()
})

test('чипы переключают проект, и список меняется', async () => {
  stubFetch(bases)

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))

  expect(screen.queryByText('reviewer')).not.toBeInTheDocument()
  expect(screen.getByText(/У проекта «Nota» исполнителей нет/)).toBeInTheDocument()
})

test('без отслеживаемых баз раздел говорит, где их добавить', async () => {
  stubFetch([])

  render(<Performers />)

  expect(await screen.findByText(/Нет отслеживаемых баз/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /Новый исполнитель/ })).toBeDisabled()
})

test('сбой запроса виден строкой', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))

  render(<Performers />)

  expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с API')
})

test('ошибка по проекту показана вместо списка', async () => {
  stubFetch([{ ...bases[0], performers: [], error: 'У проекта нет рабочих копий на диске' }])

  render(<Performers />)

  expect(await screen.findByRole('alert')).toHaveTextContent('У проекта нет рабочих копий на диске')
})

/** Проект, где исполнитель лежит не во всех копиях: в одной его нет, в другой лежит другой файл. */
const spread: BasePerformers[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    copies: [
      { path: 'D:\\Projects\\app', name: 'app', branch: 'dev', main: true },
      { path: 'D:\\Projects\\app-two', name: 'app-two', branch: 'feat/two', main: false },
      { path: 'D:\\Projects\\app-three', name: 'app-three', branch: 'master', main: false },
    ],
    performers: [
      {
        name: 'reviewer',
        description: 'Читает дифф.',
        model: null,
        tools: null,
        prompt: 'Тело.',
        path: 'D:\\Projects\\app\\.claude\\agents\\reviewer.md',
        source: 'copy',
        copy: 'D:\\Projects\\app',
        in: ['D:\\Projects\\app', 'D:\\Projects\\app-two'],
        differs: ['D:\\Projects\\app-two'],
        everywhere: false,
      },
    ],
    error: null,
  },
]

/** Тело запроса синхронизации, которое панель отправила n-м вызовом fetch. */
function body(fetchMock: ReturnType<typeof vi.fn>, n: number) {
  return JSON.parse(String((fetchMock.mock.calls[n][1] as RequestInit).body))
}

/** Заглушка списка раздела и запросов синхронизации: список читается заново после записи. */
function stubSync(sync: (body: { confirmed: boolean }) => Response) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/performers/sync')
      return Promise.resolve(sync(JSON.parse(String(init?.body)) as { confirmed: boolean }))
    return Promise.resolve(new Response(JSON.stringify(spread), { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('строка говорит, где исполнителя нет и где лежит другой файл', async () => {
  stubSync(() => new Response('{"copies":[]}', { status: 200 }))

  render(<Performers />)

  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(screen.getByText('в 2 копиях из 3 — пользоваться нельзя')).toBeInTheDocument()
  expect(screen.getByText('app')).toBeInTheDocument()
  expect(screen.getByText('app-two — файл другой')).toBeInTheDocument()
  expect(screen.getByText('app-three')).toBeInTheDocument()
})

test('синхронизация без рискованных копий сразу показывает исход по каждой', async () => {
  const fetchMock = stubSync(
    () =>
      new Response(
        JSON.stringify({ copies: [{ copy: 'D:\\Projects\\app-two', name: 'app-two', done: true, commit: 'a41c9e2', error: null }] }),
        { status: 200 },
      ),
  )

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Синхронизировать' }))

  expect(await screen.findByText('записан и закоммичен')).toBeInTheDocument()
  expect(screen.getByText('a41c9e2')).toBeInTheDocument()
  // Копии не выбирают: запрос уходит по имени исполнителя — решение оператора на B-77.
  expect(fetchMock).toHaveBeenCalledWith('/api/performers/sync', expect.objectContaining({ method: 'POST' }))
  expect(body(fetchMock, 1)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    name: 'reviewer',
    confirmed: false,
  })
})

test('про копию, куда коммитить не стоит, панель спрашивает до записи', async () => {
  const fetchMock = stubSync(({ confirmed }) =>
    confirmed
      ? new Response(
          JSON.stringify({ copies: [{ copy: 'D:\\Projects\\app-three', name: 'app-three', done: true, commit: '7d0b514', error: null }] }),
          { status: 200 },
        )
      : new Response(
          JSON.stringify({
            problem: 'needs-confirmation',
            risky: [{ copy: 'D:\\Projects\\app-three', name: 'app-three', branch: 'master', reason: 'branch' }],
          }),
          { status: 409 },
        ),
  )

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Синхронизировать' }))

  expect(await screen.findByText('копия на master — из неё публикуется панель')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Синхронизировать всё равно' }))

  expect(await screen.findByText('записан и закоммичен')).toBeInTheDocument()
  expect(body(fetchMock, 2).confirmed).toBe(true)
})

test('отказ git в одной копии виден дословно, а другая всё равно записана', async () => {
  stubSync(
    () =>
      new Response(
        JSON.stringify({
          copies: [
            { copy: 'D:\\Projects\\app-two', name: 'app-two', done: true, commit: 'a41c9e2', error: null },
            { copy: 'D:\\Projects\\app-three', name: 'app-three', done: false, commit: null, error: 'сверка не прошла' },
          ],
        }),
        { status: 200 },
      ),
  )

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Синхронизировать' }))

  expect(await screen.findByText('коммит не прошёл')).toBeInTheDocument()
  expect(screen.getByText('сверка не прошла')).toBeInTheDocument()
  expect(screen.getByText('записан и закоммичен')).toBeInTheDocument()
})

test('исполнителя, которого нет в основной копии, панель синхронизировать не даёт', async () => {
  stubSync(() => new Response(JSON.stringify({ problem: 'not-in-main', risky: [] }), { status: 409 }))

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Синхронизировать' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('В основной копии проекта этого исполнителя нет')
})

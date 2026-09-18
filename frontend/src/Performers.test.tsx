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
        path: 'D:\\Projects\\agents-kit-web\\.claude\\agents\\reviewer.md',
        source: 'copy',
        copy: 'D:\\Projects\\agents-kit-web',
      },
      {
        name: 'spec-writer',
        description: 'Пишет спеку экрана.',
        model: null,
        tools: null,
        path: 'C:\\Users\\me\\.claude\\agents\\spec-writer.md',
        source: 'profile',
        copy: null,
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

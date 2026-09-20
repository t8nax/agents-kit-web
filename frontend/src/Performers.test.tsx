import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Performers, { type BasePerformers } from './Performers'

afterEach(() => vi.unstubAllGlobals())

const bases: BasePerformers[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    prefix: 'agents-kit-web',
    directory: 'C:\\Users\\me\\.claude\\agents',
    performers: [
      {
        name: 'reviewer',
        description: 'Читает дифф ветки задачи и возвращает вердикт.',
        model: 'opus',
        tools: 'Read, Glob, Grep',
        prompt: 'Ты читаешь дифф ветки целиком.',
        path: 'C:\\Users\\me\\.claude\\agents\\agents-kit-web-reviewer.md',
      },
    ],
    error: null,
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    prefix: 'nota',
    directory: 'C:\\Users\\me\\.claude\\agents',
    performers: [
      {
        name: 'spec-writer',
        description: 'Пишет спеку экрана.',
        model: null,
        tools: null,
        prompt: 'Тело.',
        path: 'C:\\Users\\me\\.claude\\agents\\nota-spec-writer.md',
      },
    ],
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

test('показывает исполнителя именем без приставки, описанием и путём файла', async () => {
  const fetchMock = stubFetch(bases)

  render(<Performers />)

  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/performers')
  expect(screen.getByText('Читает дифф ветки задачи и возвращает вердикт.')).toBeInTheDocument()
  // Приставка видна только в пути к файлу: в имени её панель не показывает.
  expect(screen.getByText('C:\\Users\\me\\.claude\\agents\\agents-kit-web-reviewer.md')).toBeInTheDocument()
  expect(screen.getByText('opus')).toBeInTheDocument()
  expect(screen.getByText('Read, Glob, Grep')).toBeInTheDocument()
})

test('«Все» показывает исполнителей всех проектов, и каждый назван своим', async () => {
  stubFetch(bases)

  render(<Performers />)

  // Раздел открывается на «Всех»: исполнитель принадлежит машине, а проекту — приставкой в имени.
  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(screen.getByText('spec-writer')).toBeInTheDocument()
  // Название проекта стоит и чипом фильтра, и у строки исполнителя: по ней видно, чей он.
  expect(screen.getAllByText('Agents Kit Web')).toHaveLength(2)
  expect(screen.getAllByText('Nota')).toHaveLength(2)
  expect(screen.getByRole('button', { name: 'Все' })).toHaveAttribute('aria-pressed', 'true')
})

test('править панель даёт каждого исполнителя списка', async () => {
  stubFetch(bases)

  render(<Performers />)

  const buttons = await screen.findAllByRole('button', { name: 'Править' })
  expect(buttons).toHaveLength(2)
  for (const button of buttons) expect(button).toBeEnabled()
})

test('чипы переключают проект, и список меняется', async () => {
  stubFetch(bases)

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))

  expect(screen.queryByText('reviewer')).not.toBeInTheDocument()
  expect(screen.getByText('spec-writer')).toBeInTheDocument()
})

test('у проекта без исполнителей сказано, чем их заводят', async () => {
  stubFetch([bases[0], { ...bases[1], performers: [] }])

  render(<Performers />)
  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))

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

test('ошибка по проекту показана вместе с его названием', async () => {
  stubFetch([
    { ...bases[0], performers: [], error: 'Имя проекта не записать латиницей' },
  ])

  render(<Performers />)

  expect(await screen.findByRole('alert')).toHaveTextContent('Имя проекта не записать латиницей')
})

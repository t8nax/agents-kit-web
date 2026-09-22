import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Performers, { type BasePerformers } from './Performers'

afterEach(() => vi.unstubAllGlobals())

const bases: BasePerformers[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    directory: 'D:\\Projects\\app-knowledge\\agents',
    performers: [
      {
        name: 'reviewer',
        description: 'Читает дифф ветки задачи и возвращает вердикт.',
        model: 'opus',
        tools: 'Read, Glob, Grep',
        prompt: 'Ты читаешь дифф ветки целиком.',
        path: 'D:\\Projects\\app-knowledge\\agents\\reviewer.md',
      },
    ],
    error: null,
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    directory: 'D:\\Projects\\nota-knowledge\\agents',
    performers: [
      {
        name: 'spec-writer',
        description: 'Пишет спеку экрана.',
        model: null,
        tools: null,
        prompt: 'Тело.',
        path: 'D:\\Projects\\nota-knowledge\\agents\\spec-writer.md',
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

test('карточка показывает имя, описание и модель, а путь файла и инструменты — нет', async () => {
  const fetchMock = stubFetch(bases)

  render(<Performers />)

  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/performers')
  expect(screen.getByText('Читает дифф ветки задачи и возвращает вердикт.')).toBeInTheDocument()
  expect(screen.getByText('opus')).toBeInTheDocument()
  // Путь и инструменты живут в окне исполнителя: в карточке их нет (B-80).
  expect(screen.queryByText('D:\\Projects\\app-knowledge\\agents\\reviewer.md')).not.toBeInTheDocument()
  expect(screen.queryByText('Read, Glob, Grep')).not.toBeInTheDocument()
  expect(screen.queryByText('все инструменты')).not.toBeInTheDocument()
})

test('«Все» показывает исполнителей всех проектов, и каждый назван своим', async () => {
  stubFetch(bases)

  render(<Performers />)

  // Раздел открывается на «Всех»: исполнитель принадлежит проекту той базой, где лежит его файл.
  expect(await screen.findByText('reviewer')).toBeInTheDocument()
  expect(screen.getByText('spec-writer')).toBeInTheDocument()
  // Название проекта стоит и пунктом списка, и у карточки исполнителя: по ней видно, чей он.
  expect(screen.getAllByText('Agents Kit Web')).toHaveLength(2)
  expect(screen.getAllByText('Nota')).toHaveLength(2)
  // Проект выбирается выпадающим списком, а не чипами; открывается раздел на «Всех».
  expect(screen.getByRole('combobox', { name: 'Проект' })).toHaveDisplayValue('Все')
  expect(screen.queryByRole('button', { name: 'Все' })).not.toBeInTheDocument()
})

test('кнопки «Править» нет: окно исполнителя открывает клик по карточке', async () => {
  // Открытое окно само спрашивает API о просьбах к агенту: им хватает пустого списка.
  stubFetch(bases).mockResolvedValue(new Response('[]', { status: 200 }))

  render(<Performers />)

  const card = await screen.findByRole('button', { name: 'spec-writer, Nota' })
  expect(screen.getByRole('button', { name: 'reviewer, Agents Kit Web' })).toBeEnabled()
  // Описание и модель карточки программа чтения слышит её описанием, а не теряет за именем кнопки.
  expect(screen.getByRole('button', { name: 'reviewer, Agents Kit Web' })).toHaveAccessibleDescription(
    'Читает дифф ветки задачи и возвращает вердикт.opus',
  )
  expect(screen.queryByRole('button', { name: 'Править' })).not.toBeInTheDocument()

  fireEvent.click(card)

  expect(await screen.findByRole('dialog')).toHaveTextContent('spec-writer')
})

test('выпадающий список переключает проект, и сетка меняется', async () => {
  stubFetch(bases)

  render(<Performers />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Проект' }), { target: { value: bases[1].base } })

  expect(screen.queryByText('reviewer')).not.toBeInTheDocument()
  expect(screen.getByText('spec-writer')).toBeInTheDocument()

  fireEvent.change(screen.getByRole('combobox', { name: 'Проект' }), { target: { value: '' } })
  expect(screen.getByText('reviewer')).toBeInTheDocument()
})

test('у проекта без исполнителей сказано, чем их заводят', async () => {
  stubFetch([bases[0], { ...bases[1], performers: [] }])

  render(<Performers />)
  fireEvent.change(await screen.findByRole('combobox', { name: 'Проект' }), { target: { value: bases[1].base } })

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

test('итог из шапки про исполнителя, которого нет, сказан строкой, а не пустым окном нового', async () => {
  stubFetch(bases).mockResolvedValue(new Response('[]', { status: 200 }))

  render(<Performers draftFor={bases[0].base} draftSubject="gone" />)

  expect(await screen.findByRole('alert')).toHaveTextContent('Исполнителя gone в проекте больше нет')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('итог из шапки про заведённого открывается его правкой', async () => {
  stubFetch(bases).mockResolvedValue(new Response('[]', { status: 200 }))

  render(<Performers draftFor={bases[0].base} draftSubject="reviewer" />)

  expect(await screen.findByRole('dialog', { name: 'reviewer' })).toBeInTheDocument()
})

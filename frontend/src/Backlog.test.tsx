import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Backlog, { type BaseBacklog } from './Backlog'

afterEach(() => vi.unstubAllGlobals())

const backlogs: BaseBacklog[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    entries: [
      {
        number: 'B-1',
        title: 'Панель показывает проблемы баз знаний',
        text: 'Сейчас панель не говорит, что с базой что-то не так.\n\n- связь разорвана\n- сверка нашла ошибки',
      },
      { number: 'B-13', title: 'У панели есть светлая тема', text: 'Панель сейчас только тёмная.' },
    ],
    error: null,
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    entries: [{ number: 'B-2', title: 'Экспорт заметок', text: 'Забрать заметки нечем.' }],
    error: null,
  },
]

function stubFetch(...responses: BaseBacklog[][]) {
  const fetchMock = vi.fn()
  for (const backlog of responses)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(backlog), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('показывает записи бэклога группами по проектам, без текста', async () => {
  const fetchMock = stubFetch(backlogs)

  render(<Backlog />)

  expect(await screen.findByRole('heading', { name: 'Agents Kit Web' })).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledWith('/api/backlog')

  const first = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(first.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).toBeInTheDocument()
  expect(first.getByRole('button', { name: /B-13 У панели есть светлая тема/ })).toBeInTheDocument()
  // Текст оператору в списке не показывается — только в окне записи
  expect(screen.queryByText('Сейчас панель не говорит, что с базой что-то не так.')).not.toBeInTheDocument()
  expect(screen.queryByText('Панель сейчас только тёмная.')).not.toBeInTheDocument()

  const second = within(screen.getByRole('region', { name: 'Nota' }))
  expect(second.getByText('Экспорт заметок')).toBeInTheDocument()
})

test('клик по записи открывает окно с номером, заголовком и размеченным текстом', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ }))

  const dialog = within(screen.getByRole('dialog', { name: 'Панель показывает проблемы баз знаний' }))
  expect(dialog.getByText('B-1')).toBeInTheDocument()
  expect(dialog.getByText('Сейчас панель не говорит, что с базой что-то не так.')).toBeInTheDocument()
  // Текст оператору размечен markdown: список остаётся списком
  expect(dialog.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
    'связь разорвана',
    'сверка нашла ошибки',
  ])
})

test('адрес в тексте записи — ссылка в новую вкладку', async () => {
  stubFetch([
    { ...backlogs[0], entries: [{ number: 'B-7', title: 'Со ссылкой', text: 'Подробности: https://example.com/t/7' }] },
  ])

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-7 Со ссылкой/ }))

  const link = within(screen.getByRole('dialog')).getByRole('link', { name: 'https://example.com/t/7' })
  expect(link).toHaveAttribute('href', 'https://example.com/t/7')
  expect(link).toHaveAttribute('target', '_blank')
})

test('запись без текста открывается окном «Описания нет»', async () => {
  stubFetch([{ ...backlogs[0], entries: [{ number: 'B-5', title: 'Дописана руками', text: null }] }])

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-5 Дописана руками/ }))

  expect(within(screen.getByRole('dialog')).getByText('Описания нет')).toBeInTheDocument()
})

test('окно закрывается кнопкой, Esc и кликом мимо окна и возвращает фокус записи', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  const entry = await screen.findByRole('button', { name: /B-13 У панели есть светлая тема/ })

  fireEvent.click(entry)
  expect(screen.getByRole('button', { name: 'Закрыть' })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(entry).toHaveFocus()

  fireEvent.click(entry)
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(entry)
  // Клик внутри окна его не закрывает
  fireEvent.mouseDown(screen.getByText('Панель сейчас только тёмная.'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  fireEvent.mouseDown(screen.getByRole('dialog').parentElement!)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('фильтр по проектам оставляет записи одного проекта', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }))

  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Nota' })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Все проекты' }))
  expect(screen.getByRole('region', { name: 'Agents Kit Web' })).toBeInTheDocument()
})

test('одна база — фильтра нет', async () => {
  stubFetch([backlogs[0]])

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })

  expect(screen.queryByRole('group', { name: 'Фильтр по проектам' })).not.toBeInTheDocument()
})

test('«Обновить» перечитывает бэклог', async () => {
  // Соседняя сессия дописала запись и забрала прежние, пока раздел был открыт
  const changed: BaseBacklog[] = [
    { ...backlogs[0], entries: [{ number: 'B-17', title: 'Дописана соседней сессией', text: null }] },
  ]
  const fetchMock = stubFetch(backlogs, changed)

  render(<Backlog />)
  await screen.findByText('B-1')
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))

  expect(await screen.findByText('B-17')).toBeInTheDocument()
  expect(screen.queryByText('B-1')).not.toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('фильтр сбрасывается, когда его базы больше нет', async () => {
  stubFetch(backlogs, [backlogs[0]])

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }))
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))

  expect(await screen.findByRole('region', { name: 'Agents Kit Web' })).toBeInTheDocument()
})

test('пустой бэклог и непрочитанный названы словами', async () => {
  stubFetch([
    { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web', entries: [], error: null },
    { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: [], error: 'В базе нет backlog.md' },
  ])

  render(<Backlog />)

  expect(await screen.findByText('В бэклоге этого проекта записей нет.')).toBeInTheDocument()
  expect(screen.getByText('В базе нет backlog.md')).toBeInTheDocument()
})

test('без отслеживаемых баз зовёт в окно «Базы знаний»', async () => {
  stubFetch([])

  render(<Backlog />)

  expect(await screen.findByText(/Нет отслеживаемых баз/)).toBeInTheDocument()
})

test('сбой запроса показан строкой, а не пустым списком', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))

  render(<Backlog />)

  expect(await screen.findByRole('alert')).toHaveTextContent('Нет связи с API')
})

test('кнопка «Добавить с помощью Чудо-Юдо» открывает окно записи, новые записи отмечены до «Обновить»', async () => {
  const withNew: BaseBacklog[] = [
    { ...backlogs[0], entries: [...backlogs[0].entries, { number: 'B-32', title: 'Добавлена агентом', text: null }] },
    backlogs[1],
  ]
  const body = new TextEncoder().encode(
    JSON.stringify({
      type: 'written',
      text: 'ok',
      entries: [{ number: 'B-32', title: 'Добавлена агентом', text: null }],
    }) + '\n',
  )
  const fetchMock = vi.fn((url: string) => {
    // Окно записи спрашивает панель, не идёт ли уже такая просьба.
    if (url === '/api/agent/requests') return Promise.resolve(Response.json([]))
    if (url === '/api/backlog/write') {
      return Promise.resolve(
        Response.json({ kind: 'backlog', id: 'r1', base: backlogs[0].base, project: backlogs[0].project, text: 'Мысль', elapsedMs: 0, state: 'running' }),
      )
    }
    if (url.startsWith('/api/agent/backlog/stream')) return Promise.resolve(new Response(body))
    const calls = fetchMock.mock.calls.filter(([u]) => u === '/api/backlog').length
    return Promise.resolve(Response.json(calls === 1 ? backlogs : withNew))
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<Backlog />)
  await screen.findByText('B-1')
  fireEvent.click(screen.getByRole('button', { name: 'Добавить с помощью Чудо-Юдо' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Запись в бэклог' }))
  fireEvent.change(await dialog.findByLabelText('Что записать'), { target: { value: 'Мысль' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Добавить' }))
  await dialog.findByText('Добавлено 1 запись')
  fireEvent.click(dialog.getByRole('button', { name: 'К бэклогу' }))

  const added = await screen.findByRole('button', { name: /B-32 Добавлена агентом/ })
  expect(within(added).getByText('новая')).toBeInTheDocument()
  expect(screen.getAllByText('новая')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
  await screen.findByRole('button', { name: /B-32 Добавлена агентом/ })
  expect(screen.queryByText('новая')).not.toBeInTheDocument()
})

test('без баз добавлять некуда', async () => {
  stubFetch([])

  render(<Backlog />)
  await screen.findByText(/Нет отслеживаемых баз/)

  expect(screen.getByRole('button', { name: 'Добавить с помощью Чудо-Юдо' })).toBeDisabled()
})

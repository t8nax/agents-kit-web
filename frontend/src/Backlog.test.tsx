import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import Backlog, { type BaseBacklog } from './Backlog'
import { forgetRemembered } from './backlogView'

afterEach(() => {
  vi.unstubAllGlobals()
  // Порядок записей раздел помнит в браузере, отбор — страница: каждый тест начинает с раздела по умолчанию
  localStorage.clear()
  forgetRemembered()
})

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
    letters: 'B',
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    entries: [{ number: 'B-2', title: 'Экспорт заметок', text: 'Забрать заметки нечем.' }],
    error: null,
    letters: 'B',
  },
]

const copy = (base: string, path: string, status: WorkspaceRow['status']): WorkspaceRow => ({
  project: 'Проект',
  base,
  path,
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status,
  error: null,
})

const copies: WorkspaceRow[] = [
  copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\noble-keen-walrus', 'free'),
  copy('D:\\Projects\\nota-knowledge', 'D:\\Projects\\nota-copy', 'free'),
]

/**
 * Отвечает бэклогом по очереди на каждое чтение, копиями — списком `rows`, а запуск задачи
 * принимает с `taskReply` и собирает его тела: иначе тест не увидит, с чем раздел его позвал.
 */
function stubFetch(...responses: BaseBacklog[][]) {
  const queue = [...responses]
  const posts: unknown[] = []
  let rows = copies
  let taskReply: Response | null = null
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url === '/api/tasks') {
      posts.push(JSON.parse(String(init?.body)))
      return Promise.resolve(taskReply ?? Response.json({ session: '7339dced' }))
    }
    if (url === '/api/workspaces') return Promise.resolve(Response.json(rows))
    // Окно записи, открытое с раздела, спрашивает, не идёт ли уже просьба
    if (url === '/api/agent/requests') return Promise.resolve(Response.json([]))
    // Окно запуска предлагает флоу базы записи: у каждой базы здесь флоу один.
    if (url === '/api/flow')
      return Promise.resolve(
        Response.json(
          ['D:\\Projects\\app-knowledge', 'D:\\Projects\\nota-knowledge'].map((base) => ({
            base,
            flows: [{ name: 'полный', when: null, entries: [{ stage: 'Ветка' }] }],
          })),
        ),
      )
    expect(url).toBe('/api/backlog')
    return Promise.resolve(Response.json(queue.length > 1 ? queue.shift()! : queue[0]))
  })
  vi.stubGlobal('fetch', fetchMock)
  return Object.assign(fetchMock, {
    posts,
    /** Сколько раз читали бэклог: копии раздел читает своим запросом. */
    backlogReads: () => fetchMock.mock.calls.filter(([url]) => url === '/api/backlog').length,
    setCopies: (next: WorkspaceRow[]) => {
      rows = next
    },
  })
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

test('пока бэклог читается, на месте записей заготовка, а шапка раздела уже видна', async () => {
  let answer: (backlogs: BaseBacklog[]) => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url === '/api/backlog'
        ? new Promise<Response>((resolve) => (answer = (value) => resolve(Response.json(value))))
        : Promise.resolve(Response.json([])),
    ),
  )

  render(<Backlog />)

  expect(screen.getByRole('status', { name: 'Загрузка бэклога' })).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByText(/Загрузка/)).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Бэклог' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeDisabled()
  expect(screen.getByRole('button', { name: /Попросить Чудо-Юдо/ })).toBeDisabled()

  answer(backlogs)

  expect(await screen.findByRole('heading', { name: 'Agents Kit Web' })).toBeInTheDocument()
  expect(screen.queryByRole('status', { name: 'Загрузка бэклога' })).not.toBeInTheDocument()
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

test('тип и приоритет записи видны плашками в списке, а у записи без них плашек нет', async () => {
  stubFetch([
    {
      ...backlogs[0],
      entries: [
        { number: 'B-1', title: 'Копия не пускает следующую задачу', text: null, priority: 'блокер', type: 'баг' },
        { number: 'B-2', title: 'Светлая тема', text: null, priority: 'низкий', type: 'фича' },
        { number: 'B-3', title: 'Без полей', text: null, priority: null, type: null },
      ],
    },
  ])

  render(<Backlog />)

  // Плашки стоят между номером и заголовком — выбор оператора на B-75
  expect(await screen.findByRole('button', { name: /B-1 баг блокер Копия не пускает следующую задачу/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /B-2 фича низкий Светлая тема/ })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'B-3 Без полей' })).toBeInTheDocument()
})

test('в окне записи тип и приоритет стоят под заголовком', async () => {
  stubFetch([
    {
      ...backlogs[0],
      entries: [{ number: 'B-1', title: 'Копия не пускает', text: 'Текст.', priority: 'высокий', type: 'баг' }],
    },
  ])

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-1 баг высокий Копия не пускает/ }))

  // Номер с названием идут строкой, плашки — строкой ниже
  const dialog = screen.getByRole('dialog', { name: 'Копия не пускает' })
  expect(dialog.querySelector('.entry-modal-line')?.textContent).toBe('B-1Копия не пускает')
  expect(dialog.querySelector('.entry-modal-fields')?.textContent).toMatch(/баг\s*высокий/)
})

test('значение поля вне перечня кита показывается как есть', async () => {
  stubFetch([
    {
      ...backlogs[0],
      entries: [{ number: 'B-1', title: 'Своё значение', text: null, priority: 'срочно', type: 'задача' }],
    },
  ])

  render(<Backlog />)

  expect(await screen.findByRole('button', { name: /B-1 задача срочно Своё значение/ })).toBeInTheDocument()
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
  expect(fetchMock.backlogReads()).toBe(2)
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

test('«Попросить Чудо-Юдо» открывает разговор, новые записи отмечены до «Обновить»', async () => {
  const withNew: BaseBacklog[] = [
    { ...backlogs[0], entries: [...backlogs[0].entries, { number: 'B-32', title: 'Добавлена агентом', text: null }] },
    backlogs[1],
  ]
  const body = new TextEncoder().encode(
    [
      { type: 'reply', text: 'Мысль' },
      { type: 'answer', text: 'ok', entries: [{ number: 'B-32', title: 'Добавлена агентом', text: null }] },
    ]
      .map((event) => JSON.stringify(event) + '\n')
      .join(''),
  )
  const fetchMock = vi.fn((url: string) => {
    // Окно Чудо-Юдо спрашивает панель, не идёт ли уже разговор о бэклоге.
    if (url === '/api/agent/requests') return Promise.resolve(Response.json([]))
    if (url === '/api/backlog/write') {
      return Promise.resolve(
        Response.json({ kind: 'backlog', id: 'r1', base: backlogs[0].base, project: backlogs[0].project, text: 'Мысль', elapsedMs: 0, state: 'running' }),
      )
    }
    if (url.startsWith('/api/agent/backlog/stream')) return Promise.resolve(new Response(body))
    if (url === '/api/agent/backlog') return Promise.resolve(new Response(null, { status: 204 }))
    const calls = fetchMock.mock.calls.filter(([u]) => u === '/api/backlog').length
    return Promise.resolve(Response.json(calls === 1 ? backlogs : withNew))
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<Backlog />)
  await screen.findByText('B-1')
  fireEvent.click(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Чудо-Юдо' }))
  fireEvent.change(await dialog.findByLabelText('Просьба к Чудо-Юдо'), { target: { value: 'Мысль' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))
  await dialog.findByText('добавлена')
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))

  const added = await screen.findByRole('button', { name: /B-32 Добавлена агентом/ })
  expect(within(added).getByText('новая')).toBeInTheDocument()
  expect(screen.getAllByText('новая')).toHaveLength(1)

  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
  await screen.findByRole('button', { name: /B-32 Добавлена агентом/ })
  expect(screen.queryByText('новая')).not.toBeInTheDocument()
})

test('«Изменить» есть только у записи с номером и открывает разговор про неё', async () => {
  const withLoose: BaseBacklog[] = [
    { ...backlogs[0], entries: [...backlogs[0].entries, { number: null, title: 'Мысль без номера', text: null }] },
    backlogs[1],
  ]
  stubFetch(withLoose)

  render(<Backlog />)
  const loose = (await screen.findByRole('button', { name: /Мысль без номера/ })).closest('.entry-row') as HTMLElement
  expect(within(loose).queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument()

  const row = screen.getByRole('button', { name: /B-13 / }).closest('.entry-row') as HTMLElement
  fireEvent.click(within(row).getByRole('button', { name: 'Изменить' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Чудо-Юдо' }))
  expect(dialog.getByText('Запись')).toBeInTheDocument()
  expect(dialog.getByText('У панели есть светлая тема')).toBeInTheDocument()
  expect(dialog.getByLabelText('Просьба к Чудо-Юдо')).toHaveAttribute(
    'placeholder',
    'Что поменять в B-13 — или почему она больше не нужна',
  )
})

test('без баз добавлять некуда', async () => {
  stubFetch([])

  render(<Backlog />)
  await screen.findByText(/Нет отслеживаемых баз/)

  expect(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' })).toBeDisabled()
})

test('«Взять задачу» запускает свою запись в выбранную копию и возвращает фокус кнопке', async () => {
  const fetchMock = stubFetch(backlogs)
  const onStarted = vi.fn()

  render(<Backlog onStarted={onStarted} />)
  // Берут запись второго проекта: с ней в запуск должны уйти её база и её номер
  const row = (await screen.findByRole('button', { name: /B-2 Экспорт заметок/ })).closest('.entry-row')!
  const start = within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })
  fireEvent.click(start)

  // Окно берёт запись из строки, а копию спрашивает
  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  expect(dialog).toHaveTextContent('Экспорт заметок')
  fireEvent.click(await within(dialog).findByRole('radio', { name: /nota-copy/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(onStarted).toHaveBeenCalledWith('nota-copy'))
  expect(fetchMock.posts).toEqual([
    { base: 'D:\\Projects\\nota-knowledge', copy: 'D:\\Projects\\nota-copy', number: 'B-2', flow: 'полный' },
  ])
  expect(screen.queryByRole('dialog', { name: 'Взять задачу в работу' })).not.toBeInTheDocument()
  // Фокус возвращается кнопке запуска — клавиатура остаётся на месте в списке
  expect(start).toHaveFocus()
  // Копия занята, а запись убирает агент, когда до неё дойдёт: раздел перечитывает и то и другое
  await waitFor(() => expect(fetchMock.backlogReads()).toBe(2))
})

test('закрытое окно запуска возвращает фокус кнопке записи', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest(
    '.entry-row',
  )!
  const start = within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })
  fireEvent.click(start)
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))

  expect(screen.queryByRole('dialog', { name: 'Взять задачу в работу' })).not.toBeInTheDocument()
  expect(start).toHaveFocus()
})

test('у проекта без свободной копии кнопка записи погашена', async () => {
  const fetchMock = stubFetch(backlogs)
  fetchMock.setCopies([copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\noble-keen-walrus', 'in-work')])

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest(
    '.entry-row',
  )!

  await waitFor(() => expect(within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeDisabled())
})

test('у записи без номера запуска нет: запуск адресует её номером', async () => {
  stubFetch([{ ...backlogs[0], entries: [{ number: null, title: 'Дописана руками', text: null }] }])

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: 'Дописана руками' })).closest('.entry-row')!

  expect(within(row as HTMLElement).queryByRole('button', { name: 'Взять задачу' })).not.toBeInTheDocument()
})

test('записи с буквами своего проекта запускаются, а запись чужими буквами — нет', async () => {
  const orders: BaseBacklog = {
    base: 'D:\\Projects\\orders-knowledge',
    project: 'Orders',
    entries: [
      { number: 'ORD-15', title: 'Повторная оплата создаёт второй заказ', text: null },
      { number: 'B-7', title: 'Таймаут платёжного шлюза не попадает в лог', text: null },
    ],
    error: null,
    letters: 'ORD',
  }
  const fetchMock = stubFetch([orders])
  fetchMock.setCopies([copy(orders.base, 'D:\\Projects\\orders', 'free')])

  render(<Backlog />)
  const own = (await screen.findByRole('button', { name: /ORD-15 Повторная оплата/ })).closest('.entry-row')!
  const foreign = screen.getByRole('button', { name: /B-7 Таймаут платёжного шлюза/ }).closest('.entry-row')!

  await waitFor(() => expect(within(own as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeEnabled())
  // Номер чужими буквами виден, чтобы не потерялся, но кит его перенумерует — запускать рано
  expect(within(foreign as HTMLElement).getByText('B-7')).toHaveClass('entry-num')
  expect(within(foreign as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeDisabled()
})

test('колонка номера одной ширины на весь проект — по самому длинному номеру', async () => {
  stubFetch([
    {
      ...backlogs[0],
      entries: [
        { number: 'B-7', title: 'Короткий номер', text: null },
        { number: 'B-185', title: 'Длинный номер', text: null },
        { number: null, title: 'Без номера', text: null },
      ],
    },
  ])

  render(<Backlog />)
  const section = await screen.findByRole('region', { name: 'Agents Kit Web' })

  expect(section.style.getPropertyValue('--entry-num-width')).toBe('5ch')
  // Место номера есть и у записи без номера: плашки и заголовок стоят на той же вертикали
  expect(section.querySelectorAll('.entry-num-slot')).toHaveLength(3)
})

test('у проекта без номеров колонки номера нет', async () => {
  stubFetch([{ ...backlogs[0], entries: [{ number: null, title: 'Дописана руками', text: null }] }])

  render(<Backlog />)
  const section = await screen.findByRole('region', { name: 'Agents Kit Web' })

  expect(section.querySelector('.entry-num-slot')).toBeNull()
})

const fielded: BaseBacklog[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    entries: [
      { number: 'B-1', title: 'Старый баг', text: null, type: 'баг', priority: 'средний' },
      { number: 'B-2', title: 'Фича про импорт', text: null, type: 'фича', priority: 'блокер' },
      { number: 'B-3', title: 'Срочный баг импорта', text: null, type: 'баг', priority: 'высокий' },
      { number: 'B-4', title: 'Без полей', text: null },
    ],
    error: null,
    letters: 'B',
  },
]

/** Номера записей проекта в том порядке, в каком они видны. */
function shownNumbers(project = 'Agents Kit Web') {
  return Array.from(screen.getByRole('region', { name: project }).querySelectorAll('.entry-num')).map((n) => n.textContent)
}

test('чипы типа и приоритета отбирают записи, несколько значений в поле — любое из них', async () => {
  stubFetch(fielded)

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  const bar = within(screen.getByRole('group', { name: 'Отбор и порядок записей' }))

  fireEvent.click(bar.getByRole('button', { name: 'высокий' }))
  fireEvent.click(bar.getByRole('button', { name: 'блокер' }))
  expect(bar.getByRole('button', { name: 'блокер' })).toHaveAttribute('aria-pressed', 'true')
  expect(shownNumbers()).toEqual(['B-2', 'B-3'])

  fireEvent.click(bar.getByRole('button', { name: 'баг' }))
  expect(shownNumbers()).toEqual(['B-3'])

  fireEvent.click(bar.getByRole('button', { name: 'баг' }))
  fireEvent.click(bar.getByRole('button', { name: 'высокий' }))
  fireEvent.click(bar.getByRole('button', { name: 'блокер' }))
  expect(shownNumbers()).toEqual(['B-1', 'B-2', 'B-3', 'B-4'])
})

test('поиск по номеру и заголовку без различия регистра, крестик очищает поле', async () => {
  stubFetch(fielded)

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'ИМПОРТ' } })
  expect(shownNumbers()).toEqual(['B-2', 'B-3'])

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'b-4' } })
  expect(shownNumbers()).toEqual(['B-4'])

  fireEvent.click(screen.getByRole('button', { name: 'Очистить' }))
  expect(screen.getByRole('textbox', { name: 'Поиск' })).toHaveValue('')
  expect(screen.getByRole('textbox', { name: 'Поиск' })).toHaveFocus()
  expect(screen.queryByRole('button', { name: 'Очистить' })).not.toBeInTheDocument()
  expect(shownNumbers()).toEqual(['B-1', 'B-2', 'B-3', 'B-4'])
})

test('порядок выбирается полем и кнопкой направления', async () => {
  stubFetch(fielded)

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  expect(screen.getByRole('combobox', { name: 'Порядок' })).toHaveValue('number')

  fireEvent.click(screen.getByRole('button', { name: 'По возрастанию' }))
  expect(shownNumbers()).toEqual(['B-4', 'B-3', 'B-2', 'B-1'])

  fireEvent.change(screen.getByRole('combobox', { name: 'Порядок' }), { target: { value: 'priority' } })
  expect(screen.getByRole('button', { name: 'По убыванию' })).toBeInTheDocument()
  expect(shownNumbers()).toEqual(['B-2', 'B-3', 'B-1', 'B-4'])

  fireEvent.change(screen.getByRole('combobox', { name: 'Порядок' }), { target: { value: 'type' } })
  expect(shownNumbers()).toEqual(['B-3', 'B-1', 'B-2', 'B-4'])
})

test('порядок, чипы типа и приоритета помнятся между открытиями раздела, а поиск — нет', async () => {
  stubFetch(fielded)

  const { unmount } = render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  fireEvent.change(screen.getByRole('combobox', { name: 'Порядок' }), { target: { value: 'priority' } })
  fireEvent.click(screen.getByRole('button', { name: 'По возрастанию' }))
  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  fireEvent.click(screen.getByRole('button', { name: 'высокий' }))
  fireEvent.click(screen.getByRole('button', { name: 'блокер' }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'импорт' } })
  unmount()

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  expect(screen.getByRole('combobox', { name: 'Порядок' })).toHaveValue('priority')
  expect(screen.getByRole('button', { name: 'По убыванию' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'баг' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'фича' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('button', { name: 'высокий' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'блокер' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'низкий' })).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByRole('textbox', { name: 'Поиск' })).toHaveValue('')
  expect(shownNumbers()).toEqual(['B-3'])

  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  expect(shownNumbers()).toEqual(['B-2', 'B-3'])
})

test('выбранный проект помнится между открытиями раздела', async () => {
  stubFetch(backlogs)

  const { unmount } = render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })
  const projects = () => within(screen.getByRole('group', { name: 'Фильтр по проектам' }))
  fireEvent.click(projects().getByRole('button', { name: 'Nota' }))
  unmount()

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })
  expect(projects().getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
})

test('запомненного проекта нет в списке баз — раздел показывает все проекты', async () => {
  stubFetch(backlogs)

  const { unmount } = render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })
  fireEvent.click(within(screen.getByRole('group', { name: 'Фильтр по проектам' })).getByRole('button', { name: 'Nota' }))
  unmount()

  stubFetch([backlogs[0], { ...backlogs[1], base: 'D:\\Projects\\other-knowledge', project: 'Other' }])
  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Other' })
  const projects = within(screen.getByRole('group', { name: 'Фильтр по проектам' }))
  expect(projects.getByRole('button', { name: 'Все проекты' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('region', { name: 'Agents Kit Web' })).toBeInTheDocument()
})

test('проект просьбы, с которым открыт раздел, дальше запоминается как выбранный', async () => {
  stubFetch(backlogs)

  const first = render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })
  fireEvent.click(within(screen.getByRole('group', { name: 'Фильтр по проектам' })).getByRole('button', { name: 'Agents Kit Web' }))
  first.unmount()

  const second = render(<Backlog writeFor={backlogs[1].base} />)
  await screen.findByRole('heading', { name: 'Nota' })
  second.unmount()

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })
  const projects = within(screen.getByRole('group', { name: 'Фильтр по проектам' }))
  expect(projects.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
})

test('проект, где под отбор ничего не подошло, скрыт; не подошло нигде — строка на месте списка', async () => {
  stubFetch([...fielded, backlogs[1]])

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })

  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  expect(screen.getByRole('region', { name: 'Agents Kit Web' })).toBeInTheDocument()
  expect(screen.queryByRole('region', { name: 'Nota' })).not.toBeInTheDocument()
  expect(screen.queryByText('Под фильтр записей нет')).not.toBeInTheDocument()

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'нет такого' } })
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByText('Под фильтр записей нет')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Очистить' }))
  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  expect(screen.getByRole('region', { name: 'Nota' })).toBeInTheDocument()
})

test('открытие с проектом просьбы ставит фильтр его проекта, отбор при этом пуст', async () => {
  stubFetch(backlogs)

  render(<Backlog writeFor={backlogs[1].base} />)
  await screen.findByRole('heading', { name: 'Nota' })

  // Окно записи открыто на той же базе; чип проекта — в строке фильтра раздела
  const projects = within(screen.getByRole('group', { name: 'Фильтр по проектам' }))
  expect(projects.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByRole('textbox', { name: 'Поиск' })).toHaveValue('')
})

test('недоступное хранилище не мешает выбирать порядок', async () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  stubFetch(fielded)

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Agents Kit Web' })
  expect(screen.getByRole('combobox', { name: 'Порядок' })).toHaveValue('number')

  fireEvent.change(screen.getByRole('combobox', { name: 'Порядок' }), { target: { value: 'priority' } })
  fireEvent.click(screen.getByRole('button', { name: 'По возрастанию' }))
  expect(shownNumbers()).toEqual(['B-2', 'B-3', 'B-1', 'B-4'])
  vi.restoreAllMocks()
})

test('проект, чей бэклог не читается, при отборе остаётся со строкой ошибки', async () => {
  stubFetch([...fielded, { ...backlogs[1], entries: [], error: 'В базе нет backlog.md' }])

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })

  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  expect(within(screen.getByRole('region', { name: 'Nota' })).getByText('В базе нет backlog.md')).toBeInTheDocument()
  expect(screen.queryByText('Под фильтр записей нет')).not.toBeInTheDocument()

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'нет такого' } })
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Nota' })).toBeInTheDocument()
  expect(screen.getByText('Под фильтр записей нет')).toBeInTheDocument()
})

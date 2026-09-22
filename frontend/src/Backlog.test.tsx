import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
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
    base: 'D:\Projects\app-knowledge',
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

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import Backlog, { type BaseBacklog } from './Backlog'
import { forgetRemembered, readRemembered, remember } from './backlogView'
import { runningRequest } from './agentPanelTesting'

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
  let artifactReply: () => Response = () => new Response(null, { status: 204 })
  let moveReply: () => Response = () =>
    Response.json({ issue: { name: 'GitHub #58', number: 58, title: 'Заголовок', url: 'https://github.com/acme/orders/issues/58' } })
  // Задачи трекера по базам: ответ или обещание ответа — им тест держит чтение трекера незаконченным
  const trackerReplies = new Map<string, () => Promise<Response>>()
  // Задержка ответов бэклога: пока она стоит, чтение бэклога не кончается
  let backlogGate: Promise<void> | null = null
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.startsWith('/api/backlog/tracker?')) {
      const base = new URLSearchParams(url.slice(url.indexOf('?'))).get('base')!
      const reply = trackerReplies.get(base)
      expect(reply, `задачи трекера ${base} не ожидались`).toBeDefined()
      return reply!()
    }
    // Перенос записи в трекер: окно собирает задачу у API и заводит её — B-286
    if (url.startsWith('/api/backlog/tracker/draft?')) {
      const number = new URLSearchParams(url.slice(url.indexOf('?'))).get('number')!
      return Promise.resolve(Response.json({ number, title: 'Заголовок', body: 'Описание', files: [], original: `## ${number} Заголовок` }))
    }
    if (url === '/api/backlog/tracker/move') {
      posts.push(JSON.parse(String(init?.body)))
      return Promise.resolve(moveReply())
    }
    if (url === '/api/backlog/artifact/open') {
      posts.push(JSON.parse(String(init?.body)))
      return Promise.resolve(artifactReply())
    }
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
    const reply = Response.json(queue.length > 1 ? queue.shift()! : queue[0])
    return backlogGate ? backlogGate.then(() => reply) : Promise.resolve(reply)
  })
  vi.stubGlobal('fetch', fetchMock)
  return Object.assign(fetchMock, {
    posts,
    /** Сколько раз читали бэклог: копии раздел читает своим запросом. */
    backlogReads: () => fetchMock.mock.calls.filter(([url]) => url === '/api/backlog').length,
    setCopies: (next: WorkspaceRow[]) => {
      rows = next
    },
    setTaskReply: (next: Response) => {
      taskReply = next
    },
    setArtifactReply: (next: () => Response) => {
      artifactReply = next
    },
    setMoveReply: (next: Response) => {
      moveReply = () => next
    },
    setTracker: (base: string, reply: () => Promise<Response>) => {
      trackerReplies.set(base, reply)
    },
    trackerReads: () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/backlog/tracker?')).length,
    /** Держит следующие ответы бэклога, пока не позвали возвращённую функцию. */
    holdBacklog: () => {
      let release: () => void = () => {}
      backlogGate = new Promise<void>((resolve) => (release = resolve))
      return () => {
        backlogGate = null
        release()
      }
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

const withArtifacts: BaseBacklog = {
  ...backlogs[0],
  entries: [
    {
      number: 'B-9',
      title: 'Со снимком',
      text: 'Снимок падения приложен.',
      artifacts: [
        { label: 'макет', address: 'https://claude.ai/artifact/AbC' },
        { label: 'снимок падения', address: 'artifacts/B-9-снимок.png' },
      ],
    },
  ],
}

test('артефакты записи стоят блоком под описанием: ссылка — вкладкой, файл открывается в VS Code', async () => {
  const fetchMock = stubFetch([withArtifacts])

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-9 Со снимком/ }))

  const block = within(within(screen.getByRole('dialog')).getByRole('region', { name: 'Артефакты' }))
  expect(block.getByText('снимок падения')).toBeInTheDocument()
  expect(block.getByRole('link', { name: 'https://claude.ai/artifact/AbC' })).toHaveAttribute('target', '_blank')
  fireEvent.click(block.getByRole('button', { name: 'artifacts/B-9-снимок.png' }))

  await waitFor(() =>
    expect(fetchMock.posts).toEqual([
      { base: withArtifacts.base, number: 'B-9', index: 1, address: 'artifacts/B-9-снимок.png' },
    ]),
  )
})

test('файла артефакта нет в базе — строка ошибки под блоком', async () => {
  const fetchMock = stubFetch([withArtifacts])
  fetchMock.setArtifactReply(() => Response.json({ problem: 'missing' }, { status: 404 }))

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-9 Со снимком/ }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'artifacts/B-9-снимок.png' }))

  expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent(
    'Файла нет в базе: artifacts/B-9-снимок.png',
  )
})

test('у записи без артефактов блока нет', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: /B-13 У панели есть светлая тема/ }))

  expect(within(screen.getByRole('dialog')).queryByRole('region', { name: 'Артефакты' })).not.toBeInTheDocument()
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
    { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: [], error: 'В личном репозитории нет backlog.md' },
  ])

  render(<Backlog />)

  expect(await screen.findByText('В бэклоге этого проекта записей нет.')).toBeInTheDocument()
  expect(screen.getByText('В личном репозитории нет backlog.md')).toBeInTheDocument()
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

test('бэклог базы нового формата виден и берётся в работу, а правка и просьба закрыты с причиной', async () => {
  const warning = 'Кит перевёл базу на формат, которого эта версия панели не знает.'
  const refusal = 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.'
  stubFetch([{ ...backlogs[0], formatWarning: warning }, backlogs[1]])

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: /B-13 / })).closest('.entry-row') as HTMLElement

  // «Все проекты»: плашка — прямо под заголовком проекта этой базы, у другого проекта её нет
  const own = screen.getByRole('region', { name: 'Agents Kit Web' })
  expect(within(own).getByRole('status')).toHaveTextContent(warning)
  expect(own.querySelector('.base-head')?.nextElementSibling).toBe(within(own).getByRole('status'))
  expect(within(screen.getByRole('region', { name: 'Nota' })).queryByText(warning)).not.toBeInTheDocument()
  expect(screen.getAllByText(warning)).toHaveLength(1)
  // У записей базы нового формата «Изменить» погашена, «Взять задачу» открыта
  expect(within(row).getByRole('button', { name: 'Изменить' })).toBeDisabled()
  expect(within(row).getByRole('button', { name: 'Изменить' })).toHaveAttribute('title', refusal)
  await waitFor(() => expect(within(row).getByRole('button', { name: 'Взять задачу' })).toBeEnabled())
  const nota = screen.getByRole('button', { name: /B-2 / }).closest('.entry-row') as HTMLElement
  expect(within(nota).getByRole('button', { name: 'Изменить' })).toBeEnabled()

  // Просить Чудо-Юдо можно: окно встаёт на базе, которую панель знает, а базу нового формата выбрать можно —
  // тогда под шапкой плашка, а просьбу не написать и не отправить (замечание оператора на макете)
  fireEvent.click(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Чудо-Юдо' }))
  // Проект выбирается, когда окно узнало, что разговора в панели нет
  await waitFor(() => expect(dialog.getByRole('button', { name: 'Проект: Nota' })).toBeEnabled())
  const field = dialog.getByLabelText('Просьба к Чудо-Юдо')
  expect(field).toBeEnabled()
  expect(dialog.queryByText(refusal)).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'Проект: Nota' }))
  const option = dialog.getByRole('option', { name: 'Agents Kit Web' })
  expect(option).not.toHaveTextContent(refusal)
  fireEvent.click(option)
  expect(dialog.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeInTheDocument()
  // Плашка — сразу под шапкой окна, вне ленты
  expect(dialog.getByText(refusal).closest('.format-notice')?.previousElementSibling).toHaveClass('reply-head')
  expect(field).toBeDisabled()
  expect(dialog.getByRole('button', { name: 'Отправить' })).toBeDisabled()
  expect(dialog.getByRole('button', { name: 'Приложить файл' })).toBeDisabled()
  fireEvent.click(dialog.getAllByRole('button', { name: 'Закрыть' })[0])

  // Выбран проект этой базы: плашка на том же месте, под заголовком проекта, и погашенная просьба
  fireEvent.click(screen.getByRole('button', { name: 'Agents Kit Web' }))
  const selected = screen.getByRole('region', { name: 'Agents Kit Web' })
  expect(selected.querySelector('.base-head')?.nextElementSibling).toHaveTextContent(warning)
  expect(screen.getAllByText(warning)).toHaveLength(1)
  expect(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' })).toHaveAttribute('title', refusal)
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
  // Кнопка запуска гаснет — задача взята (B-89), — и фокус встаёт на заголовок строки: клавиатура остаётся на месте
  expect(screen.getByRole('button', { name: /B-2 Экспорт заметок/ })).toHaveFocus()
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

test('у записи, которую уже взяли в копию, кнопка погашена, а «Изменить» живая — B-89', async () => {
  const fetchMock = stubFetch(backlogs)
  fetchMock.setCopies([
    copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\noble-keen-walrus', 'free'),
    // Агент ещё не вырезал запись — она в списке, а её номер уже стоит в строке копии, набранный кириллицей
    {
      ...copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\brave-quiet-otter', 'starting'),
      task: 'В-1 Панель показывает проблемы баз знаний',
      letters: 'B',
    },
  ])

  render(<Backlog />)
  const taken = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest('.entry-row')!
  const other = screen.getByRole('button', { name: /B-13 У панели есть светлая тема/ }).closest('.entry-row')!

  await waitFor(() => expect(within(other as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeEnabled())
  expect(within(taken as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeDisabled()
  expect(within(taken as HTMLElement).getByRole('button', { name: 'Изменить' })).toBeEnabled()
})

test('запись успели взять из другой вкладки: после отказа окна её кнопка гаснет и в разделе — ревью B-89', async () => {
  const fetchMock = stubFetch(backlogs)

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest('.entry-row')!
  const start = within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })
  await waitFor(() => expect(start).toBeEnabled())
  fireEvent.click(start)
  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  fireEvent.click(await within(dialog).findByRole('radio', { name: /noble-keen-walrus/ }))

  // Пока окно открыто, запись взяли в другой вкладке
  fetchMock.setCopies([
    ...copies,
    { ...copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\brave-quiet-otter', 'starting'), task: 'B-1 Панель показывает проблемы баз знаний', letters: 'B' },
  ])
  fetchMock.setTaskReply(Response.json({ problem: 'task-running', message: 'brave-quiet-otter' }, { status: 400 }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Взять в работу' }))
  await within(dialog).findByRole('alert')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

  await waitFor(() => expect(start).toBeDisabled())
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
  stubFetch([...fielded, { ...backlogs[1], entries: [], error: 'В личном репозитории нет backlog.md' }])

  render(<Backlog />)
  await screen.findByRole('heading', { name: 'Nota' })

  fireEvent.click(screen.getByRole('button', { name: 'баг' }))
  expect(within(screen.getByRole('region', { name: 'Nota' })).getByText('В личном репозитории нет backlog.md')).toBeInTheDocument()
  expect(screen.queryByText('Под фильтр записей нет')).not.toBeInTheDocument()

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'нет такого' } })
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Nota' })).toBeInTheDocument()
  expect(screen.getByText('Под фильтр записей нет')).toBeInTheDocument()
})

// ——— Задачи трекера, назначенные на оператора (B-277), — на своей вкладке (B-305) ———

const withTracker = (tracker: BaseBacklog['tracker']): BaseBacklog[] => [{ ...backlogs[0], tracker }, backlogs[1]]

const github = { kind: 'github' as const, name: 'GitHub', server: 'https://github.com', project: 'acme/orders' }

const issues = [
  { name: 'GitHub #52', number: 52, title: 'Панель не стартует с пробелом в пути', url: 'https://github.com/acme/orders/issues/52' },
  { name: 'GitHub #7', number: 7, title: 'Показывать версию кита', url: 'https://github.com/acme/orders/issues/7' },
]

const answer = (body: unknown) => () => Promise.resolve(Response.json(body))

/** Раздел открывается на вкладке задач трекера — как после ухода с неё в другой раздел и возвращения. */
function onTrackerTab() {
  remember({ ...readRemembered(), tab: 'tracker' })
}

test('вкладки «Записи бэклога» и «Задачи трекера» стоят в шапке раздела; при первом открытии — записи', async () => {
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog />)

  const tabs = within(await screen.findByRole('tablist', { name: 'Части бэклога' }))
  expect(tabs.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Записи бэклога', 'Задачи трекера'])
  expect(tabs.getByRole('tab', { name: 'Записи бэклога' })).toHaveAttribute('aria-selected', 'true')
  // На вкладке записей задач трекера нет — ни ссылок, ни подписей групп
  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  expect(project.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).toBeInTheDocument()
  await waitFor(() => expect(fetchMock.trackerReads()).toBe(1))
  expect(screen.queryByRole('link', { name: /#52/ })).not.toBeInTheDocument()
  expect(screen.queryByText('Записи бэклога', { selector: 'div' })).not.toBeInTheDocument()
  // «Попросить Чудо-Юдо» и «Обновить» — на обеих вкладках
  expect(screen.getByRole('button', { name: /Попросить/ })).toBeEnabled()

  fireEvent.click(tabs.getByRole('tab', { name: 'Задачи трекера' }))
  expect(tabs.getByRole('tab', { name: 'Задачи трекера' })).toHaveAttribute('aria-selected', 'true')
  expect(screen.getByRole('button', { name: /Попросить/ })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /B-1 / })).not.toBeInTheDocument()
})

test('на вкладке трекера — только проекты с трекером, задачи ссылками на GitHub', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const link = await project.findByRole('link', { name: /#52 Панель не стартует с пробелом в пути/ })
  expect(link).toHaveAttribute('href', 'https://github.com/acme/orders/issues/52')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('title', 'Открыть GitHub #52 во вкладке браузера')
  expect(project.getByRole('link', { name: /#7 Показывать версию кита/ })).toBeInTheDocument()
  // Подписей групп больше нет — их заменили вкладки
  expect(screen.queryByText('Задачи трекера, назначенные на вас')).not.toBeInTheDocument()
  // Проекта без трекера на вкладке нет; с одним проектом с трекером чипов проектов нет
  expect(screen.queryByRole('region', { name: 'Nota' })).not.toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Фильтр по проектам' })).not.toBeInTheDocument()
  // Тип, приоритет и порядок — фильтры записей
  expect(screen.queryByRole('button', { name: 'баг' })).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox', { name: 'Порядок' })).not.toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(1)
})

test('метки задачи GitHub — серыми плашками за заголовком; у задачи без меток плашек нет', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [{ ...issues[0], labels: ['bug', 'ui'] }, issues[1]], problem: null }))

  render(<Backlog />)

  const labeled = await screen.findByRole('link', { name: /#52/ })
  expect([...labeled.querySelectorAll('.issue-label')].map((el) => el.textContent)).toEqual(['bug', 'ui'])
  expect(labeled.querySelector('.entry-title + .issue-labels')).not.toBeNull()
  expect(screen.getByRole('link', { name: /#7/ }).querySelector('.issue-labels')).toBeNull()
})

test('вкладка помнится между открытиями раздела; раздел с просьбой к Чудо-Юдо открывается на записях', async () => {
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  const { unmount } = render(<Backlog />)
  fireEvent.click(await screen.findByRole('tab', { name: 'Задачи трекера' }))
  await screen.findByRole('link', { name: /#52/ })
  unmount()

  const second = render(<Backlog />)
  expect(await screen.findByRole('tab', { name: 'Задачи трекера' })).toHaveAttribute('aria-selected', 'true')
  expect(await screen.findByRole('link', { name: /#52/ })).toBeInTheDocument()
  second.unmount()

  render(<Backlog writeFor={backlogs[0].base} />)
  expect(await screen.findByRole('tab', { name: 'Записи бэклога' })).toHaveAttribute('aria-selected', 'true')
})

test('трекер не описан ни у одного проекта — вкладка трекера говорит это строкой', async () => {
  onTrackerTab()
  stubFetch(backlogs)

  render(<Backlog />)

  expect(await screen.findByText('Трекер не описан ни у одного проекта.')).toBeInTheDocument()
})

test('выбранный проект без трекера на вкладке трекера — все проекты с трекером, а выбор на месте', async () => {
  const fetchMock = stubFetch([{ ...backlogs[0], tracker: github }, backlogs[1], { ...backlogs[1], base: 'D:\\Projects\\orders-knowledge', project: 'Orders', tracker: github }])
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  fetchMock.setTracker('D:\\Projects\\orders-knowledge', answer({ issues: [], problem: null }))

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: 'Nota' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))

  const chips = within(screen.getByRole('group', { name: 'Фильтр по проектам' }))
  expect(chips.getAllByRole('button').map((b) => b.textContent)).toEqual(['Все проекты', 'Agents Kit Web', 'Orders'])
  expect(chips.getByRole('button', { name: 'Все проекты' })).toHaveAttribute('aria-pressed', 'true')
  expect(await screen.findByRole('link', { name: /#52/ })).toBeInTheDocument()

  fireEvent.click(screen.getByRole('tab', { name: 'Записи бэклога' }))
  expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
})

test('записи бэклога не ждут трекера: пока он читается, на вкладке трекера — заготовка', async () => {
  let reply: (response: Response) => void = () => {}
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, () => new Promise<Response>((resolve) => (reply = resolve)))

  render(<Backlog />)

  expect(await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('status', { name: 'Загрузка задач трекера' })).toBeInTheDocument()

  reply(Response.json({ issues, problem: null }))
  expect(await project.findByRole('link', { name: /#52/ })).toBeInTheDocument()
  expect(project.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
})

test('«Обновить» перечитывает задачи трекера', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog />)
  await screen.findByRole('link', { name: /#52/ })

  fetchMock.setTracker(backlogs[0].base, answer({ issues: [issues[1]], problem: null }))
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))

  await waitFor(() => expect(screen.queryByRole('link', { name: /#52/ })).not.toBeInTheDocument())
  expect(await screen.findByRole('link', { name: /#7/ })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(2)
})

test('трекер, появившийся, пока раздел открыт, читается при перечитывании бэклога, а не висит заготовкой', async () => {
  const fetchMock = stubFetch(backlogs, withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog onStarted={vi.fn()} />)
  const row = (await screen.findByRole('button', { name: /B-2 Экспорт заметок/ })).closest('.entry-row')!

  // Запуск задачи перечитывает бэклог — в нём у проекта уже есть трекер
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' }))
  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  fireEvent.click(await within(dialog).findByRole('radio', { name: /nota-copy/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(fetchMock.trackerReads()).toBe(1))
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  expect(await screen.findByRole('link', { name: /#52/ })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(1)
})

test('ответ трекера прошлого чтения, пришедший после «Обновить», не встаёт на место заготовки', async () => {
  onTrackerTab()
  let late: (response: Response) => void = () => {}
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, () => new Promise<Response>((resolve) => (late = resolve)))

  render(<Backlog />)
  await screen.findByRole('region', { name: 'Agents Kit Web' })
  const first = late

  // Второе чтение трекера не кончается; первое приходит, пока бэклог ещё перечитывается
  const release = fetchMock.holdBacklog()
  fireEvent.click(screen.getByRole('button', { name: 'Обновить' }))
  first(Response.json({ issues, problem: null }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  release()

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('status', { name: 'Загрузка задач трекера' })).toBeInTheDocument()
  expect(project.queryByRole('link', { name: /#52/ })).not.toBeInTheDocument()
})

test.each([
  [{ kind: 'other' as const, name: 'Jira' }, /^Трекер проекта — Jira\. Панель пока читает задачи только из GitHub и YouTrack\.$/, false],
  [
    { kind: 'no-keys' as const, faults: ['трекер', 'сервер', 'проект'] },
    /^В описании трекера проекта нет строк «трекер:», «сервер:» и «проект:» или они записаны не так\. Исправьте описание в разделе «Трекеры»\.$/,
    true,
  ],
  [
    { kind: 'no-keys' as const, faults: ['сервер', 'проект'] },
    /^В описании трекера проекта нет строк «сервер:» и «проект:» или они записаны не так\. Исправьте описание в разделе «Трекеры»\.$/,
    true,
  ],
  [
    { kind: 'no-keys' as const, faults: ['проект'] },
    /^В описании трекера проекта нет строки «проект:» или она записана не так\. Исправьте описание в разделе «Трекеры»\.$/,
    true,
  ],
])('трекер, которого панель не читает (%o), — строка на месте задач, трекер не зовётся', async (tracker, text, warning) => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(tracker))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const line = project.getByText((_, el) => el?.matches('p.tracker-state > span') === true && text.test(el.textContent)).closest('p')!
  expect(line).toHaveClass(warning ? 'warning-text' : 'text-sec')
  expect(project.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(0)
})

// Описание трекера правится в разделе «Трекеры», а не словами киту в сессии: строка поломки ведёт к проекту (B-293, B-323).
test('строка поломки описания трекера ведёт в раздел «Трекеры» к своему проекту', async () => {
  onTrackerTab()
  stubFetch(withTracker({ kind: 'no-keys', faults: ['проект'] }))
  const onTrackers = vi.fn()

  render(<Backlog onTrackers={onTrackers} />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  fireEvent.click(project.getByRole('button', { name: '«Трекеры»' }))
  expect(onTrackers).toHaveBeenCalledExactlyOnceWith(backlogs[0].base, false)
})

test.each([
  [{ issues: [], problem: null }, /^В GitHub нет открытых задач этого репозитория\.$/, false],
  [{ issues: [], problem: 'no-tracker' }, /Описания трекера у проекта больше нет — нажмите «Обновить»/, false],
  [{ issues: [], problem: 'gh-missing' }, /Программа gh не установлена\. Установите GitHub CLI и войдите в аккаунт командой gh auth login/, true],
  [{ issues: [], problem: 'gh-login' }, /Программа gh не вошла в аккаунт GitHub\. Войдите командой gh auth login/, true],
  [
    { issues: [], problem: 'repo-unreachable', detail: "GraphQL: Could not resolve to a Repository with the name 'acme/orders'." },
    /GitHub не нашёл репозиторий acme\/orders или у вашего аккаунта нет к нему доступа: GraphQL: Could not resolve to a Repository/,
    true,
  ],
  [{ issues: [], problem: 'github-error', detail: 'HTTP 502: Bad Gateway' }, /GitHub ответил ошибкой: HTTP 502: Bad Gateway/, true],
])('ответ трекера %o — своей строкой на месте задач', async (reply, text, warning) => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer(reply))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  // Текст строки разбит кодом команды: ищется по всему тексту строки
  const line = (await project.findByText((_, el) => el?.matches('p.tracker-state > span') === true && text.test(el.textContent))).closest('p')!
  expect(line).toHaveClass(warning ? 'warning-text' : 'text-sec')
})

test('задачи трекера не загрузились — красная строка с причиной', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, () => Promise.resolve(new Response(null, { status: 500 })))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  expect((await project.findByText('Задачи трекера не загрузились: HTTP 500.')).closest('p')).toHaveClass('warning-text')
})

// Видны все открытые задачи проекта, поэтому у каждой — исполнитель второй строкой, у ничьей — «никому» (AKW-17)
test('исполнитель задачи трекера — второй строкой под заголовком, у ничьей — «никому»', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(
    backlogs[0].base,
    answer({ issues: [{ ...issues[0], assignee: 'anna-k, boris' }, { ...issues[1], assignee: null }], problem: null }),
  )

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const taken = await project.findByRole('link', { name: /#52/ })
  expect(within(taken).getByText('anna-k, boris')).toHaveClass('issue-assignee')
  const nobody = within(project.getByRole('link', { name: /#7/ })).getByText('никому')
  expect(nobody).toHaveClass('issue-assignee', 'nobody')
})

// «Мои задачи» оставляет задачи, где исполнитель — оператор; проект без своих не прячется, а говорит это (макет AKW-17)
test('флажок «Мои задачи» оставляет свои задачи, проект без своих — со строкой «Ваших задач в этом проекте нет.»', async () => {
  onTrackerTab()
  const fetchMock = stubFetch([
    { ...backlogs[0], tracker: github },
    { ...backlogs[1], tracker: { ...github, project: 'acme/nota' } },
  ])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [{ ...issues[0], mine: true }, { ...issues[1], mine: false }], problem: null }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: [{ ...issues[1], url: 'https://github.com/acme/nota/issues/7' }], problem: null }))

  render(<Backlog />)

  const own = within(await screen.findByRole('region', { name: backlogs[0].project }))
  const other = within(screen.getByRole('region', { name: backlogs[1].project }))
  await own.findByRole('link', { name: /#52/ })
  const check = screen.getByRole('checkbox', { name: 'Мои задачи' })
  expect(check).not.toBeChecked()

  fireEvent.click(check)

  expect(check).toBeChecked()
  expect(own.getByRole('link', { name: /#52/ })).toBeInTheDocument()
  expect(own.queryByRole('link', { name: /#7/ })).not.toBeInTheDocument()
  expect(other.queryByRole('link')).not.toBeInTheDocument()
  expect(other.getByText('Ваших задач в этом проекте нет.').closest('p')).toHaveClass('text-sec')
  expect(readRemembered().mine).toBe(true)
})

// Задач больше сотни — свои могут быть за ней: строка не утверждает, что их нет вовсе (ревью AKW-17)
test('флажок «Мои задачи» при задачах больше сотни — «Среди первых 100 задач проекта ваших нет.»', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: issues.map((i) => ({ ...i, mine: false })), problem: null, truncated: true }))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await project.findByRole('link', { name: /#52/ })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Мои задачи' }))

  expect(project.getByText('Среди первых 100 задач проекта ваших нет.')).toBeInTheDocument()
  expect(project.queryByText('Ваших задач в этом проекте нет.')).not.toBeInTheDocument()
})

// Больше сотни задач — строка, а не молчаливая обрезка; её ссылка ведёт к описанию трекера, где задают фильтр (AKW-17)
test('задач больше сотни — серая строка под списком со ссылкой к трекеру проекта в разделе «Трекеры»', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null, truncated: true }))
  const onTrackers = vi.fn()

  render(<Backlog onTrackers={onTrackers} />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const line = await project.findByText(
    (_, el) => el?.matches('p.tracker-state > span') === true && el.textContent === 'Показаны первые 100 задач — сузьте список фильтром в разделе «Трекеры».',
  )
  expect(line.closest('p')).toHaveClass('text-sec')
  fireEvent.click(project.getByRole('button', { name: 'в разделе «Трекеры»' }))
  expect(onTrackers).toHaveBeenCalledExactlyOnceWith(backlogs[0].base, false)
})

test('задач не больше сотни — строки о пределе нет', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await project.findByRole('link', { name: /#52/ })
  expect(project.queryByText(/Показаны первые/)).not.toBeInTheDocument()
})

test('поиск находит задачи трекера по номеру и заголовку; выбранные на вкладке записей тип и приоритет их не скрывают', async () => {
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))

  render(<Backlog />)
  fireEvent.click(await screen.findByRole('button', { name: 'баг' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  await screen.findByRole('link', { name: /#52/ })
  const search = screen.getByRole('textbox', { name: 'Поиск' })

  fireEvent.change(search, { target: { value: '#7' } })
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(project.getByRole('link', { name: /#7 Показывать версию кита/ })).toBeInTheDocument()
  expect(project.queryByRole('link', { name: /#52/ })).not.toBeInTheDocument()

  fireEvent.change(search, { target: { value: 'пробелом' } })
  expect(screen.getByRole('link', { name: /#52/ })).toBeInTheDocument()

  // Ничего не подошло — проект скрыт целиком, на месте списка строка
  fireEvent.change(search, { target: { value: 'светлая' } })
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.getByText('Под фильтр задач нет')).toBeInTheDocument()
})

test('при отборе без подошедших задач проект на вкладке трекера скрыт целиком, и со строкой поломки тоже', async () => {
  onTrackerTab()
  const fetchMock = stubFetch([{ ...backlogs[0], tracker: github }, { ...backlogs[1], tracker: github }])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [], problem: 'gh-login' }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues, problem: null }))

  render(<Backlog />)
  await screen.findByRole('link', { name: /#52/ })
  expect(screen.getByText(/Программа gh не вошла в аккаунт/)).toBeInTheDocument()

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: '#52' } })
  expect(screen.queryByRole('region', { name: 'Agents Kit Web' })).not.toBeInTheDocument()
  expect(screen.queryByText(/Программа gh не вошла в аккаунт/)).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Nota' })).toBeInTheDocument()
})

// ——— Фильтр «Метки» (B-305) ———

const orders = { ...github, project: 'acme/orders' }
const nota = { ...github, project: 'acme/nota' }

const labeled = [
  { ...issues[0], labels: ['bug', 'ui'] },
  { ...issues[1], labels: ['docs'] },
  { name: 'GitHub #9', number: 9, title: 'Без меток', url: 'https://github.com/acme/orders/issues/9', labels: [] },
]

const notaIssues = [{ name: 'GitHub #3', number: 3, title: 'Экспорт в PDF', url: 'https://github.com/acme/nota/issues/3', labels: ['bug'] }]

function stubLabeled() {
  const fetchMock = stubFetch([{ ...backlogs[0], tracker: orders }, { ...backlogs[1], tracker: nota }])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: labeled, problem: null, labels: ['bug', 'docs', 'enhancement', 'ui'] }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: notaIssues, problem: null, labels: ['bug', 'export'] }))
  return fetchMock
}

const links = () => screen.queryAllByRole('link').map((link) => link.querySelector('.tracker-num')?.textContent)

const option = (project: string, name: string) =>
  within(screen.getByRole('group', { name: project })).getByRole('option', { name })

test('список «Метки» при всех проектах — все метки репозиториев по проектам с подписями', async () => {
  onTrackerTab()
  stubLabeled()

  render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  const button = screen.getByRole('button', { name: 'Метки' })
  expect(button).toHaveAttribute('aria-expanded', 'false')

  fireEvent.click(button)
  const list = within(screen.getByRole('listbox', { name: 'Метки' }))
  const groups = list.getAllByRole('group')
  expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Agents Kit Web', 'Nota'])
  // Метка, которой нет ни у одной задачи, в списке тоже есть: перечень — метки репозитория
  expect(within(groups[0]).getAllByRole('option').map((o) => o.textContent)).toEqual(['bug', 'docs', 'enhancement', 'ui'])
  expect(within(groups[1]).getAllByRole('option').map((o) => o.textContent)).toEqual(['bug', 'export'])
  expect(list.getAllByRole('option').every((o) => o.getAttribute('aria-selected') === 'false')).toBe(true)
})

test('метки отбирают задачи с любой из выбранных; метка выбирается у своего проекта; снятая — снова все', async () => {
  onTrackerTab()
  stubLabeled()

  render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))

  fireEvent.click(option('Agents Kit Web', 'bug'))
  expect(option('Agents Kit Web', 'bug')).toHaveAttribute('aria-selected', 'true')
  expect(option('Nota', 'bug')).toHaveAttribute('aria-selected', 'false')
  // bug выбрана у Agents Kit Web: bug проекта Nota не в счёт, и Nota, где ничего не подошло, скрыт
  expect(links()).toEqual(['#52'])
  expect(screen.queryByRole('region', { name: 'Nota' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Метки: bug' })).toHaveClass('has-picked')

  fireEvent.click(option('Agents Kit Web', 'docs'))
  expect(links()).toEqual(['#52', '#7'])
  fireEvent.click(option('Nota', 'bug'))
  expect(links()).toEqual(['#52', '#7', '#3'])
  expect(screen.getByRole('button', { name: 'Метки: bug, docs, bug' })).toBeInTheDocument()

  // Метка, которой нет ни у одной задачи, — под фильтр задач нет
  for (const [project, name] of [['Agents Kit Web', 'bug'], ['Agents Kit Web', 'docs'], ['Nota', 'bug']]) fireEvent.click(option(project, name))
  fireEvent.click(option('Agents Kit Web', 'enhancement'))
  expect(links()).toEqual([])
  expect(screen.getByText('Под фильтр задач нет')).toBeInTheDocument()

  fireEvent.click(option('Agents Kit Web', 'enhancement'))
  expect(links()).toEqual(['#52', '#7', '#9', '#3'])
  expect(screen.getByRole('button', { name: 'Метки' })).not.toHaveClass('has-picked')
})

test('на кнопке — названия первых трёх выбранных меток, остальные плашкой «+N»', async () => {
  onTrackerTab()
  stubLabeled()

  render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  for (const name of ['bug', 'docs', 'enhancement', 'ui']) fireEvent.click(option('Agents Kit Web', name))

  const button = screen.getByRole('button', { name: 'Метки: bug, docs, enhancement, ui' })
  expect(button.querySelector('.lbl-names')).toHaveTextContent('bug, docs, enhancement')
  expect(button.querySelector('.lbl-more')).toHaveTextContent('+1')
})

test('список закрывается Escape и кликом мимо, фокус возвращается кнопке', async () => {
  onTrackerTab()
  stubLabeled()

  render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  const button = screen.getByRole('button', { name: 'Метки' })

  fireEvent.click(button)
  fireEvent.keyDown(option('Agents Kit Web', 'bug'), { key: 'Escape' })
  expect(screen.queryByRole('listbox', { name: 'Метки' })).not.toBeInTheDocument()
  expect(button).toHaveFocus()

  fireEvent.click(button)
  fireEvent.mouseDown(document.body)
  expect(screen.queryByRole('listbox', { name: 'Метки' })).not.toBeInTheDocument()
})

test('при выбранном проекте — его метки без подписи; метки другого проекта выбраны, но не отбирают', async () => {
  onTrackerTab()
  stubLabeled()

  render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  fireEvent.click(option('Agents Kit Web', 'docs'))
  expect(links()).toEqual(['#7'])

  fireEvent.mouseDown(document.body)
  fireEvent.click(screen.getByRole('button', { name: 'Nota' }))
  expect(links()).toEqual(['#3'])
  const button = screen.getByRole('button', { name: 'Метки' })
  fireEvent.click(button)
  const list = within(screen.getByRole('listbox', { name: 'Метки' }))
  expect(list.queryByText('Nota')).not.toBeInTheDocument()
  expect(list.getAllByRole('option').map((o) => o.textContent)).toEqual(['bug', 'export'])

  fireEvent.click(screen.getByRole('button', { name: 'Все проекты' }))
  expect(links()).toEqual(['#7'])
  expect(screen.getByRole('button', { name: 'Метки: docs' })).toBeInTheDocument()
})

test('выбранные метки помнятся между открытиями раздела', async () => {
  onTrackerTab()
  stubLabeled()

  const { unmount } = render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  fireEvent.click(option('Nota', 'export'))
  unmount()

  render(<Backlog />)
  expect(await screen.findByRole('button', { name: 'Метки: export' })).toBeInTheDocument()
})

test('выбранные метки не прячут проект, пока его трекер читается или не прочитан: видны заготовка и строка причины', async () => {
  onTrackerTab()
  const fetchMock = stubLabeled()
  const first = render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  fireEvent.click(option('Agents Kit Web', 'docs'))
  first.unmount()

  // Вернулись в раздел: трекер Agents Kit Web читается заново, а gh у Nota не вошла в аккаунт
  let reply: (response: Response) => void = () => {}
  fetchMock.setTracker(backlogs[0].base, () => new Promise<Response>((resolve) => (reply = resolve)))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: [], problem: 'gh-login' }))
  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('status', { name: 'Загрузка задач трекера' })).toBeInTheDocument()
  expect(await screen.findByText(/Программа gh не вошла в аккаунт/)).toBeInTheDocument()
  expect(screen.queryByText('Под фильтр задач нет')).not.toBeInTheDocument()

  // Прочитан — метка снова отбирает и стоит на кнопке, её можно снять
  reply(Response.json({ issues: labeled, problem: null, labels: ['bug', 'docs', 'enhancement', 'ui'] }))
  expect(await screen.findByRole('button', { name: 'Метки: docs' })).toBeInTheDocument()
  expect(links()).toEqual(['#7'])
})

test('метка, которой больше нет в репозитории, не отбирает и не стоит на кнопке', async () => {
  onTrackerTab()
  const fetchMock = stubLabeled()
  const first = render(<Backlog />)
  await screen.findByRole('link', { name: /#3 / })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  fireEvent.click(option('Agents Kit Web', 'enhancement'))
  expect(links()).toEqual([])
  first.unmount()

  fetchMock.setTracker(backlogs[0].base, answer({ issues: labeled, problem: null, labels: ['bug', 'docs', 'ui'] }))
  render(<Backlog />)

  await screen.findByRole('link', { name: /#3 / })
  expect(links()).toEqual(['#52', '#7', '#9', '#3'])
  expect(screen.getByRole('button', { name: 'Метки' })).not.toHaveClass('has-picked')
})

test('меток репозитория не прочли — в списке метки задач; у YouTrack кнопки «Метки» нет', async () => {
  onTrackerTab()
  const fetchMock = stubFetch([{ ...backlogs[0], tracker: orders }, { ...backlogs[1], tracker: youTrack }])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: labeled, problem: null, labels: null }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: ytIssues, problem: null }))

  render(<Backlog />)
  await screen.findByRole('link', { name: /ABC-7/ })
  fireEvent.click(screen.getByRole('button', { name: 'Метки' }))
  // Проект с метками один — список без подписей
  expect(within(screen.getByRole('listbox', { name: 'Метки' })).getAllByRole('option').map((o) => o.textContent)).toEqual([
    'bug', 'docs', 'ui',
  ])

  fireEvent.click(screen.getByRole('button', { name: 'Nota' }))
  expect(screen.queryByRole('button', { name: /^Метки/ })).not.toBeInTheDocument()
})

test('«Взять задачу» у задачи трекера запускает её по имени «GitHub #N» тем же окном', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  const onStarted = vi.fn()

  render(<Backlog onStarted={onStarted} />)
  const row = (await screen.findByRole('link', { name: /#52/ })).closest('.entry-row')!
  const start = within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })
  await waitFor(() => expect(start).toBeEnabled())
  fireEvent.click(start)

  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  expect(within(dialog).getByText('Задача трекера')).toBeInTheDocument()
  expect(dialog).toHaveTextContent('GitHub #52')
  expect(dialog).toHaveTextContent('Панель не стартует с пробелом в пути')
  fireEvent.click(await within(dialog).findByRole('radio', { name: /noble-keen-walrus/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() => expect(onStarted).toHaveBeenCalledWith('noble-keen-walrus'))
  expect(fetchMock.posts).toEqual([
    { base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\noble-keen-walrus', number: 'GitHub #52', flow: 'полный' },
  ])
  // Фокус — на строке задачи: её кнопка погаснет, когда раздел узнает, что задача взята (B-89)
  expect(within(row as HTMLElement).getByRole('link', { name: /#52/ })).toHaveFocus()
  // Бэклог после запуска перечитывается, а трекер — только при открытии раздела и по «Обновить»
  await waitFor(() => expect(fetchMock.backlogReads()).toBe(2))
  expect(fetchMock.trackerReads()).toBe(1)
})

// ——— Задачи YouTrack (B-288) ———

const youTrack = { kind: 'youtrack' as const, name: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'ABC' }

const ytIssues = [
  { name: 'YouTrack ABC-7', number: 7, title: 'Письмо о сбросе пароля уходит без ссылки', url: 'https://acme.youtrack.cloud/issue/ABC-7' },
  { name: 'YouTrack ABC-1287', number: 1287, title: 'Перевести отчёты на новую схему налогов', url: 'https://acme.youtrack.cloud/issue/ABC-1287' },
]

test('у проекта с трекером YouTrack — его задачи с номерами вида ABC-12 ссылками на YouTrack', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(youTrack))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: ytIssues, problem: null }))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const link = await project.findByRole('link', { name: /^ABC-7 Письмо о сбросе пароля уходит без ссылки/ })
  expect(link).toHaveAttribute('href', 'https://acme.youtrack.cloud/issue/ABC-7')
  expect(link).toHaveAttribute('title', 'Открыть YouTrack ABC-7 во вкладке браузера')
  // Колонка номера — по самому длинному номеру
  expect(link.closest('.tracker-issues')).toHaveStyle({ '--entry-num-width': '8ch' })
  expect(project.getByRole('link', { name: /^ABC-1287 / })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(1)
})

test('поиск находит задачи YouTrack по номеру без имени трекера', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(youTrack))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: ytIssues, problem: null }))

  render(<Backlog />)
  await screen.findByRole('link', { name: /ABC-7/ })

  fireEvent.change(screen.getByRole('textbox', { name: 'Поиск' }), { target: { value: 'abc-1287' } })

  expect(screen.getByRole('link', { name: /ABC-1287/ })).toBeInTheDocument()
  expect(screen.queryByRole('link', { name: /ABC-7 / })).not.toBeInTheDocument()
})

test.each([
  [{ issues: [], problem: null }, /^В YouTrack нет незакрытых задач этого проекта\.$/, false],
  [
    { issues: [], problem: 'no-key' },
    /^Для сервера https:\/\/acme\.youtrack\.cloud нет ключа\. Добавьте сервер и ключ в разделе «Трекеры», в списке «Серверы трекеров»\.$/,
    true,
  ],
  [
    { issues: [], problem: 'key-rejected' },
    /^Сервер https:\/\/acme\.youtrack\.cloud отклонил ключ\. Замените ключ в разделе «Трекеры», в списке «Серверы трекеров»\.$/,
    true,
  ],
  [
    { issues: [], problem: 'key-unreadable' },
    /^Ключ сервера https:\/\/acme\.youtrack\.cloud не прочитать на этом компьютере\. Замените ключ в разделе «Трекеры», в списке «Серверы трекеров»\.$/,
    true,
  ],
  [
    { issues: [], problem: 'key-forbidden' },
    /^Сервер https:\/\/acme\.youtrack\.cloud принял ключ, но у его владельца нет прав на проект ABC\. Проверьте права владельца ключа в YouTrack\.$/,
    true,
  ],
  [
    { issues: [], problem: 'server-silent', detail: 'истекло время ожидания' },
    /^Сервер https:\/\/acme\.youtrack\.cloud не ответил: истекло время ожидания\. Проверьте адрес сервера в описании трекера проекта и подключение к сети\.$/,
    true,
  ],
  [
    { issues: [], problem: 'project-missing' },
    /^На сервере https:\/\/acme\.youtrack\.cloud нет проекта ABC или у вашего ключа нет к нему доступа\. Проверьте строку «проект:» в описании трекера проекта\.$/,
    true,
  ],
  [{ issues: [], problem: 'youtrack-error', detail: 'Сервер на обслуживании' }, /^YouTrack ответил ошибкой: Сервер на обслуживании\.$/, true],
])('ответ YouTrack %o — своей строкой на месте задач', async (reply, text, warning) => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(youTrack))
  fetchMock.setTracker(backlogs[0].base, answer(reply))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const line = (await project.findByText((_, el) => el?.matches('p.tracker-state > span') === true && text.test(el.textContent))).closest('p')!
  expect(line).toHaveClass(warning ? 'warning-text' : 'text-sec')
})

// Критерий 4 B-323: и причина ключа ведёт в раздел «Трекеры», где стоят серверы с ключами.
test('строка о ключе сервера ведёт в раздел «Трекеры» к серверам трекеров', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(youTrack))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [], problem: 'no-key' }))
  const onTrackers = vi.fn()

  render(<Backlog onTrackers={onTrackers} />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  fireEvent.click(await project.findByRole('button', { name: '«Трекеры»' }))
  expect(onTrackers).toHaveBeenCalledExactlyOnceWith(backlogs[0].base, true)
})

// B-300: отбор задан — пустой список называет его, а отказ трекера на него ведёт в раздел «Трекеры».
test.each([
  [youTrack, 'State: {To Do}', { issues: [], problem: null }, /^По фильтру State: \{To Do\} в YouTrack сейчас нет задач этого проекта\.$/, false],
  [
    youTrack,
    'State: {To Do}',
    { issues: [], problem: 'filter-rejected', detail: 'Unknown field "Stat"' },
    /^YouTrack не принял фильтр State: \{To Do\}: Unknown field "Stat"\. Исправьте его в разделе «Трекеры»\.$/,
    true,
  ],
  [github, 'label:bug', { issues: [], problem: null }, /^По фильтру label:bug в GitHub сейчас нет открытых задач этого репозитория\.$/, false],
])('отбор задан, трекер %o, фильтр %s, ответ %o — своей строкой на месте задач', async (tracker, filter, reply, text, warning) => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker({ ...tracker, filter }))
  fetchMock.setTracker(backlogs[0].base, answer(reply))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  const line = (await project.findByText((_, el) => el?.matches('p.tracker-state > span') === true && text.test(el.textContent))).closest('p')!
  expect(line).toHaveClass(warning ? 'warning-text' : 'text-sec')
  expect(within(line).getByText(filter).tagName).toBe('CODE')
})

test('отбор задан, задачи есть — группа как без отбора, фильтр не назван', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker({ ...youTrack, filter: 'State: {To Do}' }))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: ytIssues, problem: null }))

  render(<Backlog />)

  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await project.findByRole('link', { name: /ABC-7/ })
  expect(project.queryByText(/State: \{To Do\}/)).not.toBeInTheDocument()
})

test('«Взять задачу» у задачи YouTrack запускает её по имени «YouTrack ABC-N»', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(youTrack))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: ytIssues, problem: null }))

  render(<Backlog onStarted={vi.fn()} />)
  const row = (await screen.findByRole('link', { name: /ABC-7/ })).closest('.entry-row')!
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' }))

  const dialog = screen.getByRole('dialog', { name: 'Взять задачу в работу' })
  expect(within(dialog).getByText('Задача трекера')).toBeInTheDocument()
  expect(dialog).toHaveTextContent('YouTrack ABC-7')
  fireEvent.click(await within(dialog).findByRole('radio', { name: /noble-keen-walrus/ }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Взять в работу' }))

  await waitFor(() =>
    expect(fetchMock.posts).toEqual([
      { base: 'D:\\Projects\\app-knowledge', copy: 'D:\\Projects\\noble-keen-walrus', number: 'YouTrack ABC-7', flow: 'полный' },
    ]),
  )
})

test('«В трекер» есть и у записей проекта с YouTrack, а у проекта с Jira — нет', async () => {
  const fetchMock = stubFetch([
    { ...backlogs[0], tracker: youTrack },
    { ...backlogs[1], tracker: { kind: 'other', name: 'Jira' } },
  ])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [], problem: null }))

  render(<Backlog />)

  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest('.entry-row')!
  expect(within(row as HTMLElement).getByRole('button', { name: 'В трекер' })).toBeInTheDocument()
  const nota = within(screen.getByRole('region', { name: 'Nota' }))
  expect(nota.queryByRole('button', { name: 'В трекер' })).not.toBeInTheDocument()
})

// ——— Перенос записи в трекер (B-286) ———

test('«В трекер» — у записей с номером в проекте с трекером GitHub, между «Изменить» и «Взять задачу»', async () => {
  const fetchMock = stubFetch([
    { ...backlogs[0], entries: [...backlogs[0].entries, { number: null, title: 'Дописано руками', text: null }], tracker: github },
    { ...backlogs[1], tracker: { kind: 'no-keys' } },
  ])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [], problem: null }))

  render(<Backlog />)

  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest('.entry-row')!
  expect(within(row as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual([
    expect.stringContaining('B-1'),
    'Изменить',
    'В трекер',
    'Взять задачу',
  ])
  // У записи без номера кнопки нет: перенос адресует запись номером
  const bare = screen.getByRole('button', { name: /Дописано руками/ }).closest('.entry-row')!
  expect(within(bare as HTMLElement).queryByRole('button', { name: 'В трекер' })).not.toBeInTheDocument()
  // Трекер без адреса репозитория — переносить некуда
  const nota = within(screen.getByRole('region', { name: 'Nota' }))
  expect(nota.queryByRole('button', { name: 'В трекер' })).not.toBeInTheDocument()
})

test('у базы нового формата «В трекер» погашена с причиной, как «Изменить» (B-281)', async () => {
  const refusal = 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.'
  const fetchMock = stubFetch([
    { ...backlogs[0], tracker: github, formatWarning: 'Кит перевёл базу на формат, которого эта версия панели не знает.' },
    backlogs[1],
  ])
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [], problem: null }))

  render(<Backlog />)
  const row = (await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).closest('.entry-row')!

  const send = within(row as HTMLElement).getByRole('button', { name: 'В трекер' })
  expect(send).toBeDisabled()
  expect(send).toHaveAttribute('title', refusal)
})

test('у проекта без трекера кнопки «В трекер» нет', async () => {
  stubFetch(backlogs)

  render(<Backlog />)
  await screen.findByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })

  expect(screen.queryByRole('button', { name: 'В трекер' })).not.toBeInTheDocument()
})

const moved = { name: 'GitHub #58', number: 58, title: 'Заголовок', url: 'https://github.com/acme/orders/issues/58' }

/** Сколько раз читали задачи трекера одной базы. */
const trackerReadsOf = (fetchMock: ReturnType<typeof stubFetch>, base: string) =>
  fetchMock.mock.calls.filter(([url]) => url === `/api/backlog/tracker?base=${encodeURIComponent(base)}`).length

test('перенос из строки записи заводит задачу и перечитывает бэклог и трекер своей базы', async () => {
  const other = { ...github, project: 'acme/notes' }
  const fetchMock = stubFetch(
    [{ ...backlogs[0], tracker: github }, { ...backlogs[1], tracker: other }],
    [{ ...backlogs[0], entries: [backlogs[0].entries[1]], tracker: github }, { ...backlogs[1], tracker: other }],
  )
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: [], problem: null }))

  render(<Backlog />)
  const entries = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await waitFor(() => expect(trackerReadsOf(fetchMock, backlogs[0].base)).toBe(1))

  // Трекер после переноса отвечает не сразу: пока он читается, на месте его задач — заготовка, как по «Обновить»
  let reply: (response: Response) => void = () => {}
  fetchMock.setTracker(backlogs[0].base, () => new Promise<Response>((resolve) => (reply = resolve)))
  const row = entries.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ }).closest('.entry-row')!
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'В трекер' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Перенести в трекер' }))
  fireEvent.click(await dialog.findByRole('button', { name: 'Перевести задачу' }))

  expect(await screen.findByRole('dialog', { name: 'Задача заведена' })).toBeInTheDocument()
  expect(fetchMock.posts).toContainEqual({ base: backlogs[0].base, number: 'B-1', original: '## B-1 Заголовок' })
  await waitFor(() =>
    expect(entries.queryByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).not.toBeInTheDocument(),
  )

  // Заведённая задача — на вкладке задач трекера (B-305)
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('status', { name: 'Загрузка задач трекера' })).toBeInTheDocument()
  expect(project.queryByRole('link', { name: /#52/ })).not.toBeInTheDocument()

  reply(Response.json({ issues: [moved, ...issues], problem: null }))
  expect(await project.findByRole('link', { name: /#58 Заголовок/ })).toBeInTheDocument()
  expect(project.getByRole('link', { name: /#52/ })).toBeInTheDocument()
  expect(project.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
  expect(fetchMock.backlogReads()).toBe(2)
  expect(trackerReadsOf(fetchMock, backlogs[0].base)).toBe(2)
  // Трекер другого проекта перенос не трогает
  expect(trackerReadsOf(fetchMock, backlogs[1].base)).toBe(1)
})

/**
 * Раздел с трекером у первой базы и разговор Чудо-Юдо, который отдаёт события stream; saved — бэклог после
 * «Сохранить»: его отдаёт каждое чтение, кроме первого.
 */
function stubSaving(stream: object[], saved: BaseBacklog[] = withTracker(github)) {
  const body = new TextEncoder().encode(stream.map((event) => JSON.stringify(event) + '\n').join(''))
  let replies = [answer({ issues, problem: null })]
  // Заведённый разговор панель называет окну, открытому заново: оно показывает его на месте
  let talking = false
  const fetchMock = vi.fn((url: string) => {
    if (url === '/api/agent/requests')
      return Promise.resolve(Response.json(talking ? [runningRequest('backlog', 'Мысль', backlogs[0].base, backlogs[0].project)] : []))
    if (url === '/api/backlog/write') {
      talking = true
      return Promise.resolve(
        Response.json({ kind: 'backlog', id: 'r1', base: backlogs[0].base, project: backlogs[0].project, text: 'Мысль', elapsedMs: 0, state: 'running' }),
      )
    }
    if (url.startsWith('/api/agent/backlog/stream')) return Promise.resolve(new Response(body))
    if (url === '/api/agent/backlog') return Promise.resolve(new Response(null, { status: 204 }))
    if (url.startsWith('/api/backlog/tracker?')) return (replies.length > 1 ? replies.shift()! : replies[0])()
    if (url === '/api/workspaces') return Promise.resolve(Response.json([]))
    expect(url).toBe('/api/backlog')
    const reads = fetchMock.mock.calls.filter(([u]) => u === '/api/backlog').length
    return Promise.resolve(Response.json(reads > 1 ? saved : withTracker(github)))
  })
  vi.stubGlobal('fetch', fetchMock)
  return Object.assign(fetchMock, {
    trackerReads: () => fetchMock.mock.calls.filter(([url]) => url.startsWith('/api/backlog/tracker?')).length,
    setTracker: (next: ReturnType<typeof answer>[]) => {
      replies = next
    },
  })
}

/** Просьба к Чудо-Юдо с вкладки задач трекера: на ней видно, что стало с задачами (B-305). */
async function saySaving() {
  fireEvent.click(await screen.findByRole('tab', { name: 'Задачи трекера' }))
  const project = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await project.findByRole('link', { name: /#52/ })
  fireEvent.click(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Чудо-Юдо' }))
  fireEvent.change(await dialog.findByLabelText('Просьба к Чудо-Юдо'), { target: { value: 'Мысль' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))
  return { project, dialog }
}

test('«Сохранить» Чудо-Юдо с переносом в трекер перечитывает трекер базы и показывает заведённую задачу', async () => {
  const fetchMock = stubSaving([
    { type: 'reply', text: 'Мысль' },
    { type: 'saved', text: '', commit: 'c0ffee1', proposalId: 'p1', issues: { 'B-1': moved } },
  ])
  let reply: (response: Response) => void = () => {}
  fetchMock.setTracker([answer({ issues, problem: null }), () => new Promise<Response>((resolve) => (reply = resolve))])

  const view = render(<Backlog />)
  const { project, dialog } = await saySaving()

  // Пока трекер читается — заготовка на месте его задач
  expect(await project.findByRole('status', { name: 'Загрузка задач трекера' })).toBeInTheDocument()
  reply(Response.json({ issues: [moved, ...issues], problem: null }))
  expect(await project.findByRole('link', { name: /#58 Заголовок/ })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(2)

  // Окно, открытое заново, называет ту же задачу: бэклог перечитывается снова, а трекер — нет
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/backlog').length).toBe(3)
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  fireEvent.click(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' }))
  await within(await screen.findByRole('dialog', { name: 'Чудо-Юдо' })).findByText('Мысль')
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/backlog').length).toBe(4))
  expect(project.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(2)

  // Ушли в другой раздел и вернулись: раздел читает трекер при открытии, а окно с тем же разговором — уже нет
  fetchMock.setTracker([answer({ issues: [moved, ...issues], problem: null })])
  view.unmount()
  render(<Backlog />)
  const again = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await again.findByRole('link', { name: /#58 Заголовок/ })
  expect(fetchMock.trackerReads()).toBe(3)
  fireEvent.click(screen.getByRole('button', { name: 'Попросить Чудо-Юдо' }))
  await within(await screen.findByRole('dialog', { name: 'Чудо-Юдо' })).findByText('Мысль')
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/backlog').length).toBe(6))
  expect(again.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(3)
})

test('«Сохранить» Чудо-Юдо без переноса трекер не перечитывает', async () => {
  const fetchMock = stubSaving(
    [
      { type: 'reply', text: 'Мысль' },
      { type: 'saved', text: '', commit: 'c0ffee1', proposalId: 'p1' },
    ],
    [{ ...backlogs[0], entries: [backlogs[0].entries[1]], tracker: github }, backlogs[1]],
  )

  render(<Backlog />)
  await saySaving()

  // Раздел перечитал бэклог после «Сохранить» — удалённой записи на вкладке записей нет; трекер он решает перечитывать
  // тем же ходом, что показывает бэклог (decisions/tests.md, B-183)
  fireEvent.click(screen.getByRole('tab', { name: 'Записи бэклога' }))
  const entries = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  await waitFor(() => expect(entries.queryByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).not.toBeInTheDocument())

  // А трекер остался как был
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(project.queryByRole('status', { name: 'Загрузка задач трекера' })).not.toBeInTheDocument()
  expect(project.getByRole('link', { name: /#52/ })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(1)
})

test('ответ чтения трекера при открытии, пришедший после перечитывания переносом, не затирает заведённую задачу', async () => {
  const fetchMock = stubFetch(withTracker(github), [{ ...backlogs[0], entries: [backlogs[0].entries[1]], tracker: github }, backlogs[1]])
  let late: (response: Response) => void = () => {}
  fetchMock.setTracker(backlogs[0].base, () => new Promise<Response>((resolve) => (late = resolve)))

  render(<Backlog />)
  const entries = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  // Трекер ещё читается с открытия раздела, а запись уже переносят
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [moved, ...issues], problem: null }))
  const row = entries.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ }).closest('.entry-row')!
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'В трекер' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Перенести в трекер' }))
  fireEvent.click(await dialog.findByRole('button', { name: 'Перевести задачу' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('link', { name: /#58 Заголовок/ })).toBeInTheDocument()

  // Запоздавший ответ разобран, и ход раздела после разбора прошёл (decisions/tests.md, B-183)
  const stale = Response.json({ issues, problem: null })
  const parsed = vi.spyOn(stale, 'json')
  late(stale)
  await waitFor(() => expect(parsed).toHaveBeenCalled())
  await act(async () => {
    await parsed.mock.results[0].value
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  expect(project.getByRole('link', { name: /#58 Заголовок/ })).toBeInTheDocument()
  expect(fetchMock.trackerReads()).toBe(2)
})

test('задача заведена, а запись не вырезалась — трекер всё равно перечитывается и показывает задачу рядом с записью', async () => {
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  fetchMock.setMoveReply(
    Response.json({ issue: moved, error: 'Запись не вырезана: backlog.md правили в другом месте.', output: null, removed: [] }),
  )

  render(<Backlog />)
  const entries = within(await screen.findByRole('region', { name: 'Agents Kit Web' }))
  await waitFor(() => expect(fetchMock.trackerReads()).toBe(1))
  fetchMock.setTracker(backlogs[0].base, answer({ issues: [moved, ...issues], problem: null }))

  const row = entries.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ }).closest('.entry-row')!
  fireEvent.click(within(row as HTMLElement).getByRole('button', { name: 'В трекер' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Перенести в трекер' }))
  fireEvent.click(await dialog.findByRole('button', { name: 'Перевести задачу' }))

  await waitFor(() => expect(fetchMock.trackerReads()).toBe(2))
  expect(entries.getByRole('button', { name: /B-1 Панель показывает проблемы баз знаний/ })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('tab', { name: 'Задачи трекера' }))
  const project = within(screen.getByRole('region', { name: 'Agents Kit Web' }))
  expect(await project.findByRole('link', { name: /#58 Заголовок/ })).toBeInTheDocument()
})

test('у задачи трекера «Взять задачу» погашена, когда свободной копии нет', async () => {
  onTrackerTab()
  const fetchMock = stubFetch([{ ...backlogs[0], tracker: github }, { ...backlogs[1], tracker: github }])
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  fetchMock.setTracker(backlogs[1].base, answer({ issues: [{ ...issues[1], name: 'GitHub #8', number: 8 }], problem: null }))
  fetchMock.setCopies([
    copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\noble-keen-walrus', 'in-work'),
    copy('D:\\Projects\\nota-knowledge', 'D:\\Projects\\nota-copy', 'free'),
  ])

  render(<Backlog />)
  const row = (await screen.findByRole('link', { name: /#52/ })).closest('.entry-row')!
  // Кнопка погашена и до прочтения копий: сперва дождаться, что они прочитаны, — у Nota свободная копия есть
  const nota = (await screen.findByRole('link', { name: /#8 / })).closest('.entry-row')!
  await waitFor(() => expect(within(nota as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeEnabled())

  expect(within(row as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeDisabled()
})

test('у задачи трекера, которая уже идёт в копии, «Взять задачу» погашена всё время работы — B-89', async () => {
  onTrackerTab()
  const fetchMock = stubFetch(withTracker(github))
  fetchMock.setTracker(backlogs[0].base, answer({ issues, problem: null }))
  fetchMock.setCopies([
    copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\noble-keen-walrus', 'free'),
    { ...copy('D:\\Projects\\app-knowledge', 'D:\\Projects\\brave-quiet-otter', 'waiting'), task: 'GitHub #52 Панель не стартует с пробелом в пути' },
  ])

  render(<Backlog />)
  const taken = (await screen.findByRole('link', { name: /#52/ })).closest('.entry-row')!
  const other = screen.getByRole('link', { name: /#7/ }).closest('.entry-row')!

  await waitFor(() => expect(within(other as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeEnabled())
  expect(within(taken as HTMLElement).getByRole('button', { name: 'Взять задачу' })).toBeDisabled()
})

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import Reports, { type FlowReport, type FlowReportItem, type ReportSchedule } from './Reports'
import { controlledStream, runningRequest, stubPanel, type PanelStub } from './agentPanelTesting'

// Прокрутки к элементу у jsdom нет: переход к строке-близнецу и к кольцу проверяется по вызову.
const scrolled = vi.fn()
beforeEach(() => {
  Element.prototype.scrollIntoView = scrolled
})

afterEach(() => {
  vi.unstubAllGlobals()
  scrolled.mockReset()
  delete (Element.prototype as Partial<Element>).scrollIntoView
})

type ReportEvent = { type: string; text: string; output?: string }

const requirements: FlowReport['requirements'] = [
  { code: 'П1', ring: 'Проходимость', priority: 'high', title: 'Каждый исход куда-то ведёт', text: 'У каждого исхода есть продолжение.' },
  { code: 'П5', ring: 'Проходимость', priority: 'medium', title: 'Нужное дальше — выходом', text: 'Нужное дальше этап отдаёт выходом.' },
  { code: 'П6', ring: 'Проходимость', priority: 'high', title: 'Задача не теряет себя', text: 'Этап не отправляет недоделанное в бэклог.' },
  { code: 'С1', ring: 'Согласованность', priority: 'high', title: 'Флоу себе не противоречит', text: 'Этап не противоречит себе.' },
  { code: 'Я4', ring: 'Ясность', priority: 'low', title: 'Во флоу только порядок работы', text: 'Во флоу нет устройства системы.' },
]

const report: FlowReport = {
  built: new Date(2026, 8, 26, 12, 30).toISOString(),
  checked: new Date(2026, 8, 28, 9, 0).toISOString(),
  rings: [
    { name: 'Проходимость', score: 55, band: 'avg', total: 3, passed: 0 },
    { name: 'Согласованность', score: 85, band: 'avg', total: 1, passed: 0 },
    { name: 'Ясность', score: 100, band: 'pass', total: 1, passed: 1 },
  ],
  requirements,
  findings: [
    {
      id: '1',
      requirements: ['П1'],
      place: 'Мерж',
      quotes: [{ where: 'Мерж, описание', text: '«Если приёмки не было — спросить „принято“.»' }],
      why: 'При ответе «не принято» у задачи нет продолжения.',
      fix: 'Добавить этапу «Мерж» возврат на этап «Реализация».',
    },
    {
      id: '2',
      requirements: ['П6', 'С1'],
      place: 'Ревью',
      quotes: [],
      why: 'Этап запрещает переносить внесённое задачей в бэклог и тут же разрешает.',
      fix: 'Заменить перенос в бэклог вопросом оператору.',
    },
    { id: '3', requirements: ['П5'], place: 'Дизайн', quotes: [], why: 'Ссылка на макет остаётся в переписке.', fix: 'Указать ссылку в выходе.' },
  ],
  discussions: [
    { title: 'Разделить ли этап «Мерж»', place: 'Мерж', now: 'Один этап.', for: 'Проще проверять.', against: 'Больше отметок.' },
  ],
}

const off: ReportSchedule = { enabled: false, days: [], hour: 9 }

const item = (overrides: Partial<FlowReportItem> = {}): FlowReportItem => ({
  base: 'D:\\kb\\app',
  project: 'Agents Kit Web',
  schedule: off,
  report,
  blocked: null,
  ...overrides,
})

/** Раздел с просьбой разбора: список отчётов отвечает тем, что задал тест, а расписание пишется в puts. */
function stub(list: () => FlowReportItem[], options: { running?: boolean; run?: number } = {}) {
  const stream = controlledStream<ReportEvent>()
  const puts: Record<string, unknown>[] = []
  const others: PanelStub['others'] = (url, init) => {
    if (url === '/api/reports/flow') return Response.json(list())
    if (url === '/api/reports/flow/schedule') {
      puts.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return Response.json(off)
    }
    if (url === '/api/reports/flow/run' && options.run) return new Response(null, { status: options.run })
    // Окно переписывания поверх отчёта читает флоу и исполнителей проекта, как раздел «Флоу».
    if (url === '/api/flow')
      return Response.json([
        { base: 'D:\\kb\\app', project: 'Agents Kit Web', stages: [], flows: [], version: 'v1', error: null, icons: {}, tasks: [] },
      ])
    if (url === '/api/performers') return Response.json([])
    return null
  }
  const panel = stubPanel('report', stream, {
    project: 'Agents Kit Web',
    others,
    running: options.running ? runningRequest('report', 'Разбор флоу', 'D:\\kb\\app', 'Agents Kit Web', 61000) : undefined,
  })
  return { stream, puts, panel }
}

function renderReports(onProblems = vi.fn()) {
  render(<Reports onProblems={onProblems} />)
  return { onProblems }
}

test('пока отчёты читаются, на месте выбора проекта заготовка, а заголовок и вид отчёта уже на месте', async () => {
  let answer: () => void = () => {}
  stub(() => [item()])
  const listed = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url === '/api/reports/flow'
        ? new Promise<Response>((resolve) => (answer = () => resolve(Response.json([item()]))))
        : listed(url, init),
    ),
  )
  renderReports()

  expect(screen.getByRole('heading', { name: 'Отчёты' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Вид отчёта: Как устроен флоу' })).toBeTruthy()
  expect(screen.queryByRole('button', { name: /^Проект:/ })).toBeNull()
  // Полоса держит место, но скрыта от диктора и видна, только если чтение затянулось (decisions/loading.md).
  const bar = document.querySelector('.rp-head .sk')!
  expect(bar.closest('[aria-hidden="true"]')).not.toBeNull()
  expect(bar.closest('.sk-wait')).not.toBeNull()
  await waitFor(() => expect(bar.closest('.sk-wait')).toBeNull())

  answer()

  expect(await screen.findByRole('button', { name: 'Проект: Agents Kit Web' })).toBeTruthy()
  expect(document.querySelector('.rp-head .sk')).toBeNull()
})

test('раздел показывает вид отчёта, проект, кольца и находки по приоритету без номеров требований', async () => {
  stub(() => [item()])

  renderReports()

  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Отчёты' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Вид отчёта: Как устроен флоу' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Проект: Agents Kit Web' })).toBeTruthy()
  expect(screen.getByText('Высокий приоритет')).toBeTruthy()
  expect(screen.getByText('Средний приоритет')).toBeTruthy()
  // Номеров требований нет — замечание оператора к макету.
  expect(document.body.textContent).not.toMatch(/П1|П6|С1/)
  // Чисел у заголовков групп нет.
  expect(screen.getByText('Высокий приоритет').textContent).toBe('Высокий приоритет')
  expect(screen.getByText('Разделить ли этап «Мерж»')).toBeTruthy()
})

test('находка под двумя требованиями стоит двумя строками, и ссылка раскрывает вторую', async () => {
  stub(() => [item()])
  renderReports()

  const tags = await screen.findAllByText(/одно исправление с/)
  expect(tags.map((tag) => tag.textContent)).toEqual([
    'одно исправление с «Флоу себе не противоречит»',
    'одно исправление с «Задача не теряет себя»',
  ])

  const first = tags[0].closest('details')!
  fireEvent.click(within(first).getByText('Задача не теряет себя'))
  await waitFor(() => expect(first.open).toBe(true))
  fireEvent.click(within(first).getByRole('button', { name: 'Показать строку' }))

  const twin = tags[1].closest('details')!
  await waitFor(() => expect(twin.open).toBe(true))
  expect(twin.className).toContain('is-lit')
  expect(scrolled.mock.contexts.at(-1)).toBe(twin)
})

test('раскрытая находка говорит, что проверяет требование, где проблема, почему и что сделать', async () => {
  stub(() => [item()])
  renderReports()

  const row = (await screen.findByText('Каждый исход куда-то ведёт')).closest('details')!
  fireEvent.click(within(row).getByText('Каждый исход куда-то ведёт'))

  await waitFor(() => expect(row.open).toBe(true))
  expect(within(row).getByText('У каждого исхода есть продолжение.')).toBeTruthy()
  expect(within(row).getByText('Мерж, описание')).toBeTruthy()
  expect(within(row).getByText('При ответе «не принято» у задачи нет продолжения.')).toBeTruthy()
  expect(within(row).getByText('Добавить этапу «Мерж» возврат на этап «Реализация».')).toBeTruthy()
  expect(within(row).getByText('Исправление вернёт кольцу «Проходимость» 15 баллов.')).toBeTruthy()

  // Окно встаёт поверх отчёта, как на макете, с просьбой по находке в поле; отправляет оператор.
  fireEvent.click(within(row).getByRole('button', { name: 'Переписать с Чудо-Юдо' }))
  const dialog = await screen.findByRole('dialog', { name: 'Переписать с Чудо-Юдо' })
  expect(within(dialog).getByLabelText('Просьба')).toHaveValue(
    'Прошу исправить находку отчёта «Как устроен флоу» по требованию «Каждый исход куда-то ведёт». Место во флоу: Мерж.' +
      '\n\nПри ответе «не принято» у задачи нет продолжения.' +
      '\n\nПредлагаемое исправление: Добавить этапу «Мерж» возврат на этап «Реализация».',
  )
  expect(screen.getByRole('heading', { name: 'Отчёты' })).toBeTruthy()

  // Закрытое окно уходит вместе с просьбой: открытое снова от другой находки несёт уже её.
  fireEvent.click(within(dialog).getByRole('button', { name: 'Закрыть' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Переписать с Чудо-Юдо' })).toBeNull())
})

test('код в формулировке требования показан моноширинным, без обратных кавычек', async () => {
  const withCode = {
    ...report,
    requirements: report.requirements.map((one) =>
      one.code === 'Я4' ? { ...one, text: 'Во флоу нет устройства системы (`product.md`, `decisions/`).' } : one,
    ),
  }
  stub(() => [item({ report: withCode })])
  renderReports()

  const passed = (await screen.findByText('Во флоу только порядок работы')).closest('.rp-passed-row')!
  expect(passed.textContent).not.toContain('`')
  expect(passed.querySelector('code')?.textContent).toBe('product.md')
})

test('код в ответе Чудо-Юдо — в месте находки, цитате и «Стоит обсудить» — тоже моноширинным', async () => {
  const withCode = {
    ...report,
    findings: [
      { ...report.findings[0], place: 'Этап `merge`', quotes: [{ where: 'Файл `stages/merge.md`', text: 'Строка `возврат:`' }] },
    ],
    discussions: [{ title: 'Делить ли `merge`', place: 'Мерж', now: 'Один `merge.md`.', for: 'Проще.', against: 'Дольше.' }],
  }
  stub(() => [item({ report: withCode })])
  renderReports()

  const row = (await screen.findByText('Каждый исход куда-то ведёт')).closest('details')!
  fireEvent.click(within(row).getByText('Каждый исход куда-то ведёт'))
  await waitFor(() => expect(row.open).toBe(true))
  expect(row.textContent).not.toContain('`')
  expect([...row.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['merge', 'stages/merge.md', 'возврат:'])

  const discussion = screen.getByText('Мерж', { selector: '.rp-finding-where' }).closest('details')!
  expect(discussion.textContent).not.toContain('`')
  expect([...discussion.querySelectorAll('code')].map((code) => code.textContent)).toEqual(['merge', 'merge.md'])
})

test('по кольцам находки стоят под своим кольцом со счётом требований, без «вычтено»', async () => {
  stub(() => [item()])
  renderReports()

  fireEvent.click(await screen.findByRole('tab', { name: 'По кольцам' }))

  const section = screen.getByRole('heading', { name: 'Согласованность' }).closest('section')!
  expect(within(section).getByText('Требований 1, выполнено 0.')).toBeTruthy()
  expect(within(section).getByText('Флоу себе не противоречит')).toBeTruthy()
  const clean = screen.getByRole('heading', { name: 'Ясность' }).closest('section')!
  expect(within(clean).getByText('Выполненные требования')).toBeTruthy()
  expect(document.body.textContent).not.toMatch(/вычтено/)
})

test('строка расписания пишет изменение сразу, а дни и час выключенного расписания недоступны', async () => {
  const { puts } = stub(() => [item()])
  renderReports()

  const monday = await screen.findByRole('button', { name: 'Пн' })
  expect(monday).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Час проверки: 09:00' })).toBeDisabled()

  fireEvent.click(screen.getByRole('switch', { name: 'Проверять по расписанию' }))
  await waitFor(() => expect(puts).toEqual([{ base: 'D:\\kb\\app', enabled: true, days: [], hour: 9 }]))
  expect(monday).not.toBeDisabled()

  fireEvent.click(monday)
  await waitFor(() => expect(puts.at(-1)).toEqual({ base: 'D:\\kb\\app', enabled: true, days: [1], hour: 9 }))
  expect(monday).toHaveAttribute('aria-pressed', 'true')
})

test('когда построен отчёт и когда проверяли флоу — отметками в строке расписания', async () => {
  stub(() => [item()])
  renderReports()

  const built = new Date(2026, 8, 26, 12, 30).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  expect((await screen.findByText(built)).parentElement!.textContent).toBe(`Отчёт ${built}`)
  expect(screen.getByText(/Проверка флоу/)).toHaveAttribute('title', 'Флоу после построения отчёта не изменялся')
})

test('отчёта ещё нет — раздел предлагает построить его, идёт разбор с «Отменить», и готовый отчёт встаёт на место', async () => {
  let reports = [item({ report: null })]
  const { stream, panel } = stub(() => reports)
  renderReports()

  fireEvent.click(await screen.findByRole('button', { name: 'Построить отчёт' }))

  expect(await screen.findByText('Идёт разбор флоу Agents Kit Web.')).toBeTruthy()
  expect(panel.posts).toEqual([{ url: '/api/reports/flow/run', body: { base: 'D:\\kb\\app' } }])

  reports = [item()]
  stream.send({ type: 'reported', text: 'Отчёт построен.' })

  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()
  expect(screen.queryByText('Идёт разбор флоу Agents Kit Web.')).toBeNull()
})

test('«Отменить» останавливает идущий разбор', async () => {
  const { panel } = stub(() => [item()], { running: true })
  renderReports()

  const waiting = (await screen.findByText('Идёт разбор флоу Agents Kit Web.')).closest('[role="status"]')!
  // Разбор идёт — перезапуск погашен, а прошлый отчёт виден под строкой хода.
  expect(screen.getByRole('button', { name: 'Проверить заново' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()

  fireEvent.click(within(waiting as HTMLElement).getByRole('button', { name: 'Отменить' }))

  await waitFor(() => expect(panel.deletes).toEqual(['/api/agent/report']))
})

test('ошибки сверки во флоу: отчёта нет, причина названа, а кнопка ведёт в «Проблемы баз»', async () => {
  stub(() => [item({ report: null, blocked: { kind: 'health', reason: 'Во флоу проекта есть ошибки сверки.' } })])
  const { onProblems } = renderReports()

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Отчёт не построен')).toBeTruthy()
  expect(within(alert).getByText('Во флоу проекта есть ошибки сверки.')).toBeTruthy()
  fireEvent.click(within(alert).getByRole('button', { name: 'Открыть «Проблемы баз»' }))
  expect(onProblems).toHaveBeenCalled()
  expect(screen.queryByRole('button', { name: 'Построить отчёт' })).toBeNull()
})

test('без кита или требований в его справке раздел называет причину без перехода', async () => {
  stub(() => [item({ report: null, blocked: { kind: 'kit', reason: 'В справке кита нет раздела «Требования к флоу».' } })])
  renderReports()

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('В справке кита нет раздела «Требования к флоу».')).toBeTruthy()
  expect(within(alert).queryByRole('button')).toBeNull()
})

test('разбор, который не удался, называет причину', async () => {
  const { stream } = stub(() => [item({ report: null })])
  renderReports()

  fireEvent.click(await screen.findByRole('button', { name: 'Построить отчёт' }))
  await screen.findByText('Идёт разбор флоу Agents Kit Web.')
  stream.send({ type: 'error', text: 'Claude Code не запустился.' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Claude Code не запустился.')).toBeTruthy()
})

test('разбор по расписанию, начатый при открытом разделе, раздел подхватывает сам', async () => {
  const stream = controlledStream<ReportEvent>()
  let started = false
  let reports = [item({ report: null })]
  stubPanel('report', stream, {
    project: 'Agents Kit Web',
    others: (url) => {
      if (url === '/api/reports/flow') return Response.json(reports)
      if (url === '/api/agent/requests')
        return Response.json(started ? [runningRequest('report', 'Разбор флоу', 'D:\\kb\\app', 'Agents Kit Web')] : [])
      if (url.startsWith('/api/agent/report/stream'))
        return new Response(stream.body, { headers: { 'Content-Type': 'application/x-ndjson' } })
      return null
    },
  })
  renderReports()
  expect(await screen.findByRole('button', { name: 'Построить отчёт' })).toBeTruthy()

  started = true

  expect(await screen.findByText('Идёт разбор флоу Agents Kit Web.', undefined, { timeout: 10000 })).toBeTruthy()
  reports = [item()]
  stream.send({ type: 'reported', text: 'Отчёт построен.' })
  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()
})

test('оборвавшийся разбор раздел называет, а не молча гасит строку хода', async () => {
  const { stream } = stub(() => [item({ report: null })])
  renderReports()

  fireEvent.click(await screen.findByRole('button', { name: 'Построить отчёт' }))
  await screen.findByText('Идёт разбор флоу Agents Kit Web.')
  stream.close()

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Ответ оборвался: API закрыл поток без ответа агента')).toBeTruthy()
})

test('пока идёт первая сверка после старта панели, отчёт виден, а запуск ждёт её конца', async () => {
  const checking: FlowReportItem['blocked'] = { kind: 'check', reason: 'Идёт сверка баз после запуска панели.' }
  let reports = [item({ blocked: checking })]
  stub(() => reports)
  renderReports()

  // Сохранённый отчёт на месте — не «Отчёт не построен»; держится только перезапуск.
  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()
  expect(screen.getByText('Идёт сверка баз после запуска панели.')).toBeTruthy()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(screen.getByRole('button', { name: 'Проверить заново' })).toBeDisabled()

  reports = [item()]

  await waitFor(() => expect(screen.getByRole('button', { name: 'Проверить заново' })).not.toBeDisabled(), { timeout: 10000 })
  expect(screen.queryByText('Идёт сверка баз после запуска панели.')).toBeNull()
})

test('оборвавшийся поток идущего разбора раздел подхватывает снова и дожидается отчёта', async () => {
  const first = controlledStream<ReportEvent>()
  const second = controlledStream<ReportEvent>()
  let streams = 0
  let reports = [item({ report: null })]
  stubPanel('report', first, {
    project: 'Agents Kit Web',
    running: runningRequest('report', 'Разбор флоу', 'D:\\kb\\app', 'Agents Kit Web'),
    others: (url) => {
      if (url === '/api/reports/flow') return Response.json(reports)
      if (url.startsWith('/api/agent/report/stream')) {
        streams++
        return new Response((streams === 1 ? first : second).body, { headers: { 'Content-Type': 'application/x-ndjson' } })
      }
      return null
    },
  })
  renderReports()
  await screen.findByText('Идёт разбор флоу Agents Kit Web.')

  first.close()
  expect(await screen.findByText('Ответ оборвался: API закрыл поток без ответа агента')).toBeTruthy()

  // Разбор на сервере идёт дальше: раздел подхватывает его снова.
  expect(await screen.findByText('Идёт разбор флоу Agents Kit Web.', undefined, { timeout: 10000 })).toBeTruthy()
  reports = [item()]
  second.send({ type: 'reported', text: 'Отчёт построен.' })
  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' })).toBeTruthy()
})

test('сверку после старта раздел перечитывает и после отказа чтения', async () => {
  const checking: FlowReportItem['blocked'] = { kind: 'check', reason: 'Идёт сверка баз после запуска панели.' }
  let reads = 0
  const stream = controlledStream<ReportEvent>()
  stubPanel('report', stream, {
    others: (url) => {
      if (url !== '/api/reports/flow') return null
      reads++
      if (reads === 1) return Response.json([item({ report: null, blocked: checking })])
      if (reads === 2) return new Response(null, { status: 500 })
      return Response.json([item()])
    },
  })
  renderReports()
  expect(await screen.findByText('Идёт сверка баз после запуска панели.')).toBeTruthy()

  expect(await screen.findByRole('button', { name: 'Проходимость: 55 из 100.' }, { timeout: 12000 })).toBeTruthy()
  expect(reads).toBeGreaterThanOrEqual(3)
})

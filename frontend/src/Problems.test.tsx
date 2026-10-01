import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Problems, { type HealthSnapshot } from './Problems'
import { plural } from './plural'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function stubHealth(...snapshots: HealthSnapshot[]) {
  const fetchMock = vi.fn()
  snapshots.forEach((s) => fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(s), { status: 200 })))
  fetchMock.mockImplementation(async () => new Response(JSON.stringify(snapshots.at(-1)), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const checked: HealthSnapshot = {
  pending: false,
  kit: 'ok',
  checkedAt: '2026-09-17T12:00:00+03:00',
  bases: [
    {
      base: 'D:\\Projects\\agents-kit-web-knowledge',
      project: 'Agents Kit Web',
      status: 'checked',
      error: null,
      problems: [
        { severity: 'error', file: 'product.md', message: '53 строк при потолке 50 — перечитать по тесту входа' },
        { severity: 'warning', file: 'backlog.md', message: '1 записей без номера — пронумерует /backlog' },
      ],
      copies: [
        { path: 'D:\\Projects\\agents-kit-web', problems: [] },
        {
          path: 'D:\\Projects\\noble-keen-walrus',
          problems: [{ severity: 'error', file: null, message: 'база не числит эту копию своей' }],
        },
      ],
    },
    {
      base: 'D:\\Projects\\nota-knowledge',
      project: 'Nota',
      status: 'checked',
      error: null,
      problems: [],
      copies: [{ path: 'D:\\Projects\\nota', problems: [] }],
    },
    {
      base: 'D:\\Projects\\crm-knowledge',
      project: 'Legacy CRM',
      status: 'failed',
      error: 'сверка сломалась',
      problems: [],
      copies: [],
    },
  ],
}

test('проблемы собраны карточкой на базу: база отдельно, каждая копия отдельно', async () => {
  stubHealth(checked)

  render(<Problems onSettings={() => {}} />)

  const app = await screen.findByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  expect(within(app).getByText('2 ошибки · 1 предупреждение')).toBeInTheDocument()

  const own = within(within(app).getByRole('list', { name: 'База' })).getAllByRole('listitem')
  expect(own).toHaveLength(2)
  expect(within(own[0]).getByText('Ошибка')).toBeInTheDocument()
  expect(within(own[0]).getByText('product.md')).toBeInTheDocument()
  expect(within(own[0]).getByText('53 строк при потолке 50 — перечитать по тесту входа')).toBeInTheDocument()
  expect(within(own[1]).getByText('Предупреждение')).toBeInTheDocument()

  const copy = within(app).getByRole('list', { name: 'Копия D:\\Projects\\noble-keen-walrus' })
  expect(within(copy).getByText('связь')).toBeInTheDocument()
  expect(within(copy).getByText('база не числит эту копию своей')).toBeInTheDocument()
  // Копия без проблем своей группы не получает
  expect(within(app).queryByRole('list', { name: 'Копия D:\\Projects\\agents-kit-web' })).not.toBeInTheDocument()

  const nota = screen.getByRole('region', { name: 'Nota — D:\\Projects\\nota-knowledge' })
  expect(within(nota).getByText('проблем нет')).toBeInTheDocument()

  const crm = screen.getByRole('region', { name: 'Legacy CRM — D:\\Projects\\crm-knowledge' })
  expect(within(crm).getByText('сверка не выполнена')).toBeInTheDocument()
  expect(within(crm).getByText(/Скрипт кита завершился с ошибкой/)).toBeInTheDocument()
  expect(within(crm).getByText('сверка сломалась')).toBeInTheDocument()
})

test('база нового формата — предупреждение полосой в карточке, находки кита под ним', async () => {
  const warning = 'Кит перевёл базу на формат, которого эта версия панели не знает.'
  stubHealth({
    ...checked,
    bases: [{ ...checked.bases[0], formatWarning: warning }, checked.bases[1]],
  })

  render(<Problems onSettings={() => {}} />)

  const app = await screen.findByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  expect(within(app).getByRole('status')).toHaveTextContent(warning)
  expect(within(app).getAllByRole('listitem').length).toBeGreaterThan(0)
  const nota = screen.getByRole('region', { name: 'Nota — D:\\Projects\\nota-knowledge' })
  expect(within(nota).queryByRole('status')).not.toBeInTheDocument()
})

test('кит не задан — раздел говорит об этом и ведёт в настройки', async () => {
  stubHealth({
    pending: false,
    kit: 'not-set',
    checkedAt: null,
    bases: [{ base: 'D:\\Projects\\nota-knowledge', project: 'Nota', status: 'unchecked', error: null, problems: [], copies: [] }],
  })
  const onSettings = vi.fn()

  render(<Problems onSettings={onSettings} />)

  expect(await screen.findByText('Проблемы баз не проверяются: не задан путь к киту.')).toBeInTheDocument()
  expect(screen.getByText('не проверена')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Открыть настройки' }))
  expect(onSettings).toHaveBeenCalled()
})

const kitUpdate = { path: 'C:\\Users\\me\\.claude\\plugins\\cache\\agents-kit\\agents-kit\\1.15.0', version: '1.15.0' }

test('новая версия кита названа, а переход на неё — в настройках', async () => {
  stubHealth({ ...checked, kitUpdate, currentKitVersion: '1.14.2' })
  const onSettings = vi.fn()

  render(<Problems onSettings={onSettings} />)

  // Ролью status помечена и заготовка раздела, поэтому предупреждение ищется по тексту
  const notice = (await screen.findByText('Установлена новая версия кита 1.15.0, панель работает версией 1.14.2.')).closest(
    '.kit-notice',
  ) as HTMLElement
  // Переходит оператор в «Настройках»: здесь кнопки перехода нет
  expect(within(notice).queryByRole('button', { name: /Перейти/ })).not.toBeInTheDocument()
  fireEvent.click(within(notice).getByRole('button', { name: 'Открыть настройки' }))
  expect(onSettings).toHaveBeenCalled()
  // Базы при этом проверены прежним китом
  expect(screen.getByRole('region', { name: 'Nota — D:\\Projects\\nota-knowledge' })).toBeInTheDocument()
})

test('прежней версии кита нет, а новая есть — вместо «кита нет» предупреждение о новой версии', async () => {
  stubHealth({
    pending: false,
    kit: 'not-found',
    checkedAt: null,
    kitUpdate,
    currentKitVersion: null,
    bases: [{ base: 'D:\\Projects\\nota-knowledge', project: 'Nota', status: 'unchecked', error: null, problems: [], copies: [] }],
  })

  render(<Problems onSettings={() => {}} />)

  expect(
    await screen.findByText(
      'Прежней версии кита по сохранённому пути больше нет, проблемы баз не проверяются. Установлена новая версия 1.15.0.',
    ),
  ).toBeInTheDocument()
  expect(screen.queryByText(/по заданному пути кита нет/)).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Открыть настройки' })).toBeInTheDocument()
})

test('пока снимок читается в первый раз, на месте карточек баз заготовка, а «Проверить сейчас» уже на месте', async () => {
  let answer: () => void = () => {}
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => (answer = () => resolve(Response.json(checked))))),
  )

  render(<Problems onSettings={() => {}} />)

  expect(screen.getByRole('status', { name: 'Загрузка проблем баз' })).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByText(/Загрузка/)).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Проблемы баз' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Проверить сейчас' })).toBeInTheDocument()

  await act(async () => answer())

  expect(screen.queryByRole('status', { name: 'Загрузка проблем баз' })).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: checked.bases[0].project })).toBeInTheDocument()
})

test('пока идёт первая проверка, раздел так и говорит', async () => {
  stubHealth({ pending: true, kit: 'not-set', checkedAt: null, bases: [] })

  render(<Problems onSettings={() => {}} />)

  expect(await screen.findByText('Идёт первая проверка баз…')).toBeInTheDocument()
})

test('раздел перечитывает снимок сам: починенная проблема пропадает без перезагрузки', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const fixed: HealthSnapshot = {
    ...checked,
    bases: [{ ...checked.bases[0], problems: [], copies: [] }],
  }
  const fetchMock = stubHealth(checked, fixed)

  render(<Problems onSettings={() => {}} />)
  expect(await screen.findByText('2 ошибки · 1 предупреждение')).toBeInTheDocument()

  await act(async () => {
    vi.advanceTimersByTime(5000)
  })
  await vi.waitFor(() => expect(screen.queryByText('2 ошибки · 1 предупреждение')).not.toBeInTheDocument())
  const app = screen.getByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  expect(within(app).getByText('проблем нет')).toBeInTheDocument()
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

test('«Проверить сейчас» запускает проверку и ждёт снимка с новым временем', async () => {
  const fixed: HealthSnapshot = {
    ...checked,
    checkedAt: '2026-09-17T12:00:42+03:00',
    bases: [{ ...checked.bases[0], problems: [], copies: [] }],
  }
  let requested = false
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/health/check' && init?.method === 'POST') {
      requested = true
      return new Response(null, { status: 202 })
    }
    return new Response(JSON.stringify(requested ? fixed : checked), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)

  render(<Problems onSettings={() => {}} />)
  expect(await screen.findByText('2 ошибки · 1 предупреждение')).toBeInTheDocument()
  expect(screen.getByText(`проверено в ${new Date(checked.checkedAt!).toLocaleTimeString('ru-RU')}`)).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Проверить сейчас' }))
  expect(await screen.findByRole('button', { name: 'Проверяется…' })).toBeDisabled()
  expect(fetchMock).toHaveBeenCalledWith('/api/health/check', { method: 'POST' })

  expect(await screen.findByRole('button', { name: 'Проверить сейчас' })).toBeEnabled()
  expect(screen.queryByText('2 ошибки · 1 предупреждение')).not.toBeInTheDocument()
  expect(screen.getByText(`проверено в ${new Date(fixed.checkedAt!).toLocaleTimeString('ru-RU')}`)).toBeInTheDocument()
})

test('проверка не запустилась — раздел говорит почему и кнопка снова доступна', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/health/check'
        ? new Response(null, { status: 500 })
        : new Response(JSON.stringify(checked), { status: 200 }),
    ),
  )

  render(<Problems onSettings={() => {}} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Проверить сейчас' }))

  expect(await screen.findByText('Проверка не запущена: HTTP 500')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Проверить сейчас' })).toBeEnabled()
})

test('падеж числа проблем', () => {
  expect(plural(1, 'ошибка', 'ошибки', 'ошибок')).toBe('1 ошибка')
  expect(plural(3, 'ошибка', 'ошибки', 'ошибок')).toBe('3 ошибки')
  expect(plural(11, 'ошибка', 'ошибки', 'ошибок')).toBe('11 ошибок')
  expect(plural(21, 'ошибка', 'ошибки', 'ошибок')).toBe('21 ошибка')
  expect(plural(14, 'ошибка', 'ошибки', 'ошибок')).toBe('14 ошибок')
})

const oldBase = 'D:\\Projects\\orders-knowledge'
const outdated: HealthSnapshot = {
  ...checked,
  bases: [
    {
      base: oldBase,
      project: 'Orders',
      status: 'unavailable',
      error: 'База хранится в прежнем формате. Перевести её можно в разделе «Проблемы баз».',
      problems: [],
      copies: [],
      outdated: true,
    },
  ],
}
const translated: HealthSnapshot = {
  ...checked,
  checkedAt: '2026-09-17T12:05:00+03:00',
  bases: [{ base: oldBase, project: 'Orders', status: 'checked', error: null, problems: [], copies: [] }],
}

/**
 * API раздела с переводом: migrate отвечает итогами по очереди, после удачного перевода снимок — переведённая база.
 * Пока ответ перевода не отпущен (release), перевод идёт.
 */
let terminalStatus = 200

function stubMigrate(...outcomes: string[]) {
  terminalStatus = 200
  let done = false
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const calls: { url: string; body: unknown }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') calls.push({ url, body: init.body ? JSON.parse(init.body as string) : null })
    if (url === '/api/bases/migrate') {
      await gate
      const outcome = outcomes.shift() ?? 'failed'
      if (outcome === 'migrated' || outcome === 'not-pushed' || outcome === 'not-synced') done = true
      return new Response(JSON.stringify({ outcome }), { status: 200 })
    }
    if (url === '/api/bases/terminal') return new Response(null, { status: terminalStatus })
    if (url === '/api/health/check') return new Response(null, { status: 202 })
    return new Response(JSON.stringify(done ? translated : outdated), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return { calls, release: () => release() }
}

async function orders() {
  return screen.findByRole('region', { name: `Orders — ${oldBase}` })
}

test('база прежнего формата — полоса с кнопкой «Перевести базу», перевод идёт сразу, кнопка недоступна', async () => {
  const api = stubMigrate('migrated')

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  expect(within(card).getByText('база не читается')).toBeInTheDocument()
  expect(
    within(card).getByText(
      'База хранится в прежнем формате, поэтому панель не может её прочитать. Переведите базу на новый формат.',
    ),
  ).toBeInTheDocument()

  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(await within(card).findByText('Выполняется перевод базы на новый формат.')).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Перевести базу' })).toBeDisabled()
  expect(api.calls[0]).toEqual({ url: '/api/bases/migrate', body: { base: oldBase, operator: null } })

  api.release()
  // Удачный перевод итогом не показывается: карточка просто становится обычной.
  expect(await within(card).findByText('проблем нет')).toBeInTheDocument()
  expect(within(card).queryByRole('status')).not.toBeInTheDocument()
  expect(api.calls.some((c) => c.url === '/api/health/check')).toBe(true)
})

test('переведённая база не ушла на сервер — строка в обычной карточке, без кнопок', async () => {
  const api = stubMigrate('not-pushed')
  api.release()

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(await within(card).findByText('проблем нет')).toBeInTheDocument()
  expect(within(card).getByRole('status')).toHaveTextContent(
    'База переведена на новый формат, но не отправлена на сервер: сервер недоступен.',
  )
  expect(within(card).queryByRole('button')).not.toBeInTheDocument()
})

test('кит попросил имя — поле в карточке, перевод повторяется с именем; неверное имя отвергнуто', async () => {
  const api = stubMigrate('need-name', 'invalid-name', 'migrated')
  api.release()

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(
    await within(card).findByText('Для перевода базы необходимо указать имя оператора этого компьютера.'),
  ).toBeInTheDocument()
  expect(within(card).queryByRole('button', { name: 'Перевести базу' })).not.toBeInTheDocument()
  expect(within(card).getByText(/Имя состоит из строчных латинских букв и цифр/)).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Перевести с указанным именем' })).toBeDisabled()

  const name = () => within(card).getByRole('textbox', { name: 'Имя оператора этого компьютера' })
  fireEvent.change(name(), { target: { value: 'Борис' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести с указанным именем' }))
  expect(await within(card).findByRole('alert')).toHaveTextContent('Указанное имя не соответствует требованиям.')
  expect(name()).toHaveAttribute('aria-invalid', 'true')

  fireEvent.change(name(), { target: { value: 'b-ignatyev' } })
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести с указанным именем' }))
  expect(await within(card).findByText('проблем нет')).toBeInTheDocument()
  expect(api.calls.filter((c) => c.url === '/api/bases/migrate').map((c) => c.body)).toEqual([
    { base: oldBase, operator: null },
    { base: oldBase, operator: 'Борис' },
    { base: oldBase, operator: 'b-ignatyev' },
  ])
})

test('перевод сорвался — одна строка без слов кита, «Повторить» и «Открыть терминал в копии»', async () => {
  const api = stubMigrate('failed', 'migrated')
  api.release()

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  const alert = await within(card).findByRole('alert')
  expect(alert).toHaveTextContent(/^Не удалось перевести базу на новый формат\.ПовторитьОткрыть терминал в копии$/)

  fireEvent.click(within(alert).getByRole('button', { name: 'Открыть терминал в копии' }))
  await vi.waitFor(() => expect(api.calls.some((c) => c.url === '/api/bases/terminal')).toBe(true))
  expect(api.calls.find((c) => c.url === '/api/bases/terminal')!.body).toEqual({ base: oldBase })

  fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }))
  expect(await within(card).findByText('проблем нет')).toBeInTheDocument()
})

test('кит старше панели — карточка ведёт обновить кит в «Настройки»', async () => {
  const api = stubMigrate('kit-old')
  api.release()
  const onSettings = vi.fn()

  render(<Problems onSettings={onSettings} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(await within(card).findByText(/Установленная версия кита не может перевести базу/)).toBeInTheDocument()
  fireEvent.click(within(card).getByRole('button', { name: 'Открыть настройки' }))
  expect(onSettings).toHaveBeenCalled()
})

test('отдача не прошла не из-за сервера — строка без причины', async () => {
  const api = stubMigrate('not-synced')
  api.release()

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(await within(card).findByText('проблем нет')).toBeInTheDocument()
  expect(within(card).getByRole('status')).toHaveTextContent(
    /^База переведена на новый формат, но не отправлена на сервер\.$/,
  )
})

test('перевод идёт, а карточку открыли заново — полоса держит перевод идущим', async () => {
  stubHealth({ ...outdated, bases: [{ ...outdated.bases[0], migrating: true }] })

  render(<Problems onSettings={() => {}} />)
  const card = await orders()

  expect(within(card).getByText('Выполняется перевод базы на новый формат.')).toBeInTheDocument()
  expect(within(card).getByRole('button', { name: 'Перевести базу' })).toBeDisabled()
})

test('терминал не открылся — полоса сорванного перевода так и говорит', async () => {
  const api = stubMigrate('failed')
  api.release()
  terminalStatus = 404

  render(<Problems onSettings={() => {}} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))
  fireEvent.click(await within(card).findByRole('button', { name: 'Открыть терминал в копии' }))

  expect(await within(card).findByText(/Терминал не открылся\./)).toBeInTheDocument()
})

test('пути к киту нет — карточка ведёт задать его в «Настройках»', async () => {
  const api = stubMigrate('kit-missing')
  api.release()
  const onSettings = vi.fn()

  render(<Problems onSettings={onSettings} />)
  const card = await orders()
  fireEvent.click(within(card).getByRole('button', { name: 'Перевести базу' }))

  expect(
    await within(card).findByText('Для перевода базы необходимо указать путь к киту в разделе «Настройки».'),
  ).toBeInTheDocument()
  fireEvent.click(within(card).getByRole('button', { name: 'Открыть настройки' }))
  expect(onSettings).toHaveBeenCalled()
})

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

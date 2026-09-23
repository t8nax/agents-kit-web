import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PanelCard, { type Panel, type PanelUpdateState, type PanelUpdates } from './PanelCard'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit) => Response | null

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const installed: Panel = {
  installed: true,
  channel: 'master',
  published: { channel: 'master', sha: '4189d1f0000', version: '0.10.1', builtAt: '2026-09-12T16:40:00Z' },
}

const development: Panel = { installed: false, channel: 'master', published: null }

const behind: PanelUpdates = {
  latest: '0.10.2',
  releases: [
    {
      version: '0.10.2',
      tag: 'v0.10.2',
      tasks: ['Исполнитель синхронизируется по копиям', 'Переход строки ведёт в сессию задачи'],
    },
  ],
}

const current: PanelUpdates = { latest: '0.10.1', releases: [] }

const idle: PanelUpdateState = { state: 'none', log: [], file: 'C:\\app\\update.log' }

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input.split('?')[0]}`
    const handler = handlers[key]
    if (!handler) throw new Error(`Нет обработчика ${key}`)
    const response = handler(init)
    // null — панели сейчас нет: так она пропадает на подмене каталога.
    return response === null ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(response)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const api = (panel: Panel, updates: PanelUpdates, update: PanelUpdateState = idle, extra: Record<string, Handler> = {}) => ({
  'GET /api/panel': () => json(panel),
  'GET /api/panel/updates': () => json(updates),
  'GET /api/panel/update': () => json(update),
  ...extra,
})

test('карточка показывает номер стоящей и вышедшей сборки и задачи, которые приедут', async () => {
  stubApi(api(installed, behind))

  render(<PanelCard />)

  expect(await screen.findByText('0.10.1')).toBeTruthy()
  expect(screen.getByText(/собрана 12 сентября/)).toBeTruthy()
  expect(await screen.findByText('0.10.2')).toBeTruthy()
  expect(screen.getByText('2 задачи ждут обновления')).toBeTruthy()
  expect(screen.getByText('Исполнитель синхронизируется по копиям')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy()
})

test('несколько вышедших сборок — задачи под номером каждой, свежая сверху', async () => {
  stubApi(
    api(installed, {
      latest: '0.10.3',
      releases: [
        { version: '0.10.3', tag: 'v0.10.3', tasks: ['Сессии задачи видны в окне ответа'] },
        { version: '0.10.2', tag: 'v0.10.2', tasks: ['Бэклог держит порядок записей', 'Поиск находит записи по номеру'] },
      ],
    }),
  )

  render(<PanelCard />)

  expect(await screen.findByText('3 задачи ждут обновления')).toBeTruthy()
  const numbers = [...document.querySelectorAll('.panel-release-num')].map((node) => node.textContent)
  expect(numbers).toEqual(['0.10.3', '0.10.2'])
})

test('панель на последней сборке говорит, что новее нет, и кнопки не показывает', async () => {
  stubApi(api(installed, current))

  render(<PanelCard />)

  expect(await screen.findByText('Новее в канале «Стабильный» пока нет')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull()
})

test('одна задача в канале посчитана по-русски', async () => {
  stubApi(api(installed, { latest: '0.10.2', releases: [{ version: '0.10.2', tag: 'v0.10.2', tasks: ['Копия удаляется из панели'] }] }))

  render(<PanelCard />)

  expect(await screen.findByText('1 задача ждёт обновления')).toBeTruthy()
})

test('GitHub не ответил — сравнить не с чем, и кнопки нет', async () => {
  stubApi(api(installed, current, idle, { 'GET /api/panel/updates': () => new Response(null, { status: 502 }) }))

  render(<PanelCard />)

  expect(await screen.findByText('GitHub не ответил — сравнить сейчас не с чем.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull()
})

test('в запуске для разработки кнопки обновления нет', async () => {
  stubApi(api(development, behind))

  render(<PanelCard />)

  expect(await screen.findByText(/Это запуск для разработки/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
})

test('выбранный канал уходит в панель', async () => {
  const fetchMock = stubApi(api(installed, behind, idle, { 'PUT /api/panel/channel': () => new Response(null, { status: 204 }) }))

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Бета' }))

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/panel/channel', expect.objectContaining({ method: 'PUT' })),
  )
  expect(screen.getByRole('button', { name: 'Бета' }).getAttribute('aria-pressed')).toBe('true')
})

test('пока канал сменяется, карточка смотрит, что вышло, а не говорит, что GitHub молчит', async () => {
  stubApi(api(installed, behind, idle, { 'PUT /api/panel/channel': () => new Response(null, { status: 204 }) }))

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Бета' }))

  expect(screen.getByText('Смотрим, что вышло…')).toBeTruthy()
  expect(screen.queryByText(/GitHub не ответил/)).toBeNull()
})

test('в канале без выпусков карточка так и говорит, и кнопки нет', async () => {
  stubApi(api(installed, { latest: null, releases: [] }))

  render(<PanelCard />)

  expect(await screen.findByText('В канале «Стабильный» ещё нет ни одного выпуска.')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull()
})

test('кнопка запускает обновление и показывает, сколько скачано', async () => {
  let update: PanelUpdateState = idle
  stubApi(
    api(installed, behind, idle, {
      'POST /api/panel/update': () => {
        update = { state: 'running', log: [], file: idle.file, release: '0.10.2', downloaded: 11744051, total: 19293798 }
        return new Response(null, { status: 202 })
      },
      'GET /api/panel/update': () => json(update),
    }),
  )

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))

  expect(await screen.findByRole('dialog', { name: 'Панель обновляется' })).toBeTruthy()
  expect(await screen.findByText('11,2 из 18,4 МБ')).toBeTruthy()
  expect(screen.getByText(/Скачать сборку 0\.10\.2/).className).toBe('now')
  expect(screen.getByText('Поставить сборку').className).toBe('')
})

test('скачанная сборка ставится — текущий шаг второй', async () => {
  const installing: PanelUpdateState = {
    state: 'running', log: [], file: idle.file, release: '0.10.2', downloaded: 100, total: 100, installing: true,
  }
  stubApi(api(installed, behind, installing))

  render(<PanelCard />)

  expect(await screen.findByRole('dialog', { name: 'Панель обновляется' })).toBeTruthy()
  expect((await screen.findByText('Поставить сборку')).className).toBe('now')
})

test('пропавшая панель в окне обновления — часть обновления, а не сбой', async () => {
  stubApi(
    api(installed, behind, idle, {
      'POST /api/panel/update': () => new Response(null, { status: 202 }),
      // Панель подменяется: связи с ней нет, и fetch отказывает промисом, а не броском.
      'GET /api/panel/update': () => null,
    }),
  )

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))

  expect(await screen.findByRole('dialog', { name: 'Панель перезапускается' })).toBeTruthy()
  expect(screen.getByText(/это часть обновления, а не сбой/)).toBeTruthy()
})

test('сорвавшееся обновление видно в карточке вместе с журналом', async () => {
  const failed: PanelUpdateState = {
    state: 'failed',
    log: ['выпуск v0.10.2', 'Связь с GitHub оборвалась: время ожидания истекло'],
    file: 'C:\\app\\update.log',
  }
  stubApi(api(installed, behind, failed))

  render(<PanelCard />)

  expect(await screen.findByText('Обновление не удалось — панель осталась прежней')).toBeTruthy()
  expect(screen.getByText(/Связь с GitHub оборвалась/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
})

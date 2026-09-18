import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PanelCard, { type Panel, type PanelUpdateState, type PanelUpdates } from './PanelCard'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit) => Response | null

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const installed: Panel = {
  version: '1.0.0',
  installed: true,
  channel: 'master',
  published: { channel: 'master', sha: '4189d1f0000', version: '1.0.0', builtAt: '2026-09-12T16:40:00Z' },
}

const development: Panel = { version: '1.2.0', installed: false, channel: 'master', published: null }

const behind: PanelUpdates = {
  latest: '1.2.0',
  releases: [
    { version: '1.2.0', title: 'Исполнитель синхронизируется по копиям' },
    { version: '1.1.0', title: 'Переход строки ведёт в сессию задачи' },
  ],
}

const current: PanelUpdates = { latest: '1.0.0', releases: [] }

const idle: PanelUpdateState = { state: 'none', version: null, log: [], file: 'C:\\app\\update.log' }

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

test('карточка показывает стоящую версию, вышедшую и что в ней', async () => {
  stubApi(api(installed, behind))

  render(<PanelCard />)

  expect(await screen.findByText('1.0.0')).toBeTruthy()
  expect(screen.getByText(/собрана 12 сентября.*master 4189d1f/)).toBeTruthy()
  // «1.2.0» стоит и крупным номером вышедшей версии, и строкой перечня — обе на месте.
  expect(await screen.findAllByText('1.2.0')).toHaveLength(2)
  expect(screen.getByText('Исполнитель синхронизируется по копиям')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Обновить до 1.2.0' })).toBeTruthy()
})

test('панель на последней версии говорит, что новее нет', async () => {
  stubApi(api(installed, current))

  render(<PanelCard />)

  expect(await screen.findByText(/новее в канале master пока нет/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Собрать заново' })).toBeTruthy()
})

test('в запуске для разработки кнопки обновления нет', async () => {
  stubApi(api(development, behind))

  render(<PanelCard />)

  expect(await screen.findByText(/Это запуск для разработки/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Собрать заново' })).toBeNull()
})

test('выбранный канал уходит в панель', async () => {
  const fetchMock = stubApi(api(installed, behind, idle, { 'PUT /api/panel/channel': () => new Response(null, { status: 204 }) }))

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'dev' }))

  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/panel/channel', expect.objectContaining({ method: 'PUT' })),
  )
  expect(screen.getByRole('button', { name: 'dev' }).getAttribute('aria-pressed')).toBe('true')
})

test('кнопка запускает обновление и показывает его ход', async () => {
  let update: PanelUpdateState = idle
  stubApi(
    api(installed, behind, idle, {
      'POST /api/panel/update': () => {
        update = { state: 'running', version: null, log: ['npm ci'], file: idle.file }
        return new Response(null, { status: 202 })
      },
      'GET /api/panel/update': () => json(update),
    }),
  )

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить до 1.2.0' }))

  expect(await screen.findByRole('dialog', { name: 'Панель обновляется' })).toBeTruthy()
  expect(await screen.findByText('npm ci')).toBeTruthy()
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
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить до 1.2.0' }))

  expect(await screen.findByRole('dialog', { name: 'Панель перезапускается' })).toBeTruthy()
  expect(screen.getByText(/это часть обновления, а не сбой/)).toBeTruthy()
})

test('сорвавшееся обновление видно в карточке вместе с журналом', async () => {
  const failed: PanelUpdateState = {
    state: 'failed',
    version: null,
    log: ['npm run build', 'ELIFECYCLE Command failed with exit code 2'],
    file: 'C:\\app\\update.log',
  }
  stubApi(api(installed, behind, failed))

  render(<PanelCard />)

  expect(await screen.findByText('Обновление не удалось — панель осталась на 1.0.0')).toBeTruthy()
  expect(screen.getByText(/ELIFECYCLE/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
})

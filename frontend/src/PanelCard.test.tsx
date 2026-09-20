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
  published: { channel: 'master', sha: '4189d1f0000', builtAt: '2026-09-12T16:40:00Z' },
}

const development: Panel = { installed: false, channel: 'master', published: null }

const behind: PanelUpdates = {
  sha: 'e5c1a2b0000',
  releases: [
    { sha: 'e5c1a2b0000', title: 'Исполнитель синхронизируется по копиям' },
    { sha: 'a71fe3d0000', title: 'Переход строки ведёт в сессию задачи' },
  ],
}

const current: PanelUpdates = { sha: '4189d1f0000', releases: [] }

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

test('карточка показывает код сборки и задачи, которые приедут', async () => {
  stubApi(api(installed, behind))

  render(<PanelCard />)

  expect(await screen.findByText('master 4189d1f')).toBeTruthy()
  expect(screen.getByText(/собрана 12 сентября/)).toBeTruthy()
  expect(await screen.findByText('2 задачи ждут обновления')).toBeTruthy()
  expect(screen.getByText('Исполнитель синхронизируется по копиям')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy()
  // Номерами версий карточка не говорит вовсе.
  expect(screen.queryByText(/\d+\.\d+\.\d+/)).toBeNull()
})

test('панель, собранная не из канала, зовёт вернуться в него', async () => {
  // Так стоит приёмочная сборка из ветки задачи: код разошёлся, а называть нечего.
  stubApi(api(installed, { sha: 'e5c1a2b0000', releases: [] }))

  render(<PanelCard />)

  expect(await screen.findByText(/Панель собрана не из канала master/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy()
})

test('панель на последней версии говорит, что новее нет', async () => {
  stubApi(api(installed, current))

  render(<PanelCard />)

  expect(await screen.findByText(/Новее в канале master пока нет/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Собрать заново' })).toBeTruthy()
})

test('одна задача в канале посчитана по-русски', async () => {
  stubApi(api(installed, { sha: 'e5c1a2b0000', releases: [{ sha: 'e5c1a2b0000', title: 'Копия удаляется из панели' }] }))

  render(<PanelCard />)

  expect(await screen.findByText('1 задача ждёт обновления')).toBeTruthy()
})

test('без исходников проекта кнопки обновления нет', async () => {
  stubApi(api(installed, current, idle, { 'GET /api/panel/updates': () => new Response(null, { status: 404 }) }))

  render(<PanelCard />)

  expect(await screen.findByText(/Исходники проекта недоступны/)).toBeTruthy()
  expect(screen.getByText(/обновиться отсюда не получится/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: /Обновить/ })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Собрать заново' })).toBeNull()
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
        update = { state: 'running', log: ['npm ci'], file: idle.file }
        return new Response(null, { status: 202 })
      },
      'GET /api/panel/update': () => json(update),
    }),
  )

  render(<PanelCard />)
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))

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
  fireEvent.click(await screen.findByRole('button', { name: 'Обновить' }))

  expect(await screen.findByRole('dialog', { name: 'Панель перезапускается' })).toBeTruthy()
  expect(screen.getByText(/это часть обновления, а не сбой/)).toBeTruthy()
})

test('сорвавшееся обновление видно в карточке вместе с журналом', async () => {
  const failed: PanelUpdateState = {
    state: 'failed',
    log: ['npm run build', 'ELIFECYCLE Command failed with exit code 2'],
    file: 'C:\\app\\update.log',
  }
  stubApi(api(installed, behind, failed))

  render(<PanelCard />)

  expect(await screen.findByText('Обновление не удалось — панель осталась прежней')).toBeTruthy()
  expect(screen.getByText(/ELIFECYCLE/)).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
})

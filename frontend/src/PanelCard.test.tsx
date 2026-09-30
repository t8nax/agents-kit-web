import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

test('карточка показывает номер стоящей и вышедшей сборки и счёт изменений, которые приедут', async () => {
  stubApi(api(installed, behind))

  render(<PanelCard />)

  expect(await screen.findByText('0.10.1')).toBeTruthy()
  expect(screen.getByText(/собрана 12 сентября/)).toBeTruthy()
  expect(await screen.findByText('0.10.2')).toBeTruthy()
  expect(screen.getByRole('button', { name: '2 изменения ждут обновления' })).toBeTruthy()
  // Сами изменения — в окне «Что нового», а не в карточке (макет окна B-313).
  expect(screen.queryByText('Исполнитель синхронизируется по копиям')).toBeNull()
  expect(screen.getByRole('button', { name: 'Обновить' })).toBeTruthy()
})

/** Открыть окно «Что нового» нажатием на счёт изменений. */
async function openNews(count: string) {
  fireEvent.click(await screen.findByRole('button', { name: count }))
  return screen.getByRole('dialog')
}

test('Стабильный: в окне «Что нового» фразы всех выпусков подряд, без номеров', async () => {
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

  const dialog = await openNews('3 изменения ждут обновления')
  expect(within(dialog).getByText('Что нового в 0.10.3')).toBeTruthy()
  expect(within(dialog).getByText('3 изменения')).toBeTruthy()
  const lines = [...dialog.querySelectorAll('.panel-releases li')].map((node) => node.textContent)
  expect(lines).toEqual(['Сессии задачи видны в окне ответа', 'Бэклог держит порядок записей', 'Поиск находит записи по номеру'])
  expect(dialog.querySelector('.panel-release-num')).toBeNull()
})

const beta: Panel = {
  installed: true,
  channel: 'dev',
  published: { channel: 'dev', sha: '4189d1f0000', version: '0.28.1.2', builtAt: '2026-09-27T16:20:00Z' },
}

const betaApi = (releases: PanelUpdates['releases'], extra: Record<string, Handler> = {}) =>
  api(beta, { latest: releases[0].version, releases }, idle, {
    'GET /api/panel/stable': () => json({ version: '0.28.1.2', stable: null, state: 'older', releases: [] }),
    ...extra,
  })

test('Бета: в окне каждая вышедшая сборка — строка, номер слева и её фраза справа', async () => {
  stubApi(
    betaApi([
      { version: '0.28.1.4', tag: 'v0.28.1.4-dev', tasks: ['Карточка «Панель» показывает, что изменилось'] },
      { version: '0.28.1.3', tag: 'v0.28.1.3-dev', tasks: ['Колонка «Стадия» не обрезает названия'] },
    ]),
  )

  render(<PanelCard />)

  const dialog = await openNews('2 изменения ждут обновления')
  const cells = [...dialog.querySelectorAll('.build-lines > span')].map((node) => node.textContent)
  expect(cells).toEqual([
    '0.28.1.4',
    'Карточка «Панель» показывает, что изменилось',
    '0.28.1.3',
    'Колонка «Стадия» не обрезает названия',
  ])
})

test('Бета: сборка с пустым описанием на GitHub остаётся в окне номером', async () => {
  stubApi(
    betaApi([
      { version: '0.28.1.4', tag: 'v0.28.1.4-dev', tasks: ['Карточка «Панель» показывает, что изменилось'] },
      { version: '0.28.1.3', tag: 'v0.28.1.3-dev', tasks: [] },
    ]),
  )

  render(<PanelCard />)

  const dialog = await openNews('2 изменения ждут обновления')
  const numbers = [...dialog.querySelectorAll('.build-lines .panel-release-num')].map((node) => node.textContent)
  expect(numbers).toEqual(['0.28.1.4', '0.28.1.3'])
})

test('вышла одна сборка — в карточке тоже только счёт, фраза в окне', async () => {
  stubApi(
    api(installed, { latest: '0.10.2', releases: [{ version: '0.10.2', tag: 'v0.10.2', tasks: ['Копия удаляется из панели'] }] }),
  )

  render(<PanelCard />)

  expect(await screen.findByRole('button', { name: '1 изменение ждёт обновления' })).toBeTruthy()
  expect(screen.queryByText('Копия удаляется из панели')).toBeNull()
  const dialog = await openNews('1 изменение ждёт обновления')
  expect(within(dialog).getByText('Копия удаляется из панели')).toBeTruthy()
})

test('окно «Что нового» закрывают «Закрыть», Esc и щелчок мимо', async () => {
  stubApi(api(installed, behind))
  render(<PanelCard />)

  fireEvent.click(within(await openNews('2 изменения ждут обновления')).getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).toBeNull()

  await openNews('2 изменения ждут обновления')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()

  await openNews('2 изменения ждут обновления')
  fireEvent.mouseDown(document.querySelector('.panel-overlay') as HTMLElement)
  expect(screen.queryByRole('dialog')).toBeNull()
})

test('«Обновить» в окне «Что нового» закрывает его и запускает обновление', async () => {
  const fetchMock = stubApi(
    api(installed, behind, idle, { 'POST /api/panel/update': () => new Response(null, { status: 202 }) }),
  )
  render(<PanelCard />)

  const dialog = await openNews('2 изменения ждут обновления')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Обновить' }))

  await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
  expect(screen.queryByRole('dialog', { name: /Что нового/ })).toBeNull()
})

test('панель на последней сборке говорит, что новее нет, и кнопки не показывает', async () => {
  stubApi(api(installed, current))

  render(<PanelCard />)

  expect(await screen.findByText('Новее в канале «Стабильный» пока нет')).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Обновить' })).toBeNull()
})

test('изменения посчитаны по-русски', async () => {
  const five = ['а', 'б', 'в', 'г', 'д']
  stubApi(api(installed, { latest: '0.10.2', releases: [{ version: '0.10.2', tag: 'v0.10.2', tasks: five }] }))

  render(<PanelCard />)

  expect(await screen.findByText('5 изменений ждут обновления')).toBeTruthy()
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

test('у поставленной Беты внизу карточки — блок выкладки в Стабильный, у Стабильного его нет', async () => {
  const beta: Panel = {
    installed: true,
    channel: 'dev',
    published: { channel: 'dev', sha: '4189d1f0000', version: '0.28.1.3', builtAt: '2026-09-28T13:42:00Z' },
  }
  stubApi(
    api(beta, { latest: '0.28.1.3', releases: [] }, idle, {
      'GET /api/panel/stable': () =>
        json({ version: '0.28.1.3', stable: '0.27.4.0', state: 'ready', releases: [] }),
    }),
  )

  render(<PanelCard />)

  expect(await screen.findByRole('button', { name: 'Выпустить в Стабильный' })).toBeTruthy()
})

test('на канале «Стабильный» блок выкладки не спрашивается', async () => {
  const fetchMock = stubApi(api(installed, current))

  render(<PanelCard />)

  expect(await screen.findByText('Новее в канале «Стабильный» пока нет')).toBeTruthy()
  expect(fetchMock.mock.calls.some(([input]) => input === '/api/panel/stable')).toBe(false)
  expect(document.querySelector('.rel-block')).toBeNull()
})

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import StablePromotion, { type PanelStable } from './StablePromotion'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const releases = [
  { version: '0.28.1.3', tag: 'v0.28.1.3-dev', tasks: ['Фильтр «Метки» помнит выбор'] },
  { version: '0.28.0.1', tag: 'v0.28.0.1-dev', tasks: ['Бэклог разделён на вкладки', 'Окно запуска показывает флоу'] },
]

const stable = (state: PanelStable['state'], extra: Partial<PanelStable> = {}): PanelStable => ({
  version: '0.28.1.3',
  stable: '0.27.4.0',
  state,
  releases,
  ...extra,
})

/** Ответы API блока по очереди: GET отдаёт следующий из states, последний — дальше. */
function stubApi(states: PanelStable[], post: () => Response = () => new Response(null, { status: 202 })) {
  let index = 0
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    if (input === '/api/panel/stable' && (init?.method ?? 'GET') === 'GET') {
      const body = states[Math.min(index, states.length - 1)]
      index++
      return Promise.resolve(json(body))
    }
    if (input === '/api/panel/stable' && init?.method === 'POST') return Promise.resolve(post())
    throw new Error(`Нет обработчика ${init?.method ?? 'GET'} ${input}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const block = () => document.querySelector('.rel-block') as HTMLElement

test('есть что выложить — номера Стабильного и стоящей сборки и кнопка', async () => {
  stubApi([stable('ready')])

  render(<StablePromotion />)

  expect(await screen.findByRole('button', { name: 'Выпустить в Стабильный' })).toBeTruthy()
  expect(screen.getByText('Выкладка в Стабильный')).toBeTruthy()
  expect(within(block()).getByText('0.27.4.0')).toBeTruthy()
  expect(within(block()).getByText('0.28.1.3')).toBeTruthy()
  // Число задач в блоке не пишется — только в окне подтверждения.
  expect(block().textContent).not.toMatch(/задач/)
})

test('кнопка открывает окно подтверждения с задачами по номерам Беты, «Отмена» его закрывает', async () => {
  const fetchMock = stubApi([stable('ready')])
  render(<StablePromotion />)

  fireEvent.click(await screen.findByRole('button', { name: 'Выпустить в Стабильный' }))

  const dialog = screen.getByRole('dialog', { name: 'Выпустить 0.28.1.3 в Стабильный?' })
  expect(within(dialog).getByText('3 задачи')).toBeTruthy()
  expect(within(dialog).getByText('Окно запуска показывает флоу')).toBeTruthy()
  const numbers = [...dialog.querySelectorAll('.panel-releases .panel-release-num')].map((node) => node.textContent)
  expect(numbers).toEqual(['0.28.1.3', '0.28.0.1'])
  expect(within(dialog).getByText('Отменить выпуск нельзя.')).toBeTruthy()

  fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }))

  expect(screen.queryByRole('dialog')).toBeNull()
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

test('подтверждённая выкладка идёт с полосой хода, а кончившись, показывает итог', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const fetchMock = stubApi([stable('ready'), stable('running'), stable('already', { stable: '0.28.1.3' })])
  render(<StablePromotion />)

  fireEvent.click(await screen.findByRole('button', { name: 'Выпустить в Стабильный' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Выпустить в Стабильный' }))

  expect(await screen.findByText('Выпускается 0.28.1.3…')).toBeTruthy()
  expect(screen.getByText('Выкладка на GitHub займёт несколько минут.')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(await screen.findByText('Сборка 0.28.1.3 вышла в Стабильный')).toBeTruthy()
  expect(screen.queryByText('Выпускается 0.28.1.3…')).toBeNull()
})

test('сорвавшаяся выкладка называет причину и даёт повторить через окно подтверждения', async () => {
  stubApi([stable('failed')])
  render(<StablePromotion />)

  const alert = await screen.findByRole('alert')

  expect(alert.textContent).toBe('Выкладка не удалась: GitHub не принял выпуск. В Стабильном осталась 0.27.4.0.')
  fireEvent.click(screen.getByRole('button', { name: 'Повторить' }))
  expect(screen.getByRole('dialog', { name: 'Выпустить 0.28.1.3 в Стабильный?' })).toBeTruthy()
})

test('отказ GitHub на запуске показывается его словами', async () => {
  stubApi([stable('ready')], () =>
    json({ detail: 'HTTP 404: workflow promote.yml not found on the default branch' }, 502),
  )
  render(<StablePromotion />)

  fireEvent.click(await screen.findByRole('button', { name: 'Выпустить в Стабильный' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Выпустить в Стабильный' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe(
    'Выкладка не удалась: HTTP 404: workflow promote.yml not found on the default branch. В Стабильном осталась 0.27.4.0.',
  )
  expect(screen.getByRole('button', { name: 'Повторить' })).toBeTruthy()
})

test('стоящая сборка уже в Стабильном — одна строка без кнопки', async () => {
  stubApi([stable('already', { stable: '0.28.1.3' })])
  render(<StablePromotion />)

  expect(await screen.findByText('Стоящая сборка уже в Стабильном')).toBeTruthy()
  expect(screen.queryByText('Выкладка в Стабильный')).toBeNull()
  expect(screen.queryByRole('button')).toBeNull()
})

test('без прав выпускать кнопки нет, на её месте надпись', async () => {
  stubApi([stable('no-rights')])
  render(<StablePromotion />)

  expect(await screen.findByText('У вас нет прав для выпуска сборки')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

test('API не отдал блок — блока нет', async () => {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 404 })))
  vi.stubGlobal('fetch', fetchMock)

  render(<StablePromotion />)

  await waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(document.querySelector('.rel-block')).toBeNull()
})


test('сбой опроса посреди выкладки блок не убирает, и итог приходит следующим опросом', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const answers: (() => Response)[] = [
    () => json(stable('running')),
    () => new Response(null, { status: 502 }),
    () => json(stable('already', { stable: '0.28.1.3' })),
  ]
  let index = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(answers[Math.min(index++, answers.length - 1)]())),
  )
  render(<StablePromotion />)
  expect(await screen.findByText('Выпускается 0.28.1.3…')).toBeTruthy()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(screen.getByText('Выпускается 0.28.1.3…')).toBeTruthy()

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })

  expect(await screen.findByText('Сборка 0.28.1.3 вышла в Стабильный')).toBeTruthy()
})

test('отказ запуска без объяснения — GitHub не ответил', async () => {
  stubApi([stable('ready')], () => new Response(null, { status: 502 }))
  render(<StablePromotion />)

  fireEvent.click(await screen.findByRole('button', { name: 'Выпустить в Стабильный' }))
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Выпустить в Стабильный' }))

  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toBe('Выкладка не удалась: GitHub не ответил. В Стабильном осталась 0.27.4.0.')
})

import { render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Usage, { type UsageView } from './Usage'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubUsage(view: UsageView) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(view), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const withPercents: UsageView = {
  fiveHours: {
    since: '2026-09-18T11:30:00+00:00',
    tokens: 31_500_000,
    answers: 420,
    percent: 46,
    resetsAt: '2026-09-18T18:40:00+00:00',
  },
  week: {
    since: '2026-09-11T16:30:00+00:00',
    tokens: 164_500_000,
    answers: 2100,
    percent: 82,
    resetsAt: '2026-09-21T11:00:00+00:00',
  },
  models: [
    { model: 'claude-opus-5', answers: 900, tokens: 120_000_000, weight: 5, share: 0.83 },
    { model: 'claude-haiku-4-5', answers: 1200, tokens: 44_500_000, weight: 0.33, share: 0.17 },
  ],
  limitsProblem: null,
  fetchedAt: '2026-09-18T16:30:00+00:00',
}

test('показывает проценты окон, их сброс и свой счёт токенов', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  const five = (await screen.findByRole('heading', { name: 'Пятичасовое окно' })).closest('section')!
  expect(within(five).getByText('46%')).toBeTruthy()
  expect(within(five).getByText(/панель насчитала/).textContent).toContain('31,5 млн токенов')
  expect(within(five).getByText(/сбросится/)).toBeTruthy()

  const week = screen.getByRole('heading', { name: 'Недельное окно' }).closest('section')!
  expect(within(week).getByText('82%')).toBeTruthy()
  expect(within(week).getByText(/2100 ответов агента/)).toBeTruthy()
})

test('полоса окна ближе к лимиту предупреждает цветом', async () => {
  stubUsage(withPercents)

  const { container } = render(<Usage />)
  await screen.findByText('46%')

  const fills = container.querySelectorAll('.usage-fill')
  // Пятичасовое окно на 46% — обычное, недельное на 82% — предупреждает
  expect(fills[0].className).not.toContain('warn')
  expect(fills[1].className).toContain('warn')
})

test('разбирает модели по долям израсходованного', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  const row = (await screen.findByText('claude-opus-5')).closest('tr')!
  expect(within(row).getByText('83%')).toBeTruthy()
  expect(within(row).getByText('×5')).toBeTruthy()
  expect(within(row).getByText('120,0 млн')).toBeTruthy()
})

test('говорит словами, когда процентов нет, и оставляет счёт токенов', async () => {
  stubUsage({
    ...withPercents,
    fiveHours: { ...withPercents.fiveHours, percent: null, resetsAt: null },
    week: { ...withPercents.week, percent: null, resetsAt: null },
    limitsProblem: 'Anthropic не ответил: 401.',
  })

  render(<Usage />)

  expect(await screen.findByText(/Проценты лимита сейчас недоступны/)).toBeTruthy()
  expect(screen.getByText(/Anthropic не ответил: 401/)).toBeTruthy()
  expect(screen.getAllByText('—').length).toBe(2)
  expect(screen.getAllByText(/лимит неизвестен/).length).toBe(2)
  // Свой счёт панели остаётся на месте
  expect(screen.getByText(/31,5 млн токенов/)).toBeTruthy()
})

test('объясняет, откуда числа и что ключ не уходит в браузер', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  const source = (await screen.findByText(/из вашей учётной записи Anthropic/)).closest('p')!
  expect(source.textContent).toContain('в браузер он не уходит и в журналы не пишется')
})

test('пустые журналы — не ошибка, а строка на месте таблицы', async () => {
  stubUsage({
    ...withPercents,
    fiveHours: { ...withPercents.fiveHours, tokens: 0, answers: 0 },
    week: { ...withPercents.week, tokens: 0, answers: 0 },
    models: [],
  })

  render(<Usage />)

  expect(await screen.findByText('За неделю агенты в этой машине не работали.')).toBeTruthy()
})

test('сбой API не прячется', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('', { status: 500 })),
  )

  render(<Usage />)

  await waitFor(() => expect(screen.getByText('Нет связи с API')).toBeTruthy())
})

test('кнопка обновления перечитывает раздел', async () => {
  const fetchMock = stubUsage(withPercents)

  render(<Usage />)
  await screen.findByText('46%')
  screen.getByRole('button', { name: 'Обновить' }).click()

  await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2))
})

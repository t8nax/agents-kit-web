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
    cost: 93.4,
    percent: 46,
    resetsAt: '2026-09-18T18:40:00+00:00',
  },
  week: {
    since: '2026-09-11T16:30:00+00:00',
    tokens: 164_500_000,
    cost: 480.2,
    percent: 82,
    resetsAt: '2026-09-21T11:00:00+00:00',
  },
  day: {
    since: '2026-09-17T16:30:00+00:00',
    tokens: 41_000_000,
    cost: 120.6,
    percent: 18.86,
  },
  models: [
    { model: 'claude-opus-5', tokens: 120_000_000, cost: 450, pricedAs: null, weight: 5, share: 0.83 },
    { model: 'claude-haiku-4-5', tokens: 44_500_000, cost: 4.56, pricedAs: null, weight: 0.33, share: 0.17 },
  ],
  limitsProblem: null,
  fetchedAt: '2026-09-18T16:30:00+00:00',
  pricesDate: '2026-09-21',
}

test('показывает проценты окон, их сброс, токены и доллары', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  const five = (await screen.findByRole('heading', { name: 'Пятичасовое окно' })).closest('section')!
  expect(within(five).getByText('46%')).toBeTruthy()
  expect(five.querySelector('.usage-window-foot')!.textContent).toBe('31,5 млн токенов · ≈ $93')
  expect(within(five).getByText(/сбросится/)).toBeTruthy()

  const week = screen.getByRole('heading', { name: 'Недельное окно' }).closest('section')!
  expect(within(week).getByText('82%')).toBeTruthy()
  expect(week.querySelector('.usage-window-foot')!.textContent).toBe('164,5 млн токенов · ≈ $480')
  // Лишнее оператор убрал на макете: ни «панель насчитала», ни ответов агента
  expect(screen.queryByText(/панель насчитала/)).toBeNull()
  expect(screen.queryByText(/ответ(а|ов)? агента/)).toBeNull()
})

test('показывает последние сутки оценкой процента недели и токенами', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  const day = (await screen.findByRole('heading', { name: '24 часа' })).closest('section')!
  const estimate = within(day).getByText('≈19%')
  // Процента за сутки Anthropic не даёт — как посчитана оценка, видно при наведении
  expect(estimate.getAttribute('title')).toBe(
    'Оценка: часть расхода с последнего сброса недели, пришедшаяся на сутки, × 82% лимита недели',
  )
  expect(day.querySelector('.usage-window-foot')!.textContent).toBe('41,0 млн токенов · ≈ $121')
  // Долю суток в недельном расходе оператор убрал на приёмке
  expect(within(day).queryByText(/недельного расхода/)).toBeNull()
  // Своего лимита у суток нет, и полосы тоже
  expect(day.querySelector('.usage-track')).toBeNull()
})

test('счёт суток идёт с первого целого часа после края', async () => {
  stubUsage(withPercents)

  render(<Usage />)

  // Край — 16:30 по UTC, а порция часа, на который он лёг, не считается: счёт с 17:00 по UTC
  const first = new Date('2026-09-17T17:00:00Z')
  const time = first.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const when = first.toDateString() === new Date(withPercents.fetchedAt).toDateString() ? 'сегодня' : 'вчера'
  const day = (await screen.findByRole('heading', { name: '24 часа' })).closest('section')!
  expect(within(day).getByText(`с ${time} ${when}`)).toBeTruthy()
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
  expect(within(row).getByText('≈ $450')).toBeTruthy()
  // Мелкие суммы — с центами
  const haiku = screen.getByText('claude-haiku-4-5').closest('tr')!
  expect(within(haiku).getByText('≈ $4,56')).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Расход по моделям' })).toBeTruthy()
  expect(screen.queryByRole('columnheader', { name: 'Ответов' })).toBeNull()
  expect(screen.getByRole('columnheader', { name: 'По ценам API' })).toBeTruthy()
})

test('говорит словами, когда процентов нет, и оставляет счёт токенов', async () => {
  stubUsage({
    ...withPercents,
    fiveHours: { ...withPercents.fiveHours, percent: null, resetsAt: null },
    week: { ...withPercents.week, percent: null, resetsAt: null },
    day: { ...withPercents.day, percent: null },
    limitsProblem: 'Anthropic не ответил: 401.',
  })

  render(<Usage />)

  expect(await screen.findByText(/Проценты лимита сейчас недоступны/)).toBeTruthy()
  expect(screen.getByText(/Anthropic не ответил: 401/)).toBeTruthy()
  expect(screen.getAllByText('—').length).toBe(3)
  expect(screen.getAllByText(/лимит неизвестен/).length).toBe(2)
  // Свой счёт панели остаётся на месте — и у окон, и у суток
  expect(screen.getByText(/31,5 млн токенов/)).toBeTruthy()
  const day = screen.getByRole('heading', { name: '24 часа' }).closest('section')!
  expect(day.querySelector('.usage-window-foot')!.textContent).toContain('41,0 млн токенов')
  expect(within(day).getByText('—').getAttribute('title')).toBeNull()
})

test('называет дату цен под карточками и под таблицей', async () => {
  stubUsage(withPercents)

  const { container } = render(<Usage />)

  // Под карточками и под таблицей
  expect((await screen.findAllByText('цены API на 21 сентября 2026')).length).toBe(2)
  expect(container.querySelector('.usage-card-foot')!.textContent).toBe('цены API на 21 сентября 2026')
  // Абзац об источнике процентов оператор убрал на макете
  expect(screen.queryByText(/из вашей учётной записи Anthropic/)).toBeNull()
})

test('называет модели, посчитанные ценой линейки или не посчитанные вовсе', async () => {
  stubUsage({
    ...withPercents,
    models: [
      ...withPercents.models,
      { model: 'claude-opus-5-2', tokens: 1_000_000, cost: 25, pricedAs: 'Opus 5', weight: 5, share: 0 },
      { model: 'нечто', tokens: 1_000, cost: null, pricedAs: null, weight: 1, share: 0 },
    ],
  })

  const { container } = render(<Usage />)

  const row = await screen.findByRole('row', { name: /нечто/ })
  expect(within(row).getByText('—')).toBeTruthy()
  expect(container.querySelector('.usage-card-foot')!.textContent).toBe(
    'цены API на 21 сентября 2026 · claude-opus-5-2 посчитана по ценам Opus 5 · нечто не посчитана: цены нет',
  )
})

test('пустые журналы — не ошибка, а строка на месте таблицы', async () => {
  stubUsage({
    ...withPercents,
    fiveHours: { ...withPercents.fiveHours, tokens: 0, cost: 0 },
    week: { ...withPercents.week, tokens: 0, cost: 0 },
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

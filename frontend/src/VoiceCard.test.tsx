import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { useVoiceModuleSource, VOICE_POLL_MS, VOICE_TITLES, VoiceContext } from './voice'
import VoiceButton from './VoiceButton'
import VoiceCard, { type VoiceState } from './VoiceCard'

// Микрофон браузера кнопке здесь нужен только тем, что он есть: запись проверяется своим тестом.
vi.mock('./microphone', async (original) => ({
  ...(await original<typeof import('./microphone')>()),
  microphoneSupported: () => true,
  watchMicrophonePermission: async () => () => {},
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const MB = 1024 * 1024
const model = 547.4 * MB

const absent: VoiceState = { state: 'absent', downloaded: 0, total: null, error: null }
const downloading: VoiceState = { state: 'downloading', downloaded: 212.4 * MB, total: model, error: null }
const installed: VoiceState = { state: 'installed', downloaded: model, total: model, error: null }

/** API модуля: GET отдаёт состояния по очереди, последнее повторяется; действия записываются. */
function stubVoice(...states: VoiceState[]) {
  const calls: string[] = []
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input}`
    calls.push(key)
    if (key === 'GET /api/voice') return Response.json(states.length > 1 ? states.shift() : states[0])
    return new Response(null, { status: key === 'POST /api/voice/install' ? 202 : 204 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

function renderCard() {
  const refresh = vi.fn()
  render(
    <VoiceContext value={{ state: 'unknown', ensure: () => {}, refresh }}>
      <VoiceCard />
    </VoiceContext>,
  )
  return { refresh }
}

const card = () => screen.getByRole('region', { name: 'Голосовой ввод' })

test('без модели карточка предлагает его установить и говорит, сколько качать', async () => {
  stubVoice(absent)

  renderCard()

  expect(await within(card()).findByText('не установлена')).toBeInTheDocument()
  expect(within(card()).getByText('Whisper, около 550 МБ')).toBeInTheDocument()
  expect(within(card()).getByText('Диктовка в поля, где пишут агенту. Речь распознаётся на этом компьютере.')).toBeInTheDocument()
  expect(within(card()).getByRole('button', { name: 'Установить' })).toBeInTheDocument()
})

test('«Установить» запускает скачивание, ход виден мегабайтами до конца, окна узнают о модуле', async () => {
  const calls = stubVoice(absent, downloading, downloading, installed)
  const { refresh } = renderCard()

  fireEvent.click(await within(card()).findByRole('button', { name: 'Установить' }))

  expect(await within(card()).findByText('Скачивается')).toBeInTheDocument()
  expect(within(card()).getByText('212,4 из 547,4 МБ')).toBeInTheDocument()
  expect(within(card()).getByRole('button', { name: 'Отменить' })).toBeInTheDocument()
  expect(calls).toContain('POST /api/voice/install')
  expect(await within(card()).findByText('Установлена')).toBeInTheDocument()
  expect(within(card()).getByText('547,4 МБ')).toBeInTheDocument()
  expect(within(card()).getByRole('button', { name: 'Удалить' })).toBeInTheDocument()
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
})

test('«Отменить» останавливает скачивание', async () => {
  const calls = stubVoice(downloading, absent)
  renderCard()

  fireEvent.click(await within(card()).findByRole('button', { name: 'Отменить' }))

  expect(await within(card()).findByRole('button', { name: 'Установить' })).toBeInTheDocument()
  expect(calls).toContain('POST /api/voice/cancel')
})

test('«Удалить» убирает поставленную модель', async () => {
  const calls = stubVoice(installed, absent)
  const { refresh } = renderCard()
  await within(card()).findByText('Установлена')
  refresh.mockClear()

  fireEvent.click(within(card()).getByRole('button', { name: 'Удалить' }))

  expect(await within(card()).findByRole('button', { name: 'Установить' })).toBeInTheDocument()
  expect(calls).toContain('DELETE /api/voice')
  await vi.waitFor(() => expect(refresh).toHaveBeenCalled())
})

test('сорвавшееся скачивание говорит, на чём прервалось, и даёт повторить', async () => {
  const calls = stubVoice(
    { state: 'failed', downloaded: 212.4 * MB, total: model, error: 'Связь с сервером модели прервалась.' },
    downloading,
  )
  renderCard()

  const alert = await within(card()).findByRole('alert')

  expect(alert).toHaveTextContent('Модель не скачалась')
  expect(alert).toHaveTextContent(
    'Связь с сервером модели прервалась на 212,4 из 547,4 МБ. Скачанное удалено, голосовой ввод не установлен.',
  )
  expect(within(card()).queryByRole('button', { name: 'Установить' })).not.toBeInTheDocument()
  fireEvent.click(within(alert).getByRole('button', { name: 'Повторить' }))
  expect(await within(card()).findByText('Скачивается')).toBeInTheDocument()
  expect(calls).toContain('POST /api/voice/install')
})

test('отказ сервера до первого байта называется без «скачанное удалено»', async () => {
  stubVoice({ state: 'failed', downloaded: 0, total: null, error: 'Сервер модели ответил 404.' })
  renderCard()

  expect(await within(card()).findByRole('alert')).toHaveTextContent(
    'Сервер модели ответил 404. Голосовой ввод не установлен.',
  )
})

test('«Установить», уход из «Настроек» — модель докачалась, и кнопка в окне зажглась сама', async () => {
  let current: VoiceState = absent
  let reads = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' && input === '/api/voice/install') {
        current = downloading
        return new Response(null, { status: 202 })
      }
      reads++
      return Response.json(current)
    }),
  )
  function Panel({ settings }: { settings: boolean }) {
    return (
      <VoiceContext value={useVoiceModuleSource()}>
        {settings && <VoiceCard />}
        <VoiceButton onText={() => {}} />
      </VoiceContext>
    )
  }
  const { rerender } = render(<Panel settings />)
  const mic = screen.getByRole('button', { name: 'Голосовой ввод' })
  // Панель прочитала «не установлен» сама и по знаку карточки, а карточка — для себя: три чтения до «Установить».
  await within(card()).findByRole('button', { name: 'Установить' })
  await vi.waitFor(() => expect(reads).toBeGreaterThanOrEqual(3))

  fireEvent.click(within(card()).getByRole('button', { name: 'Установить' }))
  await within(card()).findByText('Скачивается')
  rerender(<Panel settings={false} />)
  current = installed

  await vi.waitFor(() => expect(mic).toHaveAttribute('title', VOICE_TITLES.ready), { timeout: 4 * VOICE_POLL_MS })
})

test('API не ответил — карточка говорит это строкой', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  renderCard()

  expect(await within(card()).findByText('Нет связи с API')).toBeInTheDocument()
})

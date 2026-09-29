import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SAMPLE_RATE } from './microphone'
import {
  appendSpoken,
  HOLD_MS,
  MIC_FAILED,
  RECOGNIZE_FAILED,
  useVoiceModuleSource,
  VOICE_POLL_MS,
  VOICE_RETRY_MS,
  VOICE_TITLES,
  VoiceContext,
  type VoiceModuleState,
} from './voice'
import VoiceButton from './VoiceButton'

const mic = vi.hoisted(() => ({
  supported: true,
  denied: false,
  // Что браузер скажет о разрешении после отказа: запрет или только закрытый запрос.
  deniedAfterFailure: true,
  failure: null as unknown,
  feed: null as ((samples: Float32Array) => void) | null,
  closed: 0,
}))

vi.mock('./microphone', async (original) => ({
  ...(await original<typeof import('./microphone')>()),
  microphoneSupported: () => mic.supported,
  watchMicrophonePermission: async (onChange: (denied: boolean) => void) => {
    onChange(mic.denied)
    return () => {}
  },
  microphoneDenied: async () => mic.deniedAfterFailure,
  openMicrophone: async (onSamples: (samples: Float32Array) => void) => {
    if (mic.failure) throw mic.failure
    mic.feed = onSamples
    return {
      close: () => {
        mic.closed++
        mic.feed = null
      },
    }
  },
}))

beforeEach(() => {
  Object.assign(mic, { supported: true, denied: false, deniedAfterFailure: true, failure: null, feed: null, closed: 0 })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const phrase = () => {
  const speech = Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.3 * Math.sin(i / 5))
  const pause = new Float32Array(SAMPLE_RATE)
  act(() => {
    mic.feed?.(speech)
    mic.feed?.(pause)
  })
}

type Answer = { text?: string; status?: number }

function stubRecognize(...answers: Answer[]) {
  const pending: ((answer: Answer) => void)[] = []
  const fetchMock = vi.fn(
    (_input: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const answer = answers.shift()
        // Ответ, поданный отменённому запросу, ничего не меняет — как опоздавший ответ сервера.
        const respond = ({ text = '', status = 200 }: Answer) =>
          resolve(new Response(JSON.stringify({ text }), { status }))
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        if (answer) respond(answer)
        else pending.push(respond)
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return { fetchMock, answerLater: (answer: Answer) => pending.shift()?.(answer) }
}

function Field({ state = 'installed', disabled = false }: { state?: VoiceModuleState; disabled?: boolean }) {
  const [text, setText] = useState('Набрано')
  const [error, setError] = useState<string | null>(null)
  return (
    <VoiceContext value={{ state, ensure: () => {}, refresh: () => {} }}>
      <textarea aria-label="Поле" value={text} onChange={(e) => setText(e.target.value)} />
      <VoiceButton
        disabled={disabled}
        onText={(spoken) => setText((current) => appendSpoken(current, spoken))}
        onError={setError}
      />
      {error && <p role="alert">{error}</p>}
    </VoiceContext>
  )
}

const button = () => screen.getByRole('button', { name: 'Голосовой ввод' })
const field = () => screen.getByRole('textbox', { name: 'Поле' })

const click = () => {
  fireEvent.pointerDown(button(), { button: 0, pointerId: 1 })
  fireEvent.pointerUp(button(), { button: 0, pointerId: 1 })
}

test('без модуля кнопка погашена и говорит, где его поставить', () => {
  render(<Field state="absent" />)

  expect(button()).toHaveAttribute('aria-disabled', 'true')
  expect(button()).toHaveAttribute('title', VOICE_TITLES.notInstalled)
  click()
  expect(button()).toHaveAttribute('aria-pressed', 'false')
})

test('без окна панели вокруг модуль неизвестен, и кнопка погашена', () => {
  render(<VoiceButton onText={() => {}} />)

  expect(button()).toHaveAttribute('title', VOICE_TITLES.notInstalled)
})

function Panel({ children }: { children: ReactNode }) {
  return <VoiceContext value={useVoiceModuleSource()}>{children}</VoiceContext>
}

test('панель спрашивает модуль, когда на экране появилась кнопка, а не раньше', async () => {
  const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
    Response.json({ state: 'installed', downloaded: 1, total: 1 }),
  )
  vi.stubGlobal('fetch', fetchMock)

  // Эффекты панели отработали уже при отрисовке: спроси она модуль сразу, запрос был бы здесь.
  const { rerender } = render(<Panel>{null}</Panel>)
  expect(fetchMock).not.toHaveBeenCalled()
  rerender(
    <Panel>
      <VoiceButton onText={() => {}} />
      <VoiceButton onText={() => {}} />
    </Panel>,
  )

  await vi.waitFor(() => expect(screen.getAllByRole('button', { name: 'Голосовой ввод' })[0]).toHaveAttribute('title', VOICE_TITLES.ready))
  // Модуль прочитан один раз на обе кнопки, а стоящий — сразу прогревается.
  await vi.waitFor(() =>
    expect(fetchMock.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)).toEqual([
      'GET /api/voice',
      'POST /api/voice/warm',
    ]),
  )
})

test('модель встала, пока «Настроек» нет на экране, — кнопка зажигается сама', async () => {
  const states = ['downloading', 'downloading', 'installed']
  const fetchMock = vi.fn(async (_url: string) =>
    Response.json({ state: states.length > 1 ? states.shift() : states[0] }),
  )
  vi.stubGlobal('fetch', fetchMock)

  render(
    <Panel>
      <VoiceButton onText={() => {}} />
    </Panel>,
  )

  expect(button()).toHaveAttribute('title', VOICE_TITLES.notInstalled)
  await vi.waitFor(() => expect(button()).toHaveAttribute('title', VOICE_TITLES.ready), { timeout: 4 * VOICE_POLL_MS })
  expect(fetchMock.mock.calls.filter(([url]) => url === '/api/voice')).toHaveLength(3)
})

test('API не ответил — панель спрашивает модуль снова', async () => {
  let up = false
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (up ? Response.json({ state: 'installed' }) : Promise.reject(new TypeError('Failed to fetch')))),
  )
  render(
    <Panel>
      <VoiceButton onText={() => {}} />
    </Panel>,
  )
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))

  up = true

  await vi.waitFor(() => expect(button()).toHaveAttribute('title', VOICE_TITLES.ready), { timeout: 2 * VOICE_RETRY_MS })
})

test('браузер без микрофона — кнопка погашена со своей причиной', () => {
  mic.supported = false

  render(<Field />)

  expect(button()).toHaveAttribute('aria-disabled', 'true')
  expect(button()).toHaveAttribute('title', VOICE_TITLES.unsupported)
})

test('микрофон, запрещённый в браузере заранее, гасит кнопку до нажатия', async () => {
  mic.denied = true

  render(<Field />)

  await vi.waitFor(() => expect(button()).toHaveAttribute('title', VOICE_TITLES.denied))
  expect(button()).toHaveAttribute('aria-disabled', 'true')
})

test('запрет, узнанный при записи, гасит кнопку', async () => {
  mic.failure = new DOMException('нет', 'NotAllowedError')
  render(<Field />)

  click()

  await vi.waitFor(() => expect(button()).toHaveAttribute('title', VOICE_TITLES.denied))
  expect(button()).toHaveAttribute('aria-pressed', 'false')
})

test('отказ без запрета браузера — не запрет: кнопка остаётся рабочей, а отказ назван строкой', async () => {
  // Закрытый крестиком запрос или микрофон, закрытый приложениям в Windows: разрешение сайта не «запрещено».
  mic.failure = new DOMException('закрыли', 'NotAllowedError')
  mic.deniedAfterFailure = false
  render(<Field />)

  click()

  expect(await screen.findByRole('alert')).toHaveTextContent(MIC_FAILED)
  expect(button()).toHaveAttribute('aria-pressed', 'false')
  expect(button()).toHaveAttribute('title', VOICE_TITLES.ready)
  expect(button()).not.toHaveAttribute('aria-disabled')
})

test('щелчок пишет до второго щелчка, сказанное дописывается к набранному', async () => {
  const { fetchMock } = stubRecognize({ text: 'проверь ветку.' }, { text: 'И отправь.' })
  render(<Field />)

  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  expect(button()).toHaveAttribute('aria-pressed', 'true')
  expect(button()).toHaveAttribute('title', VOICE_TITLES.stop)
  expect(button()).toHaveClass('is-click')
  phrase()
  await vi.waitFor(() => expect(field()).toHaveValue('Набрано проверь ветку.'))
  // Запись идёт дальше: вторая фраза тоже ложится в поле.
  phrase()
  await vi.waitFor(() => expect(field()).toHaveValue('Набрано проверь ветку. И отправь.'))

  click()

  expect(button()).toHaveAttribute('aria-pressed', 'false')
  expect(mic.closed).toBe(1)
  expect(fetchMock).toHaveBeenCalledTimes(2)
  const [url, init] = fetchMock.mock.calls[0]
  expect(url).toBe('/api/voice/recognize')
  expect(init?.method).toBe('POST')
  expect((init!.body as ArrayBuffer).byteLength % 4).toBe(0)
})

test('удержание пишет, пока кнопку держат; отпустили — недоговорённое распознаётся', async () => {
  const { answerLater } = stubRecognize()
  render(<Field />)

  fireEvent.pointerDown(button(), { button: 0, pointerId: 1 })
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  await new Promise((resolve) => setTimeout(resolve, HOLD_MS + 50))
  expect(button()).toHaveClass('is-hold')
  expect(button()).toHaveAttribute('aria-pressed', 'true')
  act(() => mic.feed?.(Float32Array.from({ length: SAMPLE_RATE }, (_, i) => 0.3 * Math.sin(i / 5))))
  fireEvent.pointerUp(button(), { button: 0, pointerId: 1 })

  expect(mic.closed).toBe(1)
  // Запись кончилась, кусок ещё распознаётся: на кнопке колёсико.
  await vi.waitFor(() => expect(button()).toHaveAttribute('aria-busy', 'true'))
  expect(button()).toHaveAttribute('title', VOICE_TITLES.recognizing)
  answerLater({ text: 'готово' })
  await vi.waitFor(() => expect(field()).toHaveValue('Набрано готово'))
  expect(button()).not.toHaveAttribute('aria-busy')
  expect(button()).toHaveAttribute('title', VOICE_TITLES.ready)
})

test('кусок возвращает цель, какой она была, когда его нарезали, а не когда пришёл текст', async () => {
  const { fetchMock, answerLater } = stubRecognize()
  const heard: [string, number][] = []
  const view = (target: number) => (
    <VoiceContext value={{ state: 'installed', ensure: () => {}, refresh: () => {} }}>
      <VoiceButton target={target} onText={(text, at) => heard.push([text, at])} />
    </VoiceContext>
  )
  const { rerender } = render(view(1))
  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  phrase()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

  rerender(view(2))
  answerLater({ text: 'Принимаю.' })

  await vi.waitFor(() => expect(heard).toEqual([['Принимаю.', 1]]))
})

test('запись щелчком идёт, а сказанное раньше распознаётся — на кнопке колёсико в углу, «стоп» на месте', async () => {
  const { fetchMock, answerLater } = stubRecognize()
  render(<Field />)
  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())

  phrase()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

  expect(button()).toHaveAttribute('aria-pressed', 'true')
  expect(button()).toHaveAttribute('aria-busy', 'true')
  expect(button()).toHaveAttribute('title', `${VOICE_TITLES.stop}. ${VOICE_TITLES.recognizing}`)
  expect(button().querySelector('.mic-stop')).not.toBeNull()
  expect(button().querySelector('.mic-spin-corner')).not.toBeNull()

  answerLater({ text: 'готово' })
  await vi.waitFor(() => expect(field()).toHaveValue('Набрано готово'))
  expect(button()).not.toHaveAttribute('aria-busy')
  expect(button().querySelector('.mic-spin-corner')).toBeNull()
  expect(button()).toHaveAttribute('title', VOICE_TITLES.stop)
})

/** Два окна, у каждого своё поле и своя кнопка: Ctrl+D должен трогать только окно, где фокус. */
function TwoWindows() {
  return (
    <VoiceContext value={{ state: 'installed', ensure: () => {}, refresh: () => {} }}>
      {['Первое', 'Второе'].map((name) => (
        <div role="dialog" aria-label={name} key={name}>
          <textarea aria-label={`Поле ${name}`} />
          <VoiceButton onText={() => {}} />
        </div>
      ))}
      <input aria-label="Вне окон" />
    </VoiceContext>
  )
}

const ctrlD = (target: Element, init: KeyboardEventInit = {}) => {
  const event = new KeyboardEvent('keydown', { key: 'в', code: 'KeyD', ctrlKey: true, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

const micIn = (name: string) => within(screen.getByRole('dialog', { name })).getByRole('button', { name: 'Голосовой ввод' })

test('Ctrl+D включает и выключает запись в окне, где фокус, при любой раскладке, и закладку не открывает', async () => {
  stubRecognize()
  render(<TwoWindows />)
  const field = screen.getByLabelText('Поле Второе')
  field.focus()

  const on = ctrlD(field)
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())

  expect(on.defaultPrevented).toBe(true)
  expect(micIn('Второе')).toHaveAttribute('aria-pressed', 'true')
  expect(micIn('Первое')).toHaveAttribute('aria-pressed', 'false')
  // Зажатая клавиша повторяет нажатие — запись от этого не выключается.
  ctrlD(field, { repeat: true })
  expect(micIn('Второе')).toHaveAttribute('aria-pressed', 'true')

  ctrlD(field)
  expect(micIn('Второе')).toHaveAttribute('aria-pressed', 'false')
  expect(mic.closed).toBe(1)
})

test('фокус вне окон — Ctrl+D пишет в верхнем, последнем открытом окне', async () => {
  // «Взять в работу» и «Новая сессия» фокус себе не берут, щелчок по ленте уводит его из поля.
  stubRecognize()
  render(<TwoWindows />)
  const outside = screen.getByLabelText('Вне окон')
  outside.focus()

  const event = ctrlD(outside)
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())

  expect(event.defaultPrevented).toBe(true)
  expect(micIn('Второе')).toHaveAttribute('aria-pressed', 'true')
  expect(micIn('Первое')).toHaveAttribute('aria-pressed', 'false')
})

test('окно под другим (inert) Ctrl+D не получает', async () => {
  stubRecognize()
  render(<TwoWindows />)
  screen.getByRole('dialog', { name: 'Второе' }).setAttribute('inert', '')

  ctrlD(document.body)
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())

  expect(micIn('Первое')).toHaveAttribute('aria-pressed', 'true')
})

test('без кнопки микрофона на экране Ctrl+D остаётся браузеру', () => {
  const { unmount } = render(<TwoWindows />)
  unmount()

  const event = ctrlD(document.body)

  expect(event.defaultPrevented).toBe(false)
})

test('Ctrl+D на недоступной кнопке называет причину строкой под полем', () => {
  render(<Field state="absent" />)
  field().focus()

  const event = ctrlD(field())

  expect(event.defaultPrevented).toBe(true)
  expect(screen.getByRole('alert')).toHaveTextContent(VOICE_TITLES.notInstalled)
  expect(button()).toHaveAttribute('aria-pressed', 'false')
})

test('клавиатура включает и выключает запись щелчком', async () => {
  stubRecognize()
  render(<Field />)

  fireEvent.click(button(), { detail: 0 })
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  expect(button()).toHaveAttribute('aria-pressed', 'true')
  fireEvent.click(button(), { detail: 0 })

  expect(button()).toHaveAttribute('aria-pressed', 'false')
  expect(mic.closed).toBe(1)
})

test('нераспознанный кусок называется строкой, набранное не трогается', async () => {
  stubRecognize({ status: 500 })
  render(<Field />)

  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  phrase()

  expect(await screen.findByRole('alert')).toHaveTextContent(RECOGNIZE_FAILED)
  expect(field()).toHaveValue('Набрано')
})

test('поле погасло — запись кончается, запоздавший текст в него не ложится', async () => {
  const { fetchMock, answerLater } = stubRecognize()
  const { rerender } = render(<Field />)
  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())
  phrase()
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

  rerender(<Field disabled />)

  expect(mic.closed).toBe(1)
  expect(button()).toBeDisabled()
  expect(button()).toHaveAttribute('aria-pressed', 'false')
  // Запоздавший текст не ляжет, потому что его запрос отменён — это и проверяется, а не срок.
  expect(fetchMock.mock.calls[0][1]?.signal?.aborted).toBe(true)
  answerLater({ text: 'опоздал' })
  await act(async () => {})
  expect(field()).toHaveValue('Набрано')
})

test('закрытое окно гасит микрофон', async () => {
  stubRecognize()
  const { unmount } = render(<Field />)
  click()
  await vi.waitFor(() => expect(mic.feed).not.toBeNull())

  unmount()

  expect(mic.closed).toBe(1)
})

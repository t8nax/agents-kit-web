import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { SAMPLE_RATE } from './microphone'

/** Состояние модуля голосового ввода, как его отдаёт API; unknown — ещё не прочитано или API не ответил. */
export type VoiceModuleState = 'unknown' | 'absent' | 'downloading' | 'installed' | 'failed'

/** ensure — прочитать, если ещё не читали; refresh — перечитать: модуль поставили или убрали в «Настройках». */
export type VoiceModule = { state: VoiceModuleState; ensure: () => void; refresh: () => void }

/**
 * Модуль читает сама панель и раздаёт окнам: кнопка стоит в девяти полях, и каждое окно спрашивало бы API
 * заново. Читает, когда первая кнопка появилась на экране, а не на открытии панели: пока полей нет, модуль
 * не нужен. Без панели вокруг — в тестах окна — модуль неизвестен и кнопка погашена, как без модуля.
 */
export const VoiceContext = createContext<VoiceModule>({ state: 'unknown', ensure: () => {}, refresh: () => {} })

export const useVoiceModule = () => useContext(VoiceContext)

export function useVoiceModuleSource(): VoiceModule {
  const [state, setState] = useState<VoiceModuleState>('unknown')
  const [asked, setAsked] = useState(false)
  const [round, setRound] = useState(0)
  const ensure = useCallback(() => setAsked(true), [])
  const refresh = useCallback(() => {
    setAsked(true)
    setRound((value) => value + 1)
  }, [])
  // Пока модель качается или API не ответил, панель перечитывает модуль сама: оператор нажал «Установить»
  // и ушёл из «Настроек», а кнопки в окнах должны зажечься, когда модель встала (ревью B-291).
  useEffect(() => {
    if (!asked) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = () =>
      fetch('/api/voice')
        .then((response) => (response.ok ? response.json() : null))
        .then((body: { state?: VoiceModuleState } | null) => body?.state ?? 'unknown')
        .catch((): VoiceModuleState => 'unknown')
        .then((next) => {
          if (!alive) return
          setState(next)
          if (next === 'downloading') timer = setTimeout(read, VOICE_POLL_MS)
          else if (next === 'unknown') timer = setTimeout(read, VOICE_RETRY_MS)
        })
    void read()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [asked, round])
  return useMemo(() => ({ state, ensure, refresh }), [state, ensure, refresh])
}

/** Как часто панель перечитывает модуль, пока модель качается, и пока API не отвечает. */
export const VOICE_POLL_MS = 1500
export const VOICE_RETRY_MS = 5000

export const VOICE_TITLES = {
  ready: 'Надиктовать: щелчок — запись до второго щелчка, удержание — запись, пока кнопка нажата',
  stop: 'Остановить запись',
  recognizing: 'Распознаётся сказанное',
  notInstalled: 'Голосовой ввод не установлен. Установить его можно в разделе «Настройки».',
  denied: 'Доступ к микрофону запрещён в браузере. Разрешите его в настройках сайта.',
  unsupported: 'Браузер не предоставляет доступ к микрофону.',
}

export const MIC_FAILED =
  'Микрофон не включился. Проверьте, что он подключён и разрешён приложениям в параметрах Windows, и повторите.'

/** Нажатие короче этого — щелчок: запись идёт до второго щелчка; дольше — удержание, запись до отпускания. */
export const HOLD_MS = 350

/** Сказанное дописывается к набранному через пробел, а не заменяет его — решение оператора на B-291. */
export function appendSpoken(current: string, spoken: string) {
  const text = spoken.trim()
  if (!text) return current
  if (!current || /\s$/.test(current)) return current + text
  return `${current} ${text}`
}

export const RECOGNIZE_FAILED = 'Сказанное не распознано: программа распознавания не ответила. Повторите, пожалуйста.'

/** Кусок речи уходит панели отсчётами float32: разбирать звуковые форматы ей не нужно. */
export async function recognize(samples: Float32Array, signal?: AbortSignal): Promise<string> {
  const response = await fetch('/api/voice/recognize', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: samples.slice().buffer,
    signal,
  })
  if (!response.ok) throw new Error(`recognize ${response.status}`)
  const body = (await response.json()) as { text?: string }
  return body.text ?? ''
}

const WINDOW = SAMPLE_RATE / 50 // 20 мс
const PRE_ROLL = 15 // 0,3 с до начала речи: первый слог не обрезается
const SILENCE_END = 40 // 0,8 с тишины после речи — фраза кончилась
const MIN_SPEECH = 5 // 0,1 с громкого — речь, а не щелчок
const MAX_WINDOWS = 25 * 50 // 25 с — кусок режется и без паузы, панель держит до минуты

/**
 * Режет поток на куски по паузам в речи: Whisper отдаёт текст куском, и оператор видит сказанное
 * фраза за фразой, а не всё в конце. Тишина распознаванию не уходит: на ней Whisper выдумывает текст.
 * Порог громкости следует за шумом комнаты.
 */
export class SpeechChunks {
  private readonly windows: Float32Array[] = []
  private pending = new Float32Array(0)
  private speech = 0
  private silence = 0
  private noise = 0.005
  private readonly emit: (chunk: Float32Array) => void

  constructor(emit: (chunk: Float32Array) => void) {
    this.emit = emit
  }

  push(samples: Float32Array) {
    const joined = new Float32Array(this.pending.length + samples.length)
    joined.set(this.pending)
    joined.set(samples, this.pending.length)
    let at = 0
    for (; at + WINDOW <= joined.length; at += WINDOW) this.window(joined.subarray(at, at + WINDOW))
    this.pending = joined.slice(at)
  }

  /** Запись кончилась: недоговорённая фраза уходит сразу, не дожидаясь паузы. */
  flush() {
    if (this.speech >= MIN_SPEECH) this.cut()
    this.reset()
  }

  private window(frame: Float32Array) {
    let sum = 0
    for (const sample of frame) sum += sample * sample
    const level = Math.sqrt(sum / frame.length)
    const loud = level > Math.max(0.01, this.noise * 3)
    this.windows.push(frame.slice())
    if (loud) {
      this.speech++
      this.silence = 0
    } else {
      this.noise = this.noise * 0.95 + level * 0.05
      if (this.speech > 0) this.silence++
    }
    if (this.speech === 0) {
      // До речи держим только хвост на запас.
      if (this.windows.length > PRE_ROLL) this.windows.shift()
      return
    }
    if (this.speech >= MIN_SPEECH && (this.silence >= SILENCE_END || this.windows.length >= MAX_WINDOWS)) {
      this.cut()
      this.reset()
    } else if (this.speech < MIN_SPEECH && this.silence >= SILENCE_END) {
      this.reset()
    }
  }

  private cut() {
    const length = this.windows.reduce((total, frame) => total + frame.length, 0)
    const chunk = new Float32Array(length)
    let at = 0
    for (const frame of this.windows) {
      chunk.set(frame, at)
      at += frame.length
    }
    this.emit(chunk)
  }

  private reset() {
    this.windows.length = 0
    this.speech = 0
    this.silence = 0
  }
}

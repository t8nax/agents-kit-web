import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react'
import './VoiceButton.css'
import { isDenied, microphoneSupported, openMicrophone, watchMicrophonePermission, type Microphone } from './microphone'
import {
  HOLD_MS,
  MIC_FAILED,
  RECOGNIZE_FAILED,
  recognize,
  SpeechChunks,
  useVoiceModule,
  VOICE_TITLES,
} from './voice'

type Mode = 'idle' | 'pressed' | 'click' | 'hold'

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
      <line x1="8" y1="22" x2="16" y2="22" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect className="mic-stop" x="7" y="7" width="10" height="10" rx="1.5" />
    </svg>
  )
}

/**
 * Голосовой ввод в поле: короткий щелчок пишет до второго щелчка, долгое нажатие — пока кнопку держат
 * (решение оператора на B-291). Сказанное приходит кусками по паузам, по порядку, через onText; поле само
 * дописывает его к набранному. Поле погасло (реплика ушла) или окно закрылось — запись кончается,
 * а недораспознанное отбрасывается: писать уже некуда.
 */
export default function VoiceButton({
  onText,
  onError,
  disabled = false,
  className,
}: {
  onText: (text: string) => void
  onError?: (error: string | null) => void
  disabled?: boolean
  className?: string
}) {
  const voice = useVoiceModule()
  const [mode, setMode] = useState<Mode>('idle')
  const [pending, setPending] = useState(0)
  const [denied, setDenied] = useState(false)
  const microphone = useRef<Microphone | null>(null)
  const chunks = useRef<SpeechChunks | null>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const abort = useRef<AbortController | null>(null)
  const pressedAt = useRef(0)
  const modeRef = useRef<Mode>('idle')
  const callbacks = useRef({ onText, onError })
  useLayoutEffect(() => {
    callbacks.current = { onText, onError }
  })

  const { ensure } = voice
  useEffect(ensure, [ensure])

  const supported = microphoneSupported()
  const reason =
    voice.state !== 'installed'
      ? VOICE_TITLES.notInstalled
      : !supported
        ? VOICE_TITLES.unsupported
        : denied
          ? VOICE_TITLES.denied
          : null

  const changeMode = (next: Mode) => {
    modeRef.current = next
    setMode(next)
  }

  useEffect(() => {
    if (!supported) return
    let stop = () => {}
    let alive = true
    void watchMicrophonePermission((isDeniedNow) => alive && setDenied(isDeniedNow)).then((unwatch) => {
      if (alive) stop = unwatch
      else unwatch()
    })
    return () => {
      alive = false
      stop()
    }
  }, [supported])

  const send = (chunk: Float32Array) => {
    const controller = abort.current
    if (!controller) return
    setPending((count) => count + 1)
    queue.current = queue.current.then(async () => {
      try {
        const text = await recognize(chunk, controller.signal)
        if (!controller.signal.aborted && text.trim()) callbacks.current.onText(text)
      } catch {
        if (!controller.signal.aborted) callbacks.current.onError?.(RECOGNIZE_FAILED)
      } finally {
        if (!controller.signal.aborted) setPending((count) => count - 1)
      }
    })
  }

  const start = async (next: Mode) => {
    callbacks.current.onError?.(null)
    changeMode(next)
    if (!abort.current || abort.current.signal.aborted) abort.current = new AbortController()
    const cut = new SpeechChunks(send)
    chunks.current = cut
    try {
      const opened = await openMicrophone((samples) => cut.push(samples))
      // Пока браузер открывал микрофон, запись уже отпустили или окно закрылось.
      if (modeRef.current === 'idle' || chunks.current !== cut) {
        opened.close()
        return
      }
      microphone.current = opened
    } catch (error) {
      if (chunks.current === cut) chunks.current = null
      changeMode('idle')
      if (isDenied(error)) setDenied(true)
      else callbacks.current.onError?.(MIC_FAILED)
    }
  }

  /** Конец записи оператором: недоговорённое уходит распознаваться, пришедшее допишется. */
  const stop = () => {
    changeMode('idle')
    microphone.current?.close()
    microphone.current = null
    chunks.current?.flush()
    chunks.current = null
  }

  /** Поле погасло или окно закрылось: запись кончается, недораспознанное отбрасывается. */
  const drop = () => {
    modeRef.current = 'idle'
    microphone.current?.close()
    microphone.current = null
    chunks.current = null
    abort.current?.abort()
    abort.current = null
  }

  // Уборка, а не тело эффекта: она идёт, когда поле погасло, и когда окно закрылось.
  useEffect(() => {
    if (disabled) return
    return () => {
      drop()
      setMode('idle')
      setPending(0)
    }
  }, [disabled])

  const unavailable = reason !== null

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || disabled || unavailable) return
    event.preventDefault()
    if (modeRef.current === 'click') {
      stop()
      return
    }
    if (modeRef.current !== 'idle') return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    pressedAt.current = Date.now()
    void start('pressed')
  }

  const onPointerUp = () => {
    if (modeRef.current !== 'pressed' && modeRef.current !== 'hold') return
    if (modeRef.current === 'pressed' && Date.now() - pressedAt.current < HOLD_MS) changeMode('click')
    else stop()
  }

  // Удержание узнаётся по времени, а не по отпусканию: кнопка должна вдавиться, пока её держат.
  useEffect(() => {
    if (mode !== 'pressed') return
    const timer = setTimeout(() => {
      if (modeRef.current === 'pressed') changeMode('hold')
    }, HOLD_MS)
    return () => clearTimeout(timer)
  }, [mode])

  // Клавиатура нажимает кнопку щелчком без указателя: запись включается и выключается им.
  const onClick = (event: { detail: number }) => {
    if (event.detail !== 0 || disabled || unavailable) return
    if (modeRef.current === 'idle') void start('click')
    else stop()
  }

  const listening = mode !== 'idle'
  const recognizing = !listening && pending > 0
  const title = unavailable
    ? reason
    : mode === 'click'
      ? VOICE_TITLES.stop
      : recognizing
        ? VOICE_TITLES.recognizing
        : mode === 'idle'
          ? VOICE_TITLES.ready
          : undefined

  return (
    <button
      type="button"
      className={['mic', mode === 'click' && 'is-click', (mode === 'hold' || mode === 'pressed') && 'is-hold', className]
        .filter(Boolean)
        .join(' ')}
      aria-label="Голосовой ввод"
      aria-pressed={listening}
      aria-busy={recognizing || undefined}
      aria-disabled={unavailable || undefined}
      disabled={disabled}
      title={title}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerCancel={() => modeRef.current !== 'idle' && modeRef.current !== 'click' && stop()}
      onClick={onClick}
      onContextMenu={(event) => event.preventDefault()}
    >
      {mode === 'click' ? <StopIcon /> : recognizing ? <span className="mic-spin" aria-hidden="true" /> : <MicIcon />}
    </button>
  )
}

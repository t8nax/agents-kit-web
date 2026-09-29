/** Частота, которой ждёт распознавание панели: Whisper слушает моно 16 кГц. */
export const SAMPLE_RATE = 16000

export type Microphone = { close: () => void }

export function microphoneSupported() {
  return typeof navigator !== 'undefined' && typeof navigator.mediaDevices?.getUserMedia === 'function'
}

/** Отказ пользователя или политики браузера — не поломка, а запрет: кнопка гаснет с подсказкой. */
export function isDenied(error: unknown) {
  return error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError')
}

/**
 * Запрет, который браузер уже знает, — до первого нажатия: иначе кнопка выглядела бы рабочей,
 * а отказывала бы только в руках. Браузер без Permissions API о запрете молчит — узнаем при записи.
 */
export async function watchMicrophonePermission(onChange: (denied: boolean) => void): Promise<() => void> {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName })
    if (!status) return () => {}
    const report = () => onChange(status.state === 'denied')
    report()
    status.addEventListener('change', report)
    return () => status.removeEventListener('change', report)
  } catch {
    return () => {}
  }
}

/**
 * Отказ в микрофоне — запрет или только закрытый запрос? Chrome отвечает одним и тем же NotAllowedError, когда
 * запрос разрешения закрыли крестиком, а тогда запрета нет, и следующий щелчок спросит снова. Браузер без
 * Permissions API не скажет — отказ считается запретом.
 */
export async function microphoneDenied(): Promise<boolean> {
  try {
    const status = await navigator.permissions?.query({ name: 'microphone' as PermissionName })
    return status ? status.state === 'denied' : true
  } catch {
    return true
  }
}

// Отсчёты уходят из потока звука порциями по 0,1 с: по кадру в 128 отсчётов сообщений было бы сотни в секунду.
const tap = `
class VoiceTap extends AudioWorkletProcessor {
  constructor() { super(); this.buffer = []; this.size = 0; }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      this.buffer.push(channel.slice());
      this.size += channel.length;
      if (this.size >= sampleRate / 10) {
        const out = new Float32Array(this.size);
        let at = 0;
        for (const part of this.buffer) { out.set(part, at); at += part.length; }
        this.port.postMessage(out, [out.buffer]);
        this.buffer = []; this.size = 0;
      }
    }
    return true;
  }
}
registerProcessor('voice-tap', VoiceTap);
`

/** Браузер, не умеющий пересчитать поток в 16 кГц сам, отдаёт свою частоту: сводим её усреднением. */
function downsample(samples: Float32Array, rate: number) {
  if (rate === SAMPLE_RATE) return samples
  const ratio = rate / SAMPLE_RATE
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * ratio)
    const to = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = from; j < to; j++) sum += samples[j]
    out[i] = sum / Math.max(1, to - from)
  }
  return out
}

function createContext() {
  try {
    return new AudioContext({ sampleRate: SAMPLE_RATE })
  } catch {
    return new AudioContext()
  }
}

/** Открывает микрофон и отдаёт звук моно 16 кГц порциями; close гасит микрофон — значок записи браузера уходит. */
export async function openMicrophone(onSamples: (samples: Float32Array) => void): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  })
  const context = createContext()
  const close = () => {
    stream.getTracks().forEach((track) => track.stop())
    void context.close()
  }
  try {
    const url = URL.createObjectURL(new Blob([tap], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
    } finally {
      URL.revokeObjectURL(url)
    }
    const source = context.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(context, 'voice-tap')
    node.port.onmessage = (event: MessageEvent<Float32Array>) => onSamples(downsample(event.data, context.sampleRate))
    source.connect(node)
    // Узел без выхода в граф браузер может не считать: ведём его в выход, он молчит.
    node.connect(context.destination)
    return { close }
  } catch (error) {
    close()
    throw error
  }
}

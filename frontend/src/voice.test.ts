import { expect, test } from 'vitest'
import { SAMPLE_RATE } from './microphone'
import { appendSpoken, SpeechChunks } from './voice'

const speech = (seconds: number) =>
  Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) }, (_, i) => 0.3 * Math.sin(i / 5))
const silence = (seconds: number) => new Float32Array(Math.round(seconds * SAMPLE_RATE))

function cut(...parts: Float32Array[]) {
  const chunks: Float32Array[] = []
  const splitter = new SpeechChunks((chunk) => chunks.push(chunk))
  // Микрофон отдаёт звук порциями по 0,1 с, и окна нарезки ложатся поперёк порций.
  for (const part of parts)
    for (let at = 0; at < part.length; at += 1600) splitter.push(part.subarray(at, at + 1600))
  return { chunks, splitter }
}

test('сказанное дописывается к набранному через пробел', () => {
  expect(appendSpoken('', 'Привет.')).toBe('Привет.')
  expect(appendSpoken('Сделай так', ' и проверь. ')).toBe('Сделай так и проверь.')
  expect(appendSpoken('Первая строка\n', 'вторая')).toBe('Первая строка\nвторая')
  expect(appendSpoken('Набранное', '  ')).toBe('Набранное')
})

test('тишина распознаванию не уходит', () => {
  const { chunks, splitter } = cut(silence(3))
  splitter.flush()

  expect(chunks).toHaveLength(0)
})

test('фраза уходит куском после паузы, с запасом тишины перед ней', () => {
  const { chunks } = cut(silence(1), speech(1), silence(1))

  expect(chunks).toHaveLength(1)
  // Секунда речи, 0,3 с до неё и 0,8 с паузы, по которой фраза кончилась.
  expect(chunks[0].length / SAMPLE_RATE).toBeCloseTo(2.1, 1)
})

test('две фразы через паузу — два куска', () => {
  const { chunks } = cut(speech(1), silence(1), speech(0.5), silence(1))

  expect(chunks).toHaveLength(2)
})

test('речь без пауз режется на куски не длиннее 25 с', () => {
  const { chunks, splitter } = cut(speech(30))
  splitter.flush()

  expect(chunks).toHaveLength(2)
  expect(chunks[0].length / SAMPLE_RATE).toBeLessThanOrEqual(25)
})

test('конец записи отдаёт недоговорённую фразу сразу', () => {
  const { chunks, splitter } = cut(speech(1))
  expect(chunks).toHaveLength(0)

  splitter.flush()

  expect(chunks).toHaveLength(1)
})

test('щелчок короче 0,1 с речью не считается', () => {
  const { chunks, splitter } = cut(silence(0.5), speech(0.04), silence(1))
  splitter.flush()

  expect(chunks).toHaveLength(0)
})

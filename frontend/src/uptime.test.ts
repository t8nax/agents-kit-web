import { expect, test } from 'vitest'
import { uptime } from './uptime'

const start = Date.parse('2026-09-18T10:00:00Z')

test('сессия моложе часа — одни минуты', () => {
  expect(uptime(start, start + 14 * 60_000)).toBe('14 мин')
  expect(uptime(start, start + 30_000)).toBe('0 мин')
})

test('сессия старше часа — часы и минуты', () => {
  expect(uptime(start, start + (2 * 60 + 14) * 60_000)).toBe('2 ч 14 мин')
  expect(uptime(start, start + (9 * 60 + 5) * 60_000)).toBe('9 ч 05 мин')
})

test('сессия старше суток — дни и часы', () => {
  expect(uptime(start, start + 27 * 60 * 60_000)).toBe('1 д 03 ч')
})

test('времени старта нет или оно из будущего — показывать нечего', () => {
  expect(uptime(null, start)).toBe('—')
  expect(uptime(start + 60_000, start)).toBe('—')
})

import { afterEach, expect, test } from 'vitest'
import { forgetGoneStartWords, readStartWords, saveStartWords } from './startWords'

afterEach(() => localStorage.clear())

const backlog = (base: string, numbers: string[], error: string | null = null) => ({
  base,
  entries: numbers.map((number) => ({ number })),
  error,
})

const a = 'D:\\Projects\\a-knowledge'
const b = 'D:\\Projects\\b-knowledge'
const c = 'D:\\Projects\\c-knowledge'

test('черновики ушедших записей и баз забываются, живых и непрочитанных — остаются', () => {
  saveStartWords(a, 'B-1', 'живая')
  saveStartWords(a, 'B-2', 'взята из терминала')
  saveStartWords(b, 'N-3', 'база не прочиталась')
  saveStartWords(c, 'X-4', 'базы нет в списке')
  localStorage.setItem(`agents-kit-web.answer-drafts|${a}|copy`, '{"q":"чужой ключ"}')

  forgetGoneStartWords([backlog(a, ['B-1']), backlog(b, [], 'нет файла')])

  expect(readStartWords(a, 'B-1')).toBe('живая')
  expect(readStartWords(a, 'B-2')).toBe('')
  expect(readStartWords(b, 'N-3')).toBe('база не прочиталась')
  expect(readStartWords(c, 'X-4')).toBe('')
  expect(localStorage.getItem(`agents-kit-web.answer-drafts|${a}|copy`)).not.toBeNull()
})

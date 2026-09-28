import { afterEach, expect, test } from 'vitest'
import { forgetGoneIssueWords, forgetGoneStartWords, readStartWords, saveStartWords } from './startWords'

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

test('черновики задач трекера чтение бэклога не трогает, а чтение трекера забывает ушедшие', () => {
  saveStartWords(a, 'GitHub #37', 'живая задача')
  saveStartWords(a, 'GitHub #36', 'закрыта в GitHub')
  saveStartWords(b, 'GitHub #5', 'другая база')
  saveStartWords(c, 'GitHub #9', 'базы нет в списке')

  forgetGoneStartWords([backlog(a, ['B-1']), backlog(b, [])])

  expect(readStartWords(a, 'GitHub #37')).toBe('живая задача')
  expect(readStartWords(a, 'GitHub #36')).toBe('закрыта в GitHub')
  expect(readStartWords(c, 'GitHub #9')).toBe('')

  forgetGoneIssueWords(a, ['GitHub #37'])

  expect(readStartWords(a, 'GitHub #37')).toBe('живая задача')
  expect(readStartWords(a, 'GitHub #36')).toBe('')
  expect(readStartWords(b, 'GitHub #5')).toBe('другая база')
})

test('черновики задач YouTrack держатся так же, как у GitHub', () => {
  saveStartWords(a, 'YouTrack ABC-12', 'живая задача')
  saveStartWords(a, 'YouTrack ABC-11', 'закрыта')

  forgetGoneStartWords([backlog(a, ['B-1'])])
  expect(readStartWords(a, 'YouTrack ABC-12')).toBe('живая задача')

  forgetGoneIssueWords(a, ['YouTrack ABC-12'])
  expect(readStartWords(a, 'YouTrack ABC-12')).toBe('живая задача')
  expect(readStartWords(a, 'YouTrack ABC-11')).toBe('')
})

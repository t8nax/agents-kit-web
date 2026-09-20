import { expect, test } from 'vitest'
import { fullName, knownPerformer, shortName, shownName } from './performerName'

test('полное имя начинается приставкой проекта, а без приставки остаётся как есть', () => {
  expect(fullName('agents-kit-web', 'scout')).toBe('agents-kit-web-scout')
  expect(fullName('', 'scout')).toBe('scout')
})

test('короткое имя — своё без приставки; чужое и беспрефиксное короткого не имеют', () => {
  expect(shortName('agents-kit-web', 'agents-kit-web-scout')).toBe('scout')
  // Приставка чужого проекта — исполнитель не этого проекта
  expect(shortName('agents-kit-web', 'nota-scout')).toBeNull()
  // Имя без приставки: такое панель писала до починки, и агент по нему исполнителя не найдёт
  expect(shortName('agents-kit-web', 'scout')).toBeNull()
  // Само имя приставки без хвоста именем исполнителя не бывает
  expect(shortName('agents-kit-web', 'agents-kit-web')).toBeNull()
  expect(shortName('agents-kit-web', 'agents-kit-web-')).toBeNull()
  // Приставки у проекта нет — короткого имени тоже
  expect(shortName('', 'scout')).toBeNull()
})

test('оператор видит своё имя без приставки, чужое — целиком', () => {
  expect(shownName('agents-kit-web', 'agents-kit-web-scout')).toBe('scout')
  expect(shownName('agents-kit-web', 'nota-scout')).toBe('nota-scout')
  expect(shownName('', 'scout')).toBe('scout')
})

test('заведён только тот, чьё имя из флоу совпало с коротким именем из списка', () => {
  const known = ['scout', 'check-runner']
  expect(knownPerformer('agents-kit-web', known, 'agents-kit-web-scout')).toBe(true)
  expect(knownPerformer('agents-kit-web', known, ' agents-kit-web-scout ')).toBe(true)
  expect(knownPerformer('agents-kit-web', known, 'scout')).toBe(false)
  expect(knownPerformer('agents-kit-web', known, 'agents-kit-web-reviewer')).toBe(false)
  expect(knownPerformer('', known, 'scout')).toBe(false)
})

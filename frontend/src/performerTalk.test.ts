import { expect, test } from 'vitest'
import { changedText, foreignTalk } from './performerTalk'

test('переписка о новом исполнителе другого проекта окну нового чужая (B-193)', () => {
  expect(foreignTalk({ base: 'D:/billing', subject: null }, { base: 'D:/orders', subject: null })).toBe(true)
})

test('переписка о другом исполнителе того же проекта чужая, о своём — своя', () => {
  expect(foreignTalk({ base: 'D:/orders', subject: 'reviewer' }, { base: 'D:/orders', subject: null })).toBe(true)
  expect(foreignTalk({ base: 'D:/orders', subject: 'reviewer' }, { base: 'D:/orders', subject: 'tester' })).toBe(true)
  expect(foreignTalk({ base: 'D:/orders', subject: 'reviewer' }, { base: 'D:/orders', subject: 'reviewer' })).toBe(false)
  expect(foreignTalk({ base: 'D:/orders', subject: null }, { base: 'D:/orders', subject: null })).toBe(false)
  expect(foreignTalk(null, { base: 'D:/orders', subject: null })).toBe(false)
})

test('в строке изменений нет выбранных вручную модели и инструментов', () => {
  const changed = ['description', 'model', 'tools', 'prompt'] as const
  expect(changedText([...changed], { model: true, tools: false, name: false })).toBe('описание, инструменты, задание')
  expect(changedText([...changed], { model: false, tools: false, name: false })).toBe('описание, модель, инструменты, задание')
  expect(changedText(['name'], { model: false, tools: false, name: true })).toBe('')
  expect(changedText(null, { model: false, tools: false, name: false })).toBe('')
})

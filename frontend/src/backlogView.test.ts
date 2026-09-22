import { afterEach, expect, test, vi } from 'vitest'
import type { BacklogEntry } from './Backlog'
import { arrange, defaultOrder, emptySelection, isFiltering, readOrder, writeOrder } from './backlogView'

const entry = (number: string | null, title: string, type?: string | null, priority?: string | null): BacklogEntry => ({
  number,
  title,
  text: null,
  type,
  priority,
})

const entries = [
  entry('B-1', 'Старый баг', 'баг', 'средний'),
  entry('B-2', 'Фича про импорт', 'фича', 'блокер'),
  entry(null, 'Дописана руками', 'баг', 'высокий'),
  entry('B-10', 'Срочный баг Импорта', 'баг', 'блокер'),
  entry('B-3', 'Без полей'),
  entry('B-4', 'Своё значение', 'задача', 'срочно'),
]

const numbers = (list: BacklogEntry[]) => list.map((e) => e.number ?? e.title)

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
})

test('по умолчанию — номер по возрастанию, запись без номера в конце', () => {
  expect(numbers(arrange(entries, emptySelection, defaultOrder))).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'B-10', 'Дописана руками'])
})

test('номер по убыванию — новые сверху, запись без номера всё равно в конце', () => {
  expect(numbers(arrange(entries, emptySelection, { field: 'number', direction: 'desc' }))).toEqual([
    'B-10', 'B-4', 'B-3', 'B-2', 'B-1', 'Дописана руками',
  ])
})

test('приоритет по убыванию — блокеры сверху, одинаковые от новых к старым, без поля и чужое в конце', () => {
  expect(numbers(arrange(entries, emptySelection, { field: 'priority', direction: 'desc' }))).toEqual([
    'B-10', 'B-2', 'Дописана руками', 'B-1', 'B-4', 'B-3',
  ])
})

test('приоритет по возрастанию — низкие сверху, без поля всё равно в конце', () => {
  expect(numbers(arrange(entries, emptySelection, { field: 'priority', direction: 'asc' }))).toEqual([
    'B-1', 'Дописана руками', 'B-10', 'B-2', 'B-4', 'B-3',
  ])
})

test('тип по убыванию — баги сверху, по возрастанию — фичи сверху', () => {
  expect(numbers(arrange(entries, emptySelection, { field: 'type', direction: 'desc' }))).toEqual([
    'B-10', 'B-1', 'Дописана руками', 'B-2', 'B-4', 'B-3',
  ])
  expect(numbers(arrange(entries, emptySelection, { field: 'type', direction: 'asc' }))).toEqual([
    'B-2', 'B-10', 'B-1', 'Дописана руками', 'B-4', 'B-3',
  ])
})

test('несколько значений в поле — любое из них, два поля — оба сразу', () => {
  const selection = { ...emptySelection, priorities: ['высокий', 'блокер'] }
  expect(numbers(arrange(entries, selection, defaultOrder))).toEqual(['B-2', 'B-10', 'Дописана руками'])
  expect(numbers(arrange(entries, { ...selection, types: ['баг'] }, defaultOrder))).toEqual(['B-10', 'Дописана руками'])
})

test('запись без поля и со своим значением под фильтром по полю не видна', () => {
  const found = numbers(arrange(entries, { ...emptySelection, types: ['баг', 'фича'] }, defaultOrder))
  expect(found).not.toContain('B-3')
  expect(found).not.toContain('B-4')
})

test('поиск — по номеру и заголовку без различия регистра, вместе с фильтром', () => {
  expect(numbers(arrange(entries, { ...emptySelection, query: ' импорт' }, defaultOrder))).toEqual(['B-2', 'B-10'])
  expect(numbers(arrange(entries, { ...emptySelection, query: 'b-1' }, defaultOrder))).toEqual(['B-1', 'B-10'])
  expect(numbers(arrange(entries, { ...emptySelection, query: 'импорт', types: ['баг'] }, defaultOrder))).toEqual(['B-10'])
})

test('отбор включён, когда выбрано значение или набран запрос', () => {
  expect(isFiltering(emptySelection)).toBe(false)
  expect(isFiltering({ ...emptySelection, query: '  ' })).toBe(false)
  expect(isFiltering({ ...emptySelection, types: ['баг'] })).toBe(true)
  expect(isFiltering({ ...emptySelection, query: 'x' })).toBe(true)
})

test('порядок помнится в браузере, чужое значение — порядок по умолчанию', () => {
  expect(readOrder()).toEqual(defaultOrder)
  writeOrder({ field: 'priority', direction: 'desc' })
  expect(readOrder()).toEqual({ field: 'priority', direction: 'desc' })
  localStorage.setItem('agents-kit-web.backlog-order', '{"field":"title","direction":"desc"}')
  expect(readOrder()).toEqual(defaultOrder)
})

test('недоступное хранилище — порядок по умолчанию и без ошибки', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readOrder()).toEqual(defaultOrder)
  expect(() => writeOrder({ field: 'type', direction: 'asc' })).not.toThrow()
})

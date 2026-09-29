import { afterEach, expect, test, vi } from 'vitest'
import type { BacklogEntry } from './Backlog'
import {
  activeLabels,
  arrange,
  defaultOrder,
  emptySelection,
  isFiltering,
  isFilteringIssues,
  matchesIssue,
  readOrder,
  writeOrder,
} from './backlogView'
import { labelChoices } from './tracker'

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

test('номер, набранный кириллицей, и слова вокруг разметки заголовка находятся', () => {
  const marked = [...entries, entry('B-5', 'Флаг `--force` у **сборки**')]
  expect(numbers(arrange(marked, { ...emptySelection, query: 'в-10' }, defaultOrder))).toEqual(['B-10'])
  expect(numbers(arrange(marked, { ...emptySelection, query: '--force у сборки' }, defaultOrder))).toEqual(['B-5'])
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

const issue = {
  name: 'GitHub #37',
  number: 37,
  title: 'Оплата падает',
  url: 'https://github.com/acme/orders/issues/37',
  labels: ['bug', 'ui'],
}

test('задача трекера проходит поиск по имени и заголовку; тип и приоритет — фильтры вкладки записей', () => {
  expect(matchesIssue(issue, 'orders', emptySelection, [])).toBe(true)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, query: '#37' }, [])).toBe(true)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, query: 'github #37' }, [])).toBe(true)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, query: 'оплата' }, [])).toBe(true)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, query: '#38' }, [])).toBe(false)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, types: ['баг'], priorities: ['высокий'] }, [])).toBe(true)
})

test('несколько меток — задача хотя бы с одной из них; метка своего проекта, одноимённая чужая не в счёт', () => {
  const pick = (base: string, name: string) => ({ base, name })

  expect(matchesIssue(issue, 'orders', emptySelection, [pick('orders', 'docs'), pick('orders', 'ui')])).toBe(true)
  expect(matchesIssue(issue, 'orders', emptySelection, [pick('orders', 'docs')])).toBe(false)
  expect(matchesIssue(issue, 'orders', emptySelection, [pick('nota', 'bug')])).toBe(false)
  expect(matchesIssue({ ...issue, labels: null }, 'orders', emptySelection, [pick('orders', 'bug')])).toBe(false)
  expect(matchesIssue(issue, 'orders', { ...emptySelection, query: '#38' }, [pick('orders', 'bug')])).toBe(false)
})

test('метки невидимого проекта остаются выбранными, но не отбирают', () => {
  const labels = [{ base: 'orders', name: 'bug' }, { base: 'nota', name: 'docs' }]

  expect(activeLabels(labels, ['nota'])).toEqual([{ base: 'nota', name: 'docs' }])
  expect(activeLabels(labels, ['orders', 'nota'])).toEqual(labels)
  expect(isFilteringIssues({ ...emptySelection, labels }, activeLabels(labels, ['other']))).toBe(false)
  expect(isFilteringIssues({ ...emptySelection, labels }, activeLabels(labels, ['nota']))).toBe(true)
  expect(isFilteringIssues({ ...emptySelection, query: 'x' }, [])).toBe(true)
})

test('перечень меток — метки репозитория, а не прочитали их — метки задач по имени', () => {
  const loaded = { kind: 'loaded' as const, problem: null, detail: null }

  expect(labelChoices({ ...loaded, issues: [issue], labels: ['bug', 'docs', 'ui'] })).toEqual(['bug', 'docs', 'ui'])
  expect(labelChoices({ ...loaded, issues: [issue, { ...issue, labels: ['api', 'bug'] }], labels: null })).toEqual([
    'api', 'bug', 'ui',
  ])
  expect(labelChoices({ kind: 'loading' })).toEqual([])
})

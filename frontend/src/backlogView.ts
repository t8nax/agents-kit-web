import type { BacklogEntry } from './Backlog'
import { twins } from './taskTitle'
import type { TrackerIssue } from './tracker'

// Отбор и порядок записей бэклога — только показ: порядок записей в самом файле панель не меняет.
// Значения полей задаёт кит; запись без поля или со своим значением под фильтр по этому полю не попадает.
export const TYPES = ['баг', 'фича']
export const PRIORITIES = ['низкий', 'средний', 'высокий', 'блокер']

export type SortField = 'number' | 'type' | 'priority'
export type SortDirection = 'asc' | 'desc'
export type Order = { field: SortField; direction: SortDirection }

/** Без сохранённого выбора — по числу номера от давних к новым; буквы номера порядку не важны. */
export const defaultOrder: Order = { field: 'number', direction: 'asc' }

/** Вкладка раздела: записи бэклога базы или задачи трекера — у каждой свои фильтры (B-305, вместо фильтра источника B-302). */
export type Tab = 'entries' | 'tracker'

/** Метка, выбранная в фильтре «Метки», — у своего проекта: одноимённые метки двух репозиториев разные (B-305). */
export type PickedLabel = { base: string; name: string }

/**
 * Выбор оператора: пустой список значений — поле не фильтрует, пустой запрос — поиска нет. Тип и приоритет отбирают
 * записи бэклога, метки — задачи трекера, поиск — и то и другое.
 */
export type Selection = { types: string[]; priorities: string[]; labels: PickedLabel[]; query: string }

export const emptySelection: Selection = { types: [], priorities: [], labels: [], query: '' }

/** Отбор записей бэклога включён: выбран тип или приоритет или набран запрос. */
export function isFiltering(selection: Selection): boolean {
  return selection.types.length > 0 || selection.priorities.length > 0 || selection.query.trim() !== ''
}

/**
 * Метки, которые отбирают задачи сейчас, — выбранные у видимых проектов: при смене проекта метки другого остаются
 * выбранными, но не действуют, пока их проект не виден снова.
 */
export function activeLabels(labels: PickedLabel[], bases: string[]): PickedLabel[] {
  return labels.filter((label) => bases.includes(label.base))
}

/** Отбор задач трекера включён: действует метка или набран запрос. */
export function isFilteringIssues(selection: Selection, active: PickedLabel[]): boolean {
  return active.length > 0 || selection.query.trim() !== ''
}

export function samePicked(a: PickedLabel, b: PickedLabel): boolean {
  return a.base === b.base && a.name === b.name
}

export function matches(entry: BacklogEntry, selection: Selection): boolean {
  if (selection.types.length > 0 && !selection.types.includes(entry.type ?? '')) return false
  if (selection.priorities.length > 0 && !selection.priorities.includes(entry.priority ?? '')) return false
  const query = searchable(selection.query.trim())
  return query === '' || searchable(`${entry.number ?? ''} ${entry.title}`).includes(query)
}

/**
 * Задача трекера base проходит отбор своей вкладки: действуют метки active — у неё есть хоть одна из выбранных
 * у её проекта; у проекта своих выбранных нет — ни одна (задачи прочих видимых проектов при выбранной метке скрыты).
 * Поиск — по имени задачи («GitHub #37») и заголовку. Тип и приоритет — фильтры другой вкладки.
 */
export function matchesIssue(issue: TrackerIssue, base: string, selection: Selection, active: PickedLabel[]): boolean {
  if (active.length > 0) {
    const labels = issue.labels ?? []
    if (!active.some((label) => label.base === base && labels.includes(label.name))) return false
  }
  const query = searchable(selection.query.trim())
  return query === '' || searchable(`${issue.name} ${issue.title}`).includes(query)
}

// Поиск сравнивает то, что видно: без регистра, без знаков разметки заголовка, а номер, набранный
// кириллицей, — как латиницей: «в-7» находит «B-7», как у номеров кита.
function searchable(text: string): string {
  return [...text.replace(/[`*_~]/g, '').toUpperCase()].map((c) => twins[c] ?? c).join('')
}

function numberRank(entry: BacklogEntry): number | null {
  const digits = /-(\d+)$/.exec(entry.number ?? '')
  return digits ? Number(digits[1]) : null
}

// По возрастанию тип идёт от фич к багам: «по убыванию» ставит баги сверху, как блокеры у приоритета.
function rank(entry: BacklogEntry, field: SortField): number | null {
  if (field === 'number') return numberRank(entry)
  const index = (field === 'type' ? ['фича', 'баг'] : PRIORITIES).indexOf(entry[field] ?? '')
  return index < 0 ? null : index
}

/** Записи проекта, прошедшие отбор, в выбранном порядке; без номера или без поля — в конце. */
export function arrange(entries: BacklogEntry[], selection: Selection, order: Order): BacklogEntry[] {
  const sign = order.direction === 'asc' ? 1 : -1
  return entries
    .map((entry, index) => ({ entry, index, rank: rank(entry, order.field), number: numberRank(entry) }))
    .filter(({ entry }) => matches(entry, selection))
    .sort((a, b) => {
      if (a.rank !== b.rank) {
        if (a.rank === null) return 1
        if (b.rank === null) return -1
        return sign * (a.rank - b.rank)
      }
      // Записи без номера держатся порядка файла
      if (order.field === 'number') return a.index - b.index
      // Одинаковые по полю идут от новых к старым: по номеру, а без номера — дописанные в файл позже выше
      if (a.number !== b.number) {
        if (a.number === null) return 1
        if (b.number === null) return -1
        return b.number - a.number
      }
      return b.index - a.index
    })
    .map(({ entry }) => entry)
}

/** Отбор, который раздел помнит между открытиями: вкладка, проект (null — все), чипы типа и приоритета и метки. */
export type Remembered = { tab: Tab; project: string | null; types: string[]; priorities: string[]; labels: PickedLabel[] }

const nothingRemembered: Remembered = { tab: 'entries', project: null, types: [], priorities: [], labels: [] }

// Отбор живёт в памяти страницы, а не в браузере: уход в другой раздел его не сбрасывает,
// перезагрузка страницы — сбрасывает. Поиск не помнится — решения оператора на B-267; вкладка и метки — как чипы (B-305).
let remembered = nothingRemembered

export function readRemembered(): Remembered {
  return remembered
}

export function remember(next: Remembered) {
  remembered = next
}

/** Для тестов: каждый начинает с раздела без отбора, как после перезагрузки страницы. */
export function forgetRemembered() {
  remembered = nothingRemembered
}

const orderKey = 'agents-kit-web.backlog-order'

// Порядок помнит браузер между открытиями раздела. Хранилище может быть недоступно — тогда порядок по умолчанию.
export function readOrder(): Order {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(orderKey) ?? 'null')
    if (typeof value !== 'object' || value === null) return defaultOrder
    const { field, direction } = value as Record<string, unknown>
    return (field === 'number' || field === 'type' || field === 'priority') && (direction === 'asc' || direction === 'desc')
      ? { field, direction }
      : defaultOrder
  } catch {
    return defaultOrder
  }
}

export function writeOrder(order: Order) {
  try {
    localStorage.setItem(orderKey, JSON.stringify(order))
  } catch {
    // выбор проживёт до ухода из раздела
  }
}

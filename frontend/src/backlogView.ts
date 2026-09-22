import type { BacklogEntry } from './Backlog'

// Отбор и порядок записей бэклога — только показ: порядок записей в самом файле панель не меняет.
// Значения полей задаёт кит; запись без поля или со своим значением под фильтр по этому полю не попадает.
export const TYPES = ['баг', 'фича']
export const PRIORITIES = ['низкий', 'средний', 'высокий', 'блокер']

export type SortField = 'number' | 'type' | 'priority'
export type SortDirection = 'asc' | 'desc'
export type Order = { field: SortField; direction: SortDirection }

/** Без сохранённого выбора записи стоят как в файле — по номеру от давних к новым. */
export const defaultOrder: Order = { field: 'number', direction: 'asc' }

/** Выбор оператора: пустой список значений — поле не фильтрует, пустой запрос — поиска нет. */
export type Selection = { types: string[]; priorities: string[]; query: string }

export const emptySelection: Selection = { types: [], priorities: [], query: '' }

export function isFiltering(selection: Selection): boolean {
  return selection.types.length > 0 || selection.priorities.length > 0 || selection.query.trim() !== ''
}

export function matches(entry: BacklogEntry, selection: Selection): boolean {
  if (selection.types.length > 0 && !selection.types.includes(entry.type ?? '')) return false
  if (selection.priorities.length > 0 && !selection.priorities.includes(entry.priority ?? '')) return false
  const query = selection.query.trim().toLowerCase()
  return query === '' || `${entry.number ?? ''} ${entry.title}`.toLowerCase().includes(query)
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

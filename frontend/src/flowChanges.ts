import type { FlowStep } from './Flow'

export type FlowFieldName = 'executor' | 'output' | 'skip' | 'description'

export type FlowFieldChange = { field: FlowFieldName; before: string | null; after: string | null }

/**
 * Что стало с шагом: at — место в новом флоу, from — в прежнем; у добавленного и удалённого своего места
 * во втором нет и стоит -1.
 */
export type FlowChange = {
  kind: 'added' | 'changed' | 'moved' | 'removed' | 'same'
  title: string
  at: number
  from: number
  step: FlowStep | null
  fields: FlowFieldChange[]
}

const fieldNames: FlowFieldName[] = ['executor', 'output', 'skip', 'description']

const value = (step: FlowStep, field: FlowFieldName) => {
  const raw = field === 'executor' ? step.executor : field === 'output' ? step.output : field === 'skip' ? step.skip : step.description
  return raw === null || raw === undefined || raw === '' ? null : raw
}

const fieldsOf = (before: FlowStep, after: FlowStep) =>
  fieldNames
    .map((field) => ({ field, before: value(before, field), after: value(after, field) }))
    .filter((change) => change.before !== change.after)

/**
 * Пары «прежний шаг — новый» по названию: одинаковые названия разбираются по порядку, поэтому
 * переставленный шаг узнаётся, а переименованный выглядит как удалённый и добавленный.
 */
function pairs(before: FlowStep[], after: FlowStep[]) {
  const free = new Map<string, number[]>()
  before.forEach((step, index) => {
    const key = step.title.trim()
    free.set(key, [...(free.get(key) ?? []), index])
  })

  return after.map((step) => {
    const places = free.get(step.title.trim())
    return places?.length ? (places.shift() as number) : -1
  })
}

/** Разбор переписанного флоу: по шагу на строку, сначала новый порядок, следом удалённые шаги. */
export function flowChanges(before: FlowStep[], after: FlowStep[]): FlowChange[] {
  const from = pairs(before, after)
  const taken = new Set(from.filter((index) => index >= 0))

  const changes: FlowChange[] = after.map((step, at) => {
    const was = from[at] >= 0 ? before[from[at]] : null
    if (!was) return { kind: 'added', title: step.title, at, from: -1, step, fields: [] }

    const fields = fieldsOf(was, step)
    // Место считается по шагам, которые есть в обоих флоу: иначе сдвиг от чужого шага выглядит перестановкой.
    const kind = fields.length > 0 ? 'changed' : moved(from, at) ? 'moved' : 'same'
    return { kind, title: step.title, at, from: from[at], step, fields }
  })

  before.forEach((step, index) => {
    if (!taken.has(index))
      changes.push({ kind: 'removed', title: step.title, at: -1, from: index, step, fields: [] })
  })

  return changes
}

/** Шаг переставлен, если порядок уцелевших шагов вокруг него изменился: чужие шаги места не сдвигают. */
function moved(from: number[], at: number) {
  const order = from.filter((index) => index >= 0)
  const place = from.slice(0, at).filter((index) => index >= 0).length
  return order[place] !== [...order].sort((a, b) => a - b)[place]
}

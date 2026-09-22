import type { FlowStage } from './Flow'

/**
 * Стадия из ответа Чудо-Юдо: of — название стадии контекста, которую она переписывает. У новой стадии его нет:
 * пустые поля API не пишет, поэтому of приходит не null, а не приходит вовсе.
 */
export type RewrittenStage = { of?: string | null; stage: FlowStage }

export type StageFieldName = 'title' | 'executor' | 'output' | 'skip' | 'helpers' | 'description'

export type StageFieldChange = { field: StageFieldName; before: string | null; after: string | null }

/**
 * Что стало со стадией контекста или новой стадией: title — название, каким оно стало; of — прежнее
 * название, у новой стадии его нет. У стадии без правок fields пуст.
 */
export type StageChange = {
  kind: 'added' | 'changed' | 'same'
  title: string
  of: string | null
  stage: FlowStage
  fields: StageFieldChange[]
}

const fieldNames: StageFieldName[] = ['title', 'executor', 'output', 'skip', 'helpers', 'description']

const value = (stage: FlowStage, field: StageFieldName) => {
  const raw = field === 'helpers' ? (stage.helpers ?? []).join(', ') : stage[field]
  return raw === null || raw === undefined || raw.trim() === '' ? null : raw
}

const norm = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase()

/**
 * Разбор ответа: сначала стадии, которые агент вернул, в его порядке, — прежний их вид берётся из stages
 * раздела, — следом стадии контекста, которых он не вернул или вернул как было: они стоят строкой «без правок».
 */
export function stageChanges(stages: FlowStage[], rewritten: RewrittenStage[], context: FlowStage[]): StageChange[] {
  const changes: StageChange[] = rewritten.map(({ of, stage }) => {
    const was = of == null ? undefined : stages.find((one) => norm(one.title) === norm(of))
    if (!was) return { kind: 'added', title: stage.title, of: null, stage, fields: [] }

    const fields = fieldNames
      .map((field) => ({ field, before: value(was, field), after: value(stage, field) }))
      .filter((change) => change.before !== change.after)
    return { kind: fields.length > 0 ? 'changed' : 'same', title: stage.title, of: was.title, stage, fields }
  })

  for (const stage of context)
    if (!changes.some((change) => change.of !== null && norm(change.of) === norm(stage.title)))
      changes.push({ kind: 'same', title: stage.title, of: stage.title, stage, fields: [] })

  return changes
}

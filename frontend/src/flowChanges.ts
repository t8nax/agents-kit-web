import type { FlowStage, NamedFlow, StageReturn } from './Flow'

/**
 * Правки, до которых договорились в переписке о флоу (B-242). of — название этапа или имя сценария на экране,
 * у нового его нет; stage и flow — каким он стал, у удалённого их нет. Пустые поля API не пишет: вместо null поле
 * просто не приходит.
 */
export type StageChange = { of?: string | null; stage?: FlowStage | null }
export type ScenarioChange = { of?: string | null; flow?: NamedFlow | null }
export type FlowProposal = { scenarios: ScenarioChange[]; stages: StageChange[] }

/** Сколько сценариев и этапов тронул один ответ агента. */
export type FlowChanged = { scenarios: number; stages: number }

export type StageFieldName = 'title' | 'executor' | 'output' | 'skip' | 'helpers' | 'description'

export type StageFieldChange = { field: StageFieldName; before: string | null; after: string | null }

export type ChangeKind = 'added' | 'changed' | 'removed'

/**
 * Этап в списке изменений: title — каким он стал, у удалённого — каким был; of — название на экране. flows — сценарии,
 * где он стоит с правками, а у удалённого — где стоял.
 */
export type StageItem = {
  kind: ChangeKind
  title: string
  of: string | null
  stage: FlowStage | null
  fields: StageFieldChange[]
  flows: string[]
  /** Правка этапа, который оператор убрал из раздела после ответа: «Принять правки» заведёт его снова. */
  gone?: string
}

/** Звено цепочки сценария: этап на своём месте, новый в сценарии или убранный из него. */
export type ChainLink = { title: string; mark: 'same' | 'added' | 'removed' }

/** Сценарий в списке изменений: chain — этапы по порядку, returns — его возвраты, если их правили, иначе null. */
export type ScenarioItem = {
  kind: ChangeKind
  name: string
  of: string | null
  flow: NamedFlow | null
  chain: ChainLink[]
  returns: string[] | null
  /** Правка сценария, который оператор убрал из раздела после ответа: «Принять правки» заведёт его снова. */
  gone?: string
}

/** Число и слово в нужной форме: «1 этап», «2 этапа», «5 этапов». */
function counted(n: number, one: string, few: string, many: string) {
  const tens = n % 100
  const units = n % 10
  const word = tens >= 11 && tens <= 14 ? many : units === 1 ? one : units >= 2 && units <= 4 ? few : many
  return `${n} ${word}`
}

/** «2 сценария, 1 этап» — сколько тронул ответ; ноль не называется. */
export function changedText(changed: FlowChanged) {
  return [
    changed.scenarios > 0 ? counted(changed.scenarios, 'сценарий', 'сценария', 'сценариев') : null,
    changed.stages > 0 ? counted(changed.stages, 'этап', 'этапа', 'этапов') : null,
  ]
    .filter(Boolean)
    .join(', ')
}

const fieldNames: StageFieldName[] = ['title', 'executor', 'output', 'skip', 'helpers', 'description']

/** Значение поля этапа строкой; пустое — null. */
export const fieldValue = (stage: FlowStage, field: StageFieldName) => {
  const raw = field === 'helpers' ? (stage.helpers ?? []).join(', ') : stage[field]
  return raw === null || raw === undefined || raw.trim() === '' ? null : raw
}

const norm = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase()

const sameStage = (one: FlowStage, other: FlowStage) => fieldNames.every((field) => fieldValue(one, field) === fieldValue(other, field))

const returnsOf = (flow: NamedFlow) =>
  flow.entries.flatMap((entry) =>
    (entry.returns ?? []).map((back: StageReturn) => `${entry.stage} → ${back.stage}: ${back.condition}`),
  )

const sameFlow = (one: NamedFlow, other: NamedFlow) =>
  norm(one.name) === norm(other.name) &&
  (one.when ?? '') === (other.when ?? '') &&
  one.entries.length === other.entries.length &&
  one.entries.every((entry, i) => norm(entry.stage) === norm(other.entries[i].stage)) &&
  returnsOf(one).join('\n') === returnsOf(other).join('\n')

/**
 * Правки, которых на экране ещё нет: записанное оператором из списка уходит само, как и удаление того, чего
 * в разделе уже нет.
 */
export function pending(stages: FlowStage[], flows: NamedFlow[], proposal: FlowProposal): FlowProposal {
  return {
    stages: proposal.stages.filter((change) => {
      const was = change.of == null ? undefined : stages.find((one) => norm(one.title) === norm(change.of!))
      if (!change.stage) return was !== undefined
      const now = was ?? stages.find((one) => norm(one.title) === norm(change.stage!.title))
      return !now || !sameStage(now, change.stage)
    }),
    scenarios: proposal.scenarios.filter((change) => {
      const was = change.of == null ? undefined : flows.find((one) => norm(one.name) === norm(change.of!))
      if (!change.flow) return was !== undefined
      const now = was ?? flows.find((one) => norm(one.name) === norm(change.flow!.name))
      return !now || !sameFlow(now, change.flow)
    }),
  }
}

/** Флоу раздела с правками — чтобы сказать, в каких сценариях этап окажется. */
function applied(flows: NamedFlow[], proposal: FlowProposal) {
  const renamed = new Map<string, string>()
  for (const change of proposal.stages)
    if (change.of != null && change.stage && norm(change.of) !== norm(change.stage.title))
      renamed.set(norm(change.of), change.stage.title)
  const follow = (title: string) => renamed.get(norm(title)) ?? title

  let result = flows.map((flow) => ({ ...flow, entries: flow.entries.map((entry) => ({ ...entry, stage: follow(entry.stage) })) }))
  for (const change of proposal.scenarios) {
    const at = change.of == null ? -1 : result.findIndex((one) => norm(one.name) === norm(change.of!))
    if (at < 0) {
      if (change.flow) result = [...result, change.flow]
    } else result = change.flow ? result.map((one, i) => (i === at ? change.flow! : one)) : result.filter((_, i) => i !== at)
  }
  return { flows: result, follow }
}

const standsIn = (flows: NamedFlow[], title: string) =>
  flows.filter((flow) => flow.entries.some((entry) => norm(entry.stage) === norm(title))).map((flow) => flow.name)

/** Список изменений: сценарии и этапы, которых правки касаются, в порядке их правок. */
export function proposalItems(
  stages: FlowStage[],
  flows: NamedFlow[],
  proposal: FlowProposal,
): { scenarios: ScenarioItem[]; stages: StageItem[] } {
  const { flows: after, follow } = applied(flows, proposal)

  const stageItems = proposal.stages.flatMap((change): StageItem[] => {
    const was = change.of == null ? undefined : stages.find((one) => norm(one.title) === norm(change.of!))
    if (!change.stage) {
      if (!was) return []
      return [{ kind: 'removed', title: was.title, of: was.title, stage: null, fields: [], flows: standsIn(flows, was.title) }]
    }
    const stage = change.stage
    const place = standsIn(after, stage.title)
    if (!was)
      return [{ kind: 'added', title: stage.title, of: null, stage, fields: [], flows: place, ...(change.of != null ? { gone: change.of } : {}) }]
    const fields = fieldNames
      .map((field) => ({ field, before: fieldValue(was, field), after: fieldValue(stage, field) }))
      .filter((field) => field.before !== field.after)
    return fields.length === 0 ? [] : [{ kind: 'changed', title: stage.title, of: was.title, stage, fields, flows: place }]
  })

  const scenarioItems = proposal.scenarios.flatMap((change): ScenarioItem[] => {
    const was = change.of == null ? undefined : flows.find((one) => norm(one.name) === norm(change.of!))
    if (!change.flow) {
      if (!was) return []
      return [{ kind: 'removed', name: was.name, of: was.name, flow: null, chain: chainOf(was.entries.map((e) => e.stage), []), returns: null }]
    }
    const flow = change.flow
    const now = flow.entries.map((entry) => entry.stage)
    if (!was)
      return [
        {
          kind: 'added',
          name: flow.name,
          of: null,
          flow,
          chain: chainOf([], now),
          returns: returnsOf(flow).length > 0 ? returnsOf(flow) : null,
          ...(change.of != null ? { gone: change.of } : {}),
        },
      ]
    // Этап, переименованный теми же правками, в сценарии не убран и не добавлен: он стоит на своём месте.
    const before = was.entries.map((entry) => follow(entry.stage))
    const renamedWas = { ...was, entries: was.entries.map((entry) => ({ ...entry, stage: follow(entry.stage), returns: (entry.returns ?? []).map((back) => ({ ...back, stage: follow(back.stage) })) })) }
    const returns = returnsOf(renamedWas).join('\n') === returnsOf(flow).join('\n') ? null : returnsOf(flow)
    return [{ kind: 'changed', name: flow.name, of: was.name, flow, chain: chainOf(before, now), returns }]
  })

  return { scenarios: scenarioItems, stages: stageItems }
}

/**
 * Этапы сценария по новому порядку: новый в сценарии помечен, убранный стоит там, где был, — после этапа, который
 * шёл перед ним и остался.
 */
function chainOf(before: string[], after: string[]): ChainLink[] {
  const chain: ChainLink[] = after.map((title) => ({
    title,
    mark: before.some((one) => norm(one) === norm(title)) ? 'same' : 'added',
  }))
  before.forEach((title, i) => {
    if (after.some((one) => norm(one) === norm(title))) return
    const previous = before.slice(0, i).reverse().find((one) => chain.some((link) => norm(link.title) === norm(one)))
    const at = previous === undefined ? 0 : chain.findIndex((link) => norm(link.title) === norm(previous)) + 1
    chain.splice(at, 0, { title, mark: 'removed' })
  })
  return chain
}

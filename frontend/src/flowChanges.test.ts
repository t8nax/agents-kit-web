import { describe, expect, it } from 'vitest'
import type { FlowStep } from './Flow'
import { flowChanges } from './flowChanges'

const step = (title: string, patch: Partial<FlowStep> = {}): FlowStep => ({
  title,
  executor: 'оркестратор',
  output: `выход ${title}`,
  skip: null,
  description: null,
  ...patch,
})

describe('flowChanges', () => {
  it('нетронутый флоу не даёт правок', () => {
    const steps = [step('Критерий'), step('Мерж')]

    expect(flowChanges(steps, steps).map((c) => c.kind)).toEqual(['same', 'same'])
  })

  it('новый шаг посреди флоу добавлен, а соседи остаются на месте', () => {
    const before = [step('Критерий'), step('Мерж')]
    const after = [step('Критерий'), step('Ревью', { executor: 'reviewer' }), step('Мерж')]

    const changes = flowChanges(before, after)

    expect(changes.map((c) => c.kind)).toEqual(['same', 'added', 'same'])
    expect(changes[1]).toMatchObject({ title: 'Ревью', at: 1, from: -1 })
  })

  it('правка ключей шага собрана по полям с прежним и новым значением', () => {
    const before = [step('Мерж', { output: 'sha в dev', skip: 'правка в текстах' })]
    const after = [step('Мерж', { output: 'sha в dev после ревью', skip: null, description: '1.1. Мержить.' })]

    const change = flowChanges(before, after)[0]

    expect(change.kind).toBe('changed')
    expect(change.fields).toEqual([
      { field: 'output', before: 'sha в dev', after: 'sha в dev после ревью' },
      { field: 'skip', before: 'правка в текстах', after: null },
      { field: 'description', before: null, after: '1.1. Мержить.' },
    ])
  })

  it('перестановка шагов видна обоим переехавшим', () => {
    const before = [step('Критерий'), step('Ветка'), step('Мерж')]
    const after = [step('Ветка'), step('Критерий'), step('Мерж')]

    const changes = flowChanges(before, after)

    expect(changes.map((c) => c.kind)).toEqual(['moved', 'moved', 'same'])
    expect(changes[0]).toMatchObject({ title: 'Ветка', at: 0, from: 1 })
  })

  it('удалённый шаг идёт после новых, со своим прежним местом', () => {
    const before = [step('Критерий'), step('Приёмка'), step('Мерж')]
    const after = [step('Критерий'), step('Мерж')]

    const changes = flowChanges(before, after)

    expect(changes.map((c) => c.kind)).toEqual(['same', 'same', 'removed'])
    expect(changes[2]).toMatchObject({ title: 'Приёмка', at: -1, from: 1 })
  })

  it('переименованный шаг — удалённый и добавленный: по названию пары ему нет', () => {
    const before = [step('Приёмка')]
    const after = [step('Показ оператору')]

    expect(flowChanges(before, after).map((c) => c.kind)).toEqual(['added', 'removed'])
  })

  it('шаги с одинаковым названием разбираются по порядку', () => {
    const before = [step('Проверки', { output: 'первый' }), step('Проверки', { output: 'второй' })]
    const after = [step('Проверки', { output: 'первый' }), step('Проверки', { output: 'второй, теперь с e2e' })]

    const changes = flowChanges(before, after)

    expect(changes.map((c) => c.kind)).toEqual(['same', 'changed'])
    expect(changes[1].fields).toEqual([{ field: 'output', before: 'второй', after: 'второй, теперь с e2e' }])
  })
})

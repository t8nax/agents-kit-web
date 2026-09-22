import { describe, expect, it } from 'vitest'
import type { FlowStage } from './Flow'
import { stageChanges } from './flowChanges'

const stage = (title: string, patch: Partial<FlowStage> = {}): FlowStage => ({
  title,
  executor: 'оркестратор',
  output: `выход ${title}`,
  skip: null,
  description: null,
  helpers: [],
  ...patch,
})

const review = stage('Ревью', { executor: 'reviewer', slug: 'review' })
const merge = stage('Мерж', { slug: 'merge' })
const stages = [review, merge]

describe('stageChanges', () => {
  it('переписанная стадия называет поля «было → стало», а не тронутые оставляет', () => {
    const changes = stageChanges(
      stages,
      [{ of: 'Ревью', stage: { ...review, output: 'вердикт по sha', skip: 'правка в текстах' } }],
      [review],
    )

    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('changed')
    expect(changes[0].of).toBe('Ревью')
    expect(changes[0].fields).toEqual([
      { field: 'output', before: 'выход Ревью', after: 'вердикт по sha' },
      { field: 'skip', before: null, after: 'правка в текстах' },
    ])
  })

  it('переименование — поле «название», помощники читаются строкой', () => {
    const changes = stageChanges(
      stages,
      [{ of: 'Мерж', stage: { ...merge, title: 'Слияние', helpers: ['check-runner', 'scout'] } }],
      [merge],
    )

    expect(changes[0].title).toBe('Слияние')
    expect(changes[0].fields).toEqual([
      { field: 'title', before: 'Мерж', after: 'Слияние' },
      { field: 'helpers', before: null, after: 'check-runner, scout' },
    ])
  })

  it('новая стадия — добавлена, стадия контекста, которую агент не вернул или вернул как было, — без правок', () => {
    const docs = stage('Документация', { executor: 'оператор' })
    const changes = stageChanges(stages, [{ of: null, stage: docs }, { of: 'Мерж', stage: merge }], [review, merge])

    expect(changes.map((c) => [c.kind, c.title])).toEqual([
      ['added', 'Документация'],
      ['same', 'Мерж'],
      ['same', 'Ревью'],
    ])
  })

  it('новая стадия из API приходит без of вовсе', () => {
    const docs = stage('Документация')

    expect(stageChanges(stages, [{ stage: docs }], []).map((c) => [c.kind, c.of])).toEqual([['added', null]])
  })

  it('прежний вид стадии берётся из раздела, даже когда контекст не известен', () => {
    const changes = stageChanges(stages, [{ of: 'ревью', stage: { ...review, output: 'вердикт' } }], [])

    expect(changes.map((c) => [c.kind, c.of])).toEqual([['changed', 'Ревью']])
  })
})

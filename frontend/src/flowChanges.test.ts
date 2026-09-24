import { describe, expect, it } from 'vitest'
import type { FlowStage, NamedFlow } from './Flow'
import { pending, proposalItems } from './flowChanges'

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
const design = stage('Дизайн', { executor: 'designer', slug: 'design' })
const stages = [review, merge, design]

const big: NamedFlow = {
  name: 'крупный',
  when: 'много работы',
  entries: [{ stage: 'Дизайн' }, { stage: 'Ревью' }, { stage: 'Мерж', returns: [{ condition: 'dev ушёл', stage: 'Ревью' }] }],
}
const small: NamedFlow = { name: 'мелкий', when: 'мало', entries: [{ stage: 'Ревью' }, { stage: 'Мерж' }] }
const flows = [big, small]

describe('proposalItems', () => {
  it('переписанный этап называет поля «было → стало» и сценарии, где стоит', () => {
    const items = proposalItems(stages, flows, {
      scenarios: [],
      stages: [{ of: 'Ревью', stage: { ...review, output: 'вердикт по sha', skip: 'правка в текстах' } }],
    })

    expect(items.stages).toEqual([
      {
        kind: 'changed',
        title: 'Ревью',
        of: 'Ревью',
        stage: { ...review, output: 'вердикт по sha', skip: 'правка в текстах' },
        fields: [
          { field: 'output', before: 'выход Ревью', after: 'вердикт по sha' },
          { field: 'skip', before: null, after: 'правка в текстах' },
        ],
        flows: ['крупный', 'мелкий'],
      },
    ])
  })

  it('новый этап — «новый» со сценарием, куда его поставили; удалённый — со сценариями, где стоял', () => {
    const docs = stage('Документация')
    const items = proposalItems(stages, flows, {
      scenarios: [{ of: 'мелкий', flow: { ...small, entries: [...small.entries, { stage: 'Документация' }] } }],
      stages: [{ stage: docs }, { of: 'Дизайн' }],
    })

    expect(items.stages.map((one) => [one.kind, one.title, one.flows])).toEqual([
      ['added', 'Документация', ['мелкий']],
      ['removed', 'Дизайн', ['крупный']],
    ])
  })

  it('цепочка сценария: новый этап помечен, убранный стоит на своём месте, переименованный — не новый', () => {
    const items = proposalItems(stages, flows, {
      scenarios: [
        {
          of: 'крупный',
          flow: {
            ...big,
            entries: [{ stage: 'Проверка' }, { stage: 'Мерж', returns: [{ condition: 'dev ушёл', stage: 'Проверка' }] }, { stage: 'Документация' }],
          },
        },
      ],
      stages: [{ of: 'Ревью', stage: { ...review, title: 'Проверка' } }, { stage: stage('Документация') }],
    })

    expect(items.scenarios[0].chain).toEqual([
      { title: 'Дизайн', mark: 'removed' },
      { title: 'Проверка', mark: 'same' },
      { title: 'Мерж', mark: 'same' },
      { title: 'Документация', mark: 'added' },
    ])
    // Возврат лишь пошёл за переименованием: правкой возвратов это не считается.
    expect(items.scenarios[0].returns).toBeNull()
  })

  it('правленые возвраты перечислены, новый и удалённый сценарии помечены', () => {
    const items = proposalItems(stages, flows, {
      scenarios: [
        { of: 'мелкий', flow: { ...small, entries: [{ stage: 'Ревью' }, { stage: 'Мерж', returns: [{ condition: 'красное', stage: 'Ревью' }] }] } },
        { flow: { name: 'срочный', when: 'горит', entries: [{ stage: 'Мерж' }] } },
        { of: 'крупный' },
      ],
      stages: [],
    })

    expect(items.scenarios.map((one) => [one.kind, one.name, one.returns])).toEqual([
      ['changed', 'мелкий', ['Мерж → Ревью: красное']],
      ['added', 'срочный', null],
      ['removed', 'крупный', null],
    ])
  })
})

describe('pending', () => {
  it('правки, которые раздел уже держит, и удаление того, чего нет, уходят', () => {
    const docs = stage('Документация')
    const kept = { of: 'мелкий', flow: { ...small, when: 'совсем мало' } }

    const left = pending([{ ...review, title: 'Проверка' }, merge, { ...docs, slug: 'docs' }], [small], {
      scenarios: [kept, { of: 'крупный' }],
      stages: [{ of: 'Ревью', stage: { ...review, title: 'Проверка' } }, { stage: docs }, { of: 'Дизайн' }],
    })

    expect(left).toEqual({ scenarios: [kept], stages: [] })
  })
})

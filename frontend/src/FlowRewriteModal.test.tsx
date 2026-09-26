import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { FlowStage, NamedFlow } from './Flow'
import FlowRewriteModal, { type RewriteEvent } from './FlowRewriteModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'
import { changedText, type FlowProposal } from './flowChanges'

afterEach(() => {
  vi.unstubAllGlobals()
})

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
const merge = stage('Мерж', { output: 'sha в dev', slug: 'merge' })
const design = stage('Дизайн', { executor: 'designer', slug: 'design' })
const stages = [review, merge, design]

const big: NamedFlow = {
  name: 'крупный',
  when: 'много работы',
  entries: [{ stage: 'Дизайн' }, { stage: 'Ревью' }, { stage: 'Мерж' }],
}
const small: NamedFlow = { name: 'мелкий', when: 'мало работы', entries: [{ stage: 'Ревью' }, { stage: 'Мерж' }] }
const flows = [big, small]

const docs = stage('Документация', { output: 'раздел README' })

/** Правки: документация после мержа в крупном, ревью смотрит тесты. */
const proposal: FlowProposal = {
  scenarios: [{ of: 'крупный', flow: { ...big, entries: [...big.entries, { stage: 'Документация' }] } }],
  stages: [{ stage: docs }, { of: 'Ревью', stage: { ...review, output: 'вердикт и тесты' } }],
}

const base = String.raw`D:\Projects\app-knowledge`

function stubFetch(stream: { body: ReadableStream<Uint8Array> }, running?: ReturnType<typeof runningRequest>) {
  const replies: Record<string, unknown>[] = []
  const stops: string[] = []
  const panel = stubPanel('flow', stream, {
    running,
    project: 'Agents Kit Web',
    others: (url, init) => {
      if (url === '/api/flow/rewrite/reply') {
        replies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(null, { status: 204 })
      }
      if (url === '/api/flow/rewrite/stop') {
        stops.push(url)
        return new Response(null, { status: 204 })
      }
      return null
    },
  })
  return { ...panel, replies, stops }
}

function renderModal(
  options: {
    apply?: () => Promise<string | null>
    lockedFlow?: (name: string) => string[] | null
    screen?: { stages: FlowStage[]; flows: NamedFlow[] }
  } = {},
) {
  const onApply = vi.fn(options.apply ?? (async () => null))
  const onClose = vi.fn()
  const props = {
    base,
    project: 'Agents Kit Web',
    mark: (title: string) => <span data-testid={`mark-${title}`} />,
    lockedStage: () => null,
    lockedFlow: options.lockedFlow ?? (() => null),
    onApply,
    onClose,
  }
  const view = render(
    <FlowRewriteModal {...props} stages={options.screen?.stages ?? stages} flows={options.screen?.flows ?? flows} />,
  )
  const rerender = (next: { stages: FlowStage[]; flows: NamedFlow[] }) =>
    view.rerender(<FlowRewriteModal {...props} stages={next.stages} flows={next.flows} />)
  return { onApply, onClose, rerender, unmount: view.unmount }
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText(/^(Просьба|Следующая реплика)$/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

/** Переписка, в которой агент ответил правками. */
async function answered() {
  const stream = controlledStream<RewriteEvent>()
  const panel = stubFetch(stream)
  const view = renderModal()
  await say('Заведи документацию и пусть ревью смотрит тесты')
  stream.send({ type: 'reply', text: 'Заведи документацию и пусть ревью смотрит тесты' })
  stream.send({ type: 'answer', text: 'Завёл **документацию**.', durationMs: 41000, proposal, changed: { scenarios: 1, stages: 2 } })
  await screen.findByText('документацию')
  return { stream, ...panel, ...view }
}

test('просьба уходит с флоу раздела целиком, «+ Этапы» нет, ход работы виден до ответа', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { posts } = stubFetch(stream)
  renderModal()

  expect(screen.queryByRole('button', { name: /Этапы/ })).not.toBeInTheDocument()
  await say('  Заведи этап документации  ')
  stream.send({ type: 'reply', text: 'Заведи этап документации' })

  expect(await screen.findByText('Чудо-Юдо читает флоу Agents Kit Web…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/flow/rewrite')
  expect(posts[0].body).toEqual({ base, wish: 'Заведи этап документации', stages, flows })

  stream.send({ type: 'step', text: 'читает flow/stages/review.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-Юдо' })
  expect(within(steps).getByText('читает flow/stages/review.md')).toBeInTheDocument()
  // Пока агент отвечает, на месте «Отправить» стоит «Отменить».
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument()
})

test('ответ, вернутый на доработку, остаётся строкой панели, а агент дописывает его', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  renderModal()

  await say('Заведи документацию')
  stream.send({ type: 'reply', text: 'Заведи документацию' })
  stream.send({ type: 'step', text: 'читает flow/stages/review.md' })
  const rework =
    'Этап «Документация» вернулся не в форме кита: не указан выход. Панель вернула ответ Чудо-Юдо на доработку.'
  stream.send({ type: 'rework', text: rework })

  expect(await screen.findByText('Чудо-Юдо дописывает ответ…')).toBeInTheDocument()
  expect(screen.getByText(rework)).toBeInTheDocument()
  // Ход доработки — свой: шаги первого ответа уходят вместе с ним.
  expect(screen.queryByText('читает flow/stages/review.md')).not.toBeInTheDocument()
  stream.send({ type: 'step', text: 'дописывает этап «Документация»' })
  expect(await screen.findByText('дописывает этап «Документация»')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument()

  stream.send({ type: 'answer', text: 'Дописал выход.', durationMs: 20000, proposal, changed: { scenarios: 1, stages: 2 } })
  expect(await screen.findByText('Дописал выход.')).toBeInTheDocument()
  // След доработки остаётся над исправленным ответом, ожидания больше нет.
  expect(screen.getByText(rework)).toBeInTheDocument()
  expect(screen.queryByText('Чудо-Юдо дописывает ответ…')).not.toBeInTheDocument()
  expect(screen.getByText(/В изменениях/)).toBeInTheDocument()
})

test('ответ-вопрос остаётся в переписке, а вкладка «Изменения» погашена', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { replies } = stubFetch(stream)
  renderModal()

  await say('Заведи документацию')
  stream.send({ type: 'reply', text: 'Заведи документацию' })
  stream.send({ type: 'answer', text: 'В обоих сценариях?', durationMs: 5000, proposal: { scenarios: [], stages: [] } })

  expect(await screen.findByText('В обоих сценариях?')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: /^Изменения/ })).toBeDisabled()
  expect(screen.queryByText(/В изменениях/)).not.toBeInTheDocument()

  // Следующая реплика несёт флоу раздела, каким он стал.
  await say('В обоих')
  expect(replies).toEqual([{ text: 'В обоих', stages, flows }])
})

test('ответ с правками: строка «В изменениях» считает их числом, на вкладке точка, ссылка открывает список', async () => {
  await answered()

  expect(screen.getByText(/В изменениях:/)).toBeInTheDocument()
  const link = screen.getByRole('button', { name: '1 сценарий, 2 этапа' })
  expect(screen.getByLabelText('Список изменён последним ответом')).toBeInTheDocument()

  fireEvent.click(link)

  expect(screen.getByRole('tab', { name: /^Изменения/ })).toHaveAttribute('aria-selected', 'true')
  expect(screen.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
  const list = screen.getByLabelText('Изменения флоу')
  expect(within(list).getByText('Сценарии')).toBeInTheDocument()
  expect(within(list).getByText('Этапы')).toBeInTheDocument()
  expect(within(list).getAllByText('Документация')).toHaveLength(2)
  expect(within(list).getByText('в сценарии «крупный»')).toBeInTheDocument()
  // На вкладке «Изменения» поля нет, а кнопки свои.
  expect(screen.queryByLabelText('Следующая реплика')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Новая переписка' })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeEnabled()
  expect(screen.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument()
})

test('ответ-вопрос после правок список не трогает и точку не зажигает', async () => {
  const { stream } = await answered()
  fireEvent.click(screen.getByRole('button', { name: '1 сценарий, 2 этапа' }))
  fireEvent.click(screen.getByRole('tab', { name: 'Переписка' }))

  await say('А тесты какие?')
  stream.send({ type: 'reply', text: 'А тесты какие?' })
  // Вопрос несёт прежние правки: бэкенд отдаёт с каждым ответом все правки переписки.
  stream.send({ type: 'answer', text: 'Юнит или e2e?', durationMs: 3000, proposal })

  expect(await screen.findByText('Юнит или e2e?')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Изменения' })).toBeEnabled()
  expect(screen.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
  expect(screen.getAllByText(/В изменениях:/)).toHaveLength(1)
})

test('окно, открытое заново, не зажигает точку от списка, который уже смотрели', async () => {
  localStorage.clear()
  const { unmount } = await answered()
  fireEvent.click(screen.getByRole('button', { name: '1 сценарий, 2 этапа' }))
  unmount()

  // Окно открыли заново: переписка та же, её поток читается с начала.
  const again = controlledStream<RewriteEvent>()
  stubFetch(again, runningRequest('flow', 'Заведи документацию', base, 'Agents Kit Web'))
  renderModal()
  again.send({ type: 'reply', text: 'Заведи документацию' })
  again.send({ type: 'answer', text: 'Завёл **документацию**.', durationMs: 41000, proposal, changed: { scenarios: 1, stages: 2 } })

  expect(await screen.findByText('документацию')).toBeInTheDocument()
  expect(screen.getByRole('tab', { name: 'Изменения' })).toBeEnabled()
  expect(screen.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
})

test('правка этапа, убранного из раздела после ответа, говорит, что «Принять правки» заведёт его снова', async () => {
  const { rerender } = await answered()
  fireEvent.click(screen.getByRole('button', { name: '1 сценарий, 2 этапа' }))

  rerender({ stages: [merge, design], flows })
  fireEvent.click(screen.getByText('Ревью', { selector: '.rewrite-item-name' }))

  expect(await screen.findByText('Этапа «Ревью» в разделе уже нет: «Принять правки» заведёт его снова.')).toBeInTheDocument()
})

test('у изменённого этапа всегда исполнитель, выход и «Открыть описание»; поменявшееся — «было → стало»', async () => {
  await answered()
  fireEvent.click(screen.getByRole('button', { name: '1 сценарий, 2 этапа' }))

  // Ревью: выход поменялся, исполнитель и описание — нет.
  fireEvent.click(screen.getByText('Ревью', { selector: '.rewrite-item-name' }))
  const item = within(screen.getByText('Ревью', { selector: '.rewrite-item-name' }).closest('details')!)
  expect(item.getByText('исполнитель')).toBeInTheDocument()
  expect(item.getByText('reviewer')).toBeInTheDocument()
  expect(item.getByText('выход Ревью')).toHaveClass('rewrite-was')
  expect(item.getByText('вердикт и тесты')).toHaveClass('rewrite-now')
  expect(item.getByText('описание')).toBeInTheDocument()
  // Описания у ревью нет — так и сказано; пропуска и помощников нет — их строк нет.
  expect(item.getByText('нет')).toBeInTheDocument()
  expect(item.queryByText('пропуск')).not.toBeInTheDocument()
  expect(item.queryByText('помощники')).not.toBeInTheDocument()
})

test('пропуск и помощники нового этапа стоят простыми значениями, а пустой выход — словом «нет»', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  renderModal()
  await say('Заведи документацию')
  const helped = { ...docs, output: '', skip: 'правка только в тестах', helpers: ['scout', 'check-runner'] }
  stream.send({ type: 'answer', text: 'Готово.', proposal: { scenarios: [], stages: [{ stage: helped }] }, changed: { scenarios: 0, stages: 1 } })
  fireEvent.click(await screen.findByRole('button', { name: '1 этап' }))
  fireEvent.click(screen.getByText('Документация', { selector: '.rewrite-item-name' }))

  const item = within(screen.getByText('Документация', { selector: '.rewrite-item-name' }).closest('details')!)
  expect(item.getByText('пропуск')).toBeInTheDocument()
  expect(item.getByText('правка только в тестах')).not.toHaveClass('rewrite-was')
  expect(item.getByText('помощники')).toBeInTheDocument()
  expect(item.getByText('scout, check-runner')).toBeInTheDocument()
  // «Нет» ищется в строке выхода: у описания своя строка со своим «нет».
  const output = item.getByText('выход').closest('.rewrite-field')!
  expect(within(output as HTMLElement).getByText('нет')).toHaveClass('rewrite-none')
})

test('убранные у этапа пропуск и помощники стоят строками «было → нет»', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  const skipped = { ...review, skip: 'правка только в текстах', helpers: ['scout'] }
  renderModal({ screen: { stages: [skipped, merge, design], flows } })
  await say('Убери пропуск у ревью')
  stream.send({
    type: 'answer',
    text: 'Готово.',
    proposal: { scenarios: [], stages: [{ of: 'Ревью', stage: { ...skipped, skip: null, helpers: [] } }] },
    changed: { scenarios: 0, stages: 1 },
  })
  fireEvent.click(await screen.findByRole('button', { name: '1 этап' }))
  fireEvent.click(screen.getByText('Ревью', { selector: '.rewrite-item-name' }))

  const item = within(screen.getByText('Ревью', { selector: '.rewrite-item-name' }).closest('details')!)
  const row = (label: string) => within(item.getByText(label).closest('.rewrite-field') as HTMLElement)
  expect(row('пропуск').getByText('правка только в текстах')).toHaveClass('rewrite-was')
  expect(row('пропуск').getByText('нет')).toHaveClass('rewrite-now')
  expect(row('помощники').getByText('scout')).toHaveClass('rewrite-was')
  expect(row('помощники').getByText('нет')).toHaveClass('rewrite-now')
})

test('«Открыть описание» открывает описание окном вкладки «Этапы» только для чтения', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  renderModal()
  await say('Заведи документацию')
  const described = { ...docs, description: '## Порядок\n\n1. Прочитать **дифф**.' }
  stream.send({ type: 'answer', text: 'Готово.', proposal: { scenarios: [], stages: [{ stage: described }] }, changed: { scenarios: 0, stages: 1 } })
  fireEvent.click(await screen.findByRole('button', { name: '1 этап' }))
  fireEvent.click(screen.getByText('Документация', { selector: '.rewrite-item-name' }))

  fireEvent.click(screen.getByRole('button', { name: 'Открыть описание' }))

  const view = within(screen.getByRole('dialog', { name: 'Описание этапа «Документация»' }))
  expect(view.getByRole('heading', { name: 'Порядок' })).toBeInTheDocument()
  expect(view.getByText('дифф').tagName).toBe('STRONG')
  expect(view.queryByRole('button', { name: /Редактировать/ })).not.toBeInTheDocument()
  fireEvent.click(view.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name: 'Описание этапа «Документация»' })).not.toBeInTheDocument()
})

test('«Принять правки» отдаёт разделу правки переписки, а отказ записи остаётся на вкладке', async () => {
  const { onApply } = await answered()
  onApply.mockResolvedValueOnce('Флоу не сохранён: его изменили в базе.')
  fireEvent.click(screen.getByRole('tab', { name: /^Изменения/ }))

  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  expect(await screen.findByText('Флоу не сохранён: его изменили в базе.')).toBeInTheDocument()
  expect(onApply).toHaveBeenCalledWith(proposal)
})

test('записанное уходит из списка: раздел держит правки, и вкладка гаснет', async () => {
  const { rerender } = await answered()
  fireEvent.click(screen.getByRole('tab', { name: /^Изменения/ }))

  rerender({
    stages: [{ ...review, output: 'вердикт и тесты' }, merge, design, { ...docs, slug: 'docs' }],
    flows: [proposal.scenarios[0].flow!, small],
  })

  await waitFor(() => expect(screen.getByRole('tab', { name: /^Изменения/ })).toBeDisabled())
  expect(screen.getByLabelText('Следующая реплика')).toBeInTheDocument()
})

test('занятое задачей помечено замком, строка над списком называет задачи, «Принять правки» погашена', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  renderModal({ lockedFlow: (name) => (name === 'крупный' ? ['B-238'] : null) })
  await say('Заведи документацию')
  stream.send({ type: 'answer', text: 'Готово.', proposal, changed: { scenarios: 1, stages: 2 } })
  fireEvent.click(await screen.findByRole('button', { name: '1 сценарий, 2 этапа' }))

  const line = screen.getByRole('status')
  expect(line).toHaveTextContent('Правки не записать: заняты задачами в работе — сценарий «крупный»B-238.')
  expect(screen.getByTitle('Занят: B-238')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
})

test('«Отменить» обрывает ответ, «Новая переписка» убирает разговор', async () => {
  const stream = controlledStream<RewriteEvent>()
  const { stops, deletes } = stubFetch(stream)
  renderModal()
  await say('Заведи документацию')
  stream.send({ type: 'reply', text: 'Заведи документацию' })

  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))
  expect(stops).toEqual(['/api/flow/rewrite/stop'])

  stream.send({ type: 'stopped', text: 'Чудо-Юдо остановлен: ответа на эту реплику не будет' })
  fireEvent.click(await screen.findByRole('button', { name: 'Новая переписка' }))
  await waitFor(() => expect(deletes).toEqual(['/api/agent/flow']))
})

test('ошибка разбора правок видна в переписке со словами агента', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream)
  renderModal()
  await say('Поправь сборку')
  stream.send({ type: 'reply', text: 'Поправь сборку' })
  stream.send({ type: 'error', text: 'Чудо-Юдо предложил правку этапа «Сборка», которого во флоу нет', output: '=== этап «Сборка»' })

  const error = await screen.findByRole('alert')
  expect(error).toHaveTextContent('Чудо-Юдо предложил правку этапа «Сборка», которого во флоу нет')
  expect(error).toHaveTextContent('=== этап «Сборка»')
})

test('переписка про флоу другого проекта не показывается, а окно говорит, что новая её уберёт', async () => {
  const stream = controlledStream<RewriteEvent>()
  stubFetch(stream, runningRequest('flow', 'Поправь ревью', String.raw`D:\Projects\nota-knowledge`, 'Nota'))
  renderModal()

  expect(await screen.findByText('Идёт переписка о флоу Nota: первая реплика отсюда начнёт новую, а ту уберёт.')).toBeInTheDocument()
  stream.send({ type: 'reply', text: 'Поправь ревью' })
  expect(screen.queryByText('Поправь ревью')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Просьба')).toBeEnabled()
})

test('число правок — в нужной форме, ноль не называется', () => {
  expect(changedText({ scenarios: 1, stages: 0 })).toBe('1 сценарий')
  expect(changedText({ scenarios: 2, stages: 5 })).toBe('2 сценария, 5 этапов')
  expect(changedText({ scenarios: 0, stages: 21 })).toBe('21 этап')
  expect(changedText({ scenarios: 11, stages: 0 })).toBe('11 сценариев')
  expect(changedText({ scenarios: 0, stages: 0 })).toBe('')
})

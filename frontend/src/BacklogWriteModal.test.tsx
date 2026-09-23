import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import BacklogWriteModal, { type Proposal, type WriteBase, type WriteEvent, type WrittenEntry } from './BacklogWriteModal'
import { controlledStream, runningRequest, stubPanel } from './agentPanelTesting'

afterEach(() => {
  vi.unstubAllGlobals()
})

const bases: WriteBase[] = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

const B40: WrittenEntry = {
  number: 'B-40',
  title: 'Показывать, сколько длится задача',
  text: 'В часах и минутах.',
  type: 'фича',
  priority: 'высокий',
}
const B36: WrittenEntry = { number: 'B-36', title: 'Выгрузка бэклога в CSV', text: 'Нужна выгрузка.' }

const proposal: Proposal = {
  id: 'p1',
  changes: [
    { kind: 'change', number: 'B-40', entry: B40 },
    { kind: 'delete', number: 'B-36', entry: B36 },
  ],
}

/** Панель с разговором о бэклоге: ответы на реплику, сохранение и отказ тест задаёт сам. */
function stubFetch(
  stream: { body: ReadableStream<Uint8Array> },
  options: { running?: ReturnType<typeof runningRequest>; save?: () => Response } = {},
) {
  const calls: { url: string; body: Record<string, unknown> }[] = []
  const panel = stubPanel('backlog', stream, {
    running: options.running,
    project: 'Nota',
    others: (url, init) => {
      if (!['/api/backlog/write/reply', '/api/backlog/write/stop', '/api/backlog/write/save', '/api/backlog/write/refuse'].includes(url))
        return null
      calls.push({ url, body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} })
      if (url === '/api/backlog/write/save') return options.save?.() ?? Response.json({ commit: 'c0ffee1' })
      return new Response(null, { status: 204 })
    },
  })
  return { ...panel, calls }
}

function renderModal(
  options: { initialBase?: string | null; subject?: { base: string; entry: WrittenEntry } | null } = {},
) {
  const onEntries = vi.fn()
  const onSaved = vi.fn()
  const onClose = vi.fn()
  const view = render(
    <BacklogWriteModal
      bases={bases}
      initialBase={options.initialBase ?? null}
      subject={options.subject ?? null}
      findEntry={(_, number) => [B40, B36].find((entry) => entry.number === number)}
      onClose={onClose}
      onEntries={onEntries}
      onSaved={onSaved}
    />,
  )
  return { onEntries, onSaved, onClose, unmount: view.unmount }
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText('Просьба к Чудо-Юдо'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

function answer(fields: Partial<Extract<WriteEvent, { type: 'answer' }>> = {}): WriteEvent {
  return { type: 'answer', text: '', ...fields }
}

test('просьба из шапки уходит в выбранный проект, ход агента виден, новые записи отмечены «добавлена»', async () => {
  const stream = controlledStream<WriteEvent>()
  const { posts } = stubFetch(stream)
  const { onEntries } = renderModal({ initialBase: bases[1].base })

  expect(screen.getByRole('dialog', { name: 'Чудо-Юдо' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  await say('  Хочу видеть ожидание  ')

  expect(posts[0].url).toBe('/api/backlog/write')
  expect(posts[0].body).toEqual({ base: bases[1].base, text: 'Хочу видеть ожидание' })
  stream.send({ type: 'reply', text: 'Хочу видеть ожидание' })
  expect(await screen.findByText('Чудо-Юдо читает бэклог Nota…')).toBeInTheDocument()
  // После первой просьбы на месте чипов — проект и каталог его базы.
  expect(screen.queryByRole('group', { name: 'Проект' })).not.toBeInTheDocument()
  expect(screen.getByText('nota-knowledge')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Отменить' })).toBeInTheDocument()
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toBeDisabled()

  stream.send({ type: 'step', text: 'правит backlog.md' })
  const steps = await screen.findByRole('list', { name: 'Ход работы Чудо-Юдо' })
  expect(within(steps).getByText('правит backlog.md')).toBeInTheDocument()

  stream.send(
    answer({
      text: 'Записал **B-60**.',
      entries: [{ number: 'B-60', title: 'Ожидание в таблице', text: null }],
      commit: '4f1c2a9',
    }),
  )

  const added = within(await screen.findByRole('list', { name: 'Новые записи' }))
  expect(added.getByText('B-60')).toBeInTheDocument()
  expect(added.getByText('добавлена')).toBeInTheDocument()
  expect(screen.getByText('B-60', { selector: 'strong' })).toBeInTheDocument()
  await waitFor(() => expect(onEntries).toHaveBeenCalledWith(bases[1].base, ['B-60']))
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toBeEnabled()
})

test('окно от записи показывает её первой, называет её в просьбе и не даёт выбрать проект', async () => {
  const stream = controlledStream<WriteEvent>()
  const { posts } = stubFetch(stream)
  renderModal({ subject: { base: bases[0].base, entry: B40 } })

  expect(screen.getByText('Запись')).toBeInTheDocument()
  expect(screen.getByText('Показывать, сколько длится задача')).toBeInTheDocument()
  expect(screen.getByText('высокий')).toBeInTheDocument()
  expect(screen.queryByRole('group', { name: 'Проект' })).not.toBeInTheDocument()
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toHaveAttribute(
    'placeholder',
    'Что поменять в B-40 — или почему она больше не нужна',
  )

  await say('Это блокер')

  expect(posts[0].body).toEqual({ base: bases[0].base, text: 'Это блокер', number: 'B-40' })
})

test('изменение и удаление ждут «Сохранить», а сохранённые отмечены в прошедшем времени', async () => {
  const stream = controlledStream<WriteEvent>()
  const { calls } = stubFetch(stream)
  const { onSaved } = renderModal()

  await say('Убери B-36, в B-40 приоритет высокий')
  stream.send({ type: 'reply', text: 'Убери B-36, в B-40 приоритет высокий' })
  stream.send(answer({ text: 'Сохраню, когда скажете.', proposal }))

  expect(await screen.findByText('Ждут сохранения: изменить 1, удалить 1')).toBeInTheDocument()
  const changes = within(screen.getByRole('list', { name: 'Изменения' }))
  expect(changes.getByText('изменить')).toBeInTheDocument()
  expect(changes.getByText('удалить')).toBeInTheDocument()
  // Удаляемая — номером и заголовком, без текста.
  expect(changes.queryByText('Нужна выгрузка.')).not.toBeInTheDocument()
  expect(changes.getByText('В часах и минутах.')).toBeInTheDocument()
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toHaveAttribute('placeholder', 'Поправить предложение или попросить ещё')

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(calls).toEqual([{ url: '/api/backlog/write/save', body: { id: 'p1' } }]))

  stream.send({ type: 'saved', text: '', commit: 'c0ffee1', proposalId: 'p1' })
  expect(await within(screen.getByRole('list', { name: 'Изменения' })).findByText('изменена')).toBeInTheDocument()
  expect(screen.getByText('удалена')).toBeInTheDocument()
  // Сохранённое уже в бэклоге: отметки зелёные, как у добавленной записи.
  expect(screen.getByText('изменена')).toHaveClass('added')
  expect(screen.getByText('удалена')).toHaveClass('added')
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
  expect(screen.queryByText('Ждут сохранения: изменить 1, удалить 1')).not.toBeInTheDocument()
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith(bases[0].base))
})

test('несохранённое остаётся с кнопками, а причина видна в ответе', async () => {
  const stream = controlledStream<WriteEvent>()
  stubFetch(stream, {
    save: () => Response.json({ error: 'Запись B-36 изменилась после ответа Чудо-Юдо — ничего не записано' }),
  })
  renderModal()

  await say('Убери B-36')
  stream.send({ type: 'reply', text: 'Убери B-36' })
  stream.send(answer({ proposal }))
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText('Запись B-36 изменилась после ответа Чудо-Юдо — ничего не записано')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
})

test('«Отказаться» ничего не пишет: изменения зачёркнуты с отметкой «отказались», новая запись остаётся', async () => {
  const stream = controlledStream<WriteEvent>()
  const { calls } = stubFetch(stream)
  renderModal()

  await say('Запиши мысль и убери B-36')
  stream.send({ type: 'reply', text: 'Запиши мысль и убери B-36' })
  stream.send(answer({ entries: [{ number: 'B-64', title: 'Мысль', text: null }], proposal }))
  fireEvent.click(await screen.findByRole('button', { name: 'Отказаться' }))

  await waitFor(() => expect(calls).toEqual([{ url: '/api/backlog/write/refuse', body: { id: 'p1' } }]))
  stream.send({ type: 'refused', text: '', proposalId: 'p1' })

  expect(await screen.findAllByText('отказались')).toHaveLength(2)
  expect(screen.getByText('добавлена')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
})

test('новая просьба до «Сохранить» уходит в тот же разговор и гасит прежнее предложение', async () => {
  const stream = controlledStream<WriteEvent>()
  const { calls, posts } = stubFetch(stream)
  renderModal()

  await say('Убери B-36')
  stream.send({ type: 'reply', text: 'Убери B-36' })
  stream.send(answer({ proposal }))
  await screen.findByRole('button', { name: 'Сохранить' })

  await say('B-40 не трогай')
  expect(calls).toEqual([{ url: '/api/backlog/write/reply', body: { text: 'B-40 не трогай' } }])
  expect(posts).toHaveLength(1)
  stream.send({ type: 'reply', text: 'B-40 не трогай' })

  expect(await screen.findAllByText('заменено')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()
})

test('пока идёт «Сохранить», новая просьба не уходит', async () => {
  const stream = controlledStream<WriteEvent>()
  // Ответ на «Сохранить» так и не дочитывается: панель всё ещё пишет.
  stubFetch(stream, { save: () => new Response(new ReadableStream({ start: () => {} })) })
  renderModal()

  await say('Убери B-36')
  stream.send({ type: 'reply', text: 'Убери B-36' })
  stream.send(answer({ proposal }))
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toBeDisabled())
})

test('«Отказаться» у предложения, которого панель уже не помнит, говорит об этом', async () => {
  const stream = controlledStream<WriteEvent>()
  stubPanel('backlog', stream, {
    others: (url) => (url === '/api/backlog/write/refuse' ? new Response(null, { status: 404 }) : null),
  })
  renderModal()

  await say('Убери B-36')
  stream.send({ type: 'reply', text: 'Убери B-36' })
  stream.send(answer({ proposal }))
  fireEvent.click(await screen.findByRole('button', { name: 'Отказаться' }))

  expect(await screen.findByText('Предложение уже не ждёт ответа')).toBeInTheDocument()
})

test('запись разговора, удалённая по «Сохранить», отмечена «удалена»', async () => {
  const stream = controlledStream<WriteEvent>()
  stubFetch(stream)
  render(
    <BacklogWriteModal
      bases={bases}
      initialBase={null}
      subject={{ base: bases[0].base, entry: B36 }}
      findEntry={() => undefined}
      onClose={() => {}}
      onEntries={() => {}}
    />,
  )

  await say('Больше не нужна')
  stream.send({ type: 'reply', text: 'Больше не нужна', number: 'B-36' })
  stream.send(answer({ proposal: { id: 'p3', changes: [{ kind: 'delete', number: 'B-36', entry: B36 }] } }))
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
  stream.send({ type: 'saved', text: '', commit: 'c0ffee1', proposalId: 'p3' })

  expect(await screen.findAllByText('удалена')).toHaveLength(2)
})

test('изменённая запись разговора не становится «удалена», даже если бэклог не перечитался', async () => {
  const stream = controlledStream<WriteEvent>()
  stubFetch(stream)
  render(
    <BacklogWriteModal
      bases={bases}
      initialBase={null}
      subject={{ base: bases[0].base, entry: B40 }}
      findEntry={() => undefined}
      onClose={() => {}}
      onEntries={() => {}}
    />,
  )

  await say('Сделай средний')
  stream.send({ type: 'reply', text: 'Сделай средний', number: 'B-40' })
  const lower = { ...B40, title: 'Показывать длительность задачи', priority: 'средний' }
  stream.send(answer({ proposal: { id: 'p4', changes: [{ kind: 'change', number: 'B-40', entry: lower }] } }))
  fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }))
  stream.send({ type: 'saved', text: '', commit: 'c0ffee1', proposalId: 'p4' })

  expect(await screen.findByText('изменена')).toBeInTheDocument()
  expect(screen.queryByText('удалена')).not.toBeInTheDocument()
  // Карточка записи наверху — такая, какой её сохранили.
  expect(screen.getAllByText('Показывать длительность задачи')).toHaveLength(2)
})

test('окно, ещё читающее панель, закрытием разговор не трогает', async () => {
  const stream = controlledStream<WriteEvent>()
  const { deletes } = stubPanel('backlog', stream, {
    // Список просьб панели так и не дочитывается: окно всё ещё узнаёт, идёт ли разговор.
    others: (url) => (url === '/api/agent/requests' ? new Response(new ReadableStream({ start: () => {} })) : null),
  })
  renderModal()

  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))

  expect(deletes).toEqual([])
})

test('объединение: остающаяся запись под «Останется», уходящая — под «Уйдёт в …»', async () => {
  const stream = controlledStream<WriteEvent>()
  stubFetch(stream)
  renderModal()

  await say('B-36 и B-40 — одно')
  stream.send({ type: 'reply', text: 'B-36 и B-40 — одно' })
  stream.send(
    answer({
      proposal: {
        id: 'p2',
        changes: [
          { kind: 'change', number: 'B-40', entry: B40 },
          { kind: 'delete', number: 'B-36', entry: B36, into: 'B-40' },
        ],
      },
    }),
  )

  expect(await screen.findByText('Ждёт сохранения: объединить 2 записи в одну')).toBeInTheDocument()
  expect(screen.getByText('Останется')).toBeInTheDocument()
  expect(screen.getByText('Уйдёт в B-40')).toBeInTheDocument()
})

test('вопрос Чудо-Юдо — ответ без предложения: уточнение уходит следующей репликой', async () => {
  const stream = controlledStream<WriteEvent>()
  const { calls } = stubFetch(stream)
  renderModal()

  await say('Поставь высокий про Telegram')
  stream.send({ type: 'reply', text: 'Поставь высокий про Telegram' })
  stream.send(answer({ text: 'Нашёл B-44 «Уведомлять в Telegram». Та ли это?' }))

  expect(await screen.findByText('Нашёл B-44 «Уведомлять в Telegram». Та ли это?')).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Сохранить' })).not.toBeInTheDocument()

  await say('Да')
  expect(calls).toEqual([{ url: '/api/backlog/write/reply', body: { text: 'Да' } }])
})

test('«Отменить» обрывает ответ, а переписку оставляет', async () => {
  const stream = controlledStream<WriteEvent>()
  const { calls, deletes } = stubFetch(stream)
  renderModal()

  await say('Долгая мысль')
  stream.send({ type: 'reply', text: 'Долгая мысль' })
  fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }))

  await waitFor(() => expect(calls).toEqual([{ url: '/api/backlog/write/stop', body: {} }]))
  expect(deletes).toEqual([])
})

test('закрытое посреди ответа окно агента не трогает, а после ответа убирает разговор', async () => {
  const stream = controlledStream<WriteEvent>()
  const { deletes } = stubFetch(stream)
  const { onClose } = renderModal()

  await say('Мысль')
  stream.send({ type: 'reply', text: 'Мысль' })
  await screen.findByText('Чудо-Юдо читает бэклог Agents Kit Web…')
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(deletes).toEqual([])

  stream.send(answer({ text: 'Готово.' }))
  await screen.findByText('Готово.')
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
  expect(deletes).toEqual(['/api/agent/backlog'])
})

test('окно от записи, закрытое без просьбы, не трогает разговор, который идёт в панели', async () => {
  const stream = controlledStream<WriteEvent>()
  const { deletes } = stubFetch(stream, { running: runningRequest('backlog', 'другое', bases[0].base, 'Agents Kit Web') })
  renderModal({ subject: { base: bases[0].base, entry: B40 } })

  await screen.findByLabelText('Просьба к Чудо-Юдо')
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))

  expect(deletes).toEqual([])
})

test('открытое заново окно показывает разговор с его записью и ход, который шёл без него', async () => {
  const stream = controlledStream<WriteEvent>()
  const { posts } = stubFetch(stream, { running: runningRequest('backlog', 'поправь', bases[1].base, 'Nota', 12000) })
  renderModal()

  stream.send({ type: 'reply', text: 'поправь', number: 'B-40' })
  expect(await screen.findByText('поправь')).toBeInTheDocument()
  expect(screen.getByText('Запись')).toBeInTheDocument()
  expect(screen.getByText('Показывать, сколько длится задача')).toBeInTheDocument()
  expect(screen.getByText('nota-knowledge')).toBeInTheDocument()
  expect(posts).toEqual([])
})

test('сбой агента назван, а реплика возвращается в поле', async () => {
  const stream = controlledStream<WriteEvent>()
  stubFetch(stream)
  renderModal()

  await say('Мысль')
  stream.send({ type: 'reply', text: 'Мысль' })
  stream.send({ type: 'error', text: 'Чудо-Юдо завершился без ответа', output: 'код выхода 1' })

  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Чудо-Юдо завершился без ответа')).toBeInTheDocument()
  expect(within(alert).getByText('код выхода 1')).toBeInTheDocument()
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toHaveValue('Мысль')
})

test('«Новая переписка» убирает разговор, а окно оставляет открытым с прежним проектом', async () => {
  const stream = controlledStream<WriteEvent>()
  const { deletes } = stubFetch(stream)
  const { onClose } = renderModal({ initialBase: bases[1].base })

  const fresh = await screen.findByRole('button', { name: 'Новая переписка' })
  expect(fresh).toBeDisabled()
  await say('Мысль')
  stream.send({ type: 'reply', text: 'Мысль' })
  await screen.findByText('Чудо-Юдо читает бэклог Nota…')
  // Пока Чудо-Юдо отвечает, начать заново нельзя.
  expect(screen.getByRole('button', { name: 'Новая переписка' })).toBeDisabled()
  stream.send(answer({ text: 'Записал.' }))
  await screen.findByText('Записал.')

  fireEvent.click(screen.getByRole('button', { name: 'Новая переписка' }))

  await waitFor(() => expect(deletes).toEqual(['/api/agent/backlog']))
  expect(onClose).not.toHaveBeenCalled()
  expect(screen.getByRole('dialog', { name: 'Чудо-Юдо' })).toBeInTheDocument()
  expect(screen.queryByText('Записал.')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Новая переписка' })).toBeDisabled()
  expect(screen.getByLabelText('Просьба к Чудо-Юдо')).toHaveValue('')
})

test('без текста отправить нельзя', async () => {
  stubFetch(controlledStream())
  renderModal()

  expect(await screen.findByRole('button', { name: 'Отправить' })).toBeDisabled()
})

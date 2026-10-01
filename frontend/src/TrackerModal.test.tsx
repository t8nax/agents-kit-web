import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerModal from './TrackerModal'
import type { TrackerEvent } from './TrackerChatModal'
import { controlledStream, stubPanel } from './agentPanelTesting'
import { emptyDescription, type ProjectTrackerRow, type TrackerDescription } from './projectTracker'

afterEach(() => {
  vi.unstubAllGlobals()
})

const youtrack: TrackerDescription = {
  tracker: 'YouTrack',
  server: 'https://acme.youtrack.cloud',
  project: 'CRM',
  where: 'Ходим MCP-сервером youtrack.',
  backlog: 'Задачи проекта CRM на мне.',
  take: 'Назначить на себя.',
  closed: 'Ничего: задачу закрывает мерж.',
  move: 'В проект CRM, тип Task.',
  filter: '',
}

const row: ProjectTrackerRow = {
  base: String.raw`D:\Projects\crm-knowledge`,
  project: 'crm-core',
  problem: null,
  tracker: { kind: 'youtrack', name: 'YouTrack', server: youtrack.server, project: 'CRM' },
  description: youtrack,
  version: 'v1',
  busy: [],
  newerFormat: false,
}

const fresh: ProjectTrackerRow = { ...row, tracker: null, description: null, version: '' }

const proposal: TrackerDescription = {
  ...youtrack,
  project: 'CRM2',
  backlog: 'Задачи проекта CRM2 на мне.',
  take: 'Назначить на себя и поставить метку in-progress.',
  move: 'В проект CRM2, тип Task.',
}

type Put = { body: Record<string, unknown> }

function stubFetch(
  stream: { body: ReadableStream<Uint8Array> },
  save: () => Response | Promise<Response> = () => Response.json({ version: 'v2', checked: true, pushed: true, message: null }),
) {
  const replies: Record<string, unknown>[] = []
  const puts: Put[] = []
  const panel = stubPanel('tracker', stream, {
    project: 'crm-core',
    others: (url, init) => {
      if (url === '/api/trackers/rewrite/reply') {
        replies.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
        return new Response(null, { status: 204 })
      }
      return null
    },
  })
  // Запись описания тест может держать, а стенд отдаёт ответы сразу: PUT идёт мимо него, остальное — ему.
  const stand = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) =>
      url === '/api/trackers/projects' && init?.method === 'PUT'
        ? (puts.push({ body: JSON.parse(String(init.body)) as Record<string, unknown> }), Promise.resolve(save()))
        : stand(url, init),
    ),
  )
  return { ...panel, replies, puts }
}

function renderModal(of: ProjectTrackerRow = row, talking = false) {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(<TrackerModal row={of} talking={talking} onSaved={onSaved} onClose={onClose} />)
  return { onSaved, onClose }
}

/** Окно «Трекер проекта» — форма; переписка с Чудо-Юдо открывается поверх неё кнопкой подвала. */
function form() {
  return within(screen.getByRole('dialog', { name: 'Трекер проекта', hidden: true }))
}

function chatDialog() {
  return within(screen.getByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' }))
}

function openChat(name: string | RegExp = /с Чудо-Юдо$/) {
  fireEvent.click(form().getByRole('button', { name }))
  return chatDialog()
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText(/^(Просьба|Следующая реплика)$/), { target: { value: text } })
  // Заново открытое окно сначала узнаёт о своей переписке: до того «Отправить» погашена.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Отправить' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

/** Поле окна трекера вместе с подписью, прежним значением и причиной отказа. */
function field(label: string) {
  return form().getByLabelText(label).closest('.tf-field') as HTMLElement
}

function save() {
  fireEvent.click(form().getByRole('button', { name: 'Сохранить' }))
}

// Критерий 3 B-323: окно трекера — форма, как окно исполнителя; у нового пометок нет (замечание оператора на B-293).
test('у нового трекера — форма без пометок, вид трекера выбирается, подсказки — по виду, переписка — «Завести с Чудо-Юдо»', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal(fresh)

  const dialog = form()
  expect(dialog.getByText('crm-core')).toHaveClass('pf-project')
  fireEvent.click(dialog.getByRole('radio', { name: 'Jira' }))

  expect(dialog.getByRole('radio', { name: 'Jira' })).toBeChecked()
  expect(dialog.getByLabelText('Адрес сервера')).toHaveAttribute('placeholder', 'https://acme.atlassian.net')
  expect(dialog.getByLabelText('Проект')).toHaveAttribute('placeholder', 'Ключ проекта, например PAY')
  expect(dialog.getByLabelText('Задача закрыта')).toHaveAttribute('placeholder', 'Что менять при закрытии, или «ничего, её закрывает мерж»')
  expect(dialog.queryByText('изменено')).not.toBeInTheDocument()
  expect(dialog.getByText('Задачи Jira панель не проверяет: описание запишется без проверки.')).toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Завести с Чудо-Юдо' })).toBeEnabled()
  expect(screen.queryByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' })).not.toBeInTheDocument()
})

test('поле, разошедшееся с базой, помечено «изменено» с прежним значением зачёркнутым', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  expect(form().getByRole('button', { name: 'Переписать с Чудо-Юдо' })).toBeEnabled()
  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })

  expect(within(field('Проект')).getByText('изменено')).toBeInTheDocument()
  expect(within(field('Проект')).getByText('CRM')).toHaveClass('rewrite-was', 'mono')
  expect(within(field('Адрес сервера')).queryByText('изменено')).not.toBeInTheDocument()
})

test('«Сохранить» проверяет трекер, пишет поверх увиденного и закрывает окно', async () => {
  let answer: (response: Response) => void = () => {}
  const { puts } = stubFetch(controlledStream<TrackerEvent>(), () => new Promise((resolve) => (answer = resolve)))
  const { onSaved, onClose } = renderModal()

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  save()

  const note = await form().findByRole('status')
  expect(note).toHaveTextContent('Панель читает задачи проекта CRM2 на сервере https://acme.youtrack.cloud…')
  expect(form().getByRole('button', { name: 'Проверка…' })).toBeDisabled()
  expect(form().getByLabelText('Проект')).toBeDisabled()
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: { ...youtrack, project: 'CRM2' } })

  answer(Response.json({ version: 'v2', checked: true, pushed: true, message: null }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(onClose).toHaveBeenCalledTimes(1)
})

test('трекер не прочитан — причина под полем проекта, поле в красной рамке', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'check', field: 'project', code: 'project-missing' }, { status: 422 }),
  )
  const { onSaved, onClose } = renderModal()

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRMX' } })
  save()

  expect(await within(field('Проект')).findByRole('alert')).toHaveTextContent(
    'На сервере https://acme.youtrack.cloud нет проекта CRMX или у вашего ключа нет к нему доступа. Описание не записано.',
  )
  expect(form().getByLabelText('Проект')).toHaveAttribute('aria-invalid', 'true')
  expect(onSaved).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

// B-300: поле «Фильтр» — только у трекеров, задачи которых панель читает; заполненное уходит строкой описания.
test('поле «Фильтр» есть у YouTrack и GitHub, нет у Jira, заполненное уходит с правками', async () => {
  const { puts } = stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  const dialog = form()
  expect(dialog.getByLabelText('Фильтр')).toHaveAttribute('placeholder', 'Строка поиска YouTrack, например Assignee: me — только ваши задачи')
  fireEvent.click(dialog.getByRole('radio', { name: 'GitHub' }))
  expect(dialog.getByLabelText('Фильтр')).toHaveAttribute('placeholder', 'Строка поиска GitHub, например assignee:@me — только ваши задачи')
  fireEvent.click(dialog.getByRole('radio', { name: 'Jira' }))
  expect(dialog.queryByLabelText('Фильтр')).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('radio', { name: 'YouTrack' }))

  fireEvent.change(dialog.getByLabelText('Фильтр'), { target: { value: 'State: {To Do}' } })
  expect(within(field('Фильтр')).getByText('изменено')).toBeInTheDocument()
  expect(within(field('Фильтр')).getByText('пусто')).toHaveClass('rewrite-was', 'mono')
  save()

  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: { ...youtrack, filter: 'State: {To Do}' } })
})

test('у Jira фильтр не пишется, даже если был набран до смены трекера', async () => {
  const { puts } = stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  fireEvent.change(form().getByLabelText('Фильтр'), { target: { value: 'State: {To Do}' } })
  fireEvent.click(form().getByRole('radio', { name: 'Jira' }))
  save()

  await waitFor(() => expect(puts).toHaveLength(1))
  expect((puts[0].body.description as TrackerDescription).filter).toBe('')
})

// Ревью B-300: скрытый фильтр — не правка; у трекера, поменявшего вид обратно, записывать нечего.
test('набранный фильтр, скрытый сменой трекера на Jira, правкой не считается', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal({ ...row, tracker: { kind: 'other', name: 'Jira' }, description: { ...youtrack, tracker: 'Jira' } })

  fireEvent.click(form().getByRole('radio', { name: 'YouTrack' }))
  fireEvent.change(form().getByLabelText('Фильтр'), { target: { value: 'State: {To Do}' } })
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  fireEvent.click(form().getByRole('radio', { name: 'Jira' }))

  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('трекер не принял фильтр — причина его словами под полем «Фильтр»', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'check', field: 'filter', code: 'filter-rejected', detail: 'Unknown field "Stat"' }, { status: 422 }),
  )
  const { onSaved } = renderModal()

  fireEvent.change(form().getByLabelText('Фильтр'), { target: { value: 'Stat: {To Do}' } })
  save()

  expect(await within(field('Фильтр')).findByRole('alert')).toHaveTextContent(
    'YouTrack не принял фильтр: Unknown field "Stat". Описание не записано.',
  )
  expect(form().getByLabelText('Фильтр')).toHaveAttribute('aria-invalid', 'true')
  expect(onSaved).not.toHaveBeenCalled()
})

test('описание не в форме кита — причины под своими полями', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'invalid', faults: { closed: 'Раздел не может быть пустым' } }, { status: 400 }),
  )
  renderModal()

  fireEvent.change(form().getByLabelText('Задача закрыта'), { target: { value: '' } })
  save()

  expect(await within(field('Задача закрыта')).findByRole('alert')).toHaveTextContent('Раздел не может быть пустым')
  // Поправленное поле снимает свою причину.
  fireEvent.change(form().getByLabelText('Задача закрыта'), { target: { value: 'Ничего.' } })
  expect(within(field('Задача закрыта')).queryByRole('alert')).not.toBeInTheDocument()
})

test('база не ушла на сервер — описание записано, окно остаётся и говорит это словами кита', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ version: 'v2', checked: true, pushed: false, message: 'на remote базы не отдано — git: rejected' }),
  )
  const { onSaved, onClose } = renderModal()

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  save()

  const alert = await form().findByRole('alert')
  expect(alert).toHaveTextContent('База не отправлена на сервер')
  expect(alert).toHaveTextContent('Описание трекера записано на этом компьютере, но на сервер не ушло.')
  expect(alert).toHaveTextContent('на remote базы не отдано — git: rejected')
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(onClose).not.toHaveBeenCalled()
})

test('описание поменялось под окном — проекты перечитываются, набранное остаётся', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () => Response.json({ problem: 'changed' }, { status: 409 }))
  const { onSaved } = renderModal()

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  save()

  expect(await form().findByRole('alert')).toHaveTextContent('Описание трекера изменилось с тех пор, как окно его прочитало.')
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(form().getByLabelText('Проект')).toHaveValue('CRM2')
})

test('имеющееся описание без правок записывать нечего — «Сохранить» погашена', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM' } })
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

// Критерий 3 B-323: переписка — окном поверх формы, как у исполнителя.
test('просьба уходит с полями окна трекера, у нового трекера — пустыми', async () => {
  const stream = controlledStream<TrackerEvent>()
  const { posts } = stubFetch(stream)
  renderModal(fresh)

  const chat = openChat('Завести с Чудо-Юдо')
  expect(chat.getByText('crm-core')).toHaveClass('rewrite-project-name')
  expect(chat.getByRole('tab', { name: 'Изменения' })).toBeDisabled()
  await say('  Трекер — YouTrack на acme.youtrack.cloud, проект PAY  ')
  stream.send({ type: 'reply', text: 'Трекер — YouTrack на acme.youtrack.cloud, проект PAY' })

  expect(await screen.findByText('Чудо-Юдо разбирает трекер crm-core…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/trackers/rewrite')
  expect(posts[0].body).toEqual({ base: row.base, wish: 'Трекер — YouTrack на acme.youtrack.cloud, проект PAY', description: emptyDescription })
})

test('поправленное в форме уходит с просьбой и со следующей репликой', async () => {
  const stream = controlledStream<TrackerEvent>()
  const { posts, replies } = stubFetch(stream)
  renderModal()
  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM3' } })
  openChat()
  await say('Что с проектом?')
  stream.send({ type: 'reply', text: 'Что с проектом?' })
  stream.send({ type: 'answer', text: 'Какой проект?', durationMs: 3000 })
  await screen.findByText('Какой проект?')
  await say('Вот так')

  expect(posts[0].body).toEqual({ base: row.base, wish: 'Что с проектом?', description: { ...youtrack, project: 'CRM3' } })
  await waitFor(() => expect(replies).toHaveLength(1))
  expect(replies[0]).toEqual({ text: 'Вот так', description: { ...youtrack, project: 'CRM3' } })
})

test('ответ с описанием — «В изменениях», точка на вкладке, сверка с формой; «Принять правки» кладёт его в поля', async () => {
  const stream = controlledStream<TrackerEvent>()
  const { puts } = stubFetch(stream)
  renderModal()
  const chat = openChat()
  await say('Проект переехал в CRM2')
  stream.send({ type: 'reply', text: 'Проект переехал в CRM2' })
  stream.send({ type: 'answer', text: 'Поменял проект.', durationMs: 17000, proposal, changed: { lines: 1, sections: 3 } })

  const link = await chat.findByRole('button', { name: '1 строка, 3 раздела' })
  expect(chat.getByLabelText('Список изменён последним ответом')).toBeInTheDocument()
  fireEvent.click(link)

  expect(chat.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
  const list = within(chat.getByLabelText('Изменения трекера'))
  const project = list.getByText('Проект').closest('.pc-row') as HTMLElement
  expect(within(project).getByText('изменено')).toBeInTheDocument()
  expect(within(project).getByText('CRM')).toHaveClass('rewrite-was')
  expect(within(project).getByText('CRM2')).toBeInTheDocument()
  const server = list.getByText('Адрес сервера').closest('.pc-row') as HTMLElement
  expect(within(server).queryByText('изменено')).not.toBeInTheDocument()
  // В базу «Принять правки» ничего не пишет: описание ложится в поля формы, записывает «Сохранить».
  fireEvent.click(chat.getByRole('button', { name: 'Принять правки' }))

  expect(screen.queryByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' })).not.toBeInTheDocument()
  expect(puts).toHaveLength(0)
  expect(form().getByLabelText('Проект')).toHaveValue('CRM2')
  expect(form().getByLabelText('Взятие задачи')).toHaveValue(proposal.take)
  expect(within(field('Проект')).getByText('изменено')).toBeInTheDocument()
  expect(form().getByText('Правки Чудо-Юдо приняты')).toBeInTheDocument()

  fireEvent.click(form().getByRole('button', { name: 'вернуть как было' }))
  expect(form().getByLabelText('Проект')).toHaveValue('CRM')
  expect(form().queryByText('Правки Чудо-Юдо приняты')).not.toBeInTheDocument()
})

test('пока Чудо-Юдо отвечает, «Принять правки» погашена, после ответа открыта', async () => {
  const stream = controlledStream<TrackerEvent>()
  stubFetch(stream)
  renderModal()
  const chat = openChat()
  await say('Проект переехал')
  stream.send({ type: 'reply', text: 'Проект переехал' })
  stream.send({ type: 'answer', text: 'Поменял.', durationMs: 1000, proposal, changed: { lines: 1, sections: 3 } })
  await chat.findByRole('button', { name: '1 строка, 3 раздела' })
  await say('Ещё раз')
  stream.send({ type: 'reply', text: 'Ещё раз' })
  await screen.findByText('Чудо-Юдо разбирает трекер crm-core…')

  fireEvent.click(chat.getByRole('tab', { name: /Изменения/ }))
  expect(chat.getByRole('button', { name: 'Принять правки' })).toBeDisabled()

  stream.send({ type: 'answer', text: 'Готово.', durationMs: 1000, proposal, changed: { lines: 0, sections: 0 } })
  await waitFor(() => expect(chat.getByRole('button', { name: 'Принять правки' })).toBeEnabled())
})

test('в подвале переписки — микрофон', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  expect(openChat().getByRole('button', { name: 'Голосовой ввод' })).toBeInTheDocument()
})

test('возврат к переписке из шапки открывает её сразу поверх окна трекера', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal(row, true)

  expect(chatDialog().getByRole('tab', { name: 'Переписка' })).toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Трекер проекта', hidden: true })).toHaveAttribute('inert')
})

test('переписка о трекере другого проекта форму этого не держит', async () => {
  const stream = controlledStream<TrackerEvent>()
  stubPanel('tracker', stream, {
    running: { kind: 'tracker', id: 'r1', base: String.raw`D:\Projects\other-knowledge`, project: 'Другой', text: 'x', elapsedMs: 0, state: 'running' },
  })
  renderModal()

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  expect(form().getByLabelText('Проект')).toBeEnabled()
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  const chat = openChat()
  expect(await chat.findByText(/Идёт переписка о трекере Другой/)).toBeInTheDocument()
})

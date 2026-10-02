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
  // Jira панель теперь читает — и проверяет перед записью (B-285); без проверки пишется только GitLab
  expect(dialog.queryByText(/панель не проверяет/)).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('radio', { name: 'GitLab' }))
  expect(dialog.getByText('Задачи GitLab панель не проверяет: описание запишется без проверки.')).toBeInTheDocument()
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
  // Пустой ключ — оставить сохранённый; почты у YouTrack нет
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: { ...youtrack, project: 'CRM2' }, key: '', email: null })

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
    'Проект CRMX не найден на сервере https://acme.youtrack.cloud или у вашего ключа нет к нему доступа. Описание не записано.',
  )
  expect(form().getByLabelText('Проект')).toHaveAttribute('aria-invalid', 'true')
  expect(onSaved).not.toHaveBeenCalled()
  expect(onClose).not.toHaveBeenCalled()
})

// ——— Ключ к серверу — в окне трекера, только у трекеров, которым он нужен (ответ оператора на B-285) ———

const owner = { server: 'https://acme.youtrack.cloud', login: 'boris.k', email: null }

test('«Ключ» — у YouTrack, «Почта» и «Ключ» — у Jira, у GitHub и GitLab их нет; «Фильтра» в окне нет', () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  const dialog = form()
  expect(dialog.getByLabelText('Ключ')).toHaveAttribute('placeholder', 'Постоянный токен YouTrack')
  expect(dialog.queryByLabelText('Почта')).not.toBeInTheDocument()
  expect(dialog.queryByLabelText('Фильтр')).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('radio', { name: 'Jira' }))
  expect(dialog.getByLabelText('Почта')).toHaveAttribute('placeholder', 'Почта аккаунта Atlassian')
  expect(dialog.getByLabelText('Ключ')).toHaveAttribute('placeholder', 'API-токен Atlassian')
  for (const name of ['GitHub', 'GitLab']) {
    fireEvent.click(dialog.getByRole('radio', { name }))
    expect(dialog.queryByLabelText('Ключ')).not.toBeInTheDocument()
    expect(dialog.queryByLabelText('Почта')).not.toBeInTheDocument()
  }
})

test('сохранённый ключ не показывается: подсказка называет владельца, пустое поле его оставляет, новый — правка', async () => {
  const { puts } = stubFetch(controlledStream<TrackerEvent>())
  render(<TrackerModal row={row} keyOwner={owner} onSaved={vi.fn()} onClose={vi.fn()} />)

  const key = form().getByLabelText('Ключ')
  expect(key).toHaveAttribute('type', 'password')
  expect(key).toHaveValue('')
  expect(key).toHaveAttribute('placeholder', 'сохранён ключ пользователя boris.k — оставьте пустым, чтобы не менять')
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  fireEvent.change(key, { target: { value: 'perm:новый' } })
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  save()

  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: youtrack, key: 'perm:новый', email: null })
})

test('у Jira почта и ключ уходят с описанием; сменённая почта — тоже правка', async () => {
  const jira: TrackerDescription = { ...youtrack, tracker: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' }
  const { puts } = stubFetch(controlledStream<TrackerEvent>())
  render(
    <TrackerModal
      row={{ ...row, tracker: { kind: 'jira', name: 'Jira', server: jira.server, project: 'PAY' }, description: jira }}
      keyOwner={{ server: 'https://acme.atlassian.net', login: 'anna@acme.example', email: 'anna@acme.example' }}
      onSaved={vi.fn()}
      onClose={vi.fn()}
    />,
  )

  expect(form().getByLabelText('Почта')).toHaveValue('anna@acme.example')
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()
  fireEvent.change(form().getByLabelText('Почта'), { target: { value: 'ivan@acme.example' } })
  fireEvent.change(form().getByLabelText('Ключ'), { target: { value: 'токен' } })
  save()

  await waitFor(() => expect(puts).toHaveLength(1))
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: jira, key: 'токен', email: 'ivan@acme.example' })
})

// Ревью B-285: владельцы ключей приходят своим запросом и могут опоздать к открытому окну
test('почта владельца ключа, пришедшая после открытия окна, ложится в поле, пока его не трогали', () => {
  const jira: TrackerDescription = { ...youtrack, tracker: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' }
  const jiraRow: ProjectTrackerRow = { ...row, tracker: { kind: 'jira', name: 'Jira', server: jira.server, project: 'PAY' }, description: jira }
  const owner = { server: 'https://acme.atlassian.net', login: 'anna@acme.example', email: 'anna@acme.example' }
  stubFetch(controlledStream<TrackerEvent>())
  const { rerender } = render(<TrackerModal row={jiraRow} keyOwner={null} onSaved={vi.fn()} onClose={vi.fn()} />)

  rerender(<TrackerModal row={jiraRow} keyOwner={owner} onSaved={vi.fn()} onClose={vi.fn()} />)
  expect(form().getByLabelText('Почта')).toHaveValue('anna@acme.example')
  expect(form().getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  fireEvent.change(form().getByLabelText('Почта'), { target: { value: 'ivan@acme.example' } })
  rerender(<TrackerModal row={jiraRow} keyOwner={{ ...owner }} onSaved={vi.fn()} onClose={vi.fn()} />)
  expect(form().getByLabelText('Почта')).toHaveValue('ivan@acme.example')
})

test('ключ отклонён — причина под полем «Ключ», поле в красной рамке', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'check', field: 'key', code: 'key-rejected' }, { status: 422 }),
  )
  const { onSaved } = renderModal()

  fireEvent.change(form().getByLabelText('Ключ'), { target: { value: 'плохой' } })
  save()

  expect(await within(field('Ключ')).findByRole('alert')).toHaveTextContent(
    'Сервер https://acme.youtrack.cloud отклонил ключ. Описание не записано.',
  )
  expect(form().getByLabelText('Ключ')).toHaveAttribute('aria-invalid', 'true')
  expect(onSaved).not.toHaveBeenCalled()
})

test('ключ общий для проектов одного сервера — окно называет их', () => {
  stubFetch(controlledStream<TrackerEvent>())
  render(<TrackerModal row={row} keyOwner={owner} sharedWith={['Склад', 'Биллинг']} onSaved={vi.fn()} onClose={vi.fn()} />)

  expect(form().getByText('Этот ключ читает и проекты: Склад, Биллинг.')).toBeInTheDocument()
})

// Переход из причины «Бэклога»: курсор — в поле, которое она называет (B-285)
test('окно, открытое из причины о ключе, ставит курсор в поле «Ключ»', () => {
  stubFetch(controlledStream<TrackerEvent>())
  render(<TrackerModal row={row} focusField="key" onSaved={vi.fn()} onClose={vi.fn()} />)

  expect(form().getByLabelText('Ключ')).toHaveFocus()
})

// Фильтр — на вкладке «Задачи трекера» (B-285): строка «фильтр:» описания окном не пишется
test('прежняя строка «фильтр:» описания не уходит с правкой', async () => {
  const { puts } = stubFetch(controlledStream<TrackerEvent>())
  renderModal({ ...row, description: { ...youtrack, filter: 'State: {To Do}' } })

  fireEvent.change(form().getByLabelText('Проект'), { target: { value: 'CRM2' } })
  save()

  await waitFor(() => expect(puts).toHaveLength(1))
  expect((puts[0].body.description as TrackerDescription).filter).toBe('')
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

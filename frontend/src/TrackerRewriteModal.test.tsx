import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerRewriteModal, { type TrackerEvent } from './TrackerRewriteModal'
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

function renderModal(of: ProjectTrackerRow = row) {
  const onSaved = vi.fn()
  const onClose = vi.fn()
  render(<TrackerRewriteModal row={of} onSaved={onSaved} onClose={onClose} />)
  return { onSaved, onClose }
}

async function say(text: string) {
  fireEvent.change(await screen.findByLabelText(/^(Просьба|Следующая реплика)$/), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: 'Отправить' }))
}

function changes() {
  fireEvent.click(screen.getByRole('tab', { name: /Изменения/ }))
  return within(screen.getByLabelText('Изменения описания трекера'))
}

/** Поле вкладки «Изменения» вместе с подписью, прежним значением и причиной отказа. */
function field(label: string) {
  return screen.getByLabelText(label).closest('.tf-field') as HTMLElement
}

test('просьба уходит с описанием, каким оно стоит в окне, у нового трекера — пустым', async () => {
  const stream = controlledStream<TrackerEvent>()
  const { posts } = stubFetch(stream)
  renderModal(fresh)

  expect(screen.getByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' })).toBeInTheDocument()
  await say('  Трекер — YouTrack на acme.youtrack.cloud, проект PAY  ')
  stream.send({ type: 'reply', text: 'Трекер — YouTrack на acme.youtrack.cloud, проект PAY' })

  expect(await screen.findByText('Чудо-Юдо разбирает трекер crm-core…')).toBeInTheDocument()
  expect(posts[0].url).toBe('/api/trackers/rewrite')
  expect(posts[0].body).toEqual({ base: row.base, wish: 'Трекер — YouTrack на acme.youtrack.cloud, проект PAY', description: emptyDescription })
})

test('ответ с описанием — строка «В изменениях», точка на вкладке, поля заполнены, поменявшееся помечено', async () => {
  const stream = controlledStream<TrackerEvent>()
  stubFetch(stream)
  renderModal()
  await say('Проект переехал в CRM2')
  stream.send({ type: 'reply', text: 'Проект переехал в CRM2' })
  stream.send({ type: 'answer', text: 'Поменял проект.', durationMs: 17000, proposal, changed: { lines: 1, sections: 3 } })

  const link = await screen.findByRole('button', { name: '1 строка, 3 раздела' })
  expect(screen.getByLabelText('Список изменён последним ответом')).toBeInTheDocument()
  fireEvent.click(link)

  expect(screen.queryByLabelText('Список изменён последним ответом')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Проект')).toHaveValue('CRM2')
  expect(within(field('Проект')).getByText('изменено')).toBeInTheDocument()
  expect(within(field('Проект')).getByText('CRM')).toHaveClass('rewrite-was')
  expect(within(field('Взятие задачи')).getByText('изменено')).toBeInTheDocument()
  expect(within(field('Адрес сервера')).queryByText('изменено')).not.toBeInTheDocument()
  expect(within(field('Где задачи')).queryByText('изменено')).not.toBeInTheDocument()
})

// Замечание оператора к макету B-293: «Новое не надо» — у нового трекера пометок нет.
test('у нового трекера поля без пометок, вид трекера выбирается, подсказки — по виду', async () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal(fresh)

  const tab = changes()
  fireEvent.click(tab.getByRole('radio', { name: 'Jira' }))

  expect(tab.getByRole('radio', { name: 'Jira' })).toBeChecked()
  expect(screen.getByLabelText('Адрес сервера')).toHaveAttribute('placeholder', 'https://acme.atlassian.net')
  expect(screen.getByLabelText('Проект')).toHaveAttribute('placeholder', 'Ключ проекта, например PAY')
  expect(screen.getByLabelText('Задача закрыта')).toHaveAttribute('placeholder', 'Что менять при закрытии, или «ничего, её закрывает мерж»')
  expect(tab.queryByText('изменено')).not.toBeInTheDocument()
  expect(screen.getByText('Задачи Jira панель не проверяет: описание запишется без проверки.')).toBeInTheDocument()
})

test('поправленное руками уходит со следующей репликой', async () => {
  const stream = controlledStream<TrackerEvent>()
  const { replies } = stubFetch(stream)
  renderModal()
  await say('Что с проектом?')
  stream.send({ type: 'reply', text: 'Что с проектом?' })
  stream.send({ type: 'answer', text: 'Какой проект?', durationMs: 3000 })
  await screen.findByText('Какой проект?')

  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM3' } })
  fireEvent.click(screen.getByRole('tab', { name: 'Переписка' }))
  await say('Вот так')

  await waitFor(() => expect(replies).toHaveLength(1))
  expect(replies[0]).toEqual({ text: 'Вот так', description: { ...youtrack, project: 'CRM3' } })
})

test('«Принять правки» проверяет трекер, пишет поверх увиденного и возвращает к переписке', async () => {
  let answer: (response: Response) => void = () => {}
  const { puts } = stubFetch(controlledStream<TrackerEvent>(), () => new Promise((resolve) => (answer = resolve)))
  const { onSaved } = renderModal()

  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  const note = await screen.findByRole('status')
  expect(note).toHaveTextContent('Панель читает задачи проекта CRM2 на сервере https://acme.youtrack.cloud…')
  expect(screen.getByRole('button', { name: 'Проверка…' })).toBeDisabled()
  expect(puts[0].body).toEqual({ base: row.base, version: 'v1', description: { ...youtrack, project: 'CRM2' } })

  answer(Response.json({ version: 'v2', checked: true, pushed: true, message: null }))
  await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1))
  expect(await screen.findByRole('tab', { name: 'Переписка' })).toHaveAttribute('aria-selected', 'true')
})

test('трекер не прочитан — причина под полем проекта, поле в красной рамке', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'check', field: 'project', code: 'project-missing' }, { status: 422 }),
  )
  const { onSaved } = renderModal()

  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRMX' } })
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  expect(await within(field('Проект')).findByRole('alert')).toHaveTextContent(
    'На сервере https://acme.youtrack.cloud нет проекта CRMX или у вашего ключа нет к нему доступа. Описание не записано.',
  )
  expect(screen.getByLabelText('Проект')).toHaveAttribute('aria-invalid', 'true')
  expect(onSaved).not.toHaveBeenCalled()
})

test('описание не в форме кита — причины под своими полями', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ problem: 'invalid', faults: { closed: 'Раздел не может быть пустым' } }, { status: 400 }),
  )
  renderModal()

  changes()
  fireEvent.change(screen.getByLabelText('Задача закрыта'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  expect(await within(field('Задача закрыта')).findByRole('alert')).toHaveTextContent('Раздел не может быть пустым')
  // Поправленное поле снимает свою причину.
  fireEvent.change(screen.getByLabelText('Задача закрыта'), { target: { value: 'Ничего.' } })
  expect(within(field('Задача закрыта')).queryByRole('alert')).not.toBeInTheDocument()
})

test('база не ушла на сервер — описание записано, окно говорит это словами кита', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () =>
    Response.json({ version: 'v2', checked: true, pushed: false, message: 'на remote базы не отдано — git: rejected' }),
  )
  const { onSaved } = renderModal()

  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('База не отправлена на сервер')
  expect(alert).toHaveTextContent('Описание трекера записано на этом компьютере, но на сервер не ушло.')
  expect(alert).toHaveTextContent('на remote базы не отдано — git: rejected')
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
})

test('описание поменялось под окном — карточка перечитывается, набранное остаётся', async () => {
  stubFetch(controlledStream<TrackerEvent>(), () => Response.json({ problem: 'changed' }, { status: 409 }))
  const { onSaved } = renderModal()

  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Принять правки' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Описание трекера изменилось с тех пор, как окно его прочитало.')
  expect(onSaved).toHaveBeenCalledTimes(1)
  expect(screen.getByLabelText('Проект')).toHaveValue('CRM2')
})

// Ревью B-293: пока Чудо-Юдо отвечает, поля не правятся — его предложение легло бы поверх набранного.
test('пока Чудо-Юдо отвечает, поля и «Принять правки» погашены, после ответа открыты', async () => {
  const stream = controlledStream<TrackerEvent>()
  stubFetch(stream)
  renderModal()
  await say('Проект переехал')
  stream.send({ type: 'reply', text: 'Проект переехал' })
  await screen.findByText('Чудо-Юдо разбирает трекер crm-core…')

  changes()
  expect(screen.getByLabelText('Проект')).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'Jira' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()

  stream.send({ type: 'answer', text: 'Поменял.', durationMs: 1000, proposal, changed: { lines: 1, sections: 3 } })
  await waitFor(() => expect(screen.getByLabelText('Проект')).toBeEnabled())
  expect(screen.getByLabelText('Проект')).toHaveValue('CRM2')
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeEnabled()
})

test('имеющееся описание без правок записывать нечего — «Принять правки» погашена', async () => {
  stubFetch(controlledStream<TrackerEvent>())
  renderModal()

  changes()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM2' } })
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeEnabled()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM' } })
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeDisabled()
})

test('переписка о трекере другого проекта запись этого не держит', async () => {
  const stream = controlledStream<TrackerEvent>()
  stubPanel('tracker', stream, {
    running: { kind: 'tracker', id: 'r1', base: String.raw`D:\Projects\other-knowledge`, project: 'Другой', text: 'x', elapsedMs: 0, state: 'running' },
  })
  renderModal()

  expect(await screen.findByText(/Идёт переписка о трекере Другой/)).toBeInTheDocument()
  changes()
  fireEvent.change(screen.getByLabelText('Проект'), { target: { value: 'CRM2' } })
  expect(screen.getByLabelText('Проект')).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Принять правки' })).toBeEnabled()
})

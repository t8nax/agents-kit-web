import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerProjectsCard from './TrackerProjectsCard'
import { emptyDescription, type ProjectTrackerRow, type TrackerDescription } from './projectTracker'

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit, url?: string) => Response | Promise<Response>

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function stubApi(handlers: Record<string, Handler>) {
  const fetchMock = vi.fn((input: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${input.split('?')[0]}`
    const handler = handlers[key]
    if (!handler) throw new Error(`Нет обработчика ${key}`)
    return Promise.resolve(handler(init, input))
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const github: TrackerDescription = {
  tracker: 'GitHub',
  server: 'https://github.com',
  project: 'acme/orders',
  where: 'Ходим gh.',
  backlog: 'Задачи на мне.',
  take: 'Метка in-progress.',
  closed: 'Ничего: задачу закрывает мерж.',
  move: 'В acme/orders без меток.',
  filter: '',
}

const described: ProjectTrackerRow = {
  base: 'D:\\Projects\\orders-knowledge',
  project: 'Orders',
  problem: null,
  tracker: { kind: 'github', name: 'GitHub', server: 'https://github.com', project: 'acme/orders' },
  description: github,
  version: 'v1',
  busy: [],
  newerFormat: false,
}

const bare: ProjectTrackerRow = {
  ...described,
  base: 'D:\\Projects\\crm-knowledge',
  project: 'CRM',
  tracker: null,
  description: null,
  version: '',
}

async function row(name: string) {
  const list = await screen.findByRole('list', { name: 'Трекеры проектов' })
  return within(within(list).getByText(name).closest('li')!)
}

test('проект без трекера — «Трекера нет» и «Завести», с трекером — вид, сервер, проект, «Изменить» и «Удалить»', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([described, bare]) })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  expect(orders.getByText('GitHub')).toHaveClass('prj-kind')
  expect(orders.getByText('https://github.com')).toBeInTheDocument()
  expect(orders.getByText('acme/orders')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeEnabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeEnabled()
  const crm = await row('CRM')
  expect(crm.getByText('Трекера нет')).toBeInTheDocument()
  expect(crm.getByRole('button', { name: 'Завести трекер CRM' })).toBeEnabled()
  expect(crm.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument()
})

// B-300: заданный отбор виден строкой под сервером и проектом; без отбора строки нет.
test('фильтр трекера — строкой «Фильтр» в строке проекта, без фильтра её нет', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([
        { ...described, tracker: { ...described.tracker, filter: 'label:bug milestone:v2' }, description: { ...github, filter: 'label:bug milestone:v2' } },
        { ...described, base: 'D:\\Projects\\crm-knowledge', project: 'CRM' },
      ]),
  })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  expect(orders.getByText('Фильтр')).toHaveClass('prj-filter-label')
  expect(orders.getByText('label:bug milestone:v2')).toHaveAttribute('title', 'label:bug milestone:v2')
  expect((await row('CRM')).queryByText('Фильтр')).not.toBeInTheDocument()
})

// Удалить нельзя, пока идёт задача из трекера: подсказка называет копии и задачи — ответ оператора на B-293.
test('задачи трекера в работе гасят «Удалить», подсказка называет копии и номера', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([
        {
          ...described,
          busy: [
            { task: 'GitHub #293 Выгрузка', copy: 'D:\\Projects\\agents-kit-web-2' },
            { task: 'GitHub #301 Вход', copy: 'D:\\Projects\\agents-kit-web-4' },
          ],
        },
      ]),
  })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  const remove = orders.getByRole('button', { name: 'Удалить трекер Orders' })
  expect(remove).toBeDisabled()
  expect(remove).toHaveAttribute(
    'title',
    'Трекер не удалить: в копиях agents-kit-web-2 и agents-kit-web-4 идут задачи из него — #293 и #301.',
  )
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeEnabled()
})

test('сломанное описание — красная строка о строках, которых нет, кнопки открыты', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([{ ...described, tracker: { kind: 'no-keys', faults: ['проект'] }, description: { ...github, project: '' } }]),
  })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  expect(orders.getByText('В описании трекера нет строки «проект:» или она записана не так.')).toBeInTheDocument()
  expect(orders.getByText('GitHub')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeEnabled()
})

// Строки на месте, а сверка кита назовёт описание красным — карточка говорит, что не так (ревью B-293).
test('проект не по шаблону и пустой раздел — красная строка называет их', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([
        {
          ...described,
          tracker: { kind: 'other', name: 'Jira' },
          description: { ...github, tracker: 'Jira', project: 'pay', closed: '' },
          faults: { project: 'Ключ проекта Jira — …', closed: 'Раздел не может быть пустым' },
        },
      ]),
  })

  render(<TrackerProjectsCard />)

  expect(
    (await row('Orders')).getByText(
      'Описание трекера записано не так, как требует кит: проект и раздел «Задача закрыта». Исправьте его кнопкой «Изменить».',
    ),
  ).toBeInTheDocument()
})

test('база нового формата кита — правка закрыта, строка говорит почему', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([{ ...described, newerFormat: true }]) })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  expect(orders.getByText('Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeDisabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeDisabled()
})

test('описание, которое не прочитать, — прочерки, кнопки погашены', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([{ ...described, tracker: { kind: 'unreadable' }, description: null }]) })

  render(<TrackerProjectsCard />)

  const orders = await row('Orders')
  expect(orders.getByText('Описание трекера не прочитано: нет доступа к файлу tracker.md.')).toBeInTheDocument()
  expect(orders.getAllByText('—')).toHaveLength(3)
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeDisabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeDisabled()
})

test('«Удалить» спрашивает окном, удаляет поверх увиденного и перечитывает карточку', async () => {
  let listed = [described]
  const fetchMock = stubApi({
    'GET /api/trackers/projects': () => json(listed),
    'DELETE /api/trackers/projects': () => {
      listed = [{ ...described, tracker: null, description: null, version: '' }]
      return json({ version: '', checked: false, pushed: true, message: null })
    },
  })
  render(<TrackerProjectsCard />)

  fireEvent.click((await row('Orders')).getByRole('button', { name: 'Удалить трекер Orders' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Удалить трекер проекта' }))
  expect(dialog.getByText(/уйдёт из базы знаний, и «Бэклог» перестанет показывать задачи проекта/)).toHaveTextContent(
    'Описание трекера проекта Orders уйдёт из базы знаний, и «Бэклог» перестанет показывать задачи проекта acme/orders из GitHub. Панель отправит базу на сервер.',
  )
  fireEvent.click(dialog.getByRole('button', { name: 'Удалить трекер' }))

  expect(await (await row('Orders')).findByText('Трекера нет')).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')![0]
  expect(new URLSearchParams(deleted.split('?')[1])).toEqual(new URLSearchParams({ base: described.base, version: 'v1' }))
})

test('база не ушла на сервер после удаления — окно говорит это словами кита, «Закрыть» перечитывает карточку', async () => {
  let listed = [described]
  stubApi({
    'GET /api/trackers/projects': () => json(listed),
    'DELETE /api/trackers/projects': () => {
      listed = [{ ...described, tracker: null, description: null, version: '' }]
      return json({ version: '', checked: false, pushed: false, message: 'на remote базы не отдано — git: rejected' })
    },
  })
  render(<TrackerProjectsCard />)

  fireEvent.click((await row('Orders')).getByRole('button', { name: 'Удалить трекер Orders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить трекер' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('База не отправлена на сервер')
  expect(alert).toHaveTextContent('Описание трекера удалено на этом компьютере, но на сервер не ушло. Кит ответил:')
  expect(alert).toHaveTextContent('на remote базы не отдано — git: rejected')
  // Кнопка внизу окна, а не крестик: у обоих имя «Закрыть».
  fireEvent.click(screen.getByText('Закрыть', { selector: '.dw-footer button' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(await (await row('Orders')).findByText('Трекера нет')).toBeInTheDocument()
})

test('пришла задача трекера — окно удаления называет её, карточка перечитывается', async () => {
  const busy = [{ task: 'GitHub #37 Выгрузка', copy: 'D:\\Projects\\orders-2' }]
  const fetchMock = stubApi({
    'GET /api/trackers/projects': () => json([described]),
    'DELETE /api/trackers/projects': () => json({ problem: 'busy', busy }, 409),
  })
  render(<TrackerProjectsCard />)

  fireEvent.click((await row('Orders')).getByRole('button', { name: 'Удалить трекер Orders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить трекер' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Трекер не удалить: в копии orders-2 идёт задача из него — #37.')
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => url === '/api/trackers/projects')).toHaveLength(2))
})

test('«Завести» открывает окно трекера с пустым описанием', async () => {
  stubApi({
    'GET /api/trackers/projects': () => json([bare]),
    'GET /api/agent/requests': () => json([]),
  })
  render(<TrackerProjectsCard />)

  fireEvent.click((await row('CRM')).getByRole('button', { name: 'Завести трекер CRM' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Трекер проекта с Чудо-Юдо' }))
  expect(dialog.getByText('CRM')).toHaveClass('rewrite-project-name')
  fireEvent.click(dialog.getByRole('tab', { name: 'Изменения' }))
  expect(dialog.getByLabelText('Адрес сервера')).toHaveValue(emptyDescription.server)
})

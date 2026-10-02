import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import TrackerProjects from './TrackerProjects'
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

// Проект выбирается строкой слева, а его трекер — в подробностях справа.
async function row(name: string) {
  const list = await screen.findByRole('navigation', { name: 'Трекеры проектов' })
  fireEvent.click(within(list).getByRole('button', { name: new RegExp(`^${name}`) }))
  return within(await screen.findByRole('region', { name: `Трекер проекта ${name}` }))
}

test('проект без трекера — «В этом проекте нет трекера» и «Завести трекер», с трекером — вид, сервер, проект, «Изменить» и «Удалить»', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([described, bare]) })

  render(<TrackerProjects />)

  const list = within(await screen.findByRole('navigation', { name: 'Трекеры проектов' }))
  // Приёмка B-323: у проекта в списке — метка трекера и имя, без второй строки.
  expect(list.getByRole('button', { name: /^Orders/ })).toHaveTextContent(/^GHOrders$/)
  expect(list.getByRole('button', { name: /^CRM/ })).toHaveTextContent(/^CRM$/)

  const orders = await row('Orders')
  expect(orders.getByText('GitHub', { selector: 'dd' })).toBeInTheDocument()
  expect(orders.getByText('https://github.com')).toBeInTheDocument()
  expect(orders.getByText('acme/orders')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeEnabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeEnabled()
  const crm = await row('CRM')
  // Проект без трекера — как пустой проект во «Флоу»: заголовок и крупная «Завести трекер» (приёмка B-323).
  expect(crm.getByRole('heading', { name: 'В этом проекте нет трекера' })).toBeInTheDocument()
  expect(crm.getByRole('button', { name: 'Завести трекер CRM' })).toHaveTextContent('Завести трекер')
  expect(crm.getByRole('button', { name: 'Завести трекер CRM' })).toBeEnabled()
  expect(crm.queryByRole('button', { name: /Удалить/ })).not.toBeInTheDocument()
})

// Критерий 2 B-323: выбранный проект отмечен, как пункт сайдбара; сначала выбран первый.
test('выбран первый проект, щелчок выбирает другой и отмечает его', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([described, bare]) })

  render(<TrackerProjects />)

  const list = within(await screen.findByRole('navigation', { name: 'Трекеры проектов' }))
  expect(list.getByRole('button', { name: /^Orders/ })).toHaveAttribute('aria-current', 'true')
  expect(list.getByRole('button', { name: /^Orders/ })).toHaveClass('active')
  expect(screen.getByRole('region', { name: 'Трекер проекта Orders' })).toBeInTheDocument()

  fireEvent.click(list.getByRole('button', { name: /^CRM/ }))

  expect(list.getByRole('button', { name: /^CRM/ })).toHaveAttribute('aria-current', 'true')
  expect(list.getByRole('button', { name: /^Orders/ })).not.toHaveAttribute('aria-current')
  expect(screen.queryByRole('region', { name: 'Трекер проекта Orders' })).not.toBeInTheDocument()
  expect(screen.getByRole('region', { name: 'Трекер проекта CRM' })).toBeInTheDocument()
})

test('переход из «Бэклога» выбирает проект своей базы', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([described, bare]) })

  render(<TrackerProjects focus={{ base: bare.base, at: 1 }} />)

  expect(await screen.findByRole('region', { name: 'Трекер проекта CRM' })).toBeInTheDocument()
})

// Ключ к серверу: у GitHub вход программы gh, у YouTrack — владелец ключа, введённого в окне трекера (B-285).
test('ключ к серверу: вход через gh, владелец ключа YouTrack, а без ключа — красная плашка', async () => {
  const youtrack: ProjectTrackerRow = {
    ...described,
    base: 'D:\\Projects\\billing-knowledge',
    project: 'Billing',
    tracker: { kind: 'youtrack', name: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'BILL' },
    description: { ...github, tracker: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'BILL' },
  }
  const legacy: ProjectTrackerRow = {
    ...youtrack,
    base: 'D:\\Projects\\legacy-knowledge',
    project: 'Legacy',
    tracker: { ...youtrack.tracker!, server: 'https://yt.legacy.ru' },
  }
  stubApi({ 'GET /api/trackers/projects': () => json([described, youtrack, legacy]) })

  // Адрес сверяется, как на сервере панели: регистр, «/» в конце и порт по умолчанию разницы не делают.
  render(<TrackerProjects servers={[{ server: 'https://ACME.youtrack.cloud:443/', login: 'b.petrov' }]} />)

  expect((await row('Orders')).getByText('вход через gh')).toBeInTheDocument()
  expect((await row('Billing')).getByText(/ключ пользователя/)).toHaveTextContent('ключ пользователя b.petrov')
  expect((await row('Legacy')).getByText(/нет ключа/)).toHaveClass('bad')
})

// Ключ вводится кнопкой «Изменить» в окне трекера (ответ оператора на B-285): у строки «нет ключа» своей кнопки нет.
test('у Jira — владелец ключа почтой, без ключа — красная плашка без кнопки «Добавить»', async () => {
  const jira: ProjectTrackerRow = {
    ...described,
    project: 'Pay',
    tracker: { kind: 'jira', name: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' },
    description: { ...github, tracker: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' },
  }
  const other: ProjectTrackerRow = {
    ...jira,
    base: 'D:\\Projects\\delivery-knowledge',
    project: 'Delivery',
    tracker: { ...jira.tracker!, server: 'https://globex.atlassian.net' },
  }
  stubApi({ 'GET /api/trackers/projects': () => json([jira, other]) })

  render(<TrackerProjects servers={[{ server: 'https://acme.atlassian.net', login: 'anna@acme.example', email: 'anna@acme.example' }]} />)

  expect((await row('Pay')).getByText(/ключ пользователя/)).toHaveTextContent('ключ пользователя anna@acme.example')
  const delivery = await row('Delivery')
  expect(delivery.getByText('нет ключа к этому серверу')).toHaveClass('bad')
  expect(delivery.queryByRole('button', { name: /Добавить/ })).not.toBeInTheDocument()
})

// Фильтр задаётся на вкладке «Задачи трекера» (B-285): в подробностях проекта его нет
test('фильтра в подробностях проекта нет', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([{ ...described, tracker: { ...described.tracker, filter: 'label:bug' }, description: { ...github, filter: 'label:bug' } }]),
  })

  render(<TrackerProjects />)

  const orders = await row('Orders')
  expect(orders.queryByText('Фильтр')).not.toBeInTheDocument()
  expect(orders.queryByText('label:bug')).not.toBeInTheDocument()
})

// У каждого трекера своя метка своим цветом (ответ оператора на B-285)
test('метки трекеров в списке — GH, GL, JI, YT, каждая своим классом цвета', async () => {
  const kinds = [
    ['GitHub', 'https://github.com', 'acme/a', 'gh'],
    ['GitLab', 'https://gitlab.com', 'acme/b', 'gl'],
    ['Jira', 'https://acme.atlassian.net', 'PAY', 'ji'],
    ['YouTrack', 'https://acme.youtrack.cloud', 'ABC', 'yt'],
  ] as const
  stubApi({
    'GET /api/trackers/projects': () =>
      json(
        kinds.map(([tracker, server, project], i) => ({
          ...described,
          base: `D:\\Projects\\p${i}`,
          project: `P${i}`,
          tracker: { kind: tracker === 'GitLab' ? 'other' : tracker.toLowerCase(), name: tracker, server, project },
          description: { ...github, tracker, server, project },
        })),
      ),
  })

  render(<TrackerProjects />)

  const list = within(await screen.findByRole('navigation', { name: 'Трекеры проектов' }))
  kinds.forEach(([, , , mark], i) => {
    const item = list.getByRole('button', { name: new RegExp(`^P${i}`) })
    expect(item.querySelector('.tp-mark')).toHaveClass(mark)
    expect(item).toHaveTextContent(new RegExp(`^${mark.toUpperCase()}P${i}$`))
  })
})

// Переход из причины «Бэклога» о ключе: окно трекера проекта открыто, курсор — в поле «Ключ» (B-285)
test('переход из «Бэклога» с полем открывает окно трекера проекта с курсором в нём', async () => {
  const youtrack: ProjectTrackerRow = {
    ...described,
    tracker: { kind: 'youtrack', name: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'BILL' },
    description: { ...github, tracker: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'BILL' },
  }
  stubApi({ 'GET /api/trackers/projects': () => json([youtrack]) })

  render(<TrackerProjects servers={[]} focus={{ base: youtrack.base, at: 1, field: 'key' }} />)

  const dialog = await screen.findByRole('dialog', { name: 'Трекер проекта' })
  expect(within(dialog).getByLabelText('Ключ')).toHaveFocus()
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

  render(<TrackerProjects />)

  const orders = await row('Orders')
  const remove = orders.getByRole('button', { name: 'Удалить трекер Orders' })
  expect(remove).toBeDisabled()
  expect(remove).toHaveAttribute(
    'title',
    'Трекер не удалить: в копиях agents-kit-web-2 и agents-kit-web-4 идут задачи из него — #293 и #301.',
  )
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeEnabled()
})

test('сломанное описание — красная строка о полях, которые не указаны, кнопки открыты', async () => {
  stubApi({
    'GET /api/trackers/projects': () =>
      json([{ ...described, tracker: { kind: 'no-keys', faults: ['проект'] }, description: { ...github, project: '' } }]),
  })

  render(<TrackerProjects />)

  const orders = await row('Orders')
  expect(orders.getByText('В описании трекера не указан проект или указан не так.')).toBeInTheDocument()
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

  render(<TrackerProjects />)

  expect(
    (await row('Orders')).getByText(
      'Описание трекера записано не так, как требует кит: проект и раздел «Задача закрыта». Исправьте его кнопкой «Изменить».',
    ),
  ).toBeInTheDocument()
})

test('база нового формата кита — правка закрыта, строка говорит почему', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([{ ...described, newerFormat: true }]) })

  render(<TrackerProjects />)

  const orders = await row('Orders')
  expect(orders.getByText('Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeDisabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeDisabled()
})

test('описание, которое не прочитать, — строка причины, кнопки погашены', async () => {
  stubApi({ 'GET /api/trackers/projects': () => json([{ ...described, tracker: { kind: 'unreadable' }, description: null }]) })

  render(<TrackerProjects />)

  const orders = await row('Orders')
  expect(orders.getByText('Описание трекера не прочитано: нет доступа к файлу tracker.md.')).toBeInTheDocument()
  expect(orders.getByRole('button', { name: 'Изменить трекер Orders' })).toBeDisabled()
  expect(orders.getByRole('button', { name: 'Удалить трекер Orders' })).toBeDisabled()
})

test('«Удалить» спрашивает окном, удаляет поверх увиденного и перечитывает проекты', async () => {
  let listed = [described]
  const fetchMock = stubApi({
    'GET /api/trackers/projects': () => json(listed),
    'DELETE /api/trackers/projects': () => {
      listed = [{ ...described, tracker: null, description: null, version: '' }]
      return json({ version: '', checked: false, pushed: true, message: null })
    },
  })
  render(<TrackerProjects />)

  fireEvent.click((await row('Orders')).getByRole('button', { name: 'Удалить трекер Orders' }))
  const dialog = within(screen.getByRole('dialog', { name: 'Удалить трекер проекта' }))
  expect(dialog.getByText(/уйдёт из базы знаний, и «Бэклог» перестанет показывать задачи проекта/)).toHaveTextContent(
    'Описание трекера проекта Orders уйдёт из базы знаний, и «Бэклог» перестанет показывать задачи проекта acme/orders из GitHub. Панель отправит базу на сервер.',
  )
  fireEvent.click(dialog.getByRole('button', { name: 'Удалить трекер' }))

  expect(await (await row('Orders')).findByRole('heading', { name: 'В этом проекте нет трекера' })).toBeInTheDocument()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')![0]
  expect(new URLSearchParams(deleted.split('?')[1])).toEqual(new URLSearchParams({ base: described.base, version: 'v1' }))
})

// Ключ к серверу без проектов показать негде — он уходит с последним трекером сервера, и окно говорит это заранее (B-285)
test('окно удаления говорит, что уйдёт и ключ, только когда других проектов на сервере нет', async () => {
  const jira = (base: string, project: string): ProjectTrackerRow => ({
    ...described,
    base,
    project,
    tracker: { kind: 'jira', name: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' },
    description: { ...github, tracker: 'Jira', server: 'https://acme.atlassian.net', project: 'PAY' },
  })
  const pay = jira('D:\\Projects\\pay-knowledge', 'Pay')
  const servers = [{ server: 'https://acme.atlassian.net', login: 'anna@acme.example', email: 'anna@acme.example' }]
  const phrase = /удалится и ключ к нему/

  stubApi({ 'GET /api/trackers/projects': () => json([pay]) })
  const { unmount } = render(<TrackerProjects servers={servers} />)
  fireEvent.click((await row('Pay')).getByRole('button', { name: 'Удалить трекер Pay' }))
  expect(within(screen.getByRole('dialog', { name: 'Удалить трекер проекта' })).getByText(phrase)).toHaveTextContent(
    'Других проектов на сервере https://acme.atlassian.net нет, поэтому с этого компьютера удалится и ключ к нему.',
  )
  unmount()

  stubApi({ 'GET /api/trackers/projects': () => json([pay, jira('D:\\Projects\\billing-knowledge', 'Billing')]) })
  render(<TrackerProjects servers={servers} />)
  fireEvent.click((await row('Pay')).getByRole('button', { name: 'Удалить трекер Pay' }))
  expect(within(screen.getByRole('dialog', { name: 'Удалить трекер проекта' })).queryByText(phrase)).not.toBeInTheDocument()
})

test('база не ушла на сервер после удаления — окно говорит это словами кита, «Закрыть» перечитывает проекты', async () => {
  let listed = [described]
  stubApi({
    'GET /api/trackers/projects': () => json(listed),
    'DELETE /api/trackers/projects': () => {
      listed = [{ ...described, tracker: null, description: null, version: '' }]
      return json({ version: '', checked: false, pushed: false, message: 'на remote базы не отдано — git: rejected' })
    },
  })
  render(<TrackerProjects />)

  fireEvent.click((await row('Orders')).getByRole('button', { name: 'Удалить трекер Orders' }))
  fireEvent.click(screen.getByRole('button', { name: 'Удалить трекер' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('База не отправлена на сервер')
  expect(alert).toHaveTextContent('Описание трекера удалено на этом компьютере, но на сервер не ушло. Кит ответил:')
  expect(alert).toHaveTextContent('на remote базы не отдано — git: rejected')
  // Кнопка внизу окна, а не крестик: у обоих имя «Закрыть».
  fireEvent.click(screen.getByText('Закрыть', { selector: '.dw-footer button' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(await (await row('Orders')).findByRole('heading', { name: 'В этом проекте нет трекера' })).toBeInTheDocument()
})

test('пришла задача трекера — окно удаления называет её, проекты перечитываются', async () => {
  const busy = [{ task: 'GitHub #37 Выгрузка', copy: 'D:\\Projects\\orders-2' }]
  const fetchMock = stubApi({
    'GET /api/trackers/projects': () => json([described]),
    'DELETE /api/trackers/projects': () => json({ problem: 'busy', busy }, 409),
  })
  render(<TrackerProjects />)

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
  render(<TrackerProjects />)

  fireEvent.click((await row('CRM')).getByRole('button', { name: 'Завести трекер CRM' }))

  const dialog = within(screen.getByRole('dialog', { name: 'Трекер проекта' }))
  expect(dialog.getByText('CRM')).toHaveClass('pf-project')
  expect(dialog.getByLabelText('Адрес сервера')).toHaveValue(emptyDescription.server)
  expect(dialog.getByRole('button', { name: 'Завести с Чудо-Юдо' })).toBeInTheDocument()
})

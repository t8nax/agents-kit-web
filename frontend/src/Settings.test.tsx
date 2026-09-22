import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App from './App'
import type { FolderListing } from './FolderBrowser'
import type { BaseEntry, KitEntry } from './Settings'

// Индикатор просьб к агенту опрашивает панель сам и проверяется своим тестом; настройкам он не нужен.
vi.mock('./AgentBar', () => ({ default: () => null }))

afterEach(() => {
  vi.unstubAllGlobals()
})

type Handler = (init?: RequestInit, url?: string) => Response

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const existing: BaseEntry = { path: 'D:\\Projects\\app-knowledge', copies: 2 }
const noKit: KitEntry = { path: null, found: false }
const kitPath = 'C:\\Users\\me\\.claude\\skills\\agents-kit'

async function openSettings() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Настройки' }))
  await screen.findByRole('heading', { name: 'Настройки' })
  return {
    bases: () => screen.getByRole('region', { name: /^Базы знаний/ }),
    kit: () => screen.getByRole('region', { name: /^Кит/ }),
  }
}

// Карточка «Панель» стоит в этом же разделе и спрашивает панель о ней самой; своё у неё — свой тест.
const panel = { version: '1.0.0', installed: false, channel: 'master', published: null }
const noUpdate = { state: 'none', version: null, log: [], file: 'C:\\app\\update.log' }

const api = (extra: Record<string, Handler> = {}) => ({
  'GET /api/workspaces': () => json([]),
  'GET /api/bases': () => json([existing]),
  'GET /api/kit': () => json(noKit),
  'GET /api/panel': () => json(panel),
  'GET /api/panel/update': () => json(noUpdate),
  ...extra,
})

test('раздел «Настройки» показывает список баз', async () => {
  stubApi(api())

  const { bases } = await openSettings()

  const list = await within(bases()).findByRole('list', { name: 'Базы знаний' })
  expect(within(list).getByText('D:\\Projects\\app-knowledge')).toBeInTheDocument()
  expect(within(list).getByText('2 коп.')).toBeInTheDocument()
  expect(within(list).getByRole('button', { name: 'Удалить D:\\Projects\\app-knowledge' })).toBeInTheDocument()
})

test('карточка «Уведомления» стоит в разделе последней, под «Панелью»', async () => {
  stubApi(api())

  await openSettings()

  const cards = screen.getAllByRole('region').map((card) => card.getAttribute('aria-labelledby'))
  expect(cards.slice(-2)).toEqual(['settings-panel', 'settings-notifications'])
  expect(screen.getByRole('region', { name: 'Уведомления' })).toBeInTheDocument()
})

test('добавленная база появляется в списке', async () => {
  let posted: unknown = null
  stubApi(
    api({
      'GET /api/bases': () => json([]),
      'POST /api/bases': (init) => {
        posted = JSON.parse(String(init?.body))
        return json({ path: 'D:\\Projects\\nota-knowledge', copies: 1 }, 201)
      },
    }),
  )

  const { bases } = await openSettings()
  fireEvent.change(await within(bases()).findByLabelText('Путь к каталогу базы'), {
    target: { value: 'D:\\Projects\\nota-knowledge' },
  })
  fireEvent.click(within(bases()).getByRole('button', { name: 'Добавить' }))

  expect(await within(bases()).findByText('D:\\Projects\\nota-knowledge')).toBeInTheDocument()
  expect(posted).toEqual({ path: 'D:\\Projects\\nota-knowledge' })
  expect(within(bases()).getByLabelText('Путь к каталогу базы')).toHaveValue('')
})

test.each([
  ['not-a-base', 400, 'В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.'],
  ['duplicate', 409, 'Эта база уже в списке.'],
  ['not-full-path', 400, 'Укажите полный путь, например D:\\Projects\\project-knowledge.'],
])('отказ API %s показывает причину и не меняет список', async (problem, status, text) => {
  stubApi(api({ 'POST /api/bases': () => json({ problem }, status) }))

  const { bases } = await openSettings()
  fireEvent.change(await within(bases()).findByLabelText('Путь к каталогу базы'), {
    target: { value: 'D:\\Projects\\x' },
  })
  fireEvent.click(within(bases()).getByRole('button', { name: 'Добавить' }))

  expect(await within(bases()).findByRole('alert')).toHaveTextContent(text)
  expect(within(within(bases()).getByRole('list', { name: 'Базы знаний' })).getAllByRole('listitem')).toHaveLength(1)
})

test('пустой путь базы не отправляется', async () => {
  const fetchMock = stubApi(api({ 'GET /api/bases': () => json([]) }))

  const { bases } = await openSettings()
  fireEvent.change(await within(bases()).findByLabelText('Путь к каталогу базы'), { target: { value: '   ' } })
  fireEvent.click(within(bases()).getByRole('button', { name: 'Добавить' }))

  expect(await within(bases()).findByRole('alert')).toHaveTextContent(
    'Введите путь к каталогу базы или выберите папку через «Обзор…».',
  )
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
})

test('«Удалить» убирает базу из списка', async () => {
  const fetchMock = stubApi(api({ 'DELETE /api/bases': () => new Response(null, { status: 204 }) }))

  const { bases } = await openSettings()
  fireEvent.click(await within(bases()).findByRole('button', { name: 'Удалить D:\\Projects\\app-knowledge' }))

  expect(await within(bases()).findByText('Список пуст.')).toBeInTheDocument()
  const deleted = fetchMock.mock.calls.find(([, init]) => init?.method === 'DELETE')?.[0]
  expect(deleted).toBe(`/api/bases?path=${encodeURIComponent('D:\\Projects\\app-knowledge')}`)
})

const drives: FolderListing = {
  path: null,
  parent: null,
  folders: [{ name: 'D:\\', path: 'D:\\', isBase: false, copies: null }],
}

const projects: FolderListing = {
  path: 'D:\\Projects',
  parent: 'D:\\',
  folders: [
    { name: 'agents-kit-web-knowledge', path: 'D:\\Projects\\agents-kit-web-knowledge', isBase: true, copies: 2 },
    { name: 'nota-knowledge', path: 'D:\\Projects\\nota-knowledge', isBase: true, copies: 1 },
    { name: 'nota', path: 'D:\\Projects\\nota', isBase: false, copies: null },
  ],
}

const folderHandler = (listings: Record<string, FolderListing>): Handler => (_init, url) =>
  json(listings[new URLSearchParams(String(url).split('?')[1] ?? '').get('path') ?? ''])

test('«Обзор…» у баз открывает диски, папки открываются, а базу из обзора можно добавить', async () => {
  stubApi(
    api({
      'GET /api/bases': () => json([{ path: 'D:\\Projects\\agents-kit-web-knowledge', copies: 2 }]),
      'GET /api/folders': folderHandler({
        '': drives,
        'D:\\': { path: 'D:\\', parent: null, folders: [{ name: 'Projects', path: 'D:\\Projects', isBase: false, copies: null }] },
        'D:\\Projects': projects,
      }),
      'POST /api/bases': () => json({ path: 'D:\\Projects\\nota-knowledge', copies: 1 }, 201),
    }),
  )

  const { bases } = await openSettings()
  fireEvent.click(await within(bases()).findByRole('button', { name: /Обзор/ }))

  const folders = await within(bases()).findByRole('list', { name: 'Папки' })
  fireEvent.click(await within(folders).findByRole('button', { name: /D:\\/ }))
  fireEvent.click(await within(folders).findByRole('button', { name: /Projects/ }))

  expect(await within(folders).findByText('nota-knowledge')).toBeInTheDocument()
  const nav = within(bases()).getByRole('navigation', { name: 'Текущая папка' })
  expect(within(nav).getByRole('button', { name: 'Projects' })).toHaveAttribute('aria-current', 'location')

  const listed = within(folders).getByText('agents-kit-web-knowledge').closest('li')!
  expect(within(listed).getByText('уже в списке')).toBeInTheDocument()
  expect(within(folders).queryByRole('button', { name: 'Добавить D:\\Projects\\nota' })).not.toBeInTheDocument()

  fireEvent.click(within(folders).getByRole('button', { name: 'Добавить D:\\Projects\\nota-knowledge' }))
  expect(await within(bases()).findByRole('status')).toHaveTextContent('Добавлена nota-knowledge')
  const added = within(folders).getByText('nota-knowledge').closest('li')!
  expect(within(added).getByText('уже в списке')).toBeInTheDocument()

  fireEvent.click(within(bases()).getByRole('button', { name: 'К списку баз' }))
  const list = await within(bases()).findByRole('list', { name: 'Базы знаний' })
  expect(within(list).getByText('D:\\Projects\\nota-knowledge')).toBeInTheDocument()
})

test('папка без доступа показывает причину в обзоре', async () => {
  stubApi(
    api({
      'GET /api/bases': () => json([]),
      'GET /api/folders': (_init, url) =>
        String(url).includes('?') ? json({ problem: 'access-denied' }, 403) : json(drives),
    }),
  )

  const { bases } = await openSettings()
  fireEvent.click(await within(bases()).findByRole('button', { name: /Обзор/ }))
  fireEvent.click(await within(bases()).findByRole('button', { name: /D:\\/ }))

  expect(await within(bases()).findByRole('alert')).toHaveTextContent('Нет доступа к этой папке.')
})

test('путь к киту не задан — поле пустое и сказано, что базы не проверяются', async () => {
  stubApi(api())

  const { kit } = await openSettings()

  expect(await within(kit()).findByLabelText('Путь к каталогу кита')).toHaveValue('')
  expect(within(kit()).getByText('Путь к киту не задан — проблемы баз не проверяются.')).toBeInTheDocument()
})

test('сохранённый путь к киту стоит в поле, а пропавший кит назван', async () => {
  stubApi(api({ 'GET /api/kit': () => json({ path: kitPath, found: false }) }))

  const { kit } = await openSettings()

  expect(await within(kit()).findByLabelText('Путь к каталогу кита')).toHaveValue(kitPath)
  expect(
    within(kit()).getByText('По сохранённому пути кита больше нет — проблемы баз не проверяются.'),
  ).toBeInTheDocument()
})

test('путь к киту сохраняется, а каталог без кита отклоняется с причиной', async () => {
  const puts: unknown[] = []
  stubApi(
    api({
      'PUT /api/kit': (init) => {
        const body = JSON.parse(String(init?.body)) as { path: string }
        puts.push(body)
        return body.path === kitPath ? json({ path: kitPath, found: true }) : json({ problem: 'not-a-kit' }, 400)
      },
    }),
  )

  const { kit } = await openSettings()
  const input = await within(kit()).findByLabelText('Путь к каталогу кита')

  fireEvent.change(input, { target: { value: 'C:\\Users\\me\\.claude\\skills' } })
  fireEvent.click(within(kit()).getByRole('button', { name: 'Сохранить' }))
  expect(await within(kit()).findByRole('alert')).toHaveTextContent(
    'В каталоге нет скриптов проверок кита — это не кит. Путь не сохранён.',
  )
  expect(within(kit()).getByText('Путь к киту не задан — проблемы баз не проверяются.')).toBeInTheDocument()

  fireEvent.change(input, { target: { value: kitPath } })
  fireEvent.click(within(kit()).getByRole('button', { name: 'Сохранить' }))
  expect(await within(kit()).findByText('Кит найден: скрипты проверок на месте.')).toBeInTheDocument()
  expect(within(kit()).queryByRole('alert')).not.toBeInTheDocument()
  expect(puts).toEqual([{ path: 'C:\\Users\\me\\.claude\\skills' }, { path: kitPath }])
})

test('«Найти автоматически» подставляет единственный найденный кит, а сохраняет оператор', async () => {
  const fetchMock = stubApi(
    api({
      'GET /api/kit/found': () => json([kitPath]),
      'PUT /api/kit': () => json({ path: kitPath, found: true }),
    }),
  )

  const { kit } = await openSettings()
  fireEvent.click(await within(kit()).findByRole('button', { name: 'Найти автоматически' }))

  expect(await within(kit()).findByText('Кит найден, путь подставлен в поле — сохраните его.')).toBeInTheDocument()
  expect(within(kit()).getByLabelText('Путь к каталогу кита')).toHaveValue(kitPath)
  // Сам поиск ничего не сохраняет
  expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false)

  fireEvent.click(within(kit()).getByRole('button', { name: 'Сохранить' }))
  expect(await within(kit()).findByText('Кит найден: скрипты проверок на месте.')).toBeInTheDocument()
})

test('несколько найденных китов показываются списком, выбранный подставляется в поле', async () => {
  const other = 'D:\\Tools\\agents-kit'
  stubApi(api({ 'GET /api/kit/found': () => json([kitPath, other]) }))

  const { kit } = await openSettings()
  fireEvent.click(await within(kit()).findByRole('button', { name: 'Найти автоматически' }))

  const list = await within(kit()).findByRole('list', { name: 'Найденные киты' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  expect(within(kit()).getByLabelText('Путь к каталогу кита')).toHaveValue('')

  fireEvent.click(within(list).getByRole('button', { name: `Подставить ${other}` }))
  expect(within(kit()).getByLabelText('Путь к каталогу кита')).toHaveValue(other)
})

test('кит не найден — сказано, что делать дальше', async () => {
  stubApi(api({ 'GET /api/kit/found': () => json([]) }))

  const { kit } = await openSettings()
  fireEvent.click(await within(kit()).findByRole('button', { name: 'Найти автоматически' }))

  expect(
    await within(kit()).findByText(
      'Кит не найден среди навыков и плагинов Claude Code — укажите путь сами или выберите через «Обзор…».',
    ),
  ).toBeInTheDocument()
})

test('кит выбирается в обзоре: папка кита отмечена, «Выбрать» сохраняет путь', async () => {
  stubApi(
    api({
      'GET /api/folders': folderHandler({
        '': drives,
        'D:\\': {
          path: 'D:\\',
          parent: null,
          folders: [
            { name: 'agents-kit', path: 'D:\\agents-kit', isBase: false, copies: null, isKit: true },
            { name: 'Projects', path: 'D:\\Projects', isBase: false, copies: null },
          ],
        },
      }),
      'PUT /api/kit': () => json({ path: 'D:\\agents-kit', found: true }),
    }),
  )

  const { kit } = await openSettings()
  fireEvent.click(await within(kit()).findByRole('button', { name: /Обзор/ }))
  const folders = await within(kit()).findByRole('list', { name: 'Папки' })
  fireEvent.click(await within(folders).findByRole('button', { name: /D:\\/ }))

  const kitFolder = (await within(folders).findByText('agents-kit')).closest('li')!
  expect(within(kitFolder).getByText('кит')).toBeInTheDocument()
  expect(within(folders).queryByRole('button', { name: 'Выбрать D:\\Projects' })).not.toBeInTheDocument()

  fireEvent.click(within(folders).getByRole('button', { name: 'Выбрать D:\\agents-kit' }))

  expect(await within(kit()).findByLabelText('Путь к каталогу кита')).toHaveValue('D:\\agents-kit')
  expect(within(kit()).getByText('Кит найден: скрипты проверок на месте.')).toBeInTheDocument()
})

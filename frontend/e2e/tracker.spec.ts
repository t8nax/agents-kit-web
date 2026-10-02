import { expect, test, type Page } from '@playwright/test'

// Задачи трекера GitHub в разделе «Бэклог» (B-277). /api подменяется: прогон работает с живыми базами оператора,
// а задачи трекера читает gh из настоящего GitHub.
const base = 'D:\\Projects\\agents-kit-web-knowledge'
const freeRow = {
  project: 'Agents Kit Web',
  base,
  path: 'D:\\Projects\\rustic-silver-sparrow',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}
const backlog = [
  {
    base,
    project: 'Agents Kit Web',
    entries: [{ number: 'B-7', title: 'Панель показывает задачу сразу после её старта', text: null }],
    error: null,
    letters: 'B',
    tracker: { kind: 'github', name: 'GitHub', server: 'https://github.com', project: 'acme/orders' },
  },
  {
    base: 'D:\\Projects\\nota-knowledge',
    project: 'Nota',
    entries: [{ number: 'B-4', title: 'Экспорт заметок', text: null }],
    error: null,
    letters: 'B',
    tracker: null,
  },
]
const issues = [
  { name: 'GitHub #52', number: 52, title: 'Панель не стартует с пробелом в пути', url: 'https://github.com/acme/orders/issues/52', labels: ['bug', 'windows'] },
  { name: 'GitHub #7', number: 7, title: 'Показывать версию кита', url: 'https://github.com/acme/orders/issues/7', labels: [] },
]
// Все метки репозитория — перечень фильтра «Метки» (B-305); documentation нет ни у одной задачи
const labels = ['bug', 'documentation', 'windows']

async function routeApi(page: Page) {
  const posts: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [freeRow] }))
  await page.route('**/api/backlog', (route) => route.fulfill({ json: backlog }))
  await page.route('**/api/backlog/tracker?**', (route) => route.fulfill({ json: { issues, problem: null, labels } }))
  await page.route('**/api/flow', (route) =>
    route.fulfill({ json: [{ base, project: 'Agents Kit Web', flows: [{ name: 'полный', when: null, entries: [{ stage: 'Ветка' }] }] }] }),
  )
  await page.route('**/api/tasks', async (route) => {
    posts.push(route.request().postDataJSON())
    await route.fulfill({ json: { session: '7339dced' } })
  })
  // Вкладка задачи на GitHub в прогон не ходит в сеть
  await page.context().route('https://github.com/**', (route) => route.fulfill({ body: '<title>GitHub</title>', contentType: 'text/html' }))
  return posts
}

async function openTrackerTab(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await page.getByRole('tablist', { name: 'Части бэклога' }).getByRole('tab', { name: 'Задачи трекера' }).click()
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`вкладка «Задачи трекера» — задачи GitHub с метками, фильтр «Метки» (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await routeApi(page)
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

    // На вкладке записей задач трекера нет; вкладки — справа в шапке, как во «Флоу»
    const tabs = page.getByRole('tablist', { name: 'Части бэклога' })
    await expect(tabs.getByRole('tab', { name: 'Записи бэклога' })).toHaveAttribute('aria-selected', 'true')
    await expect(page.getByRole('button', { name: /B-7/ })).toBeVisible()
    await expect(page.getByRole('link', { name: /#52/ })).toHaveCount(0)
    const [tabsBox, askBox] = await Promise.all([tabs.boundingBox(), page.getByRole('button', { name: /Попросить/ }).boundingBox()])
    expect(tabsBox!.x + tabsBox!.width).toBeLessThanOrEqual(askBox!.x)

    await tabs.getByRole('tab', { name: 'Задачи трекера' }).click()
    const project = page.getByRole('region', { name: 'Agents Kit Web' })
    const link = project.getByRole('link', { name: /#52 Панель не стартует с пробелом в пути/ })
    await expect(link).toBeVisible()
    await expect(link.locator('.issue-label')).toHaveText(['bug', 'windows'])
    // Проекта без трекера на вкладке нет
    await expect(page.getByRole('region', { name: 'Nota' })).toHaveCount(0)

    await page.getByRole('button', { name: 'Метки' }).click()
    const list = page.getByRole('listbox', { name: 'Метки' })
    await expect(list.getByRole('option')).toHaveText(['bug', 'documentation', 'windows'])
    await list.getByRole('option', { name: 'documentation' }).click()
    await expect(project).toHaveCount(0)
    await expect(page.getByText('Под фильтр задач нет')).toBeVisible()
    await list.getByRole('option', { name: 'bug' }).click()
    await expect(page.getByRole('button', { name: 'Метки: documentation, bug' })).toBeVisible()
    await expect(project.getByRole('link')).toHaveCount(1)

    // Строка задачи открывает её на GitHub во вкладке браузера
    await page.keyboard.press('Escape')
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await expect.poll(() => tab.url()).toBe('https://github.com/acme/orders/issues/52')
    await tab.close()
  })
}

test('пока задачи трекера читаются, записи бэклога видны, а на вкладке трекера проступает заготовка', async ({ page }) => {
  await routeApi(page)
  // Чтение трекера держится, пока тест не отпустит: gh ходит в GitHub дольше, чем читается файл
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/backlog/tracker?**', async (route) => {
    await held
    await route.fulfill({ json: { issues, problem: null, labels } })
  })
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  await expect(page.getByRole('button', { name: /B-7/ })).toBeVisible()
  await page.getByRole('tab', { name: 'Задачи трекера' }).click()
  const project = page.getByRole('region', { name: 'Agents Kit Web' })
  const skeleton = project.getByRole('status', { name: 'Загрузка задач трекера' })
  await expect(skeleton).toBeAttached()
  // Затянулось чтение — полосы видны
  await expect(skeleton.locator('.sk').first()).toBeVisible()

  release()
  await expect(project.getByRole('link', { name: /#52/ })).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})

// ——— YouTrack (B-288) ———

const youTrackIssues = [
  { name: 'YouTrack ABC-7', number: 7, title: 'Письмо о сбросе пароля уходит без ссылки', url: 'https://acme.youtrack.cloud/issue/ABC-7', assignee: 'Анна Смирнова', mine: true },
  {
    name: 'YouTrack ABC-104',
    number: 104,
    title: 'Импорт клиентов из CSV пропускает строки с кавычками в названии компании и в адресе доставки, если адрес набран через точку с запятой',
    url: 'https://acme.youtrack.cloud/issue/ABC-104',
    assignee: 'Константин Константинопольский-Задунайский, Анна Смирнова, Борис Ким',
    mine: false,
  },
  { name: 'YouTrack ABC-1287', number: 1287, title: 'Перевести отчёты на новую схему налогов', url: 'https://acme.youtrack.cloud/issue/ABC-1287' },
]

for (const [width, colorScheme] of [
  [1400, 'light'],
  [900, 'dark'],
] as const) {
  test(`задачи YouTrack: номера ABC-N в одной колонке, строки не шире раздела (${width}px, ${colorScheme})`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await page.emulateMedia({ colorScheme })
    await routeApi(page)
    await page.route('**/api/backlog', (route) =>
      route.fulfill({
        json: [{ ...backlog[0], tracker: { kind: 'youtrack', name: 'YouTrack', server: 'https://acme.youtrack.cloud', project: 'ABC' } }],
      }),
    )
    await page.route('**/api/backlog/tracker?**', (route) => route.fulfill({ json: { issues: youTrackIssues, problem: null } }))
    await openTrackerTab(page)

    const project = page.getByRole('region', { name: 'Agents Kit Web' })
    const numbers = project.locator('.tracker-issues .tracker-num')
    await expect(numbers).toHaveText(['ABC-7', 'ABC-104', 'ABC-1287'])
    // Заголовки начинаются с одной вертикали: колонка номера — по самому длинному номеру
    await expect(async () => {
      const lefts = await project.locator('.tracker-issues .entry-title').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)))
      expect(new Set(lefts).size).toBe(1)
    }).toPass()
    // Длинный заголовок не выталкивает «Взять задачу» за край раздела
    const row = project.locator('.entry-row').filter({ hasText: 'ABC-104' })
    await expect(async () => {
      const [button, list] = await Promise.all([row.getByRole('button', { name: 'Взять задачу' }).boundingBox(), project.boundingBox()])
      expect(button!.x + button!.width).toBeLessThanOrEqual(list!.x + list!.width + 0.5)
    }).toPass()
    await expect(row.getByRole('link')).toHaveAttribute('href', 'https://acme.youtrack.cloud/issue/ABC-104')
    // Исполнитель — второй строкой под заголовком и в пределах строки задачи, у ничьей — «никому» (макет AKW-17)
    await expect(project.locator('.tracker-issues .issue-assignee')).toHaveText(['Анна Смирнова', /^Константин/, 'никому'])
    await expect(async () => {
      const [title, assignee, link] = await Promise.all([
        row.locator('.entry-title').boundingBox(),
        row.locator('.issue-assignee').boundingBox(),
        row.getByRole('link').boundingBox(),
      ])
      expect(assignee!.y).toBeGreaterThanOrEqual(title!.y + title!.height - 0.5)
      expect(Math.round(assignee!.x)).toBe(Math.round(title!.x))
      expect(assignee!.y + assignee!.height).toBeLessThanOrEqual(link!.y + link!.height + 0.5)
      expect(assignee!.x + assignee!.width).toBeLessThanOrEqual(link!.x + link!.width + 0.5)
    }).toPass()
    // Флажок «Мои задачи» — в строке отбора, за поиском (макет AKW-17, вариант А)
    const bar = page.getByRole('group', { name: 'Отбор задач трекера' })
    const mine = bar.getByRole('checkbox', { name: 'Мои задачи' })
    await expect(async () => {
      const [search, check, box] = await Promise.all([bar.locator('.backlog-search').boundingBox(), mine.boundingBox(), bar.boundingBox()])
      expect(check!.x).toBeGreaterThan(search!.x + search!.width)
      expect(check!.y).toBeGreaterThanOrEqual(box!.y - 0.5)
      expect(check!.y + check!.height).toBeLessThanOrEqual(box!.y + box!.height + 0.5)
    }).toPass()
    await mine.click()
    await expect(numbers).toHaveText(['ABC-7'])
  })
}

test('«Взять задачу» у задачи трекера запускает её по имени «GitHub #N»', async ({ page }) => {
  const posts = await routeApi(page)
  await openTrackerTab(page)

  const row = page.locator('.entry-row').filter({ hasText: '#7' })
  await row.getByRole('button', { name: 'Взять задачу' }).click()

  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  await expect(dialog.getByText('Задача трекера', { exact: true })).toBeVisible()
  await expect(dialog).toContainText('GitHub #7')
  await dialog.locator('label').filter({ hasText: 'rustic-silver-sparrow' }).click()
  await dialog.getByRole('button', { name: 'Взять в работу' }).click()

  await expect
    .poll(() => posts)
    .toEqual([{ base, copy: 'D:\\Projects\\rustic-silver-sparrow', number: 'GitHub #7', flow: 'полный' }])
})

// Фильтр проекта — воронкой в шапке его группы (макет B-285, вариант А): Enter записывает его в панели, плашка с ним
// встаёт в шапку, а шапка отстоит от первой задачи заметнее обычного — замечание оператора «слипается с задачами».
for (const width of [1400, 700]) {
  test(`фильтр проекта: воронка раскрывает поле, Enter записывает фильтр плашкой в шапке (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await routeApi(page)
    let filter: string | null = null
    const written: unknown[] = []
    await page.route('**/api/backlog/tracker/filter', async (route) => {
      const body = route.request().postDataJSON() as { filter: string }
      written.push(body)
      filter = body.filter || null
      await route.fulfill({ status: 204 })
    })
    await page.route('**/api/backlog', (route) =>
      route.fulfill({ json: backlog.map((one) => (one.tracker ? { ...one, tracker: { ...one.tracker, filter } } : one)) }),
    )

    await openTrackerTab(page)
    const project = page.getByRole('region', { name: 'Agents Kit Web' })
    await expect(project.getByRole('link', { name: /#52/ })).toBeVisible()
    await project.getByRole('button', { name: 'Фильтр проекта' }).click()
    const field = project.getByRole('textbox', { name: 'Фильтр проекта' })
    await expect(field).toBeFocused()
    await expect(field).toHaveAttribute('placeholder', 'assignee:@me — только ваши')
    await field.fill('assignee:@me')
    await field.press('Enter')

    await expect.poll(() => written).toEqual([{ base, filter: 'assignee:@me' }])
    const pill = project.getByRole('button', { name: 'assignee:@me' })
    await expect(pill).toBeVisible()
    await expect(field).toHaveCount(0)
    // Шапка с фильтром — не вплотную к первой задаче
    await expect(async () => {
      const [head, first] = await Promise.all([project.locator('.base-head').boundingBox(), project.locator('.entry-row').first().boundingBox()])
      expect(first!.y - (head!.y + head!.height)).toBeGreaterThanOrEqual(10)
    }).toPass()
    const { scroll, client } = await page.locator('html').evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    expect(scroll).toBeLessThanOrEqual(client + 1)
  })
}

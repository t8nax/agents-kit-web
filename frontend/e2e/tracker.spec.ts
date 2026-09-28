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
  { name: 'GitHub #52', number: 52, title: 'Панель не стартует с пробелом в пути', url: 'https://github.com/acme/orders/issues/52' },
  { name: 'GitHub #7', number: 7, title: 'Показывать версию кита', url: 'https://github.com/acme/orders/issues/7' },
]

async function routeApi(page: Page) {
  const posts: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [freeRow] }))
  await page.route('**/api/backlog', (route) => route.fulfill({ json: backlog }))
  await page.route('**/api/backlog/tracker?**', (route) => route.fulfill({ json: { issues, problem: null } }))
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

for (const colorScheme of ['light', 'dark'] as const) {
  test(`у проекта с трекером под записями — задачи GitHub, назначенные на оператора (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await routeApi(page)
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

    const project = page.getByRole('region', { name: 'Agents Kit Web' })
    await expect(project.getByText('Записи бэклога', { exact: true })).toBeVisible()
    const group = project.getByText('Задачи трекера, назначенные на вас', { exact: true })
    await expect(group).toBeVisible()
    const link = project.getByRole('link', { name: /#52 Панель не стартует с пробелом в пути/ })
    await expect(link).toBeVisible()
    // Задачи трекера — под записями бэклога
    const entryBox = await project.getByRole('button', { name: /B-7/ }).boundingBox()
    const groupBox = await group.boundingBox()
    expect(entryBox!.y + entryBox!.height).toBeLessThanOrEqual(groupBox!.y)
    // У проекта без трекера подписей нет
    await expect(page.getByRole('region', { name: 'Nota' }).getByText('Записи бэклога', { exact: true })).toHaveCount(0)

    // Строка задачи открывает её на GitHub во вкладке браузера
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await expect.poll(() => tab.url()).toBe('https://github.com/acme/orders/issues/52')
    await tab.close()
  })
}

test('пока задачи трекера читаются, записи бэклога видны, а под подписью группы проступает заготовка', async ({ page }) => {
  await routeApi(page)
  // Чтение трекера держится, пока тест не отпустит: gh ходит в GitHub дольше, чем читается файл
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/backlog/tracker?**', async (route) => {
    await held
    await route.fulfill({ json: { issues, problem: null } })
  })
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  const project = page.getByRole('region', { name: 'Agents Kit Web' })
  await expect(project.getByRole('button', { name: /B-7/ })).toBeVisible()
  const skeleton = project.getByRole('status', { name: 'Загрузка задач трекера' })
  await expect(skeleton).toBeAttached()
  // Затянулось чтение — полосы видны
  await expect(skeleton.locator('.sk').first()).toBeVisible()

  release()
  await expect(project.getByRole('link', { name: /#52/ })).toBeVisible()
  await expect(skeleton).toHaveCount(0)
})

test('«Взять задачу» у задачи трекера запускает её по имени «GitHub #N»', async ({ page }) => {
  const posts = await routeApi(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

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

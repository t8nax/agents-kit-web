import { expect, test, type Page } from '@playwright/test'

// Перенос записи бэклога в трекер GitHub кнопкой «В трекер» (B-286). /api подменяется: прогон работает с живыми
// базами оператора, а задачу заводит gh в настоящем GitHub.
const base = 'D:\\Projects\\agents-kit-web-knowledge'
const entry = {
  number: 'B-281',
  title: 'Экспорт истории задачи копии в markdown',
  text: 'Нужна выгрузка истории.',
  artifacts: [{ label: 'снимок', address: 'artifacts/B-281-reply-window.png' }],
}
const other = { number: 'B-7', title: 'Панель показывает задачу сразу после её старта', text: null }
const backlogOf = (entries: unknown[]) => [
  { base, project: 'Agents Kit Web', entries, error: null, letters: 'B', tracker: { kind: 'github', name: 'GitHub', server: 'https://github.com', project: 'acme/orders' } },
]
const draft = {
  number: 'B-281',
  title: entry.title,
  body: 'Нужна выгрузка истории.\n\n### Агенту\n- где: ReplyModal.tsx',
  files: [{ label: 'снимок', address: 'artifacts/B-281-reply-window.png' }],
  original: '## B-281 Экспорт истории задачи копии в markdown\n\nНужна выгрузка истории.',
}
const issue = { name: 'GitHub #58', number: 58, title: entry.title, url: 'https://github.com/acme/orders/issues/58' }

async function routeApi(page: Page) {
  const posts: unknown[] = []
  // Подмена отвечает по состоянию сюжета, а не по счёту чтений: dev-сервер под StrictMode читает раздел дважды
  let moved = false
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/backlog', (route) => route.fulfill({ json: backlogOf(moved ? [other] : [entry, other]) }))
  // Заведённую задачу трекер отдаёт, когда её завели: раздел перечитывает его после переноса (GitHub #3)
  await page.route('**/api/backlog/tracker?**', (route) => route.fulfill({ json: { issues: moved ? [issue] : [], problem: null } }))
  await page.route('**/api/backlog/tracker/draft?**', (route) => route.fulfill({ json: draft }))
  await page.route('**/api/backlog/tracker/move', async (route) => {
    posts.push(route.request().postDataJSON())
    moved = true
    await route.fulfill({ json: { issue, commit: 'c0ffee1', removed: ['artifacts/B-281-reply-window.png'] } })
  })
  // Вкладка задачи на GitHub в прогон не ходит в сеть
  await page.context().route('https://github.com/**', (route) => route.fulfill({ body: '<title>GitHub</title>', contentType: 'text/html' }))
  return posts
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`«В трекер» заводит задачу и убирает запись из бэклога (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page)
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

    const row = page.locator('.entry-row').filter({ hasText: 'B-281' })
    // Кнопка — между «Изменить» и «Взять задачу», значком того же размера, что у соседей
    await expect(row.getByRole('button')).toHaveText([/B-281/, 'Изменить', 'В трекер', 'Взять задачу'])
    const send = row.getByRole('button', { name: 'В трекер' })
    const iconOf = (name: string) => row.getByRole('button', { name }).locator('svg').boundingBox()
    await expect(async () => expect((await iconOf('В трекер'))!.width).toBe((await iconOf('Изменить'))!.width)).toPass()
    await send.click()

    const dialog = page.getByRole('dialog', { name: 'Перенести в трекер' })
    await expect(dialog.getByText('Нужна выгрузка истории.')).toBeVisible()
    await expect(dialog.getByRole('heading', { name: 'Агенту' })).toBeVisible()
    await expect(dialog.getByText('Файлы в задачу не попадут и удалятся вместе с записью:')).toBeVisible()
    await expect(dialog.getByText('artifacts/B-281-reply-window.png')).toBeVisible()
    await expect(dialog).not.toContainText('Куда')
    await dialog.getByRole('button', { name: 'Перевести задачу' }).click()

    const done = page.getByRole('dialog', { name: 'Задача заведена' })
    const link = done.getByRole('link', { name: /#58 Экспорт истории задачи копии в markdown/ })
    await expect(link).toBeVisible()
    await expect(done).toContainText('Запись B-281 убрана из бэклога, приложенные к ней файлы удалены.')
    await expect.poll(() => posts).toEqual([{ base, number: 'B-281', original: draft.original }])
    // Значок «открыть во вкладке» в окне — размера строки задачи трекера, а не общего правила окон
    await expect(async () => expect((await link.locator('svg').boundingBox())!.width).toBe(16)).toPass()

    // Строка задачи открывает её на GitHub во вкладке браузера
    const [tab] = await Promise.all([page.context().waitForEvent('page'), link.click()])
    await expect.poll(() => tab.url()).toBe('https://github.com/acme/orders/issues/58')
    await tab.close()

    await done.getByRole('button', { name: 'Закрыть' }).last().click()
    await expect(page.locator('.entry-row').filter({ hasText: 'B-281' })).toHaveCount(0)
    await expect(page.locator('.entry-row').filter({ hasText: 'B-7' })).toBeVisible()
    // Задача видна на вкладке задач трекера сразу, без «Обновить» (вкладки — B-305)
    await page.getByRole('tab', { name: 'Задачи трекера' }).click()
    await expect(page.getByRole('main').getByRole('link', { name: /#58 Экспорт истории задачи копии в markdown/ })).toBeVisible()
  })
}

test('«Отмена» закрывает окно переноса, ничего не заводя', async ({ page }) => {
  const posts = await routeApi(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  const send = page.locator('.entry-row').filter({ hasText: 'B-281' }).getByRole('button', { name: 'В трекер' })
  await send.click()
  const dialog = page.getByRole('dialog', { name: 'Перенести в трекер' })
  await expect(dialog.getByText('Нужна выгрузка истории.')).toBeVisible()
  await dialog.getByRole('button', { name: 'Отмена' }).click()

  await expect(dialog).toHaveCount(0)
  // Фокус возвращается кнопке, с которой открыли окно
  await expect(send).toBeFocused()
  expect(posts).toEqual([])
})

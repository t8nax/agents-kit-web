import { expect, test, type Page } from '@playwright/test'

// Запуск задачи e2e не делает по-настоящему: и список копий, и /api/tasks подменяются page.route.
const freeRow = {
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: 'D:\\Projects\\rustic-silver-sparrow',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}
const busyRow = {
  ...freeRow,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'feat/flow-edit',
  task: 'B-22 Правка флоу проекта из панели',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
}
const backlog = [
  {
    base: freeRow.base,
    project: 'Agents Kit Web',
    entries: [
      { number: 'B-7', title: 'Панель показывает задачу сразу после её старта', text: 'Текст оператору.' },
      { number: 'B-8', title: 'Кнопка запуска задачи', text: null },
    ],
    error: null,
  },
]

async function routeApi(page: Page, reply: { status: number; json: unknown }) {
  const posts: unknown[] = []
  await page.route('**/api/workspaces', async (route) => route.fulfill({ json: [busyRow, freeRow] }))
  await page.route('**/api/backlog', async (route) => route.fulfill({ json: backlog }))
  await page.route('**/api/tasks', async (route) => {
    posts.push(route.request().postDataJSON())
    await route.fulfill(reply)
  })
  return posts
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`задача запускается из строки свободной копии (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page, { status: 200, json: { session: '7339dced' } })
    await page.goto('/')

    const rows = page.getByRole('table').locator('tbody tr')
    // Занятая копия задачу не принимает: кнопка стоит только у свободной
    await expect(rows.filter({ hasText: 'B-22' }).getByRole('button', { name: 'Взять задачу' })).toBeHidden()
    // Кнопка стоит на месте задачи — в третьей ячейке строки, а не в колонке действий
    const taskCell = rows.filter({ hasText: 'rustic-silver-sparrow' }).getByRole('cell').nth(2)
    await taskCell.getByRole('button', { name: 'Взять задачу' }).click()

    const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
    await expect(dialog).toContainText('D:\\Projects\\rustic-silver-sparrow · ветка dev')
    // Окно непрозрачно в обеих темах: таблица под ним не просвечивает
    await expect(dialog).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(dialog.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()

    await dialog.locator('label').filter({ hasText: 'B-8' }).click()
    await dialog.getByRole('button', { name: 'Взять в работу' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status')).toContainText('Задача запущена в rustic-silver-sparrow')
    expect(posts).toEqual([{ base: freeRow.base, copy: freeRow.path, number: 'B-8' }])
  })
}

// Запуск задачи виден в строке копии до памяти: панель сама помнит, с какой записью её запустила.
const startingRow = {
  ...freeRow,
  task: 'B-8 Кнопка запуска задачи',
  status: 'starting',
  sessionState: 'working',
  backgroundSession: true,
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`копия с запускающейся задачей стоит занятой (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.route('**/api/workspaces', async (route) => route.fulfill({ json: [busyRow, startingRow] }))
    await page.goto('/')

    const row = page.getByRole('table').locator('tbody tr').filter({ hasText: 'rustic-silver-sparrow' })
    // Номер и заголовок записи стоят на своих местах, шага флоу и прогресса ещё нет
    await expect(row.getByRole('cell').nth(1)).toHaveText('B-8')
    await expect(row.getByRole('cell').nth(2)).toHaveText('Кнопка запуска задачи')
    await expect(row.getByRole('cell').nth(3)).toHaveText('—')
    await expect(row.getByRole('cell').nth(4)).toHaveText('—')
    // Вторую задачу в неё не запустить: кнопки у занятой копии нет
    await expect(row.getByRole('button', { name: 'Взять задачу' })).toBeHidden()

    const badge = row.getByText('Запускается')
    await expect(badge).toBeVisible()
    await expect(badge).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  })
}

test('сообщение о запущенной задаче гаснет само', async ({ page }) => {
  await routeApi(page, { status: 200, json: { session: '7339dced' } })
  await page.goto('/')

  await page.getByRole('table').locator('tbody tr').filter({ hasText: 'rustic-silver-sparrow' })
    .getByRole('button', { name: 'Взять задачу' }).click()
  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  await dialog.locator('label').filter({ hasText: 'B-7' }).click()
  await dialog.getByRole('button', { name: 'Взять в работу' }).click()

  const toast = page.getByRole('status')
  await expect(toast).toBeVisible()
  // Висит пять секунд и убирается без клика — решение оператора на приёмке
  await expect(toast).toBeVisible({ timeout: 3000 })
  await expect(toast).toBeHidden({ timeout: 8000 })
})

test('копию успели занять: окно называет идущую задачу и остаётся открытым', async ({ page }) => {
  await routeApi(page, { status: 400, json: { problem: 'copy-busy', message: 'B-5 Прошлая задача' } })
  await page.goto('/')

  await page.getByRole('table').locator('tbody tr').filter({ hasText: 'rustic-silver-sparrow' })
    .getByRole('button', { name: 'Взять задачу' }).click()

  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  await dialog.locator('label').filter({ hasText: 'B-7' }).click()
  await dialog.getByRole('button', { name: 'Взять в работу' }).click()

  await expect(dialog.getByRole('alert')).toContainText('В копии уже идёт задача «B-5 Прошлая задача»')
  await expect(dialog).toBeVisible()
})

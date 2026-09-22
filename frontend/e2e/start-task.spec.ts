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
  letters: 'B',
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
    letters: 'B',
  },
]

const notaFreeRow = {
  ...freeRow,
  project: 'Nota',
  base: 'D:\\Projects\\nota-knowledge',
  path: 'D:\\Projects\\nota',
}
const notaBacklog = {
  base: notaFreeRow.base,
  project: 'Nota',
  entries: [{ number: 'B-4', title: 'Экспорт заметок', text: null }],
  error: null,
  letters: 'B',
}

async function routeApi(page: Page, reply: { status: number; json: unknown }, rows = [busyRow, freeRow]) {
  const posts: unknown[] = []
  await page.route('**/api/workspaces', async (route) => route.fulfill({ json: rows }))
  await page.route('**/api/backlog', async (route) => route.fulfill({ json: backlog }))
  // Окно запуска предлагает флоу базы записи: их два, первым выбран первый.
  await page.route('**/api/flow', async (route) =>
    route.fulfill({
      json: [
        {
          base: freeRow.base,
          project: 'Agents Kit Web',
          flows: [
            { name: 'полный', when: 'новая возможность', entries: [{ stage: 'Ветка' }] },
            { name: 'мелкий', when: 'правка в одном месте', entries: [{ stage: 'Ветка' }] },
          ],
        },
      ],
    }),
  )
  await page.route('**/api/tasks', async (route) => {
    posts.push(route.request().postDataJSON())
    await route.fulfill(reply)
  })
  return posts
}

/** Открывает раздел «Бэклог»: задачу берут там, а не в таблице копий. */
async function openBacklog(page: Page) {
  await page.goto('/')
  await page.getByRole('button', { name: 'Бэклог' }).click()
  return page.locator('.entry-row')
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`задача запускается из записи бэклога (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page, { status: 200, json: { session: '7339dced' } })
    const entries = await openBacklog(page)

    // Строка записи по-прежнему открывается на чтение, а рядом с ней — запуск
    const entry = entries.filter({ hasText: 'B-8' })
    await entry.getByRole('button', { name: 'Взять задачу' }).click()

    const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
    await expect(dialog).toContainText('Кнопка запуска задачи')
    // Окно непрозрачно в обеих темах: список под ним не просвечивает
    await expect(dialog).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(dialog.getByRole('button', { name: 'Взять в работу' })).toBeDisabled()

    // Флоу выбирается над копией: первым выбран первый флоу, у каждого — его «когда»
    const flows = dialog.getByRole('group', { name: 'Флоу' })
    await expect(flows.getByRole('radio', { name: /полный/ })).toBeChecked()
    await expect(flows).toContainText('когда: правка в одном месте')
    const flowBox = await flows.boundingBox()
    const copyBox = await dialog.getByRole('group', { name: 'Рабочая копия' }).boundingBox()
    expect(flowBox!.y + flowBox!.height).toBeLessThanOrEqual(copyBox!.y)
    await flows.locator('label').filter({ hasText: 'мелкий' }).click()

    // Занятая копия в выбор не попадает
    await expect(dialog.locator('label').filter({ hasText: 'noble-keen-walrus' })).toBeHidden()
    await dialog.locator('label').filter({ hasText: 'rustic-silver-sparrow' }).click()

    // Начальные слова — последним разделом, под копией; Enter в поле — новая строка, Ctrl+Enter — запуск
    const words = dialog.getByRole('textbox', { name: 'Начальные слова' })
    const wordsBox = await words.boundingBox()
    expect(copyBox!.y + copyBox!.height).toBeLessThanOrEqual(wordsBox!.y)
    await words.fill('Начни с API.')
    await words.press('Enter')
    await words.pressSequentially('Макет подтверждён.')
    await expect(dialog).toBeVisible()
    await words.press('Control+Enter')

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status')).toContainText('Задача запущена в rustic-silver-sparrow')
    expect(posts).toEqual([
      { base: freeRow.base, copy: freeRow.path, number: 'B-8', flow: 'мелкий', words: 'Начни с API.\nМакет подтверждён.' },
    ])
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`без свободной копии кнопка записи погашена (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    // У соседнего проекта копия свободна: его живая кнопка говорит, что копии уже прочитаны
    await page.route('**/api/workspaces', async (route) => route.fulfill({ json: [busyRow, notaFreeRow] }))
    await page.route('**/api/backlog', async (route) => route.fulfill({ json: [...backlog, notaBacklog] }))
    const entries = await openBacklog(page)

    await expect(entries.filter({ hasText: 'B-4' }).getByRole('button', { name: 'Взять задачу' })).toBeEnabled()
    const start = entries.filter({ hasText: 'B-7' }).getByRole('button', { name: 'Взять задачу' })
    await expect(start).toBeVisible()
    await expect(start).toBeDisabled()
  })
}

// Запуск задачи виден в строке копии до памяти: панель сама помнит, с какой записью её запустила.
const startingRow = {
  ...freeRow,
  task: 'B-8 Кнопка запуска задачи',
  letters: 'B',
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

    const badge = row.getByText('Запускается')
    await expect(badge).toBeVisible()
    await expect(badge).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  })
}

test('в таблице копий задачу не берут: у свободной копии прочерк', async ({ page }) => {
  await routeApi(page, { status: 200, json: { session: '7339dced' } })
  await page.goto('/')

  const row = page.getByRole('table').locator('tbody tr').filter({ hasText: 'rustic-silver-sparrow' })
  await expect(row.getByRole('cell').nth(2)).toHaveText('—')
  await expect(page.getByRole('button', { name: 'Взять задачу' })).toBeHidden()
})

test('сообщение о запущенной задаче гаснет само', async ({ page }) => {
  await routeApi(page, { status: 200, json: { session: '7339dced' } })
  const entries = await openBacklog(page)

  await entries.filter({ hasText: 'B-7' }).getByRole('button', { name: 'Взять задачу' }).click()
  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  await dialog.locator('label').filter({ hasText: 'rustic-silver-sparrow' }).click()
  await dialog.getByRole('button', { name: 'Взять в работу' }).click()

  const toast = page.getByRole('status')
  await expect(toast).toBeVisible()
  // Висит пять секунд и убирается без клика — решение оператора на приёмке
  await expect(toast).toBeVisible({ timeout: 3000 })
  await expect(toast).toBeHidden({ timeout: 8000 })
})

test('копию успели занять: окно называет идущую задачу и остаётся открытым', async ({ page }) => {
  await routeApi(page, { status: 400, json: { problem: 'copy-busy', message: 'B-5 Прошлая задача' } })
  const entries = await openBacklog(page)

  await entries.filter({ hasText: 'B-7' }).getByRole('button', { name: 'Взять задачу' }).click()

  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  await dialog.locator('label').filter({ hasText: 'rustic-silver-sparrow' }).click()
  await dialog.getByRole('button', { name: 'Взять в работу' }).click()

  await expect(dialog.getByRole('alert')).toContainText('В копии уже идёт задача «B-5 Прошлая задача»')
  await expect(dialog).toBeVisible()
})

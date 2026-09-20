import { expect, test, type Page } from '@playwright/test'

// Запись в репозиторий проекта e2e не делает: заведение копии подменяется page.route.
const row = {
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: 'D:\\Projects\\agents-kit-web',
  branch: 'master',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
  copiesDir: 'D:\\Projects',
}
const busyRow = {
  ...row,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'feat/workspace-from-panel',
  task: 'B-14 Создание новой рабочей копии из панели',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
  copiesDir: null,
}
const createdRow = { ...row, path: 'D:\\Projects\\quiet-cedar', branch: 'quiet-cedar', copiesDir: null }

async function routeApi(page: Page, answer: (name: string | null) => { status: number; json: unknown }) {
  let created = false
  const posts: unknown[] = []
  await page.route('**/api/workspaces', async (route) => {
    if (route.request().method() === 'POST') {
      const body = route.request().postDataJSON() as { name: string | null }
      posts.push(body)
      const reply = answer(body.name)
      created = reply.status === 200
      await route.fulfill(reply)
      return
    }
    await route.fulfill({ json: created ? [row, busyRow, createdRow] : [row, busyRow] })
  })
  return posts
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`новая копия заводится из окна и отмечена в таблице (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page, (name) => ({ status: 200, json: { name } }))
    await page.goto('/')

    const button = page.getByRole('button', { name: 'Новая копия' })
    await expect(button).toBeVisible()
    // Кнопка стоит справа в заголовке раздела, над таблицей
    const [buttonBox, tableBox] = await Promise.all([button.boundingBox(), page.getByRole('table').boundingBox()])
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(tableBox!.y)
    expect(buttonBox!.x + buttonBox!.width).toBeGreaterThan(tableBox!.x + tableBox!.width - 60)
    await button.click()

    const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
    await expect(dialog.getByRole('radio', { name: /Agents Kit Web/ })).toBeChecked()
    await dialog.getByLabel(/Имя копии/).fill('quiet-cedar')
    const preview = dialog.getByLabel('Что будет заведено')
    await expect(preview).toContainText('D:\\Projects\\quiet-cedar')
    await expect(preview).toContainText('master · основная копия D:\\Projects\\agents-kit-web')
    await expect(dialog).toContainText('У проекта уже есть свободная копия master')
    // Окно непрозрачно в обеих темах: таблица под ним не просвечивает
    await expect(dialog).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    await dialog.getByRole('button', { name: 'Завести копию' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status')).toContainText('Копия quiet-cedar заведена')
    const fresh = page.getByRole('table').locator('tbody tr.row-fresh')
    // Путь копии в строке не пишется — он в подсказке ячейки с её именем
    await expect(fresh.getByRole('cell').first()).toHaveAttribute('title', 'D:\\Projects\\quiet-cedar')
    await expect(fresh).toContainText('новая')
    await expect(fresh).toContainText('Свободна')
    expect(posts).toEqual([{ base: row.base, name: 'quiet-cedar' }])
  })
}

test('отказ кита виден в окне его словами, окно остаётся открытым', async ({ page }) => {
  await routeApi(page, (name) => ({
    status: 400,
    json: { problem: 'refused', message: `ветка «${name}» уже существует — назвать копию иначе` },
  }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Новая копия' }).click()

  const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
  await dialog.getByLabel(/Имя копии/).fill('quiet-cedar')
  await dialog.getByRole('button', { name: 'Завести копию' }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Кит не завёл копию')
  await expect(alert).toContainText('ветка «quiet-cedar» уже существует — назвать копию иначе')
  await expect(dialog.getByRole('button', { name: 'Попробовать снова' })).toBeEnabled()
  await expect(page.getByRole('table').locator('tbody tr:not(.group-row)')).toHaveCount(2)
})

test('без кита окно объясняет и ведёт в «Настройки»', async ({ page }) => {
  await routeApi(page, () => ({ status: 400, json: { problem: 'kit-not-set', message: null } }))
  await page.goto('/')
  await page.getByRole('button', { name: 'Новая копия' }).click()

  const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
  await dialog.getByRole('button', { name: 'Завести копию' }).click()
  await expect(dialog.getByRole('alert')).toContainText('Путь к киту не задан')

  await dialog.getByRole('button', { name: 'Открыть «Настройки»' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Настройки', level: 2 })).toBeVisible()
})

test('у копии, которая и основная, и только что заведена, плашки стоят подряд', async ({ page }) => {
  let created = false
  await page.route('**/api/workspaces', async (route) => {
    if (route.request().method() === 'POST') {
      created = true
      await route.fulfill({ status: 200, json: { name: 'quiet-cedar' } })
      return
    }
    // Заведённой копии дан признак основной: только так обе плашки встают в одной строке разом.
    // У источника его в этом ответе нет: двух основных копий у проекта не бывает
    await route.fulfill({
      json: created ? [{ ...row, copiesDir: null }, { ...createdRow, copiesDir: 'D:\\Projects' }] : [row],
    })
  })
  await page.goto('/')

  await page.getByRole('button', { name: 'Новая копия' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
  await dialog.getByLabel(/Имя копии/).fill('quiet-cedar')
  await dialog.getByRole('button', { name: 'Завести копию' }).click()

  const fresh = page.getByRole('table').locator('tbody tr.row-fresh')
  const cell = fresh.getByRole('cell').first()
  await expect(cell.getByText('новая')).toBeVisible()
  await expect(cell.getByText('Основная')).toBeVisible()

  // Плашки стоят подряд и не наезжают: просвет между ними тот же, что между именем копии и первой.
  // Замер повторяется: первая отрисовка идёт запасной гарнитурой, и границы потом сдвигаются
  await expect(async () => {
    const [nameRight, newBox, mainBox] = await Promise.all([
      cell.evaluate((node) => {
        const name = [...node.querySelector('.proj')!.childNodes].find((child) => child.nodeType === Node.TEXT_NODE)!
        const range = node.ownerDocument.createRange()
        range.selectNode(name)
        return range.getBoundingClientRect().right
      }),
      cell.getByText('новая').boundingBox(),
      cell.getByText('Основная').boundingBox(),
    ])
    const beforeFirst = newBox!.x - nameRight
    const between = mainBox!.x - (newBox!.x + newBox!.width)
    expect(between).toBeGreaterThan(0)
    expect(between).toBeCloseTo(beforeFirst, 0)
  }).toPass()
})

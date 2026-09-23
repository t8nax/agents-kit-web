import { expect, test, type Page } from '@playwright/test'
import { expectChoice, expectRingOnlyFromKeyboard } from './choice.ts'

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
  letters: 'B',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
  copiesDir: null,
}
const createdRow = { ...row, path: 'D:\\Projects\\quiet-cedar', branch: 'quiet-cedar', copiesDir: null }
// Второй проект: без него в списке окна одна строка, и разделителей между строками не видно
const notaRow = { ...row, project: 'Nota', base: 'D:\\Projects\\nota-knowledge', path: 'D:\\Projects\\nota', branch: 'main' }
// Проект без копии на диске: заводить не от чего, и отличает его в окне только бледность (B-215)
const goneRow = {
  ...row,
  project: 'Ledger',
  base: 'D:\\Projects\\ledger-knowledge',
  path: 'E:\\gone',
  branch: null,
  status: null,
  error: 'Копия не найдена на диске',
  copiesDir: null,
}

async function routeApi(
  page: Page,
  answer: (name: string | null) => { status: number; json: unknown },
  extra: unknown[] = [],
) {
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
    await route.fulfill({ json: created ? [row, busyRow, createdRow, ...extra] : [row, busyRow, ...extra] })
  })
  return posts
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`новая копия заводится из окна и отмечена в таблице (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page, (name) => ({ status: 200, json: { name } }), [notaRow, goneRow])
    await page.goto('/')

    const button = page.getByRole('button', { name: 'Новая копия' })
    await expect(button).toBeVisible()
    // Кнопка стоит в заголовке раздела сразу за его названием, над таблицей (B-205)
    const [buttonBox, headingBox, tableBox] = await Promise.all([
      button.boundingBox(),
      page.getByRole('heading', { name: 'Рабочие копии' }).boundingBox(),
      page.getByRole('table').boundingBox(),
    ])
    expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(tableBox!.y)
    expect(buttonBox!.x).toBeGreaterThan(headingBox!.x + headingBox!.width)
    expect(buttonBox!.x).toBeLessThan(headingBox!.x + headingBox!.width + 40)
    // и в линию с ним: середины по высоте почти совпадают
    const middle = (box: { y: number; height: number }) => box.y + box.height / 2
    expect(Math.abs(middle(buttonBox!) - middle(headingBox!))).toBeLessThanOrEqual(3)
    await button.click()

    const dialog = page.getByRole('dialog', { name: 'Новая рабочая копия' })
    await expect(dialog.getByRole('radio', { name: /Agents Kit Web/ })).toBeChecked()
    const project = dialog.locator('label').filter({ hasText: 'Agents Kit Web' })
    await expectChoice(project, true)
    await expectRingOnlyFromKeyboard(project)
    await dialog.getByLabel(/Имя копии/).fill('quiet-cedar')
    // У проекта только имя: ни числа копий, ни пути, и блока «что будет заведено» нет (B-215)
    await expect(dialog.locator('.nw-project').first()).toHaveText('Agents Kit Web')
    await expect(dialog).not.toContainText('D:\\Projects')
    await expect(dialog.getByLabel('Что будет заведено')).toHaveCount(0)
    // Проект без копии на диске не выбирается и заметно бледнее остальных
    await expect(dialog.getByRole('radio', { name: /Ledger/ })).toBeDisabled()
    await expect(dialog.locator('.nw-project', { hasText: 'Ledger' })).toHaveCSS('opacity', '0.6')
    await expect(dialog.locator('.nw-project', { hasText: 'Nota' })).toHaveCSS('opacity', '1')
    await expect(dialog).toContainText('У проекта уже есть свободная копия master')
    const transparent = 'rgba(0, 0, 0, 0)'
    // Окно непрозрачно в обеих темах: таблица под ним не просвечивает
    await expect(dialog).not.toHaveCSS('background-color', transparent)
    // Вид «Легче» (B-215): шапка и подвал без полос и подкраски, список проектов без рамки
    // и разделителей, напоминание — простая строка без рамки и фона
    await expect(dialog.locator('.nw-head')).toHaveCSS('border-bottom-style', 'none')
    await expect(dialog.locator('.nw-footer')).toHaveCSS('border-top-style', 'none')
    await expect(dialog.locator('.nw-footer')).toHaveCSS('background-color', transparent)
    await expect(dialog.locator('.nw-projects')).toHaveCSS('border-top-style', 'none')
    await expect(dialog.locator('.nw-projects > li').nth(1)).toHaveCSS('border-top-style', 'none')
    const notice = dialog.locator('.nw-notice')
    await expect(notice).toHaveCSS('border-top-style', 'none')
    await expect(notice).toHaveCSS('background-color', transparent)

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

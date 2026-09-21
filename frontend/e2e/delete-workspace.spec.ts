import { expect, test, type Page } from '@playwright/test'

// Ничего не удаляется на самом деле: запрос к API подменяется page.route.
const main = {
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
const free = { ...main, path: 'D:\\Projects\\quiet-cedar', branch: 'quiet-cedar', copiesDir: null }
const busy = {
  ...free,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'feat/delete-workspace',
  task: 'B-55 Оператор удаляет рабочую копию из панели',
  letters: 'B',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
}

async function routeApi(page: Page, answer: () => { status: number; json?: unknown }) {
  let removed = false
  const posts: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: removed ? [main, busy] : [main, free, busy] }))
  await page.route('**/api/workspace/remove', async (route) => {
    posts.push(route.request().postDataJSON())
    const reply = answer()
    removed = reply.status === 204
    await route.fulfill(reply)
  })
  return posts
}

async function openRowMenu(page: Page, name: RegExp) {
  await page.getByRole('row', { name }).getByRole('button', { name: /Действия с / }).click()
  return page.getByRole('menu')
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`копия удаляется из меню строки и уходит из таблицы (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const posts = await routeApi(page, () => ({ status: 204 }))
    await page.goto('/')

    const menu = await openRowMenu(page, /quiet-cedar/)
    const item = menu.getByRole('menuitem', { name: 'Удалить копию' })
    // Удаление стоит последним пунктом, за переходами: клик по нему меню закрывает
    await expect(menu.getByRole('menuitem').last()).toHaveText('Удалить копию')
    await item.click()

    const dialog = page.getByRole('dialog', { name: 'Удалить рабочую копию' })
    await expect(dialog).toContainText('Копия quiet-cedar уйдёт с диска')
    const preview = dialog.getByLabel('Что будет удалено')
    await expect(preview).toContainText('D:\\Projects\\quiet-cedar')
    await expect(preview).toContainText('quiet-cedar — останется')
    // Окно непрозрачно в обеих темах: таблица под ним не просвечивает
    await expect(dialog).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    await dialog.getByRole('button', { name: 'Удалить копию' }).click()

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status')).toContainText('Копия quiet-cedar удалена')
    await expect(page.getByRole('table').locator('tbody tr:not(.group-row)')).toHaveCount(2)
    expect(posts).toEqual([{ base: main.base, copy: free.path }])
  })
}

test('отказ кита виден в окне его словами, копия остаётся в таблице', async ({ page }) => {
  await routeApi(page, () => ({
    status: 400,
    json: { problem: 'refused', message: 'в копии «D:\\Projects\\quiet-cedar» незакоммиченное: src/App.tsx — сначала закоммитить' },
  }))
  await page.goto('/')

  const menu = await openRowMenu(page, /quiet-cedar/)
  await menu.getByRole('menuitem', { name: 'Удалить копию' }).click()

  const dialog = page.getByRole('dialog', { name: 'Удалить рабочую копию' })
  await dialog.getByRole('button', { name: 'Удалить копию' }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Кит не убрал копию')
  await expect(alert).toContainText('незакоммиченное: src/App.tsx — сначала закоммитить')
  await expect(dialog.getByRole('button', { name: 'Удалить копию' })).toBeEnabled()
  await expect(page.getByRole('table').locator('tbody tr:not(.group-row)')).toHaveCount(3)
})

test('у копии с задачей пункт приглушён, у основной копии его нет', async ({ page }) => {
  await routeApi(page, () => ({ status: 204 }))
  await page.goto('/')

  const busyMenu = await openRowMenu(page, /B-55/)
  await expect(busyMenu.getByRole('menuitem', { name: 'Удалить копию' })).toBeDisabled()
  await page.keyboard.press('Escape')

  const mainMenu = await openRowMenu(page, /agents-kit-web/)
  await expect(mainMenu.getByRole('menuitem', { name: 'Удалить копию' })).toHaveCount(0)
})

import { expect, test, type Page } from '@playwright/test'

// Ничего не откатывается на самом деле: запросы отката подменяются page.route.
const main = {
  project: 'house',
  base: 'D:\\Projects\\house-knowledge',
  path: 'D:\\Projects\\house',
  branch: 'master',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
  copiesDir: 'D:\\Projects',
}
const busy = {
  ...main,
  path: 'D:\\Projects\\house-2',
  branch: 'b-42-export',
  task: 'B-42 Экспорт отчёта в CSV',
  letters: 'B',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
  copiesDir: null,
}
const free = { ...main, path: 'D:\\Projects\\house-3', branch: 'house-3', copiesDir: null }

async function routeApi(page: Page, plan: Record<string, unknown>) {
  let rolledBack = false
  const steps: string[] = []
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: [main, rolledBack ? { ...busy, task: null, flowStep: null, progress: null, status: 'free' } : busy, free] }),
  )
  await page.route('**/api/tasks/rollback**', async (route) => {
    if (route.request().method() === 'GET') {
      await route.fulfill({ json: { task: busy.task, source: 'backlog', dirty: false, blockers: [], ...plan } })
      return
    }
    const step = (route.request().postDataJSON() as { step: string }).step
    steps.push(step)
    rolledBack = step === 'memory'
    await route.fulfill({ status: 204 })
  })
  return steps
}

async function openRowMenu(page: Page, name: RegExp) {
  await page.getByRole('row', { name }).getByRole('button', { name: /Действия с / }).click()
  return page.getByRole('menu')
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`задача откатывается из меню строки, и копия становится свободной (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const steps = await routeApi(page, { dirty: true })
    await page.goto('/')

    const menu = await openRowMenu(page, /house-2/)
    const item = menu.getByRole('menuitem', { name: 'Откатить задачу' })
    const remove = menu.getByRole('menuitem', { name: 'Удалить копию' })
    // Откат стоит перед удалением, и красным горит он: удаление у копии с задачей приглушено
    await expect(menu.getByRole('menuitem').last()).toHaveText('Удалить копию')
    await expect(remove).toBeDisabled()
    const red = await item.evaluate((node) => getComputedStyle(node).color)
    const muted = await remove.evaluate((node) => getComputedStyle(node).color)
    expect(red).not.toBe(muted)
    await item.click()

    const dialog = page.getByRole('dialog', { name: 'Откатить задачу' })
    await expect(dialog).toContainText('Задача B-42 «Экспорт отчёта в CSV» в копии house-2 проекта house будет отменена:')
    await expect(dialog.getByRole('listitem')).toHaveCount(4)
    await expect(dialog).not.toContainText('b-42-export')
    await expect(dialog).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const icon = dialog.locator('.dw-head-icon svg')
    await expect(async () => expect((await icon.boundingBox())!.width).toBe(18)).toPass()
    // Предупреждение о правках — цвет ожидания, а не отказа
    const warning = dialog.locator('.rb-warning')
    await expect(warning).toContainText('Незакоммиченные правки будут потеряны')
    await expect(warning).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const danger = dialog.getByRole('button', { name: 'Откатить задачу' })
    const cancelBackground = await dialog.getByRole('button', { name: 'Отмена' }).evaluate((node) => getComputedStyle(node).backgroundColor)
    await expect(danger).not.toHaveCSS('background-color', cancelBackground)

    await danger.click()

    await expect(dialog).toBeHidden()
    await expect(page.getByRole('status')).toContainText('Задача в копии house-2 откачена')
    await expect(page.getByRole('row', { name: /house-2/ })).toContainText('Свободна')
    expect(steps).toEqual(['session', 'backlog', 'copy', 'memory'])
  })
}

test('пока в копии открыт VS Code, откат отказывает сразу и ничего не трогает', async ({ page }) => {
  const steps = await routeApi(page, { blockers: [{ kind: 'vscode', name: null }] })
  await page.goto('/')

  const menu = await openRowMenu(page, /house-2/)
  await menu.getByRole('menuitem', { name: 'Откатить задачу' }).click()

  const dialog = page.getByRole('dialog', { name: 'Откатить задачу' })
  await expect(dialog.getByRole('alert')).toContainText('открыта сессия задачи в VS Code')
  await expect(dialog.getByRole('button', { name: 'Откатить задачу' })).toBeDisabled()
  expect(steps).toEqual([])
})

test('у свободной копии откат приглушён, а у основной копии с задачей он есть', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [{ ...busy, path: main.path, copiesDir: 'D:\\Projects' }, free] }))
  await page.goto('/')

  const freeMenu = await openRowMenu(page, /house-3/)
  await expect(freeMenu.getByRole('menuitem', { name: 'Откатить задачу' })).toBeDisabled()
  await page.keyboard.press('Escape')

  const mainMenu = await openRowMenu(page, /B-42/)
  await expect(mainMenu.getByRole('menuitem', { name: 'Откатить задачу' })).toBeEnabled()
  await expect(mainMenu.getByRole('menuitem', { name: 'Удалить копию' })).toHaveCount(0)
})

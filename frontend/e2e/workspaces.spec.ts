import { expect, test } from '@playwright/test'

test('страница показывает таблицу рабочих копий из API', async ({ page }) => {
  const response = page.waitForResponse('**/api/workspaces')
  await page.goto('/')
  const rows: { base: string }[] = await (await response).json()

  await expect(page).toHaveTitle('Agents Kit Web')
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Agents Kit Web' })).toBeVisible()

  const table = page.getByRole('table')
  for (const column of ['Копия', '№', 'Задача', 'Шаг флоу', 'Прогресс', 'Статус', 'Проблемы']) {
    await expect(table.getByRole('columnheader', { name: column })).toBeVisible()
  }
  await expect(table.locator('tbody tr:not(.group-row)')).toHaveCount(rows.length)
  await expect(table.locator('tbody tr.group-row')).toHaveCount(new Set(rows.map((r) => r.base)).size)
  await expect(page.getByText('pong')).toHaveCount(0)
})

const row = {
  project: 'agents-kit-web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: 'D:\\Projects\\agents-kit-web',
  branch: 'feat/task-number-column',
  task: 'B-24 Номер задачи и её заголовок — отдельные колонки таблицы',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
  error: null,
}
const rows = [
  row,
  { ...row, path: 'D:\\Projects\\agents-kit-web-2', task: 'Задача не из бэклога' },
  { ...row, path: 'D:\\Projects\\agents-kit-web-3', branch: 'dev', task: null, flowStep: null, progress: null, status: 'free' },
]

for (const colorScheme of ['light', 'dark'] as const) {
  test(`номер задачи стоит плашкой в своей колонке, без номера и без задачи — прочерк (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
    await page.goto('/')

    const bodyRows = page.getByRole('table').locator('tbody tr:not(.group-row)')
    await expect(bodyRows).toHaveCount(3)

    const numbered = bodyRows.nth(0).getByRole('cell')
    await expect(numbered.nth(1)).toHaveText('B-24')
    await expect(numbered.nth(2)).toHaveText('Номер задачи и её заголовок — отдельные колонки таблицы')
    const chip = numbered.nth(1).locator('.num-chip')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveCSS('border-top-width', '1px')
    // Плашка залита своим фоном, а не прозрачна, в обеих темах
    await expect(chip).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    // Узкая колонка: номер не переносится и не растягивает ячейку до заголовка
    const [chipBox, cellBox] = await Promise.all([chip.boundingBox(), numbered.nth(1).boundingBox()])
    expect(cellBox!.width).toBeLessThan(chipBox!.width + 40)

    const unnumbered = bodyRows.nth(1).getByRole('cell')
    await expect(unnumbered.nth(1)).toHaveText('—')
    await expect(unnumbered.nth(2)).toHaveText('Задача не из бэклога')

    // У свободной копии задачи нет, и на её месте прочерк: задачу берут в разделе «Бэклог»
    const free = bodyRows.nth(2).getByRole('cell')
    await expect(free.nth(1)).toHaveText('—')
    await expect(free.nth(2)).toHaveText('—')
  })
}

const nota = {
  ...row,
  project: 'Nota',
  base: 'D:\\Projects\\nota-knowledge',
  path: 'D:\\Projects\\nota',
  branch: 'main',
  task: 'B-4 Экспорт заметок',
  status: 'waiting',
  problemsState: 'checked',
  baseProblems: 2,
  problems: 0,
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`копии двух проектов стоят под своими заголовками, свёрнутая группа переживает перезагрузку (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const kitWeb = rows.map((copy) => ({ ...copy, project: 'Agents Kit Web' }))
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: [...kitWeb, nota] }))
    await page.goto('/')

    const table = page.getByRole('table')
    const all = table.locator('tbody tr')
    await expect(all).toHaveCount(6)
    await expect(all.nth(0).getByRole('rowheader')).toHaveText('Agents Kit Web')
    await expect(all.nth(1).getByRole('cell').first()).toHaveText('agents-kit-webfeat/task-number-column')
    await expect(all.nth(3).getByRole('cell').first()).toHaveText('agents-kit-web-3dev')
    await expect(all.nth(4).getByRole('rowheader')).toHaveText('Nota2')
    await expect(all.nth(5).getByRole('cell').first()).toHaveText('notamain')
    // Путь копии и название проекта в строках копий больше не повторяются
    const copyRows = table.locator('tbody tr:not(.group-row)')
    await expect(copyRows.filter({ hasText: 'D:\\Projects' })).toHaveCount(0)
    await expect(copyRows.filter({ hasText: 'Agents Kit Web' })).toHaveCount(0)

    // Заголовок группы отделён от копий линией, а не сливается с ними
    const head = all.nth(4).getByRole('rowheader')
    await expect(head).toHaveCSS('border-bottom-width', '1px')
    await expect(head.locator('.group-name')).toHaveCSS('font-weight', '600')
    // Проблемы базы — плашкой у правого края заголовка, в обеих темах с рамкой и заливкой
    const baseProblems = head.getByRole('button', { name: '2 проблемы базы — открыть «Проблемы баз»' })
    await expect(baseProblems).toHaveCSS('border-top-width', '1px')
    await expect(baseProblems).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    const [headBox, problemsBox] = await Promise.all([head.boundingBox(), baseProblems.boundingBox()])
    expect(headBox!.x + headBox!.width - (problemsBox!.x + problemsBox!.width)).toBeLessThan(24)

    // Сворачивает клик по пустому месту шапки, а не только стрелка
    await expect(head).toHaveCSS('cursor', 'pointer')
    await head.click({ position: { x: headBox!.width / 2, y: headBox!.height / 2 } })
    await expect(page.getByText('Экспорт заметок')).toHaveCount(0)
    const dot = all.nth(4).locator('.group-waiting-dot')
    await expect(dot).toBeVisible()
    await expect(dot).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')

    await page.reload()
    await expect(page.getByRole('button', { name: 'Развернуть Nota' })).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByText('Экспорт заметок')).toHaveCount(0)
    await expect(table.getByText('Номер задачи и её заголовок — отдельные колонки таблицы')).toBeVisible()

    await page.getByRole('button', { name: 'Развернуть Nota' }).click()
    await expect(page.getByText('Экспорт заметок')).toBeVisible()
  })
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`точка у имени копии показывает состояние её сессии в обеих темах (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await page.route('**/api/workspaces', (route) =>
      route.fulfill({
        json: [
          { ...row, sessionState: 'working' },
          { ...row, path: 'D:\\Projects\\agents-kit-web-2', sessionState: 'waiting' },
          { ...row, path: 'D:\\Projects\\agents-kit-web-3', sessionState: 'idle' },
          { ...row, path: 'D:\\Projects\\agents-kit-web-4', sessionState: null },
        ],
      }),
    )
    await page.goto('/')

    const bodyRows = page.getByRole('table').locator('tbody tr:not(.group-row)')
    const states = ['сессия работает', 'сессия ждёт вас в терминале', 'сессия стоит без дела', 'сессии нет']
    const colors: string[] = []
    for (const [index, state] of states.entries()) {
      const dot = bodyRows.nth(index).getByRole('img', { name: state })
      await expect(dot).toBeVisible()
      colors.push(await dot.evaluate((node) => getComputedStyle(node).backgroundColor))
    }

    // Состояние читается цветом, поэтому у работающей, ждущей и стоящей сессии он разный,
    // а у копии без сессии точка пустая и обведена рамкой
    expect(new Set(colors.slice(0, 3)).size).toBe(3)
    const empty = bodyRows.nth(3).getByRole('img', { name: 'сессии нет' })
    await expect(empty).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(empty).toHaveCSS('border-top-width', '1px')

    // Легенды под таблицей нет — слова состояния держит подсказка самой точки
    await expect(page.locator('.session-legend')).toHaveCount(0)
    for (const [index, state] of states.entries()) {
      await expect(bodyRows.nth(index).getByRole('img', { name: state })).toHaveAttribute('title', state)
    }
  })
}

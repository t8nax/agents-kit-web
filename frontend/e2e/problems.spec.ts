import { expect, test, type Page } from '@playwright/test'

const row = {
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

const health = {
  pending: false,
  kit: 'ok',
  checkedAt: '2026-09-17T12:00:00+03:00',
  bases: [
    {
      base: 'D:\\Projects\\agents-kit-web-knowledge',
      project: 'Agents Kit Web',
      status: 'checked',
      error: null,
      problems: [{ severity: 'error', file: 'product.md', message: '53 строк при потолке 50 — перечитать по тесту входа' }],
      copies: [
        { path: 'D:\\Projects\\agents-kit-web', problems: [] },
        {
          path: 'D:\\Projects\\noble-keen-walrus',
          problems: [{ severity: 'error', file: null, message: 'база не числит эту копию своей' }],
        },
      ],
    },
  ],
}

// /api подменяется: прогон работает с живыми базами оператора, их проблемы в тесте не при чём.
async function mockApi(page: Page, rows: object[], snapshot: object) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
  await page.route('**/api/health', (route) => route.fulfill({ json: snapshot }))
  await page.route('**/api/bases', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/kit', (route) => route.fulfill({ json: { path: null, found: false } }))
}

test('число проблем в строке копии ведёт в «Проблемы баз», где видно, что не так', async ({ page }) => {
  await mockApi(
    page,
    [
      { ...row, path: 'D:\\Projects\\agents-kit-web', problems: 1, problemsState: 'checked' },
      { ...row, path: 'D:\\Projects\\noble-keen-walrus', problems: 2, problemsState: 'checked' },
    ],
    health,
  )

  await page.goto('/')
  const worktree = page.getByRole('row', { name: /noble-keen-walrus/ })
  await worktree.getByRole('button', { name: '2 проблемы — открыть «Проблемы баз»' }).click()

  await expect(page.getByRole('heading', { name: 'Проблемы баз' })).toBeVisible()
  const card = page.getByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  await expect(card.getByText('2 ошибки')).toBeVisible()
  await expect(card.getByRole('list', { name: 'База' })).toContainText('product.md')
  await expect(card.getByRole('list', { name: 'База' })).toContainText('53 строк при потолке 50')
  await expect(card.getByRole('list', { name: 'Копия D:\\Projects\\noble-keen-walrus' })).toContainText(
    'база не числит эту копию своей',
  )
})

test('без пути к киту таблица и раздел проблем ведут в «Настройки»', async ({ page }) => {
  await mockApi(page, [{ ...row, path: 'D:\\Projects\\agents-kit-web', problems: null, problemsState: 'kit-not-set' }], {
    pending: false,
    kit: 'not-set',
    checkedAt: null,
    bases: [{ ...health.bases[0], status: 'unchecked', problems: [], copies: [] }],
  })

  await page.goto('/')
  await expect(page.getByRole('row', { name: /agents-kit-web/ }).getByText('кит не задан')).toBeVisible()
  await expect(page.getByText('Проблемы баз не проверяются: не задан путь к киту.')).toBeVisible()

  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Проблемы баз' }).click()
  await expect(page.getByText('не проверена')).toBeVisible()
  await page.getByRole('button', { name: 'Открыть настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible()
})

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

test('проблемы базы в заголовке группы и проблема связи в строке копии ведут в «Проблемы баз»', async ({ page }) => {
  await mockApi(
    page,
    [
      { ...row, path: 'D:\\Projects\\agents-kit-web', baseProblems: 1, problems: 0, problemsState: 'checked' },
      { ...row, path: 'D:\\Projects\\noble-keen-walrus', baseProblems: 1, problems: 1, problemsState: 'checked' },
    ],
    health,
  )

  await page.goto('/')
  const group = page.getByRole('rowheader').filter({ has: page.locator('.group-name', { hasText: 'Agents Kit Web' }) })
  await expect(group.getByRole('button', { name: '1 проблема базы — открыть «Проблемы баз»' })).toBeVisible()
  // У здоровой копии в строке пусто: проблемы её базы уже названы в заголовке
  const mainCopy = page.getByRole('table').locator('tbody tr:not(.group-row)').first()
  await expect(mainCopy).toContainText('agents-kit-web')
  await expect(mainCopy.getByRole('button', { name: /открыть «Проблемы баз»/ })).toHaveCount(0)

  const worktree = page.getByRole('row', { name: /noble-keen-walrus/ })
  await worktree.getByRole('button', { name: '1 проблема копии — открыть «Проблемы баз»' }).click()
  await expect(page.getByRole('heading', { name: 'Проблемы баз' })).toBeVisible()

  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: /Рабочие копии/ }).click()
  await group.getByRole('button', { name: '1 проблема базы — открыть «Проблемы баз»' }).click()

  await expect(page.getByRole('heading', { name: 'Проблемы баз' })).toBeVisible()
  const card = page.getByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  await expect(card.getByText('2 ошибки')).toBeVisible()
  await expect(card.getByRole('list', { name: 'База' })).toContainText('product.md')
  await expect(card.getByRole('list', { name: 'База' })).toContainText('53 строк при потолке 50')
  await expect(card.getByRole('list', { name: 'Копия D:\\Projects\\noble-keen-walrus' })).toContainText(
    'база не числит эту копию своей',
  )
})

test('оператор запускает проверку кнопкой и видит свежий результат', async ({ page }) => {
  const fixed = {
    ...health,
    checkedAt: '2026-09-17T12:00:42+03:00',
    bases: [{ ...health.bases[0], problems: [], copies: [] }],
  }
  let requested = false
  await mockApi(page, [], health)
  await page.route('**/api/health', (route) => route.fulfill({ json: requested ? fixed : health }))
  await page.route('**/api/health/check', (route) => {
    requested = true
    return route.fulfill({ status: 202 })
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Проблемы баз' }).click()
  const card = page.getByRole('region', { name: 'Agents Kit Web — D:\\Projects\\agents-kit-web-knowledge' })
  await expect(card.getByText('2 ошибки')).toBeVisible()

  await page.getByRole('button', { name: 'Проверить сейчас' }).click()

  await expect(card.getByText('проблем нет')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Проверить сейчас' })).toBeEnabled()
  expect(requested).toBe(true)
})

test('без пути к киту таблица и раздел проблем ведут в «Настройки»', async ({ page }) => {
  await mockApi(page, [{ ...row, path: 'D:\\Projects\\agents-kit-web', problems: null, problemsState: 'kit-not-set' }], {
    pending: false,
    kit: 'not-set',
    checkedAt: null,
    bases: [{ ...health.bases[0], status: 'unchecked', problems: [], copies: [] }],
  })

  await page.goto('/')
  await expect(page.locator('tr.group-row').getByText('кит не задан')).toBeVisible()
  await expect(page.getByText('Проблемы баз не проверяются: не задан путь к киту.')).toBeVisible()

  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Проблемы баз' }).click()
  await expect(page.getByText('не проверена')).toBeVisible()
  await page.getByRole('button', { name: 'Открыть настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible()
})

test('о новой версии кита раздел проблем говорит и ведёт в «Настройки», где на неё переходят', async ({ page }) => {
  const newKit = 'C:\\Users\\me\\.claude\\plugins\\cache\\agents-kit\\agents-kit\\1.15.0'
  await mockApi(page, [{ ...row, path: 'D:\\Projects\\agents-kit-web', baseProblems: 1, problems: 0, problemsState: 'checked' }], {
    ...health,
    kitUpdate: { path: newKit, version: '1.15.0' },
    currentKitVersion: '1.14.2',
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Проблемы баз' }).click()
  const notice = page.locator('.kit-notice')
  await expect(notice).toHaveText(/Установлена новая версия кита 1\.15\.0, панель работает версией 1\.14\.2\./)
  // Переходят на новую версию только в «Настройках»
  await expect(notice.getByRole('button')).toHaveText(['Открыть настройки'])
  await notice.getByRole('button', { name: 'Открыть настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible()
})

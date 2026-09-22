import { expect, test, type Page } from '@playwright/test'

const known: Record<string, { copies: number; row: object }> = {
  'D:\\Projects\\nota-knowledge': {
    copies: 1,
    row: {
      project: 'nota-knowledge',
      base: 'D:\\Projects\\nota-knowledge',
      path: 'D:\\Projects\\nota',
      branch: 'dev',
      task: 'Экспорт заметок в PDF',
      flowStep: 'Приёмка',
      progress: 66,
      status: 'in-work',
      error: null,
    },
  },
}

const kitPath = 'D:\\Tools\\agents-kit'

const listings: Record<string, object> = {
  '': { path: null, parent: null, folders: [{ name: 'D:\\', path: 'D:\\', isBase: false, copies: null }] },
  'D:\\': {
    path: 'D:\\',
    parent: null,
    folders: [
      { name: 'Projects', path: 'D:\\Projects', isBase: false, copies: null },
      { name: 'Tools', path: 'D:\\Tools', isBase: false, copies: null },
    ],
  },
  'D:\\Projects': {
    path: 'D:\\Projects',
    parent: 'D:\\',
    folders: [
      { name: 'nota-knowledge', path: 'D:\\Projects\\nota-knowledge', isBase: true, copies: 1 },
      { name: 'nota', path: 'D:\\Projects\\nota', isBase: false, copies: null },
    ],
  },
  'D:\\Tools': {
    path: 'D:\\Tools',
    parent: 'D:\\',
    folders: [{ name: 'agents-kit', path: kitPath, isBase: false, copies: null, isKit: true }],
  },
}

// /api подменяется: dev-API пишет список баз и путь к киту в bases.json профиля оператора,
// и прогон поменял бы живые настройки.
async function mockApi(page: Page) {
  let bases: string[] = []
  let kit: string | null = null

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: bases.map((b) => known[b].row) }))
  await page.route('**/api/folders**', (route) => {
    const path = new URL(route.request().url()).searchParams.get('path') ?? ''
    return route.fulfill({ json: listings[path] })
  })
  await page.route('**/api/kit/found', (route) => route.fulfill({ json: [kitPath] }))
  await page.route('**/api/kit', (route) => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: { path: kit, found: kit !== null } })
    const { path } = request.postDataJSON() as { path: string }
    if (path !== kitPath) return route.fulfill({ status: 400, json: { problem: 'not-a-kit' } })
    kit = path
    return route.fulfill({ json: { path, found: true } })
  })
  await page.route('**/api/bases**', async (route) => {
    const request = route.request()
    if (request.method() === 'GET') {
      return route.fulfill({ json: bases.map((path) => ({ path, copies: known[path].copies })) })
    }
    if (request.method() === 'POST') {
      const { path } = request.postDataJSON() as { path: string }
      if (!known[path]) return route.fulfill({ status: 400, json: { problem: 'not-a-base' } })
      if (bases.includes(path)) return route.fulfill({ status: 409, json: { problem: 'duplicate' } })
      bases = [...bases, path]
      return route.fulfill({ status: 201, json: { path, copies: known[path].copies } })
    }
    const path = new URL(request.url()).searchParams.get('path')
    bases = bases.filter((b) => b !== path)
    return route.fulfill({ status: 204 })
  })
}

async function openSettings(page: Page) {
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Настройки' }).click()
  await expect(page.getByRole('heading', { name: 'Настройки' })).toBeVisible()
}

async function openWorkspaces(page: Page) {
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: /Рабочие копии/ }).click()
}

test('оператор добавляет и удаляет базу в «Настройках», и таблица строится по новому списку', async ({ page }) => {
  await mockApi(page)

  await page.goto('/')
  await expect(page.getByText('Нет отслеживаемых баз или рабочих копий.')).toBeVisible()

  await openSettings(page)
  const bases = page.getByRole('region', { name: /^Базы знаний/ })
  const input = bases.getByLabel('Путь к каталогу базы')

  await input.fill('D:\\Projects\\nota')
  await bases.getByRole('button', { name: 'Добавить' }).click()
  await expect(bases.getByRole('alert')).toHaveText('В каталоге нет agents-kit.json — это не база знаний кита. Проверьте путь.')

  await input.fill('D:\\Projects\\nota-knowledge')
  await bases.getByRole('button', { name: 'Добавить' }).click()
  await expect(bases.getByRole('list', { name: 'Базы знаний' }).getByText('D:\\Projects\\nota-knowledge')).toBeVisible()

  await openWorkspaces(page)
  await expect(page.getByRole('row', { name: /Экспорт заметок в PDF/ })).toBeVisible()

  await openSettings(page)
  await bases.getByRole('button', { name: 'Удалить D:\\Projects\\nota-knowledge' }).click()
  await expect(bases.getByText('Список пуст.')).toBeVisible()
  await openWorkspaces(page)
  await expect(page.getByRole('row', { name: /Экспорт заметок в PDF/ })).toHaveCount(0)
})

test('оператор выбирает папку базы в обзоре, не вводя путь', async ({ page }) => {
  await mockApi(page)

  await page.goto('/')
  await openSettings(page)
  const bases = page.getByRole('region', { name: /^Базы знаний/ })

  await bases.getByRole('button', { name: 'Обзор…' }).click()
  const folders = bases.getByRole('list', { name: 'Папки' })
  await folders.getByRole('button', { name: 'D:\\' }).click()
  await folders.getByRole('button', { name: 'Projects' }).click()

  await expect(folders.getByRole('button', { name: 'Добавить D:\\Projects\\nota', exact: true })).toHaveCount(0)
  await folders.getByRole('button', { name: 'Добавить D:\\Projects\\nota-knowledge' }).click()
  await expect(bases.getByRole('status')).toHaveText('Добавлена nota-knowledge')
  await expect(folders.getByText('уже в списке')).toBeVisible()

  await bases.getByRole('button', { name: 'К списку баз' }).click()
  await expect(bases.getByRole('list', { name: 'Базы знаний' }).getByText('D:\\Projects\\nota-knowledge')).toBeVisible()
  await openWorkspaces(page)
  await expect(page.getByRole('row', { name: /Экспорт заметок в PDF/ })).toBeVisible()
})

test('оператор задаёт путь к киту: чужой каталог отклонён, кит выбирается в обзоре', async ({ page }) => {
  await mockApi(page)

  await page.goto('/')
  await openSettings(page)
  const kit = page.getByRole('region', { name: /^Кит/ })

  await expect(kit.getByText('Путь к киту не задан — проблемы баз не проверяются.')).toBeVisible()
  await kit.getByLabel('Путь к каталогу кита').fill('D:\\Tools')
  await kit.getByRole('button', { name: 'Сохранить' }).click()
  await expect(kit.getByRole('alert')).toHaveText('В каталоге нет скриптов проверок кита — это не кит. Путь не сохранён.')

  await kit.getByRole('button', { name: 'Обзор…' }).click()
  const folders = kit.getByRole('list', { name: 'Папки' })
  await folders.getByRole('button', { name: 'D:\\' }).click()
  await folders.getByRole('button', { name: 'Tools' }).click()
  await expect(folders.getByText('кит', { exact: true })).toBeVisible()
  await folders.getByRole('button', { name: `Выбрать ${kitPath}` }).click()

  await expect(kit.getByLabel('Путь к каталогу кита')).toHaveValue(kitPath)
  await expect(kit.getByText('Кит найден: скрипты проверок на месте.')).toBeVisible()

  // Путь хранит API: раздел, открытый заново, показывает сохранённый
  await page.reload()
  await openSettings(page)
  await expect(kit.getByLabel('Путь к каталогу кита')).toHaveValue(kitPath)
})

test('оператор находит кит кнопкой и сам сохраняет найденный путь', async ({ page }) => {
  await mockApi(page)

  await page.goto('/')
  await openSettings(page)
  const kit = page.getByRole('region', { name: /^Кит/ })

  await kit.getByRole('button', { name: 'Найти автоматически' }).click()
  await expect(kit.getByText('Кит найден, путь подставлен в поле — сохраните его.')).toBeVisible()
  await expect(kit.getByLabel('Путь к каталогу кита')).toHaveValue(kitPath)
  // Поиск ничего не сохранил: пока оператор не нажал «Сохранить», путь не задан
  await expect(kit.getByText('Путь к киту не задан — проблемы баз не проверяются.')).toBeVisible()

  await kit.getByRole('button', { name: 'Сохранить' }).click()
  await expect(kit.getByText('Кит найден: скрипты проверок на месте.')).toBeVisible()
  await page.reload()
  await openSettings(page)
  await expect(kit.getByLabel('Путь к каталогу кита')).toHaveValue(kitPath)
})

test('оператор выключает и включает уведомления переключателем в «Настройках», а не в шапке', async ({ page }) => {
  // Chromium без окна отвечает «запрещено» и при выданном разрешении — разрешение браузера подменяется
  await page.addInitScript(() => {
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' })
  })
  await mockApi(page)

  await page.goto('/')
  await expect(page.getByRole('banner').getByRole('button', { name: /уведомления/i })).toHaveCount(0)

  await openSettings(page)
  const card = page.getByRole('region', { name: 'Уведомления' })
  await expect(page.locator('.settings-card').last()).toHaveAttribute('aria-labelledby', 'settings-notifications')
  const toggle = card.getByRole('switch', { name: 'Показывать уведомления' })
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  // Выбор помнит браузер: раздел, открытый заново, показывает выключенные уведомления
  await page.reload()
  await openSettings(page)
  await expect(toggle).toHaveAttribute('aria-checked', 'false')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
})

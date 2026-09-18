import { expect, test } from '@playwright/test'

const hours = (count: number) => Date.now() - count * 60 * 60_000

const working = {
  path: 'D:\\Projects\\rustic-silver-sparrow',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: 'agents-kit b-50 drive',
  session: '540066c8',
  state: 'working',
  background: true,
  startedAt: hours(2),
}

const idle = {
  path: 'D:\\Projects\\agents-kit-web',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: 'agents-kit b-31 drive flow',
  session: 'a1c66bfd',
  state: 'idle',
  background: true,
  startedAt: hours(14),
}

const inEditor = {
  path: 'D:\\Projects\\noble-keen-walrus',
  project: 'Agents Kit Web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  name: null,
  session: null,
  state: 'idle',
  background: false,
  startedAt: hours(26),
}

const zebra = {
  path: 'D:\\Projects\\silver-misty-zebra',
  project: 'Nota',
  base: 'D:\\Projects\\nota-knowledge',
  name: 'agents-kit n-12 drive',
  session: '9919e753',
  state: 'idle',
  background: true,
  startedAt: hours(50),
}

// /api подменяется: настоящее гашение остановило бы живые сессии на машине, где идёт прогон.
test('раздел показывает живые сессии группами по проекту и фильтрует их по копии', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [working, idle, inEditor, zebra] }))

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()

  await expect(page.getByRole('heading', { name: 'Сессии' })).toBeVisible()
  await expect(page.getByRole('rowgroup').filter({ hasText: 'Agents Kit Web' }).first()).toBeVisible()
  await expect(page.getByText('Nota')).toBeVisible()
  await expect(page.getByRole('row', { name: /agents-kit b-50 drive/ })).toContainText('Работает')
  await expect(page.getByRole('row', { name: /agents-kit b-50 drive/ })).toContainText('2 ч 00 мин')
  await expect(page.getByRole('row', { name: /noble-keen-walrus/ })).toContainText('в своём окне')

  await page.getByRole('button', { name: 'agents-kit-web', exact: true }).click()
  await expect(page.getByText('agents-kit b-31 drive flow')).toBeVisible()
  await expect(page.getByText('agents-kit b-50 drive')).toBeHidden()
  await expect(page.getByText('Nota')).toBeHidden()
})

test('простаивающая сессия гаснет из меню строки, работающая — после подтверждения', async ({ page }) => {
  const stopped: unknown[] = []
  let rows = [working, idle]

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: rows }))
  await page.route('**/api/sessions/stop', async (route) => {
    const asked = route.request().postDataJSON() as { session: string }
    stopped.push(asked)
    rows = rows.filter((row) => row.session !== asked.session)
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()

  await page.getByRole('button', { name: 'Действия с сессией в agents-kit-web' }).click()
  await page.getByRole('menuitem', { name: 'Погасить сессию' }).click()
  expect(stopped).toEqual([{ session: 'a1c66bfd' }])

  await page.getByRole('button', { name: 'Действия с сессией в rustic-silver-sparrow' }).click()
  await page.getByRole('menuitem', { name: 'Погасить сессию' }).click()
  const dialog = page.getByRole('dialog', { name: 'Погасить сессию?' })
  await expect(dialog).toContainText('540066c8')
  await dialog.getByRole('button', { name: 'Погасить' }).click()

  expect(stopped).toEqual([{ session: 'a1c66bfd' }, { session: '540066c8' }])
  // Погашенные сессии уходят из перечня очередным опросом
  await expect(page.getByText('Живых сессий Claude Code нет.')).toBeVisible()
})

test('неудачное гашение сказано словами, и сессия остаётся в перечне', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [idle] }))
  await page.route('**/api/sessions/stop', (route) =>
    route.fulfill({ status: 502, json: { problem: 'agent', message: 'no such session' } }),
  )

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()
  await page.getByRole('button', { name: 'Действия с сессией в agents-kit-web' }).click()
  await page.getByRole('menuitem', { name: 'Погасить сессию' }).click()

  await expect(page.getByRole('alert')).toHaveText('Сессию a1c66bfd не погасить: no such session')
  await expect(page.getByText('agents-kit b-31 drive flow')).toBeVisible()
})

test('сессию своего окна панель не гасит', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [inEditor] }))

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()
  await page.getByRole('button', { name: 'Действия с сессией в noble-keen-walrus' }).click()

  await expect(page.getByRole('menuitem', { name: 'Погасить сессию' })).toBeDisabled()
  await expect(page.getByRole('menuitem', { name: 'Войти в сессию' })).toBeDisabled()

  // Дойти до такой сессии панель всё же помогает: окно редактора её копии открывается из того же меню
  const opened: unknown[] = []
  await page.route('**/api/workspace/open', async (route) => {
    opened.push(route.request().postDataJSON())
    await route.fulfill({ status: 204 })
  })
  await page.getByRole('menuitem', { name: 'Открыть в VS Code' }).click()

  expect(opened).toEqual([{ base: inEditor.base, copy: inEditor.path }])
})

const freeCopy = {
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

const busyCopy = {
  ...freeCopy,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'feat/flow-edit',
  task: 'B-22 Правка флоу проекта из панели',
  flowStep: 'Реализация',
  progress: 45,
  status: 'in-work',
}

test('сессия запускается из шапки раздела и появляется в перечне', async ({ page }) => {
  const posts: unknown[] = []
  let rows: unknown[] = []

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [busyCopy, freeCopy] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: rows }))
  await page.route('**/api/sessions/new', async (route) => {
    posts.push(route.request().postDataJSON())
    rows = [{ ...working, session: '7339dced', name: null, state: 'idle', startedAt: Date.now() }]
    await route.fulfill({ json: { session: '7339dced' } })
  })

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()
  await expect(page.getByText('Живых сессий Claude Code нет.')).toBeVisible()

  await page.getByRole('button', { name: 'Новая сессия' }).click()
  const dialog = page.getByRole('dialog', { name: 'Новая сессия' })
  // Первой в списке стоит занятая копия — оператор выбирает свободную
  await dialog.getByText('rustic-silver-sparrow').click()
  await dialog.getByLabel('С чего начать — необязательно').fill('посмотри, почему падает e2e')
  await dialog.getByRole('button', { name: 'Запустить' }).click()

  expect(posts).toEqual([
    { base: freeCopy.base, copy: freeCopy.path, prompt: 'посмотри, почему падает e2e' },
  ])
  await expect(page.getByText('Сессия 7339dced запущена')).toBeVisible()
  await expect(page.getByRole('row', { name: /rustic-silver-sparrow/ })).toContainText('фоновая · 7339dced')
})

test('про копию с идущей задачей окно предупреждает, а неудачный запуск остаётся в нём', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [busyCopy, freeCopy] }))
  await page.route('**/api/sessions', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/sessions/new', (route) =>
    route.fulfill({ status: 400, json: { problem: 'agent', message: 'claude не запустился' } }),
  )

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Сессии' }).click()
  await page.getByRole('button', { name: 'Новая сессия' }).click()

  const dialog = page.getByRole('dialog', { name: 'Новая сессия' })
  await expect(dialog).toContainText('идёт задача B-22')
  await expect(dialog).toContainText('Новая сессия её не прервёт')

  await dialog.getByLabel('С чего начать — необязательно').fill('поработаем руками')
  await dialog.getByRole('button', { name: 'Запустить' }).click()

  await expect(dialog.getByRole('alert')).toHaveText('Сессия не запущена: агент не стартовал. claude не запустился')
  await expect(dialog.getByLabel('С чего начать — необязательно')).toHaveValue('поработаем руками')
})

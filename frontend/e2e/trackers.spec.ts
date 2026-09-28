import { expect, test, type Locator, type Page } from '@playwright/test'

// Карточка «Серверы трекеров» в «Настройках» (B-288). /api подменяется: dev-API хранит ключи в профиле оператора
// и проверяет их на настоящем сервере YouTrack.

const long = 'https://tracker.severo-zapadnaya-logisticheskaya-kompaniya.corp.northwind-group.ru/youtrack'
const servers = [
  { server: 'https://acme.youtrack.cloud', login: 'boris.k' },
  { server: long, login: 'kuznetsov.b' },
]

async function mockApi(page: Page, list: { server: string; login: string }[]) {
  let current = [...list]
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/bases', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/kit', (route) => route.fulfill({ json: { path: null, found: false } }))
  await page.route('**/api/trackers**', (route) => {
    const request = route.request()
    if (request.method() === 'GET') return route.fulfill({ json: current })
    if (request.method() === 'POST') {
      const { server, key } = request.postDataJSON() as { server: string; key: string }
      if (key !== 'perm:good') return route.fulfill({ status: 400, json: { problem: 'key-rejected' } })
      const entry = { server, login: 'boris.k' }
      current = [...current, entry]
      return route.fulfill({ json: entry })
    }
    const server = new URL(request.url()).searchParams.get('server')
    current = current.filter((s) => s.server !== server)
    return route.fulfill({ status: 204 })
  })
}

async function openSettings(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Настройки' }).click()
  return page.getByRole('region', { name: 'Серверы трекеров' })
}

/** Правый край элемента не выходит за правый край карточки. */
async function inside(element: Locator, card: Locator) {
  await expect(async () => {
    const [box, frame] = await Promise.all([element.boundingBox(), card.boundingBox()])
    expect(box!.x + box!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 0.5)
  }).toPass()
}

// На широком экране адрес помещается целиком, на узком — обрезается многоточием
for (const [width, cut] of [
  [1400, false],
  [900, true],
] as const) {
  test(`длинный адрес сервера стоит в одну строку, а кнопки — в карточке (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await mockApi(page, servers)

    const card = await openSettings(page)
    const row = card.getByRole('listitem').filter({ hasText: 'kuznetsov.b' })
    const address = row.locator('.trk-url')
    await expect(address).toHaveAttribute('title', long)
    // Адрес в одну строку: обрезан многоточием, а не перенесён
    await expect(async () => {
      const { scroll, client, lines } = await address.evaluate((el) => ({
        scroll: el.scrollWidth,
        client: el.clientWidth,
        lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight || '18')),
      }))
      if (cut) expect(scroll).toBeGreaterThan(client)
      else expect(scroll).toBeLessThanOrEqual(client)
      expect(lines).toBeLessThanOrEqual(1)
    }).toPass()
    await inside(row.getByRole('button', { name: `Удалить ${long}` }), card)
    await inside(row.getByRole('button', { name: `Заменить ключ ${long}` }), card)
    await inside(card.getByRole('button', { name: 'Добавить' }), card)
  })
}

test('ключ, который сервер отклонил, не сохраняется; удаление сервера — через окно', async ({ page }) => {
  await mockApi(page, [])

  const card = await openSettings(page)
  await expect(card.getByText('Список пуст.')).toBeVisible()
  await card.getByLabel('Адрес сервера').fill('https://acme.youtrack.cloud')
  await card.getByLabel('Ключ', { exact: true }).fill('perm:bad')
  await card.getByRole('button', { name: 'Добавить' }).click()
  await expect(card.getByRole('alert')).toContainText('Сервер отклонил ключ, ключ не сохранён.')
  await expect(card.getByLabel('Ключ', { exact: true })).toHaveAttribute('aria-invalid', 'true')

  await card.getByLabel('Ключ', { exact: true }).fill('perm:good')
  await card.getByRole('button', { name: 'Добавить' }).click()
  await expect(card.getByRole('list', { name: 'Серверы трекеров' }).getByText('boris.k')).toBeVisible()

  await card.getByRole('button', { name: 'Удалить https://acme.youtrack.cloud' }).click()
  const dialog = page.getByRole('dialog', { name: 'Удалить сервер трекера' })
  await dialog.getByRole('button', { name: 'Удалить сервер' }).click()
  await expect(dialog).toBeHidden()
  await expect(card.getByText('Список пуст.')).toBeVisible()
})

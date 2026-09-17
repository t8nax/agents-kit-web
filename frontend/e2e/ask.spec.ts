import { expect, test, type Page } from '@playwright/test'

const bases = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

const ndjson = (...events: object[]) => events.map((e) => JSON.stringify(e)).join('\n') + '\n'

// /api подменяется: настоящий вопрос запустил бы агента в живой базе оператора.
async function mockApi(page: Page) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/ask/bases', (route) => route.fulfill({ json: bases }))
}

async function openAsk(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Спросить базу' }).click()
  return page.getByRole('dialog', { name: 'Вопрос по базе' })
}

test('оператор спрашивает базу из шапки и читает ответ с прочитанными файлами', async ({ page }) => {
  await mockApi(page)
  let posted: unknown = null
  await page.route('**/api/ask', async (route) => {
    posted = route.request().postDataJSON()
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body: ndjson(
        { type: 'step', text: 'читает decisions/ui.md' },
        {
          type: 'answer',
          text: 'Так выбрал **оператор**:\n\n- опрос по таймеру\n- без SSE',
          files: ['decisions/ui.md', 'product.md'],
          durationMs: 31000,
        },
      ),
    })
  })

  const dialog = await openAsk(page)
  await dialog.getByRole('button', { name: 'Nota', exact: true }).click()
  await dialog.getByLabel('Вопрос').fill('Почему таблица обновляется опросом?')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  await expect(dialog.getByText('без SSE')).toBeVisible()
  await expect(dialog.locator('strong', { hasText: 'оператор' })).toBeVisible()
  await expect(dialog.getByText('decisions/ui.md')).toBeVisible()
  await expect(dialog.getByText('product.md')).toBeVisible()
  await expect(dialog.getByText('31 с')).toBeVisible()
  expect(posted).toEqual({ base: 'D:\\Projects\\nota-knowledge', question: 'Почему таблица обновляется опросом?' })

  await dialog.getByRole('button', { name: 'Новый вопрос' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('')

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('пока агент думает, идёт счётчик, а «Отменить» возвращает вопрос в поле', async ({ page }) => {
  await mockApi(page)
  // Ответ не приходит: агент «думает», пока тест не отменит вопрос
  await page.route('**/api/ask', () => {})

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Долгий вопрос')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  const waiting = dialog.getByRole('status')
  await expect(waiting).toContainText('Агент читает базу Agents Kit Web…')
  await expect(waiting.getByLabel('Прошло времени')).toHaveText('0:01', { timeout: 5000 })
  await expect(dialog.getByRole('button', { name: 'Nota', exact: true })).toBeDisabled()

  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('Долгий вопрос')
})

test('сбой агента виден с его выводом, вопрос можно повторить', async ({ page }) => {
  await mockApi(page)
  let calls = 0
  await page.route('**/api/ask', async (route) => {
    calls++
    await route.fulfill({
      contentType: 'application/x-ndjson',
      body:
        calls === 1
          ? ndjson({ type: 'error', text: 'Агент завершился с ошибкой', output: 'Invalid API key · Please run /login' })
          : ndjson({ type: 'answer', text: 'Теперь ответил', files: [], durationMs: 2000 }),
    })
  })

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что за проект?')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Агент не ответил')
  await expect(alert).toContainText('Invalid API key · Please run /login')

  await dialog.getByRole('button', { name: 'Спросить ещё раз' }).click()
  await expect(dialog.getByText('Теперь ответил')).toBeVisible()
  expect(calls).toBe(2)
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно вопроса читается в теме ${theme}`, async ({ page }) => {
    await mockApi(page)
    await page.route('**/api/ask', (route) =>
      route.fulfill({
        contentType: 'application/x-ndjson',
        body: ndjson({ type: 'error', text: 'Агент завершился с ошибкой', output: 'сбой' }),
      }),
    )
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openAsk(page)
    await dialog.getByLabel('Вопрос').fill('Вопрос')
    await dialog.getByRole('button', { name: 'Спросить' }).click()

    const title = dialog.getByRole('alert').locator('strong')
    await expect(title).toBeVisible()
    const [color, background] = await Promise.all([
      title.evaluate((el) => getComputedStyle(el).color),
      dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(color).not.toBe(background)
  })
}

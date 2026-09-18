import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

const bases = [
  { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web' },
  { base: 'D:\\Projects\\nota-knowledge', project: 'Nota' },
]

// /api подменяется: настоящий вопрос запустил бы агента в живой базе оператора.
async function mockApi(page: Page, project = 'Agents Kit Web') {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/ask/bases', (route) => route.fulfill({ json: bases }))
  return mockAgentPanel(page, 'ask', '/api/ask', project)
}

async function openAsk(page: Page) {
  await page.goto('/')
  await page.getByRole('banner').getByRole('button', { name: 'Спросить Чудо-Юдо' }).click()
  return page.getByRole('dialog', { name: 'Вопрос Чудо-Юдо' })
}

test('оператор спрашивает базу из шапки и читает ответ с прочитанными файлами', async ({ page }) => {
  const panel = await mockApi(page, 'Nota')
  panel.reply(
    ndjson(
      { type: 'step', text: 'читает decisions/ui.md' },
      {
        type: 'answer',
        text: 'Так выбрал **оператор**:\n\n- опрос по таймеру\n- без SSE',
        files: ['decisions/ui.md', 'product.md'],
        durationMs: 31000,
      },
    ),
  )

  const dialog = await openAsk(page)
  await dialog.getByRole('button', { name: 'Nota', exact: true }).click()
  await dialog.getByLabel('Вопрос').fill('Почему таблица обновляется опросом?')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  await expect(dialog.getByText('без SSE')).toBeVisible()
  await expect(dialog.locator('strong', { hasText: 'оператор' })).toBeVisible()
  await expect(dialog.getByText('decisions/ui.md')).toBeVisible()
  await expect(dialog.getByText('product.md')).toBeVisible()
  await expect(dialog.getByText('31 с')).toBeVisible()
  expect(panel.posts).toEqual([
    { base: 'D:\\Projects\\nota-knowledge', question: 'Почему таблица обновляется опросом?' },
  ])

  await dialog.getByRole('button', { name: 'Новый вопрос' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('')
  expect(panel.deletes).toBe(1)

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
})

test('закрытое окно не останавливает агента: ответ ждёт в шапке и открывается оттуда', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Почему опрос?')
  await dialog.getByRole('button', { name: 'Спросить' }).click()
  await expect(dialog.getByRole('status')).toContainText('Чудо-Юдо читает базу Agents Kit Web…')

  // Оператор закрыл окно и занялся другим: агент работает дальше.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  const chip = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо читает базу/ })
  await expect(chip).toBeVisible()

  // Агент закончил, пока окно было закрыто.
  panel.reply(ndjson({ type: 'answer', text: 'Так решил оператор.', files: ['decisions/ui.md'], durationMs: 12000 }))
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо ответил по базе Agents Kit Web/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog', { name: 'Вопрос Чудо-Юдо' })
  await expect(reopened.getByText('Почему опрос?')).toBeVisible()
  await expect(reopened.getByText('Так решил оператор.')).toBeVisible()
  await expect(reopened.getByText('decisions/ui.md')).toBeVisible()
  expect(panel.posts).toHaveLength(1)

  // Прочитанный ответ уходит вместе с окном: отметка в шапке о нём больше не говорит.
  await page.keyboard.press('Escape')
  await expect(reopened).toHaveCount(0)
  // Имя агента теперь стоит и на кнопке вопроса, поэтому отметка ищется своим классом.
  await expect(page.getByRole('banner').locator('.agent-chip')).toHaveCount(0)
})

test('пока агент думает, идёт счётчик, а «Отменить» возвращает вопрос в поле', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Долгий вопрос')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  const waiting = dialog.getByRole('status')
  await expect(waiting).toContainText('Чудо-Юдо читает базу Agents Kit Web…')
  await expect(waiting.getByLabel('Прошло времени')).toHaveText('0:01', { timeout: 5000 })
  await expect(dialog.getByRole('button', { name: 'Nota', exact: true })).toBeDisabled()

  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await expect(dialog.getByLabel('Вопрос')).toHaveValue('Долгий вопрос')
  expect(panel.deletes).toBe(1)
  await expect(page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо читает базу/ })).toHaveCount(0)
})

test('сбой агента виден с его выводом, вопрос можно повторить', async ({ page }) => {
  const panel = await mockApi(page)
  panel.reply(ndjson({ type: 'error', text: 'Агент завершился с ошибкой', output: 'Invalid API key · Please run /login' }))

  const dialog = await openAsk(page)
  await dialog.getByLabel('Вопрос').fill('Что за проект?')
  await dialog.getByRole('button', { name: 'Спросить' }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert).toContainText('Чудо-Юдо не ответил')
  await expect(alert).toContainText('Invalid API key · Please run /login')

  panel.reply(ndjson({ type: 'answer', text: 'Теперь ответил', files: [], durationMs: 2000 }))
  await dialog.getByRole('button', { name: 'Спросить ещё раз' }).click()
  await expect(dialog.getByText('Теперь ответил')).toBeVisible()
  expect(panel.posts).toHaveLength(2)
})

for (const theme of ['dark', 'light'] as const) {
  test(`окно вопроса читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockApi(page)
    panel.reply(ndjson({ type: 'error', text: 'Агент завершился с ошибкой', output: 'сбой' }))
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

for (const theme of ['dark', 'light'] as const) {
  test(`просьба в шапке читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockApi(page)
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openAsk(page)
    await dialog.getByLabel('Вопрос').fill('Вопрос')
    await dialog.getByRole('button', { name: 'Спросить' }).click()
    await page.keyboard.press('Escape')

    const chip = page.getByRole('banner').getByRole('button', { name: /Чудо-Юдо читает базу/ })
    await expect(chip).toBeVisible()
    const [color, background] = await Promise.all([
      chip.evaluate((el) => getComputedStyle(el).color),
      chip.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(color).not.toBe(background)
    expect(panel.deletes).toBe(0)
  })
}

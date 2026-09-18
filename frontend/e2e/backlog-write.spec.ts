import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

type Entry = { number: string | null; title: string; text: string | null }

const akwBase = 'D:\\Projects\\app-knowledge'
const old: Entry[] = [{ number: 'B-1', title: 'Панель показывает проблемы баз знаний', text: null }]
const added: Entry[] = [
  { number: 'B-32', title: 'Таблица показывает, сколько копия ждёт ответа', text: 'Сейчас не видно, **как давно** копия ждёт.' },
  { number: 'B-33', title: 'Таблица сортируется по номеру задачи', text: null },
]


// /api подменяется: запись из прогона не должна попасть в живые бэклоги оператора (decisions/tests.md).
async function mockApi(page: Page) {
  let reads = 0
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/backlog', (route) => {
    reads++
    route.fulfill({
      json: [
        { base: akwBase, project: 'Agents Kit Web', entries: reads === 1 ? old : [...old, ...added], error: null },
        { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: [], error: null },
      ],
    })
  })
  return mockAgentPanel(page, 'backlog', '/api/backlog/write')
}

async function openWrite(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await expect(page.getByText('B-1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Добавить с помощью «Чудо-юдо»' }).click()
  return page.getByRole('dialog', { name: 'Запись в бэклог' })
}

test('оператор пишет своими словами, видит новые записи в окне и отмеченными в бэклоге', async ({ page }) => {
  const panel = await mockApi(page)
  panel.reply(
    ndjson(
      { type: 'step', text: 'правит backlog.md' },
      { type: 'written', text: 'Записал.', entries: added, commit: '4f1c2a9', durationMs: 72000 },
    ),
  )

  const dialog = await openWrite(page)
  await dialog.getByLabel('Что записать').fill('Хочу видеть ожидание. И сортировать по номеру.')
  await dialog.getByRole('button', { name: 'Добавить' }).click()

  await expect(dialog.getByText('Добавлено 2 записи')).toBeVisible()
  expect(panel.posts).toEqual([{ base: akwBase, text: 'Хочу видеть ожидание. И сортировать по номеру.' }])
  await expect(dialog.getByText('коммит 4f1c2a9 · 1 мин 12 с')).toBeVisible()
  const entries = dialog.getByRole('list', { name: 'Новые записи' })
  await expect(entries.getByText('B-32', { exact: true })).toBeVisible()
  await expect(entries.locator('strong')).toHaveText('как давно')

  await dialog.getByRole('button', { name: 'К бэклогу' }).click()
  await expect(dialog).toHaveCount(0)
  const fresh = page.getByRole('button', { name: /B-32 Таблица показывает/ })
  await expect(fresh.getByText('новая')).toBeVisible()
  await expect(page.getByText('новая', { exact: true })).toHaveCount(2)

  await page.getByRole('button', { name: 'Обновить' }).click()
  await expect(page.getByRole('button', { name: /B-32 Таблица показывает/ })).toBeVisible()
  await expect(page.getByText('новая', { exact: true })).toHaveCount(0)
})

test('пока агент пишет, виден счётчик, а «Отменить» возвращает текст в поле', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openWrite(page)
  await dialog.getByLabel('Что записать').fill('Долгая мысль')
  await dialog.getByRole('button', { name: 'Добавить' }).click()

  await expect(dialog.getByText('Чудо-юдо пишет в бэклог Agents Kit Web…')).toBeVisible()
  await expect(dialog.getByLabel('Прошло времени')).toHaveText(/0:0[1-9]/)
  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await expect(dialog.getByLabel('Что записать')).toHaveValue('Долгая мысль')
  expect(panel.deletes).toBe(1)
})

test('закрытое окно не останавливает агента: запись доходит и ждёт в шапке', async ({ page }) => {
  const panel = await mockApi(page)

  const dialog = await openWrite(page)
  await dialog.getByLabel('Что записать').fill('Хочу видеть ожидание')
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog.getByText('Чудо-юдо пишет в бэклог Agents Kit Web…')).toBeVisible()

  // Оператор закрыл окно и пошёл читать бэклог: агент дописывает запись без него.
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(panel.deletes).toBe(0)

  panel.reply(ndjson({ type: 'written', text: 'ok', entries: added, commit: '4f1c2a9' }))
  const done = page.getByRole('banner').getByRole('button', { name: /Чудо-юдо записал в бэклог/ })
  await expect(done).toBeVisible()

  await done.click()

  const reopened = page.getByRole('dialog', { name: 'Запись в бэклог' })
  await expect(reopened.getByText('Добавлено 2 записи')).toBeVisible()
  expect(panel.posts).toHaveLength(1)
})

test('неудача видна с выводом агента, текст можно отправить снова', async ({ page }) => {
  const panel = await mockApi(page)
  panel.reply(
    ndjson({ type: 'error', text: 'Агент закончил, но новых записей в бэклоге нет', output: 'Коммит отклонён сверкой' }),
  )

  const dialog = await openWrite(page)
  await dialog.getByLabel('Что записать').fill('Мысль')
  await dialog.getByRole('button', { name: 'Добавить' }).click()

  const alert = dialog.getByRole('alert')
  await expect(alert.getByText('Чудо-юдо не записал')).toBeVisible()
  await expect(alert.getByText('Коммит отклонён сверкой')).toBeVisible()

  await dialog.getByRole('button', { name: 'Изменить текст' }).click()
  await expect(dialog.getByLabel('Что записать')).toHaveValue('Мысль')
  panel.reply(ndjson({ type: 'written', text: 'ok', entries: [added[1]] }))
  await dialog.getByRole('button', { name: 'Добавить' }).click()
  await expect(dialog.getByText('Добавлено 1 запись')).toBeVisible()
  expect(panel.posts).toHaveLength(2)
})

for (const theme of ['dark', 'light'] as const) {
  test(`запись в бэклог читается в теме ${theme}`, async ({ page }) => {
    const panel = await mockApi(page)
    panel.reply(ndjson({ type: 'written', text: 'ok', entries: added, commit: '4f1c2a9' }))
    await page.emulateMedia({ colorScheme: theme })

    const dialog = await openWrite(page)
    await dialog.getByLabel('Что записать').fill('Мысль')
    await dialog.getByRole('button', { name: 'Добавить' }).click()

    const done = dialog.getByRole('status')
    await expect(done).toBeVisible()
    const [doneColor, dialogBackground] = await Promise.all([
      done.evaluate((el) => getComputedStyle(el).color),
      dialog.evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(doneColor).not.toBe(dialogBackground)
    await page.screenshot({ path: `test-results/backlog-write-dialog-${theme}.png` })

    await dialog.getByRole('button', { name: 'К бэклогу' }).click()
    const badge = page.getByText('новая', { exact: true }).first()
    await expect(badge).toBeVisible()
    const [badgeColor, entryBackground] = await Promise.all([
      badge.evaluate((el) => getComputedStyle(el).color),
      page.getByRole('button', { name: /B-32/ }).evaluate((el) => getComputedStyle(el).backgroundColor),
    ])
    expect(badgeColor).not.toBe(entryBackground)
    await page.screenshot({ path: `test-results/backlog-write-${theme}.png` })
  })
}

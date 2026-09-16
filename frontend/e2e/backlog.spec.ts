import { expect, test, type Page } from '@playwright/test'

type Entry = { number: string | null; title: string; text: string | null }

const entries: Record<'akw' | 'nota', Entry[]> = {
  akw: [
    {
      number: 'B-1',
      title: 'Панель показывает проблемы баз знаний',
      text: 'Сейчас панель не говорит, что с базой что-то не так.\n\n- связь разорвана\n- сверка нашла ошибки',
    },
    { number: 'B-13', title: 'У панели есть светлая тема', text: 'Панель сейчас только тёмная.' },
  ],
  nota: [{ number: 'B-2', title: 'Экспорт заметок', text: 'Забрать заметки нечем.' }],
}

// /api подменяется: прогон работает с живыми базами оператора, и их бэклоги в тесте не при чём.
async function mockApi(page: Page, akw: Entry[] = entries.akw) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/backlog', (route) =>
    route.fulfill({
      json: [
        { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web', entries: akw, error: null },
        { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: entries.nota, error: null },
      ],
    }),
  )
}

test('бэклог открывается из сайдбара и фильтруется по проектам', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')

  const sidebar = page.getByRole('navigation', { name: 'Разделы панели' })
  await sidebar.getByRole('button', { name: 'Бэклог' }).click()

  await expect(page.getByRole('heading', { name: 'Бэклог', level: 2 })).toBeVisible()

  const first = page.getByRole('region', { name: 'Agents Kit Web' })
  await expect(first.getByText('B-1', { exact: true })).toBeVisible()
  await expect(first.getByText('Панель показывает проблемы баз знаний')).toBeVisible()
  // Текст оператору размечен markdown, а не показан построчно
  await expect(first.getByRole('listitem')).toHaveText(['связь разорвана', 'сверка нашла ошибки'])
  await expect(page.getByRole('region', { name: 'Nota' }).getByText('Экспорт заметок')).toBeVisible()

  await page.getByRole('button', { name: 'Nota', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Agents Kit Web' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Nota' })).toBeVisible()
})

test('«Обновить» показывает то, что в файле сейчас', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await expect(page.getByText('B-1', { exact: true })).toBeVisible()

  // Соседняя сессия забрала запись в работу и дописала новую
  await mockApi(page, [{ number: 'B-17', title: 'Дописана соседней сессией', text: null }])
  await page.getByRole('button', { name: 'Обновить' }).click()

  await expect(page.getByText('B-17')).toBeVisible()
  await expect(page.getByText('B-1', { exact: true })).toHaveCount(0)
})

import { expect, test, type Page } from '@playwright/test'

type Entry = { number: string | null; title: string; text: string | null; priority?: string; type?: string }

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
  // В списке только номер и заголовок: текст оператору открывается окном
  await expect(page.getByText('Сейчас панель не говорит, что с базой что-то не так.')).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Nota' }).getByText('Экспорт заметок')).toBeVisible()

  await page.getByRole('button', { name: 'Nota', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Agents Kit Web' })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Nota' })).toBeVisible()
})

test('запись открывается окном с размеченным текстом и закрывается', async ({ page }) => {
  await mockApi(page)
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  const entry = page.getByRole('button', { name: 'B-1 Панель показывает проблемы баз знаний' })
  await entry.click()

  const dialog = page.getByRole('dialog', { name: 'Панель показывает проблемы баз знаний' })
  await expect(dialog.getByText('B-1', { exact: true })).toBeVisible()
  // Текст оператору размечен markdown, а не показан построчно
  await expect(dialog.getByRole('listitem')).toHaveText(['связь разорвана', 'сверка нашла ошибки'])

  // Клик мимо окна закрывает его
  await page.mouse.click(10, 10)
  await expect(dialog).toHaveCount(0)

  // С клавиатуры: фокус на записи, Enter открывает, Esc закрывает и возвращает фокус записи
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(entry).toBeFocused()

  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toHaveCount(0)
})

test('тип и приоритет записи видны в списке и в окне, после названия', async ({ page }) => {
  await mockApi(page, [
    { number: 'B-1', title: 'Копия не пускает следующую задачу', text: 'Текст.', priority: 'блокер', type: 'баг' },
    { number: 'B-13', title: 'У панели есть светлая тема', text: null, priority: 'низкий', type: 'фича' },
    { number: 'B-5', title: 'Дописана руками', text: null },
  ])
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  // В списке плашки стоят между номером и заголовком, а запись без полей идёт как прежде
  const entry = page.getByRole('button', { name: 'B-1 баг блокер Копия не пускает следующую задачу' })
  await expect(entry).toBeVisible()
  await expect(page.getByRole('button', { name: 'B-13 фича низкий У панели есть светлая тема' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'B-5 Дописана руками' })).toBeVisible()

  await entry.click()
  const dialog = page.getByRole('dialog', { name: 'Копия не пускает следующую задачу' })
  await expect(dialog.locator('.entry-modal-name')).toHaveText(/B-1\s*Копия не пускает следующую задачу\s*баг\s*блокер/)
})

test('запись без текста открывается окном «Описания нет»', async ({ page }) => {
  await mockApi(page, [{ number: 'B-5', title: 'Дописана руками', text: null }])
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  await page.getByRole('button', { name: 'B-5 Дописана руками' }).click()
  await expect(page.getByRole('dialog', { name: 'Дописана руками' }).getByText('Описания нет')).toBeVisible()
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

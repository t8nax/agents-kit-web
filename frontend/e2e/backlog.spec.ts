import { expect, test, type Page } from '@playwright/test'

type Entry = {
  number: string | null
  title: string
  text: string | null
  priority?: string
  type?: string
  artifacts?: { label: string; address: string }[]
}

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
        { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web', entries: akw, error: null, letters: 'B' },
        { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', entries: entries.nota, error: null, letters: 'B' },
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

test('тип и приоритет записи видны в списке и в окне, под заголовком', async ({ page }) => {
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
  // В окне плашки идут своей строкой под заголовком
  await expect(dialog.locator('.entry-modal-line')).toHaveText(/B-1\s*Копия не пускает следующую задачу/)
  await expect(dialog.locator('.entry-modal-fields')).toHaveText(/баг\s*блокер/)
})

test('артефакты записи стоят блоком под описанием: файл открывается запросом к панели, ошибка — строкой под блоком', async ({ page }) => {
  await mockApi(page, [
    {
      number: 'B-9',
      title: 'Со снимком',
      text: 'Снимок падения приложен.',
      artifacts: [
        { label: 'макет', address: 'https://claude.ai/artifact/AbC' },
        { label: 'снимок падения', address: 'artifacts/B-9-снимок.png' },
      ],
    },
  ])
  let opened: unknown = null
  await page.route('**/api/backlog/artifact/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ status: 404, json: { problem: 'missing' } })
  })
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  await page.getByRole('button', { name: 'B-9 Со снимком' }).click()
  const dialog = page.getByRole('dialog', { name: 'Со снимком' })
  const block = dialog.getByRole('region', { name: 'Артефакты' })
  // блок — под описанием, а в самом описании списка нет
  expect((await block.boundingBox())!.y).toBeGreaterThan((await dialog.getByText('Снимок падения приложен.').boundingBox())!.y)
  await expect(dialog.locator('.entry-text')).not.toContainText('artifacts/')
  await expect(block.getByRole('link', { name: 'https://claude.ai/artifact/AbC' })).toHaveAttribute('target', '_blank')
  await block.getByRole('button', { name: 'artifacts/B-9-снимок.png' }).click()

  await expect.poll(() => opened).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    number: 'B-9',
    index: 1,
    address: 'artifacts/B-9-снимок.png',
  })
  await expect(block.getByRole('alert')).toHaveText('Файла нет в базе: artifacts/B-9-снимок.png')
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

// Проект со своими буквами номеров: номер чужими буквами виден, но не запускается, а номер, плашки и
// заголовок стоят столбцами при номерах разной ширины и у записи без номера — макет B-185.
const orders = {
  base: 'D:\\Projects\\orders-knowledge',
  project: 'Orders',
  entries: [
    { number: 'ORD-15', title: 'Повторная оплата создаёт второй заказ', text: null, priority: 'блокер', type: 'баг' },
    { number: 'B-7', title: 'Таймаут платёжного шлюза не попадает в лог', text: null, priority: 'низкий', type: 'баг' },
    { number: null, title: 'Разобраться с часовыми поясами в отчётах', text: null, priority: 'низкий', type: 'фича' },
  ],
  error: null,
  letters: 'ORD',
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`номер, плашки и заголовок записей стоят столбцами, чужие буквы не запускаются (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    const copy = {
      project: 'Orders',
      base: orders.base,
      path: 'D:\\Projects\\orders',
      branch: 'main',
      task: null,
      flowStep: null,
      progress: null,
      status: 'free',
      error: null,
      letters: 'ORD',
    }
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: [copy] }))
    await page.route('**/api/backlog', (route) => route.fulfill({ json: [orders] }))
    await page.goto('/')
    await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

    const rows = page.locator('.entry-row')
    await expect(rows).toHaveCount(3)
    // Шрифт грузится после первой отрисовки: замер повторяется, пока не сойдётся (decisions/tests.md)
    await expect(async () => {
      for (const part of ['.entry-type', '.entry-prio', '.entry-title']) {
        const lefts = await rows.locator(part).evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().left)))
        expect(lefts).toHaveLength(3)
        expect(new Set(lefts).size).toBe(1)
      }
    }).toPass()

    // Строки ищутся по номеру: по умолчанию записи стоят по номеру, а не как в файле (B-78)
    const row = (text: string) => rows.filter({ hasText: text })
    await expect(row('ORD-15').getByRole('button', { name: 'Взять задачу' })).toBeEnabled()
    await expect(row('B-7').getByRole('button', { name: 'Взять задачу' })).toBeDisabled()
    await expect(row('часовыми поясами').getByRole('button', { name: 'Взять задачу' })).toHaveCount(0)
  })
}

test('записи отбираются чипами и поиском, порядок выбирается и помнится после перезагрузки', async ({ page }) => {
  await mockApi(page, [
    { number: 'B-1', title: 'Старый баг', text: null, type: 'баг', priority: 'средний' },
    { number: 'B-2', title: 'Фича про импорт', text: null, type: 'фича', priority: 'блокер' },
    { number: 'B-3', title: 'Срочный баг импорта', text: null, type: 'баг', priority: 'высокий' },
  ])
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()

  const bar = page.getByRole('group', { name: 'Отбор и порядок записей' })
  const numbers = page.getByRole('region', { name: 'Agents Kit Web' }).locator('.entry-num')
  await expect(numbers).toHaveText(['B-1', 'B-2', 'B-3'])

  // Строка стоит одной линией: поиск слева, порядок прижат вправо
  const search = await bar.getByRole('textbox', { name: 'Поиск' }).boundingBox()
  const order = await bar.getByRole('combobox', { name: 'Порядок' }).boundingBox()
  expect(Math.abs(search!.y + search!.height / 2 - (order!.y + order!.height / 2))).toBeLessThan(2)
  expect(order!.x).toBeGreaterThan(search!.x + 400)

  await bar.getByRole('button', { name: 'высокий' }).click()
  await bar.getByRole('button', { name: 'блокер' }).click()
  await expect(numbers).toHaveText(['B-2', 'B-3'])
  // Под отбор по полю у Nota ничего не подошло — проект скрыт
  await expect(page.getByRole('region', { name: 'Nota' })).toHaveCount(0)

  await bar.getByRole('textbox', { name: 'Поиск' }).fill('баг')
  await expect(numbers).toHaveText(['B-3'])
  await bar.getByRole('textbox', { name: 'Поиск' }).fill('нет такого')
  await expect(page.getByText('Под фильтр записей нет')).toBeVisible()
  await bar.getByRole('button', { name: 'Очистить' }).click()

  await bar.getByRole('combobox', { name: 'Порядок' }).selectOption('По приоритету')
  await bar.getByRole('button', { name: 'По возрастанию' }).click()
  await expect(numbers).toHaveText(['B-2', 'B-3'])

  await page.reload()
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Бэклог' }).click()
  await expect(bar.getByRole('combobox', { name: 'Порядок' })).toHaveValue('priority')
  await expect(bar.getByRole('button', { name: 'По убыванию' })).toBeVisible()
  await expect(bar.getByRole('button', { name: 'блокер' })).toHaveAttribute('aria-pressed', 'false')
  await expect(numbers).toHaveText(['B-2', 'B-3', 'B-1'])
})

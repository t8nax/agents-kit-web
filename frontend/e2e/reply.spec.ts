import { expect, test } from '@playwright/test'

// /api подменяется: dev-API читает настоящую базу знаний, и ответ из прогона попал бы в живую память.
test('оператор отвечает на вопросы копии, и строка перестаёт ждать', async ({ page }) => {
  let answered = false
  let posted: unknown = null

  const row = (status: string) => ({
    project: 'app-knowledge',
    base: 'D:\\Projects\\app-knowledge',
    path: 'D:\\Projects\\app',
    branch: 'feat/reply',
    task: 'Окно ответа',
    flowStep: 'Критерий',
    progress: 0,
    status,
    error: null,
  })

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row(answered ? 'in-work' : 'waiting')] }))
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }],
        outOfScope: 'Health баз.',
        design: 'Макет окна ответа: https://claude.ai/artifact/AbC123',
        questions: [
          { title: 'Подтвердить критерий?', context: 'За вами объём проверок', variants: [], answer: null },
          {
            title: 'Как быть с переносами?',
            context: 'Ответ записывается одной строкой',
            variants: [
              { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
              { choice: 'Не отправлять', effect: 'Оператор переписывает', recommended: false },
            ],
            answer: null,
          },
        ],
      },
    }),
  )
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    answered = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const tableRow = page.getByRole('row', { name: /Окно ответа/ })
  await expect(tableRow.getByText('Ждёт оператора')).toBeVisible()
  await tableRow.getByRole('button', { name: 'Ответить' }).click()

  const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()

  // макет задачи — свой блок в «Контексте задачи», ссылкой в новую вкладку
  await dialog.getByText('Контекст задачи').click()
  await expect(dialog.getByText('Дизайн')).toBeVisible()
  const design = dialog.getByRole('link', { name: 'https://claude.ai/artifact/AbC123' })
  await expect(design).toHaveAttribute('target', '_blank')
  await dialog.getByText('Контекст задачи').click()

  await dialog.getByLabel('Ответ').fill('принимаю')
  await dialog.getByRole('button', { name: 'Далее' }).click()
  await dialog.getByRole('button', { name: /Заменять пробелами/ }).click()
  await dialog.getByRole('button', { name: 'Отправить' }).click()

  // после записи окно закрывается само, без экрана успеха и кнопки «Закрыть»
  await expect(dialog).toBeHidden()
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'Заменять пробелами' },
    ],
  })

  await expect(tableRow.getByText('В работе')).toBeVisible()
})

// /api подменяется, как и выше: набранный ответ хранится в браузере, а отправки нет.
test('набранный ответ возвращается после закрытия окна и перезагрузки страницы', async ({ page }) => {
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: [
        {
          project: 'app-knowledge',
          base: 'D:\\Projects\\app-knowledge',
          path: 'D:\\Projects\\app',
          branch: 'feat/reply',
          task: 'Окно ответа',
          flowStep: 'Критерий',
          progress: 0,
          status: 'waiting',
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [],
        outOfScope: null,
        design: null,
        vsCodeSession: false,
        questions: [{ title: 'Подтвердить критерий?', context: null, variants: [], answer: null }],
      },
    }),
  )

  const open = async () => {
    await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()
    const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
    await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
    return dialog
  }

  await page.goto('/')
  let dialog = await open()
  await dialog.getByLabel('Ответ').fill('принимаю, но без e2e')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  dialog = await open()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('принимаю, но без e2e')

  await page.reload()
  dialog = await open()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('принимаю, но без e2e')
})

// /api подменяется, как и выше; внешняя страница тоже подменена, чтобы прогон не ходил в сеть.
test('ссылка из вопроса открывается в новой вкладке, окно ответа и набранное остаются', async ({ page, context }) => {
  const longUrl = `https://example.com/${'verylongsegment'.repeat(20)}end`
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Внешняя страница</title>' }),
  )
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: [
        {
          project: 'app-knowledge',
          base: 'D:\\Projects\\app-knowledge',
          path: 'D:\\Projects\\app',
          branch: 'feat/reply',
          task: 'Окно ответа',
          flowStep: 'Критерий',
          progress: 0,
          status: 'waiting',
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [],
        outOfScope: null,
        design: null,
        vsCodeSession: false,
        questions: [
          {
            title: 'Куда переносить выгрузку?',
            context: `Объявление в заявке https://example.com/tickets/OPS-1\n\nПример адреса: ${longUrl}`,
            variants: [],
            answer: null,
          },
        ],
      },
    }),
  )

  await page.goto('/')
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
  await dialog.getByLabel('Ответ').fill('в новую папку')

  const link = dialog.getByRole('link', { name: 'https://example.com/tickets/OPS-1' })
  await expect(link).toBeVisible()
  await expect(link.locator('svg')).toHaveCount(0)

  // длинный адрес переносится внутри колонки и не раздвигает окно
  const box = (await dialog.locator('.question-box').boundingBox())!
  const column = (await dialog.locator('.central-column').boundingBox())!
  expect(box.width).toBeLessThanOrEqual(column.width + 1)
  const scroll = await dialog.locator('.modal-scroll-area').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(scroll).toBe(true)

  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()])
  await tab.waitForLoadState()
  expect(tab.url()).toBe('https://example.com/tickets/OPS-1')

  expect(page.url()).not.toContain('example.com')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('в новую папку')
})

// /api подменяется, как и выше: мастер проходится одной клавиатурой, ответы никуда не пишутся.
test('Enter в поле ответа ведёт по вопросам и на последнем отправляет ответы', async ({ page }) => {
  let posted: unknown = null

  await page.route('**/api/workspaces', (route) =>
    route.fulfill({
      json: [
        {
          project: 'app-knowledge',
          base: 'D:\\Projects\\app-knowledge',
          path: 'D:\\Projects\\app',
          branch: 'feat/reply',
          task: 'Окно ответа',
          flowStep: 'Критерий',
          progress: 0,
          status: 'waiting',
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [],
        outOfScope: null,
        vsCodeSession: false,
        questions: [
          { title: 'Подтвердить критерий?', context: null, variants: [], answer: null },
          { title: 'Как быть с переносами?', context: null, variants: [], answer: null },
        ],
      },
    }),
  )
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()
  const dialog = page.getByRole('dialog', { name: 'Ответ оператора' })
  const answer = dialog.getByLabel('Ответ')

  await answer.fill('принимаю')
  await answer.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()

  // ответ первого вопроса остался одной строкой: Enter перенос строки в поле не оставил
  await dialog.getByRole('button', { name: 'Назад' }).click()
  await expect(answer).toHaveValue('принимаю')
  await answer.press('Enter')

  await answer.fill('заменять')
  await answer.press('Enter')

  await expect(dialog).toBeHidden()
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'заменять' },
    ],
  })
})

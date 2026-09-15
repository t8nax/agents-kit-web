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
        criterion: ['1. Окно есть.'],
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
  await dialog.getByLabel('Ответ').fill('принимаю')
  await dialog.getByRole('button', { name: 'Далее' }).click()
  await dialog.getByRole('button', { name: /Заменять пробелами/ }).click()
  await dialog.getByRole('button', { name: 'Отправить' }).click()

  await expect(dialog.getByRole('heading', { name: 'Ответы записаны' })).toBeVisible()
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'Заменять пробелами' },
    ],
  })

  await dialog.locator('.modal-footer').getByRole('button', { name: 'Закрыть' }).click()
  await expect(dialog).toBeHidden()
  await expect(tableRow.getByText('В работе')).toBeVisible()
})

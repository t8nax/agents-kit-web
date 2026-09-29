import { expect, test } from '@playwright/test'

// Микрофон — подставной у Chromium, разрешение выдано заранее: здесь проверяется, какой кнопке достаётся Ctrl+D,
// а не распознавание. Свой файл — потому что launchOptions задаются только на весь файл (B-291).
test.use({
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] },
  permissions: ['microphone'],
})

const base = 'D:\\Projects\\agents-kit-web-knowledge'
const freeRow = {
  project: 'Agents Kit Web',
  base,
  path: 'D:\\Projects\\rustic-silver-sparrow',
  branch: 'dev',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

test('Ctrl+D сразу после открытия «Взять в работу» пишет в его поле, хотя фокус окно себе не берёт', async ({ page }) => {
  // Запуск задачи e2e не делает по-настоящему: API подменяется page.route.
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [freeRow] }))
  await page.route('**/api/backlog', (route) =>
    route.fulfill({
      json: [
        {
          base,
          project: 'Agents Kit Web',
          entries: [{ number: 'B-8', title: 'Кнопка запуска задачи', text: null }],
          error: null,
          letters: 'B',
        },
      ],
    }),
  )
  await page.route('**/api/flow', (route) =>
    route.fulfill({
      json: [{ base, project: 'Agents Kit Web', flows: [{ name: 'полный', when: 'всё', entries: [{ stage: 'Ветка' }] }] }],
    }),
  )
  await page.route('**/api/voice', (route) => route.fulfill({ json: { state: 'installed', downloaded: 1, total: 1, error: null } }))
  await page.route('**/api/voice/warm', (route) => route.fulfill({ status: 202, body: '' }))
  // Распознавание тоже подменено: кусок, успей он нарезаться, не уходит в настоящий API прогона.
  await page.route('**/api/voice/recognize', (route) => route.fulfill({ json: { text: '' } }))

  await page.goto('/')
  await page.getByRole('button', { name: 'Бэклог' }).click()
  await page.locator('.entry-row').filter({ hasText: 'B-8' }).getByRole('button', { name: 'Взять задачу' }).click()
  const dialog = page.getByRole('dialog', { name: 'Взять задачу в работу' })
  const mic = dialog.getByRole('button', { name: 'Голосовой ввод' })
  await expect(mic).toHaveAttribute('title', /^Надиктовать/)

  await page.keyboard.press('Control+KeyD')
  await expect(mic).toHaveAttribute('aria-pressed', 'true')

  await page.keyboard.press('Control+KeyD')
  await expect(mic).toHaveAttribute('aria-pressed', 'false')
  // Что Ctrl+D не открывает закладку браузера (preventDefault), держит тест кнопки: у Chromium без окна строки
  // закладок нет, и здесь этого не видно.
})

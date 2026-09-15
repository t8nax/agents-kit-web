import { expect, test } from '@playwright/test'

test('страница показывает ответ API', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByTestId('ping-status')).toHaveText('pong')
})

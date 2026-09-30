import { expect, test } from '@playwright/test'

// Критерий 1 B-306, вариант А макета: оглавление всегда видно колонкой слева, текст занимает остальную ширину,
// «Назад» и «Дальше» — внизу страницы. Раскладку видит только браузер, jsdom её не считает.
test.beforeEach(async ({ page }) => {
  // Руководству данные не нужны: таблица копий пуста, чтобы раздел не зависел от живых баз машины.
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.setViewportSize({ width: 1280, height: 720 })
  await page.goto('/')
  // Руководство открывается значком книги в шапке (B-318): полоса разделов при этом не раскрывается
  await page.getByRole('banner').getByRole('button', { name: 'Руководство' }).click()
  await expect(page.getByRole('heading', { name: 'Руководство', level: 2 })).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Разделы панели' })).not.toHaveClass(/expanded/)
})

test('оглавление стоит на месте, пока длинная страница прокручивается, а текст занимает остальную ширину', async ({
  page,
}) => {
  const toc = page.getByRole('navigation', { name: 'Страницы руководства' })
  await toc.getByRole('button', { name: 'Флоу' }).click()
  await expect(page.getByRole('heading', { name: 'Флоу', level: 1 })).toBeVisible()

  const article = page.locator('.guide-page')
  const tocBox = (await toc.boundingBox())!
  const articleBox = (await article.boundingBox())!
  expect(tocBox.width).toBeCloseTo(220, 0)
  // Текст начинается сразу за оглавлением и доходит до правого края окна
  expect(articleBox.x).toBeGreaterThanOrEqual(tocBox.x + tocBox.width - 1)
  expect(articleBox.x + articleBox.width).toBeGreaterThan(1280 - 2)

  // Страница длиннее окна и прокручивается своей колонкой; оглавление при этом не сдвигается
  expect(await article.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true)
  const pager = page.getByRole('navigation', { name: 'Соседние страницы' })
  await pager.scrollIntoViewIfNeeded()
  await expect(pager).toBeInViewport()
  expect((await toc.boundingBox())!.y).toBe(tocBox.y)
  await expect(toc.getByRole('button', { name: 'С чего начать' })).toBeInViewport()
})

test('ни одна страница не шире своей колонки: длинные названия в таблицах переносятся', async ({ page }) => {
  const toc = page.getByRole('navigation', { name: 'Страницы руководства' })
  const article = page.locator('.guide-page')
  for (const item of await toc.getByRole('button').all()) {
    await item.click()
    const name = (await item.textContent())!
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible()
    // Замер повторяется до совпадения: шрифт панели грузится после первой отрисовки (decisions/e2e.md).
    // Что вылезло за край — названо в падении: страница и начало текста широкого места.
    await expect(async () => {
      const wide = await article.evaluate((el) => {
        const right = el.getBoundingClientRect().right
        const over = [...el.querySelectorAll('*')].find((child) => child.getBoundingClientRect().right > right + 1)
        return over ? `${over.tagName}: ${over.textContent?.slice(0, 60)}` : null
      })
      expect(wide, name).toBeNull()
    }).toPass()
  }
})

test('«Дальше» внизу страницы открывает следующую страницу с её начала', async ({ page }) => {
  const toc = page.getByRole('navigation', { name: 'Страницы руководства' })
  await toc.getByRole('button', { name: 'Рабочие копии' }).click()
  const pager = page.getByRole('navigation', { name: 'Соседние страницы' })
  await pager.scrollIntoViewIfNeeded()

  await pager.getByRole('button', { name: /Дальше/ }).click()

  await expect(page.getByRole('heading', { name: 'Бэклог', level: 1 })).toBeInViewport()
  await expect(toc.getByRole('button', { name: 'Бэклог' })).toHaveAttribute('aria-current', 'page')
  expect(await page.locator('.guide-page').evaluate((el) => el.scrollTop)).toBe(0)
})

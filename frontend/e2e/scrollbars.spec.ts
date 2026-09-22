/// <reference lib="dom" />
import { expect, test, type Page } from '@playwright/test'

// Строк столько, чтобы главная область прокручивалась и на высоком окне
const rows = Array.from({ length: 60 }, (_, i) => ({
  project: 'agents-kit-web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: `D:\\Projects\\copy-${i}`,
  branch: `feat/b-${i}`,
  task: `Задача ${i}`,
  flowStep: 'Реализация',
  progress: 40,
  status: 'in-work',
  error: null,
}))

const gutter = 10

// Playwright запускает Chromium без окна с --hide-scrollbars: полос нет ни на экране, ни в раскладке
test.use({ launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] } })

async function token(page: Page, name: string) {
  return page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name)
}

// Цвет полосы виден только на экране: у псевдоэлементов полосы нет вычисленного стиля.
async function pixel(page: Page, x: number, y: number) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } })
  return page.evaluate(async (base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
    const canvas = new OffscreenCanvas(1, 1)
    const context = canvas.getContext('2d')!
    context.drawImage(bitmap, 0, 0)
    const [r, g, b] = context.getImageData(0, 0, 1, 1).data
    return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
  }, png.toString('base64'))
}

// Середина места под вертикальную полосу у правого края области, на уровне y от её верха
async function verticalBar(page: Page, selector: string, y: number) {
  return page.locator(selector).evaluate(
    (el, { gutter, y }) => {
      const box = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const right = box.right - parseFloat(style.borderRightWidth)
      return { x: Math.floor(right - gutter / 2), y: Math.floor(box.top + y), bottom: Math.floor(box.bottom - 12) }
    },
    { gutter, y },
  )
}

for (const theme of ['dark', 'light'] as const) {
  test(`полосы прокрутки узкие, без стрелок и в цветах темы ${theme}`, async ({ page }) => {
    await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
    await page.emulateMedia({ colorScheme: theme })
    await page.goto('/')
    await expect(page.getByText('Задача 59')).toBeAttached()

    const content = page.locator('.content')
    const size = await content.evaluate((el: HTMLElement) => {
      const style = getComputedStyle(el)
      const borders = parseFloat(style.borderLeftWidth) + parseFloat(style.borderRightWidth)
      return { bar: el.offsetWidth - el.clientWidth - borders, scrolls: el.scrollHeight > el.clientHeight }
    })
    expect(size.scrolls).toBe(true)
    expect(size.bar).toBe(gutter)

    const rest = await token(page, '--border-strong')
    const hover = await token(page, '--text-tertiary')

    // Стрелок нет: бегунок прокрученной к началу области начинается у самого верха полосы
    const bar = await verticalBar(page, '.content', 8)
    await page.mouse.move(0, 0)
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(rest)

    // Мышь на пустой дорожке под бегунком полосу не меняет
    await page.mouse.move(bar.x, bar.bottom)
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(rest)

    await page.mouse.move(bar.x, bar.y)
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(hover)
  })
}

test('горизонтальная полоса любой прокручиваемой области такая же узкая', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
  await page.goto('/')
  await expect(page.getByText('Задача 0')).toBeVisible()

  // Правило общее для всех элементов, поэтому хватает любой области с горизонтальной прокруткой
  const bar = await page.evaluate(() => {
    const pre = document.createElement('pre')
    pre.style.cssText = 'overflow-x: auto; width: 200px; margin: 0; position: fixed; left: 20px; top: 20px'
    pre.textContent = 'x'.repeat(400)
    document.body.append(pre)
    return pre.offsetHeight - pre.clientHeight
  })
  expect(bar).toBe(gutter)
})

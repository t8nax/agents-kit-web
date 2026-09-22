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

async function openPanel(page: Page) {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
  await page.goto('/')
  await expect(page.getByText('Задача 59')).toBeAttached()
}

async function token(page: Page, name: string) {
  return page.evaluate((name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name)
}

// Цвет полосы виден только на экране: у псевдоэлементов полосы нет вычисленного стиля.
async function pixels(page: Page, x: number, y: number, width = 1, height = 1) {
  const png = await page.screenshot({ clip: { x, y, width, height } })
  return page.evaluate(
    async ({ base64, width, height }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
      const canvas = new OffscreenCanvas(width, height)
      const context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const data = context.getImageData(0, 0, width, height).data
      return Array.from({ length: width * height }, (_, i) =>
        '#' + [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]].map((v) => v.toString(16).padStart(2, '0')).join(''),
      )
    },
    { base64: png.toString('base64'), width, height },
  )
}

async function pixel(page: Page, x: number, y: number) {
  return (await pixels(page, x, y))[0]
}

// Сколько точек поперёк полосы закрашено цветом бегунка
async function thickness(page: Page, left: number, y: number, color: string) {
  return (await pixels(page, left, y, gutter)).filter((c) => c === color).length
}

// Место под вертикальную полосу у правого края главной области
async function verticalBar(page: Page) {
  return page.locator('.content').evaluate(
    (el, gutter) => {
      const box = el.getBoundingClientRect()
      const right = box.right - parseFloat(getComputedStyle(el).borderRightWidth)
      return {
        left: Math.round(right - gutter),
        x: Math.floor(right - gutter / 2),
        // Бегунок прокрученной к началу области стоит у самого верха полосы: стрелок над ним нет
        thumb: Math.floor(box.top + 8),
        track: Math.floor(box.bottom - 12),
      }
    },
    gutter,
  )
}

async function barSize(page: Page) {
  return page.locator('.content').evaluate((el: HTMLElement) => {
    const style = getComputedStyle(el)
    return {
      width: el.offsetWidth - el.clientWidth - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth),
      height: el.offsetHeight - el.clientHeight - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth),
      down: el.scrollHeight > el.clientHeight,
      across: el.scrollWidth > el.clientWidth,
    }
  })
}

for (const theme of ['dark', 'light'] as const) {
  test(`полоса прокрутки узкая, без стрелок, на прозрачной дорожке, в цветах темы ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await openPanel(page)

    // Высоту строк задаёт шрифт, который грузится после первой отрисовки
    await expect(async () => {
      const size = await barSize(page)
      expect(size.down).toBe(true)
      expect(size.width).toBe(gutter)
    }).toPass()

    const rest = await token(page, '--border-strong')
    const hover = await token(page, '--text-tertiary')
    const drag = await token(page, '--text-secondary')
    const background = await token(page, '--bg-base')
    const bar = await verticalBar(page)

    await page.mouse.move(0, 0)
    await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(rest)
    expect(await thickness(page, bar.left, bar.thumb, rest)).toBe(4)
    // Дорожка прозрачная: под бегунком виден фон панели
    expect(await pixel(page, bar.x, bar.track)).toBe(background)

    // Мышь на пустой дорожке под бегунком полосу не меняет
    await page.mouse.move(bar.x, bar.track)
    await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(rest)

    await page.mouse.move(bar.x, bar.thumb)
    await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(hover)
    expect(await thickness(page, bar.left, bar.thumb, hover)).toBe(6)

    await page.mouse.down()
    await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(drag)
    await page.mouse.up()
  })
}

test('смена темы на открытой панели сразу перекрашивает полосу', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await openPanel(page)
  await expect(async () => expect((await barSize(page)).down).toBe(true)).toPass()

  const bar = await verticalBar(page)
  const dark = await token(page, '--border-strong')
  await page.mouse.move(0, 0)
  await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(dark)

  await page.getByRole('button', { name: 'Светлая тема' }).click()
  await expect(page.getByRole('button', { name: 'Тёмная тема' })).toBeVisible()
  const light = await token(page, '--border-strong')
  expect(light).not.toBe(dark)
  await expect.poll(() => pixel(page, bar.x, bar.thumb)).toBe(light)
})

for (const theme of ['dark', 'light'] as const) {
  test(`горизонтальная полоса такая же, как вертикальная, в теме ${theme}`, async ({ page }) => {
    // На узком окне таблица рабочих копий уходит вбок
    await page.setViewportSize({ width: 560, height: 700 })
    await page.emulateMedia({ colorScheme: theme })
    await openPanel(page)
    await expect(async () => {
      const size = await barSize(page)
      expect(size.across).toBe(true)
      expect(size.height).toBe(gutter)
    }).toPass()

    const rest = await token(page, '--border-strong')
    const hover = await token(page, '--text-tertiary')
    const drag = await token(page, '--text-secondary')
    const bar = await page.locator('.content').evaluate(
      (el, gutter) => {
        const box = el.getBoundingClientRect()
        const bottom = box.bottom - parseFloat(getComputedStyle(el).borderBottomWidth)
        return { x: Math.floor(box.left + 8), top: Math.round(bottom - gutter), y: Math.floor(bottom - gutter / 2) }
      },
      gutter,
    )
    const across = async (color: string) =>
      (await pixels(page, bar.x, bar.top, 1, gutter)).filter((c) => c === color).length

    await page.mouse.move(0, 0)
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(rest)
    expect(await across(rest)).toBe(4)

    await page.mouse.move(bar.x, bar.y)
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(hover)
    expect(await across(hover)).toBe(6)

    await page.mouse.down()
    await expect.poll(() => pixel(page, bar.x, bar.y)).toBe(drag)
    await page.mouse.up()
  })
}

// Вид полос задан один раз на все элементы: своя полоса у окна или раздела разошлась бы с остальными,
// а замеры выше смотрят только на главную область.
test('вид полос прокрутки задаёт только общий файл стилей', async ({ page }) => {
  await openPanel(page)
  const owners = await page.evaluate(() =>
    [...document.querySelectorAll('style')]
      .filter((style) => /scrollbar/.test(style.textContent ?? ''))
      .map((style) => style.dataset.viteDevId ?? '(без имени)'),
  )
  expect(owners.map((owner) => owner.split(/[\\/]/).pop())).toEqual(['index.css'])
})

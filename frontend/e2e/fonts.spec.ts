/// <reference lib="dom" />
import { expect, test } from '@playwright/test'

const rows = [
  {
    project: 'agents-kit-web',
    base: 'D:\\Projects\\agents-kit-web-knowledge',
    // Кириллица в пути — чтобы моноширинный шрифт рисовал и её
    path: 'D:\\Проекты\\agents-kit-web',
    branch: 'feat/panel-fonts',
    task: 'Шрифты панели',
    flowStep: 'Реализация',
    progress: 40,
    status: 'in-work',
    error: null,
  },
]

const latinA = 0x41
const cyrillicZhe = 0x416

// unicodeRange браузер отдаёт нормализованным: «U+0-FF, U+400-45F, U+2116»
function covers(unicodeRange: string, codePoint: number) {
  return unicodeRange.split(',').some((part) => {
    const [from, to = from] = part.trim().replace('U+', '').split('-')
    return parseInt(from, 16) <= codePoint && codePoint <= parseInt(to, 16)
  })
}

test('панель рисует латиницу и кириллицу шрифтами Inter и JetBrains Mono из своей сборки', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: rows }))
  const fontRequests: string[] = []
  page.on('request', (request) => {
    if (request.resourceType() === 'font') fontRequests.push(request.url())
  })

  await page.goto('/')
  await expect(page.getByText('Шрифты панели')).toBeVisible()

  await expect(page.locator('.proj')).toHaveCSS('font-family', /^"Inter Variable"/)
  await expect(page.locator('.mono').first()).toHaveCSS('font-family', /^"JetBrains Mono Variable"/)

  // Браузер грузит поднабор шрифта, только когда на странице есть символы из его unicode-range
  const loaded = await page.evaluate(async () => {
    await document.fonts.ready
    return [...document.fonts]
      .filter((face) => face.status === 'loaded')
      .map((face) => ({ family: face.family.replace(/"/g, ''), range: face.unicodeRange }))
  })
  for (const family of ['Inter Variable', 'JetBrains Mono Variable']) {
    const ranges = loaded.filter((face) => face.family === family).map((face) => face.range)
    expect(ranges.some((range) => covers(range, latinA)), `${family}: латиница`).toBe(true)
    expect(ranges.some((range) => covers(range, cyrillicZhe)), `${family}: кириллица`).toBe(true)
  }

  expect(fontRequests.length).toBeGreaterThan(0)
  for (const url of fontRequests) {
    expect(new URL(url).host, url).toBe(new URL(page.url()).host)
  }
})

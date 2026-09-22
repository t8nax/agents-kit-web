import { expect, test, type Page } from '@playwright/test'

// Заготовка раздела живёт в CSS — мерцание, проявление, «уменьшить движение», цвет полос в темах, — и
// тестам фронта в jsdom она не видна: её проверяют здесь, в браузере (B-201).

const row = {
  project: 'agents-kit-web',
  base: 'D:\\Projects\\agents-kit-web-knowledge',
  path: 'D:\\Projects\\agents-kit-web',
  branch: 'master',
  task: null,
  flowStep: null,
  progress: null,
  status: 'free',
  error: null,
}

/** Таблица копий отвечает, только когда тест её отпустит: до этого раздел стоит заготовкой. */
async function holdWorkspaces(page: Page) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route('**/api/workspaces', async (route) => {
    await gate
    await route.fulfill({ json: [row] })
  })
  return release
}

/** Имена анимаций, которые запускались на странице: проявление длится доли секунды, и снимок его не застаёт. */
async function recordAnimations(page: Page) {
  await page.addInitScript(() => {
    const started: string[] = []
    Object.assign(window, { started })
    document.addEventListener('animationstart', (event) => started.push(event.animationName), true)
  })
  return {
    names: () => page.evaluate(() => [...(window as unknown as { started: string[] }).started]),
    clear: () => page.evaluate(() => void ((window as unknown as { started: string[] }).started.length = 0)),
  }
}

const skeleton = (page: Page) => page.getByRole('status', { name: 'Загрузка рабочих копий' })
const firstBar = (page: Page, property: 'animationName' | 'backgroundColor') =>
  page.locator('.sk').first().evaluate((bar, name) => getComputedStyle(bar)[name], property)
const nextFrames = (page: Page) =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))

test('заготовка мерцает, содержимое проявляется один раз и не держит класс проявления', async ({ page }) => {
  const animations = await recordAnimations(page)
  const release = await holdWorkspaces(page)
  await page.route('**/api/backlog', (route) => route.fulfill({ json: [] }))
  await page.goto('/')

  await expect(skeleton(page)).toBeVisible()
  expect(await firstBar(page, 'animationName')).toBe('sk-wave')

  release()
  await expect(page.getByRole('button', { name: 'Свернуть agents-kit-web' })).toBeVisible()
  await expect.poll(animations.names).toContain('loaded-in')
  // Оставленный класс держал бы у раздела свой слой отрисовки — окно внутри уходило бы под сайдбар
  await expect(page.locator('.loaded')).toHaveCount(0)

  // Возврат в раздел с уже прочитанными копиями не проявляет таблицу заново
  const sections = page.getByRole('navigation', { name: 'Разделы панели' })
  await sections.getByRole('button', { name: 'Бэклог' }).click()
  await expect(page.getByRole('heading', { name: 'Бэклог' })).toBeVisible()
  await animations.clear()
  await sections.getByRole('button', { name: /^Рабочие копии/ }).click()
  await expect(page.getByRole('button', { name: 'Свернуть agents-kit-web' })).toBeVisible()
  await nextFrames(page)
  expect(await animations.names()).not.toContain('loaded-in')
})

test('при «уменьшить движение» полосы стоят без мерцания и содержимое встаёт без проявления', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const animations = await recordAnimations(page)
  const release = await holdWorkspaces(page)
  await page.goto('/')

  await expect(skeleton(page)).toBeVisible()
  expect(await firstBar(page, 'animationName')).toBe('none')

  release()
  await expect(page.getByRole('button', { name: 'Свернуть agents-kit-web' })).toBeVisible()
  await nextFrames(page)
  expect(await animations.names()).not.toContain('loaded-in')
})

for (const colorScheme of ['light', 'dark'] as const) {
  test(`полосы заготовки видны на фоне раздела (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme })
    await holdWorkspaces(page)
    await page.goto('/')

    await expect(skeleton(page)).toBeVisible()
    const bar = await firstBar(page, 'backgroundColor')
    const background = await page.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bar).not.toBe('rgba(0, 0, 0, 0)')
    expect(bar).not.toBe(background)
    // Цвет полос — токен темы, а не вписанный в CSS: вторая тема его переопределяет
    const token = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--border-subtle)'
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    })
    expect(bar).toBe(token)
  })
}

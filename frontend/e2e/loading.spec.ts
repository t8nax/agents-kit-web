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

/** Запрос отвечает, только когда тест его отпустит: до этого раздел стоит заготовкой. */
async function hold(page: Page, url: string, json: unknown) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  await page.route(url, async (route) => {
    await gate
    await route.fulfill({ json })
  })
  return release
}

const holdWorkspaces = (page: Page) => hold(page, '**/api/workspaces', [row])

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

/**
 * Все разделы и карточки на странице дочитали данные и доиграли проявление: иначе проявление соседней
 * карточки, которая под нагрузкой дочитала позже, попадает в запись после её сброса.
 */
async function settled(page: Page) {
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0)
  await expect(page.locator('.loaded')).toHaveCount(0)
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
  // Часы страницы стоят, пока тест смотрит на первые доли секунды: под нагрузкой срок заготовки
  // успевал выйти раньше, чем проверка до неё добиралась.
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1000)
  await page.goto('/')

  // Первые доли секунды полосы держат место невидимыми, а шапка колонок уже видна
  await skeleton(page).waitFor({ state: 'attached' })
  await page.clock.runFor(250)
  const early = await skeleton(page).evaluate((status) => ({
    head: getComputedStyle(status.querySelector('th')!).visibility,
    bar: getComputedStyle(status.querySelector('.sk')!).visibility,
  }))
  expect(early).toEqual({ head: 'visible', bar: 'hidden' })
  await page.clock.resume()

  // Затянулась загрузка — полосы видны
  await expect(page.locator('.sk').first()).toBeVisible()
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
  await settled(page)
  await animations.clear()
  await sections.getByRole('button', { name: /^Рабочие копии/ }).click()
  await expect(page.getByRole('button', { name: 'Свернуть agents-kit-web' })).toBeVisible()
  await nextFrames(page)
  expect(await animations.names()).not.toContain('loaded-in')
})

test('быстрая загрузка не мигает: ни полос, ни проявления — таблица встаёт сразу', async ({ page }) => {
  const animations = await recordAnimations(page)
  // Каждая правка страницы отмечает, была ли видна хоть одна полоса: мигание длится доли секунды.
  // Наблюдатель правок, а не кадры: под остановленными часами кадры страницы стоят. Правку он видит,
  // потому что полосы показывает снятие класса заготовки (sk-wait), а не задержка в CSS.
  await page.addInitScript(() => {
    Object.assign(window, { barsSeen: false })
    new MutationObserver(() => {
      const bars = document.querySelectorAll('.sk')
      if ([...bars].some((bar) => getComputedStyle(bar).visibility === 'visible')) Object.assign(window, { barsSeen: true })
    }).observe(document, { subtree: true, childList: true, attributes: true })
  })
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row] }))
  // Часы страницы стоят, пока строки идут: «быстро» — раньше срока заготовки по часам страницы, а не
  // по настоящим, иначе нагруженная машина перерастала срок доставкой ответа и видела полосы (B-266).
  await page.clock.install()
  await page.clock.pauseAt(Date.now() + 1000)
  await page.goto('/')

  await expect(page.getByRole('button', { name: 'Свернуть agents-kit-web' })).toBeVisible()
  // Срок заготовки выходит уже над прочитанной таблицей: ни полос, ни проявления. Проявление, взведённое
  // запоздавшим сроком, начнётся только в настоящем кадре — часы идут дальше, и кадры дожидаются.
  await page.clock.runFor(1000)
  await page.clock.resume()
  await nextFrames(page)
  expect(await page.evaluate(() => (window as unknown as { barsSeen: boolean }).barsSeen)).toBe(false)
  expect(await animations.names()).not.toContain('loaded-in')
})

test('после выбора папки в «Настройках» список баз не проявляется заново', async ({ page }) => {
  const animations = await recordAnimations(page)
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  const release = await hold(page, '**/api/bases', [{ path: 'D:\\Projects\\app-knowledge', copies: 2 }])
  await page.route('**/api/kit', (route) => route.fulfill({ json: { path: null, found: false } }))
  await page.route('**/api/folders**', (route) =>
    route.fulfill({ json: { path: null, parent: null, folders: [{ name: 'D:\\', path: 'D:\\', isBase: false, copies: null }] } }),
  )
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Настройки' }).click()

  const bases = page.getByRole('region', { name: /^Базы знаний/ })
  await expect(bases.locator('.sk').first()).toBeVisible()
  release()
  await expect(bases.getByRole('list', { name: 'Базы знаний' })).toBeVisible()
  await expect.poll(animations.names).toContain('loaded-in')
  await expect(page.locator('.loaded')).toHaveCount(0)

  await bases.getByRole('button', { name: 'Обзор…' }).click()
  await expect(bases.getByRole('list', { name: 'Папки' })).toBeVisible()
  await settled(page)
  await animations.clear()
  await bases.getByRole('button', { name: 'К списку баз' }).click()
  await expect(bases.getByRole('list', { name: 'Базы знаний' })).toBeVisible()
  await nextFrames(page)
  expect(await animations.names()).not.toContain('loaded-in')
})

test('при «уменьшить движение» полосы стоят без мерцания и содержимое встаёт без проявления', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  const animations = await recordAnimations(page)
  const release = await holdWorkspaces(page)
  await page.goto('/')

  await expect(skeleton(page)).toBeVisible()
  await expect(page.locator('.sk').first()).toBeVisible()
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
    await expect(page.locator('.sk').first()).toBeVisible()
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

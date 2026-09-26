import { expect, test, type Page } from '@playwright/test'

const row = (status = 'waiting', path = 'D:\\Projects\\app', branch = 'feat/reply') => ({
  project: 'app-knowledge',
  base: 'D:\\Projects\\app-knowledge',
  path,
  branch,
  task: 'Окно ответа',
  flowStep: 'Критерий',
  progress: 0,
  status,
  error: null,
})

type Question = { title: string; context: string | null; variants: { choice: string; effect: string | null; recommended: boolean }[]; answer: null }

const plain = (title: string): Question => ({ title, context: null, variants: [], answer: null })

// /api подменяется: dev-API читает настоящую базу знаний, и ответ из прогона попал бы в живую память.
async function stubQuestions(page: Page, questions: Question[], extra: Record<string, unknown> = {}) {
  await page.route('**/api/questions?**', (route) =>
    route.fulfill({
      json: {
        project: 'app-knowledge',
        copy: 'D:\\Projects\\app',
        task: 'Окно ответа',
        criteria: [],
        outOfScope: null,
        artifacts: [],
        vsCodeSession: false,
        questions,
        ...extra,
      },
    }),
  )
}

async function openReply(page: Page) {
  await page.getByRole('row', { name: /Окно ответа/ }).getByRole('button', { name: 'Ответить' }).click()
  return page.getByRole('dialog', { name: 'Ответ оператора' })
}

test('оператор отвечает лентой, ответы уходят по «Отправить» после секунд с «Отменить», и строка перестаёт ждать', async ({ page }) => {
  let answered = false
  let posted: unknown = null

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row(answered ? 'in-work' : 'waiting')] }))
  await stubQuestions(
    page,
    [
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
    { criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }], outOfScope: 'Health баз.' },
  )
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    answered = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const tableRow = page.getByRole('row', { name: /Окно ответа/ })
  await expect(tableRow.getByText('Ждёт оператора')).toBeVisible()
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await expect(dialog.getByRole('button', { name: /^Как быть с переносами\?/ })).toBeVisible()

  // строка ввода получает фокус сама, ответ виден в ленте сразу
  const answer = dialog.getByLabel('Ответ')
  await expect(answer).toBeFocused()
  await answer.fill('принимаю')
  await expect(dialog.locator('.op-bubble')).toHaveText(/принимаю/)
  await answer.press('Enter')

  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
  await dialog.getByRole('button', { name: /Заменять пробелами/ }).click()
  await expect(answer).toHaveValue('Заменять пробелами')
  await dialog.getByRole('button', { name: 'Отправить' }).click()

  // ленты не видно: знак отправки по центру, «Отменить» внизу
  await expect(dialog.getByRole('status')).toHaveText(/Ответы отправлены агенту/)
  await expect(dialog.locator('.reply-feed')).toHaveCount(0)
  const check = (await dialog.locator('.done-mark svg').boundingBox())!
  expect([Math.round(check.width), Math.round(check.height)]).toEqual([34, 34])
  await expect(dialog.getByRole('button', { name: 'Отменить' })).toBeVisible()
  expect(posted).toBeNull()

  // записанные ответы уводят окно угасанием: оно длится доли секунды, поэтому ловим его каждый кадр —
  // на это время оверлей гаснет и не ловит щелчки
  const faded = await page.waitForFunction(
    () => {
      const overlay = document.querySelector('.modal-overlay.is-leaving')
      if (!overlay) return null
      const style = getComputedStyle(overlay)
      return { pointerEvents: style.pointerEvents, duration: style.transitionDuration }
    },
    null,
    { polling: 'raf', timeout: 10000 },
  )
  expect(await faded.jsonValue()).toEqual({ pointerEvents: 'none', duration: '0.22s' })
  await expect(dialog).toBeHidden({ timeout: 10000 })
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

test('«Отменить» ничего не записывает, а лента возвращается с ответами', async ({ page }) => {
  let posted = false
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')])
  await page.route('**/api/answers', async (route) => {
    posted = true
    await route.fulfill({ status: 204 })
  })

  await page.clock.install()
  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  // Часы страницы стоят, пока тест жмёт «Отменить»: на занятой машине GitHub полторы секунды
  // выходили раньше, чем кнопка давалась нажать, и окно отправляло ответ само (B-248).
  await page.clock.pauseAt(Date.now() + 1000)
  await answer.press('Enter')
  await dialog.getByRole('button', { name: 'Отменить' }).click()
  await page.clock.resume()

  await expect(page.locator('.modal-overlay.is-leaving')).toHaveCount(0)
  await expect(dialog.locator('.reply-feed')).toBeVisible()
  await expect(answer).toHaveValue('принимаю')
  // «Отменить» держится полторы секунды — после них запись всё равно не ушла
  await page.waitForTimeout(2000)
  expect(posted).toBe(false)
  await expect(dialog).toBeVisible()
})

test('вопросы агента — пузыри слева, ответы оператора — справа, в обеих темах', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  await dialog.getByRole('button', { name: 'Следующий вопрос' }).click()

  for (const scheme of ['dark', 'light'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await expect(async () => {
      const feed = (await dialog.locator('.reply-feed').boundingBox())!
      const question = (await dialog.locator('.agent-q').boundingBox())!
      const compact = (await dialog.locator('.q-compact').boundingBox())!
      const bubble = (await dialog.locator('.op-bubble').boundingBox())!
      // вопрос и свёрнутый вопрос прижаты влево и не во всю ширину, ответ — вправо
      expect(question.x - feed.x).toBeLessThan(40)
      expect(compact.x - feed.x).toBeLessThan(40)
      expect(question.width).toBeLessThan(feed.width - 48)
      expect(compact.width).toBeLessThan(feed.width - 48)
      expect(feed.x + feed.width - (bubble.x + bubble.width)).toBeLessThan(40)
    }).toPass()
    // пузырь вопроса залит своим цветом, отличным от фона окна; ответ — нейтральный, не янтарный
    const fill = await dialog.locator('.agent-q').evaluate((el) => getComputedStyle(el).backgroundColor)
    const windowFill = await dialog.evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(fill).not.toBe(windowFill)
    const answerFill = await dialog.locator('.op-bubble').evaluate((el) => getComputedStyle(el).backgroundColor)
    const waiting = await page.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.background = 'var(--accent-waiting-bg)'
      document.body.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    })
    expect(answerFill).not.toBe(waiting)
    expect(answerFill).not.toBe(fill)
  }
})

test('свёрнутые вопросы одинаковы, у вариантов кружок выбора, значки шапки и строки ввода своего размера', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(
    page,
    [
      plain('Подтвердить критерий?'),
      {
        title: 'Как быть с переносами?',
        context: null,
        variants: [
          { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
          { choice: 'Не отправлять', effect: null, recommended: false },
        ],
        answer: null,
      },
    ],
    { outOfScope: 'Health баз.', artifacts: [{ label: 'макет', address: 'https://claude.ai/artifact/AbC123' }] },
  )

  await page.goto('/')
  const dialog = await openReply(page)
  await dialog.getByRole('button', { name: 'Следующий вопрос' }).click()
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()

  // вопрос, мимо которого прошли без ответа, — обычная свёрнутая строка без пометок и пунктира
  const compact = dialog.locator('.q-compact')
  await expect(compact).toHaveText('Подтвердить критерий?')
  await expect(compact).toHaveCSS('border-top-style', 'solid')

  // кружок выбора: пустой у невыбранного, с точкой у выбранного
  const option = dialog.getByRole('button', { name: /Заменять пробелами/ })
  const dot = option.locator('.radio-dot')
  const dotBox = (await dot.boundingBox())!
  expect(Math.round(dotBox.width)).toBe(16)
  expect(await dot.evaluate((el) => getComputedStyle(el, '::after').content)).toBe('none')
  await option.click()
  expect(await dot.evaluate((el) => getComputedStyle(el, '::after').content)).not.toBe('none')

  // общее `.modal-overlay svg` (18px) перебивает правило компонента той же силы — размер меряется
  const size = async (selector: string) => {
    const box = (await dialog.locator(selector).first().boundingBox())!
    return [Math.round(box.width), Math.round(box.height)]
  }
  await expect(async () => {
    expect(await size('.strip-actions .btn-code svg')).toEqual([16, 16])
    expect(await size('.meta-item svg')).toEqual([13, 13])
    expect(await size('.composer-send svg')).toEqual([16, 16])
  }).toPass()

  await dialog.getByLabel('Ответ').fill('')
  await dialog.getByRole('button', { name: 'Отправить' }).click()
  await expect(dialog.locator('.field-error')).toBeVisible()
  expect(await size('.field-error svg')).toEqual([14, 14])
})

test('снимок, приложенный к ответу, переживает закрытие окна и перезагрузку страницы', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')])

  await page.goto('/')
  let dialog = await openReply(page)
  await dialog.getByLabel('Приложить').setInputFiles({ name: 'снимок.png', mimeType: 'image/png', buffer: Buffer.from('89504e47', 'hex') })
  await expect(dialog.getByRole('list', { name: 'Приложенные файлы' }).getByText('снимок.png')).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await page.reload()
  dialog = await openReply(page)

  const tiles = dialog.getByRole('list', { name: 'Приложенные файлы' })
  await expect(tiles.getByText('снимок.png')).toBeVisible()
  await expect(tiles.getByText('4 Б')).toBeVisible()
})

test('артефакт из artifacts/ базы — путь файла: щелчок просит панель открыть его тем же адресом', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')], {
    artifacts: [{ label: 'снимок окна', address: 'artifacts/B-7-снимок.png' }],
  })
  let opened: unknown = null
  await page.route('**/api/artifact/open', async (route) => {
    opened = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  await dialog.getByRole('tab', { name: 'Артефакты' }).click()
  await dialog.getByRole('button', { name: 'artifacts/B-7-снимок.png' }).click()

  await expect.poll(() => opened).toEqual({
    base: row().base,
    copy: row().path,
    index: 0,
    address: 'artifacts/B-7-снимок.png',
  })
  await expect(dialog.getByRole('alert')).toHaveCount(0)
})

test('контекст и артефакты — вкладками в шапке: растянуты на всё окно, без строки ответа, окон поверх нет', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')], {
    criteria: [{ title: '1. Окно есть', text: 'Оператор отвечает из панели.' }],
    outOfScope: 'Health баз.',
    artifacts: [
      { label: 'макет окна ответа', address: 'https://claude.ai/artifact/AbC123' },
      { label: 'спецификация', address: 'D:\\Projects\\app\\spec.md' },
    ],
  })
  let openedArtifact: unknown = null
  await page.route('**/api/artifact/open', async (route) => {
    openedArtifact = route.request().postDataJSON()
    await route.fulfill({ status: 404, json: { problem: 'missing' } })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await dialog.getByLabel('Ответ').fill('принимаю')

  // вкладки стоят в шапке справа от переходов в сессию, у артефактов нет числа
  const tabs = dialog.getByRole('tab')
  await expect(tabs).toHaveText(['Переписка', 'Контекст', 'Артефакты'])
  const actions = (await dialog.locator('.strip-actions').boundingBox())!
  const tablist = (await dialog.getByRole('tablist').boundingBox())!
  const vsCode = (await dialog.locator('.btn-code').last().boundingBox())!
  expect(tablist.x).toBeGreaterThan(vsCode.x + vsCode.width)
  expect(Math.abs(tablist.x + tablist.width - (actions.x + actions.width))).toBeLessThan(2)

  // содержимое вкладки — от края до края окна, без строки ответа и без окна поверх
  const edgeToEdge = async (selector = '.tab-body li') => {
    const frame = (await dialog.boundingBox())!
    const line = (await dialog.locator(selector).first().boundingBox())!
    expect(Math.abs(line.x - frame.x)).toBeLessThan(2)
    expect(Math.abs(line.x + line.width - (frame.x + frame.width))).toBeLessThan(2)
  }
  await dialog.getByRole('tab', { name: 'Контекст' }).click()
  await expect(dialog.getByText('Оператор отвечает из панели.')).toBeVisible()
  await expect(dialog.getByText('Health баз.')).toBeVisible()
  // подпись над критериями — того же вида, что «Не входит»
  const criteriaLabel = dialog.getByText('Критерии закрытия')
  await expect(criteriaLabel).toBeVisible()
  for (const prop of ['font-size', 'color', 'text-transform'])
    await expect(criteriaLabel).toHaveCSS(prop, await dialog.getByText('Не входит').evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop))
  await expect(dialog.getByLabel('Ответ')).toHaveCount(0)
  await expect(page.getByRole('dialog')).toHaveCount(1)
  await edgeToEdge()

  await dialog.getByRole('tab', { name: 'Артефакты' }).click()
  const link = dialog.getByRole('link', { name: 'https://claude.ai/artifact/AbC123' })
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(dialog.getByRole('link', { name: 'D:\\Projects\\app\\spec.md' })).toHaveCount(0)
  await edgeToEdge()
  // ссылка янтарная, как остальные ссылки панели, а путь — серый
  const tokenColor = (token: string) =>
    page.evaluate((name) => {
      const probe = document.createElement('span')
      probe.style.color = `var(${name})`
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }, token)
  await expect(link).toHaveCSS('color', await tokenColor('--accent-waiting-text'))
  const file = dialog.getByRole('button', { name: 'D:\\Projects\\app\\spec.md' })
  await expect(file).toHaveCSS('color', await tokenColor('--text-secondary'))
  await file.click()
  await expect.poll(() => openedArtifact).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    index: 1,
    address: 'D:\\Projects\\app\\spec.md',
  })
  // файла нет — строка под артефактами, и переход по вкладкам её не снимает
  const alert = dialog.getByRole('alert')
  await expect(alert).toHaveText('Файла нет на диске: D:\\Projects\\app\\spec.md')
  // строка ошибки — под списком и на всю ширину окна
  expect((await alert.boundingBox())!.y).toBeGreaterThan((await dialog.locator('.artifacts').boundingBox())!.y)
  await edgeToEdge('.tab-body .open-error')
  await dialog.getByRole('tab', { name: 'Переписка' }).click()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('принимаю')
  await expect(dialog.getByLabel('Ответ')).toBeFocused()
  await dialog.getByRole('tab', { name: 'Артефакты' }).click()
  await expect(alert).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
})

test('пустые «Контекст» и «Артефакты» — серая надпись по центру вкладки', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?')])

  await page.goto('/')
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()

  for (const [tab, text] of [['Контекст', 'Контекста нет'], ['Артефакты', 'Артефактов нет']]) {
    await dialog.getByRole('tab', { name: tab }).click()
    const label = dialog.getByText(text)
    await expect(label).toHaveCSS('color', await label.evaluate(() => {
      const probe = document.createElement('span')
      probe.style.color = 'var(--text-secondary)'
      document.body.append(probe)
      const color = getComputedStyle(probe).color
      probe.remove()
      return color
    }))
    const panel = (await dialog.getByRole('tabpanel').boundingBox())!
    const box = (await label.boundingBox())!
    expect(Math.abs(box.x + box.width / 2 - (panel.x + panel.width / 2))).toBeLessThan(2)
    expect(Math.abs(box.y + box.height / 2 - (panel.y + panel.height / 2))).toBeLessThan(2)
  }
})

// Раньше шапка контекста была одной строкой, и длинный путь копии рвался на много строк рядом с кнопками перехода.
test('длинные задача и копия в шапке не наезжают друг на друга, на кнопки, вкладки и ленту; ветки в шапке нет', async ({ page }) => {
  const long = 'очень-длинное-имя-'.repeat(6)
  await page.route('**/api/workspaces', (route) =>
    route.fulfill({ json: [row('waiting', `D:\\Projects\\${long}copy`, `feat/${long}branch`)] }),
  )
  await stubQuestions(page, [plain('Подтвердить критерий?')], {
    copy: `D:\\Projects\\${long}copy`,
    branch: `feat/${long}branch`,
    task: `B-199 Окно ответа ${'с очень длинным названием задачи '.repeat(4)}`,
    outOfScope: 'Health баз.',
    artifacts: [{ label: 'макет', address: 'https://claude.ai/artifact/AbC123' }],
    backgroundSession: true,
  })

  await page.goto('/')
  const dialog = await openReply(page)
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await expect(dialog.locator('.strip-meta')).toContainText(`${long}copy`)
  await expect(dialog.locator('.strip-meta')).not.toContainText('D:\\Projects')
  await expect(dialog.locator('.strip-meta')).not.toContainText('branch')

  // шрифт панели грузится после первой отрисовки — замер повторяется, пока не сойдётся
  await expect(async () => {
    const strip = (await dialog.locator('.task-strip').boundingBox())!
    const task = (await dialog.locator('.strip-task').boundingBox())!
    const meta = (await dialog.locator('.strip-meta').boundingBox())!
    const actions = (await dialog.locator('.strip-actions').boundingBox())!
    const feed = (await dialog.locator('.reply-feed').boundingBox())!
    expect(task.y + task.height).toBeLessThanOrEqual(meta.y + 1)
    expect(meta.y + meta.height).toBeLessThanOrEqual(actions.y + 1)
    expect(actions.y + actions.height).toBeLessThanOrEqual(strip.y + strip.height + 1)
    expect(strip.y + strip.height).toBeLessThanOrEqual(feed.y + 1)
    for (const part of [task, meta, actions]) expect(part.x + part.width).toBeLessThanOrEqual(strip.x + strip.width + 1)
  }).toPass()
  const fits = await dialog.locator('.reply-feed').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)
})

test('данные ответы возвращаются после закрытия окна и перезагрузки страницы, а открыто на вопросе без ответа', async ({ page }) => {
  let posted = false
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', async (route) => {
    posted = true
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  let dialog = await openReply(page)
  await dialog.getByLabel('Ответ').fill('принимаю, но без e2e')
  await dialog.getByRole('button', { name: 'Следующий вопрос' }).click()
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  for (const reload of [false, true]) {
    if (reload) await page.reload()
    dialog = await openReply(page)
    await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()
    await expect(dialog.locator('.op-bubble')).toHaveText(/принимаю, но без e2e/)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  }
  expect(posted).toBe(false)
})

// Внешняя страница тоже подменена, чтобы прогон не ходил в сеть.
test('ссылка из вопроса открывается в новой вкладке, окно ответа и набранное остаются', async ({ page, context }) => {
  const longUrl = `https://example.com/${'verylongsegment'.repeat(20)}end`
  await context.route('https://example.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<title>Внешняя страница</title>' }),
  )
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [
    {
      title: 'Куда переносить выгрузку?',
      context: `Объявление в заявке https://example.com/tickets/OPS-1\n\nПример адреса: ${longUrl}`,
      variants: [],
      answer: null,
    },
  ])

  await page.goto('/')
  const dialog = await openReply(page)
  await dialog.getByLabel('Ответ').fill('в новую папку')

  const link = dialog.getByRole('link', { name: 'https://example.com/tickets/OPS-1' })
  await expect(link).toBeVisible()
  await expect(link.locator('svg')).toHaveCount(0)

  // длинный адрес переносится внутри пузыря вопроса и не раздвигает ленту
  const box = (await dialog.locator('.q-context').boundingBox())!
  const bubble = (await dialog.locator('.agent-q').boundingBox())!
  expect(box.x + box.width).toBeLessThanOrEqual(bubble.x + bubble.width + 1)
  const fits = await dialog.locator('.reply-feed').evaluate((el) => el.scrollWidth <= el.clientWidth)
  expect(fits).toBe(true)

  const [tab] = await Promise.all([context.waitForEvent('page'), link.click()])
  await tab.waitForLoadState()
  expect(tab.url()).toBe('https://example.com/tickets/OPS-1')

  expect(page.url()).not.toContain('example.com')
  await expect(dialog).toBeVisible()
  await expect(dialog.getByLabel('Ответ')).toHaveValue('в новую папку')
})

test('лента проходится одной клавиатурой: Enter ведёт дальше, стрелка возвращает, ответ правится', async ({ page }) => {
  let posted: unknown = null
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', async (route) => {
    posted = route.request().postDataJSON()
    await route.fulfill({ status: 204 })
  })

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')

  await answer.fill('принимаю')
  await answer.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeVisible()

  await dialog.getByRole('button', { name: 'Предыдущий вопрос' }).click()
  await expect(answer).toHaveValue('принимаю')
  await answer.fill('принимаю с оговоркой')
  await answer.press('Enter')

  await answer.fill('заменять')
  await answer.press('Enter')

  await expect(dialog).toBeHidden({ timeout: 10000 })
  expect(posted).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю с оговоркой' },
      { question: 'Как быть с переносами?', answer: 'заменять' },
    ],
  })
})

test('отказ записи — красной строкой под полем ответа, окно остаётся на вопросе отказа', async ({ page }) => {
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [row()] }))
  await stubQuestions(page, [plain('Подтвердить критерий?'), plain('Как быть с переносами?')])
  await page.route('**/api/answers', (route) =>
    route.fulfill({ status: 409, json: { question: 'Подтвердить критерий?', problem: 'already-answered' } }),
  )

  await page.goto('/')
  const dialog = await openReply(page)
  const answer = dialog.getByLabel('Ответ')
  await answer.fill('принимаю')
  await answer.press('Enter')
  await answer.fill('заменять')
  await answer.press('Enter')

  // лента вернулась с ответами, знака отправки больше нет
  await expect(dialog.locator('.reply-feed')).toBeVisible()
  const alert = dialog.getByRole('alert')
  await expect(alert).toHaveText(/уже ответили из другого места/, { timeout: 10000 })
  await expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeVisible()
  await expect(answer).toHaveValue('принимаю')
  // строка стоит под полем ответа
  const field = (await answer.boundingBox())!
  const line = (await alert.boundingBox())!
  expect(line.y).toBeGreaterThanOrEqual(field.y + field.height - 1)
})

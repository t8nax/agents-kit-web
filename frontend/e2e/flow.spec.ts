import { expect, test, type Page } from '@playwright/test'

type Step = { title: string; executor: string; output: string; skip: string | null; description: string | null }

const steps: Step[] = [
  {
    title: 'Критерий',
    executor: 'оркестратор',
    output: 'критерий закрытия в памяти',
    skip: null,
    description: '1.1. Написать критерий.',
  },
  {
    title: 'Ревью',
    executor: 'reviewer',
    output: 'вердикт по sha',
    skip: 'правка только в текстах',
    description: '2.1. Собрать дифф.',
  },
  { title: 'Приёмка', executor: 'оператор', output: 'ответ оператора «принято»', skip: null, description: null },
]

// /api подменяется: прогон работает с живыми базами оператора, и запись флоу или пресета попала бы в них.
async function mockApi(page: Page, activeTasks = 0) {
  const calls: { flow: unknown[]; presets: unknown[]; open: unknown[] } = { flow: [], presets: [], open: [] }
  let presets: (Step & { id: string })[] = []

  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/flow', (route) => {
    if (route.request().method() === 'POST') {
      calls.flow.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2' } })
    }
    return route.fulfill({
      json: [
        { base: 'D:\\Projects\\app-knowledge', project: 'Agents Kit Web', steps, activeTasks, version: 'v1', error: null },
        { base: 'D:\\Projects\\nota-knowledge', project: 'Nota', steps: [], activeTasks: 0, version: null, error: 'В базе нет flow.md' },
      ],
    })
  })
  await page.route('**/api/flow/open', (route) => {
    calls.open.push(route.request().postDataJSON())
    return route.fulfill({ status: 204 })
  })
  await page.route('**/api/presets', (route) => {
    if (route.request().method() === 'POST') {
      const preset = { ...(route.request().postDataJSON() as Step), id: `p${presets.length + 1}` }
      calls.presets.push(preset)
      presets = [...presets, preset]
      return route.fulfill({ json: preset })
    }
    return route.fulfill({ json: presets })
  })
  return calls
}

async function openFlow(page: Page) {
  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  await expect(page.getByRole('heading', { name: 'Флоу', level: 2 })).toBeVisible()
  return page.getByRole('region', { name: 'Agents Kit Web' })
}

test('флоу открывается из сайдбара: шаги без описаний, кнопка VS Code того же вида, что в панели', async ({ page }) => {
  const calls = await mockApi(page, 2)
  const region = await openFlow(page)

  await expect(region.getByRole('article')).toHaveCount(3)
  const review = region.getByRole('article', { name: 'Шаг 2: Ревью' })
  await expect(review.getByText('субагент reviewer')).toBeVisible()
  await expect(review.getByText('правка только в текстах')).toBeVisible()
  // Название проекта одно — на чипе, над шагами его не повторяют
  await expect(page.getByRole('main').getByText('Agents Kit Web', { exact: true })).toHaveCount(1)
  await expect(page.getByText('Собрать дифф')).toHaveCount(0)

  const vsCode = page.getByRole('button', { name: 'Открыть в VS Code' })
  // Синий VS Code, как у кнопки перехода в окне ответа
  await expect(vsCode).toHaveCSS('color', 'rgb(0, 152, 255)')
  await vsCode.click()
  await expect.poll(() => calls.open).toEqual([{ base: 'D:\\Projects\\app-knowledge' }])

  await page.getByRole('button', { name: 'Nota', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Nota' }).getByText(/В базе нет файла флоу/)).toBeVisible()
})

test('шаг перетаскивается мышью, при задачах в работе сохранение спрашивает подтверждение', async ({ page }) => {
  const calls = await mockApi(page, 2)
  const region = await openFlow(page)
  await page.getByRole('button', { name: 'Править' }).click()

  const forms = region.getByRole('article')
  await forms.nth(2).locator('.flow-grip').dragTo(forms.nth(0))
  await expect(region.getByRole('textbox', { name: 'Название шага 1' })).toHaveValue('Приёмка')

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Сохранить флоу Agents Kit Web?' })
  await expect(dialog.getByText(/На проекте 2 задачи в работе/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.flow).toEqual([
    { base: 'D:\\Projects\\app-knowledge', version: 'v1', steps: [steps[2], steps[0], steps[1]] },
  ])
})

test('шаг сохраняется как пресет и добавляется из списка пресетов', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)
  await page.getByRole('button', { name: 'Править' }).click()

  await page.getByRole('button', { name: 'Добавить шаг' }).click()
  await expect(page.getByRole('group', { name: 'Пресеты шагов' }).getByText(/Пресетов пока нет/)).toBeVisible()
  await page.keyboard.press('Escape')

  await region.getByRole('button', { name: 'Сохранить шаг 2 как пресет' }).click()
  await expect(region.getByRole('button', { name: 'Сохранить шаг 2 как пресет' })).toHaveAttribute('aria-pressed', 'true')

  await page.getByRole('button', { name: 'Добавить шаг' }).click()
  await page.getByRole('group', { name: 'Пресеты шагов' }).getByRole('button', { name: /^Ревью/ }).click()
  await expect(region.getByRole('textbox', { name: 'Название шага 4' })).toHaveValue('Ревью')
  await expect(region.getByRole('textbox', { name: 'Имя субагента шага 4' })).toHaveValue('reviewer')

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.presets).toEqual([{ ...steps[1], id: 'p1' }])
  expect((calls.flow[0] as { steps: Step[] }).steps[3]).toEqual(steps[1])
})

test('описание шага правится текстом в окне и уходит в запись', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)
  await page.getByRole('button', { name: 'Править' }).click()

  // Шаг без описания — та же надпись, кнопка приглушена пунктиром
  const empty = region.getByRole('button', { name: 'Описание шага 3' })
  await expect(empty).toHaveText('Описание')
  await expect(empty).toHaveCSS('border-top-style', 'dashed')
  await expect(region.getByRole('button', { name: 'Описание шага 1' })).toHaveCSS('border-top-style', 'solid')

  await region.getByRole('button', { name: 'Описание шага 1' }).click()
  const dialog = page.getByRole('dialog', { name: 'Описание шага «Критерий»' })
  const text = dialog.getByRole('textbox', { name: 'Описание шага' })
  await expect(text).toBeFocused()
  await expect(text).toHaveValue('1.1. Написать критерий.')
  await expect(dialog.locator('p')).toHaveCount(0)
  // Описание свободным текстом: абзац, пустая строка, списки «-» и «1.»
  await text.press('ControlOrMeta+Home')
  await text.pressSequentially('Критерий пишется до кода.')
  await text.press('Enter')
  await text.press('Enter')
  await text.pressSequentially('- проверяемый;')
  await text.press('Enter')
  await text.pressSequentially('1. с макетом.')
  await text.press('Enter')
  await text.press('Enter')
  await dialog.getByRole('button', { name: 'Готово' }).click()
  await expect(region.getByRole('button', { name: 'Описание шага 1' })).toHaveText('Описание')

  // Шаг переставлен: в окне меняется только номер пункта «N.M.»
  await region.getByRole('button', { name: 'Шаг 1 ниже' }).click()
  await region.getByRole('button', { name: 'Описание шага 2' }).click()
  await expect(page.getByRole('textbox', { name: 'Описание шага' })).toHaveValue(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. с макетом.\n\n2.1. Написать критерий.',
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click()

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect((calls.flow[0] as { steps: Step[] }).steps[1].description).toBe(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. с макетом.\n\n1.1. Написать критерий.',
  )
})

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
        {
          base: 'D:\\Projects\\app-knowledge',
          project: 'Agents Kit Web',
          steps,
          activeTasks,
          version: 'v1',
          error: null,
          icons: { Критерий: 'target' },
        },
        {
          base: 'D:\\Projects\\nota-knowledge',
          project: 'Nota',
          steps: [],
          activeTasks: 0,
          version: null,
          error: 'В базе нет flow.md',
          icons: {},
        },
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
  const region = page.getByRole('region', { name: 'Agents Kit Web' })
  await expect(region.getByRole('button', { name: 'Шаг 1: Критерий' })).toBeVisible()
  return region
}

test('флоу открывается схемой блоков: без номеров, выхода и описаний, кнопка VS Code того же вида, что в панели', async ({
  page,
}) => {
  const calls = await mockApi(page, 2)
  const region = await openFlow(page)

  const review = region.getByRole('button', { name: 'Шаг 2: Ревью' })
  await expect(review).toHaveText(/^Ревьюсубагент reviewer$/)
  // Флажок стоит у шага с условием пропуска; выход и описание — только в сайдбаре
  await expect(review.locator('.flow-node-skip')).toBeVisible()
  await expect(page.getByText('вердикт по sha')).toHaveCount(0)
  await expect(page.getByText('Собрать дифф')).toHaveCount(0)
  // Название проекта одно — на чипе, над схемой его не повторяют
  await expect(page.getByRole('main').getByText('Agents Kit Web', { exact: true })).toHaveCount(1)

  // Стрелки идут по центру блоков: кнопки перестановки стоят за краем и центр не сдвигают
  const block = await region.getByRole('button', { name: 'Шаг 1: Критерий' }).boundingBox()
  const arrow = await region.locator('.flow-arrow').first().boundingBox()
  const add = await page.getByRole('button', { name: 'Добавить шаг' }).boundingBox()
  expect(Math.abs(block!.x + block!.width / 2 - (arrow!.x + arrow!.width / 2))).toBeLessThan(1)
  expect(Math.abs(block!.x + block!.width / 2 - (add!.x + add!.width / 2))).toBeLessThan(1)

  const vsCode = page.getByRole('button', { name: 'Открыть в VS Code' })
  // Синий VS Code, как у кнопки перехода в окне ответа
  await expect(vsCode).toHaveCSS('color', 'rgb(0, 152, 255)')
  await vsCode.click()
  await expect.poll(() => calls.open).toEqual([{ base: 'D:\\Projects\\app-knowledge' }])

  await page.getByRole('button', { name: 'Nota', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Nota' }).getByText(/В базе нет файла флоу/)).toBeVisible()
})

test('блок открывает сайдбар, шаг правится в нём, а значок берётся из списка значков', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  await region.getByRole('button', { name: 'Шаг 3: Приёмка' }).click()
  const drawer = page.getByRole('complementary')
  await expect(drawer.getByRole('textbox', { name: 'Выход шага' })).toHaveValue('ответ оператора «принято»')
  await expect(page.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled()

  await drawer.getByRole('textbox', { name: 'Пропуск шага' }).fill('правка не меняет вида панели')
  await expect(region.getByRole('button', { name: 'Шаг 3: Приёмка' }).locator('.flow-node-skip')).toBeVisible()
  await expect(page.getByText('есть несохранённые правки')).toBeVisible()

  await drawer.getByRole('button', { name: 'Значок шага' }).click()
  const icons = page.getByRole('group', { name: 'Значки шага' })
  // В списке сами значки, а не их названия
  await expect(icons.getByRole('button')).toHaveCount(6)
  await expect(icons.getByRole('button', { name: 'Значок «проверка»' })).toHaveText('')
  await icons.getByRole('button', { name: 'Значок «проверка»' }).click()
  await expect(icons).toHaveCount(0)

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.flow).toEqual([
    {
      base: 'D:\\Projects\\app-knowledge',
      version: 'v1',
      steps: [steps[0], steps[1], { ...steps[2], skip: 'правка не меняет вида панели' }],
      icons: { Критерий: 'target', Приёмка: 'check' },
    },
  ])
})

test('блок перетаскивается мышью, при задачах в работе сохранение спрашивает подтверждение', async ({ page }) => {
  const calls = await mockApi(page, 2)
  const region = await openFlow(page)

  await region.getByRole('button', { name: 'Шаг 3: Приёмка' }).dragTo(region.getByRole('button', { name: 'Шаг 1: Критерий' }))
  await expect(region.getByRole('button', { name: 'Шаг 1: Приёмка' })).toBeVisible()

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Сохранить флоу Agents Kit Web?' })
  await expect(dialog.getByText(/На проекте 2 задачи в работе/)).toBeVisible()
  await dialog.getByRole('button', { name: 'Сохранить' }).click()

  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  const sent = calls.flow[0] as { steps: Step[] }
  expect(sent.steps.map((step) => step.title)).toEqual(['Приёмка', 'Критерий', 'Ревью'])
  // Номера пунктов описания идут за шагом
  expect(sent.steps[1].description).toBe('2.1. Написать критерий.')
})

test('шаг сохраняется как пресет из сайдбара и добавляется блоком «Добавить шаг»', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  await page.getByRole('button', { name: 'Добавить шаг' }).click()
  const adding = page.getByRole('dialog', { name: 'Добавить шаг' })
  await expect(adding.getByText(/Пресетов пока нет/)).toBeVisible()
  await adding.getByRole('button', { name: 'Отмена' }).click()
  await expect(adding).toHaveCount(0)

  await region.getByRole('button', { name: 'Шаг 2: Ревью' }).click()
  await page.getByRole('complementary').getByRole('button', { name: 'В пресеты' }).click()
  await expect(page.getByRole('button', { name: 'Шаг в пресетах' })).toBeDisabled()

  await page.getByRole('button', { name: 'Добавить шаг' }).click()
  await page.getByRole('dialog', { name: 'Добавить шаг' }).getByRole('button', { name: /^Ревью/ }).click()
  const drawer = page.getByRole('complementary')
  await expect(drawer.getByRole('textbox', { name: 'Название шага' })).toHaveValue('Ревью')
  await expect(drawer.getByRole('textbox', { name: 'Имя субагента' })).toHaveValue('reviewer')

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect(calls.presets).toEqual([{ ...steps[1], id: 'p1' }])
  expect((calls.flow[0] as { steps: Step[] }).steps[3]).toEqual({ ...steps[1], description: '4.1. Собрать дифф.' })
})

test('описание шага правится в окне по кнопке из сайдбара', async ({ page }) => {
  const calls = await mockApi(page)
  const region = await openFlow(page)

  await region.getByRole('button', { name: 'Шаг 1: Критерий' }).click()
  await page.getByRole('complementary').getByRole('button', { name: /Редактировать описание/ }).click()
  const dialog = page.getByRole('dialog', { name: 'Описание шага «Критерий»' })
  const text = dialog.getByRole('textbox', { name: 'Описание шага' })
  await expect(text).toBeFocused()
  await expect(text).toHaveValue('1.1. Написать критерий.')

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
  await expect(dialog).toHaveCount(0)

  // Шаг переставлен: меняется только номер пункта «N.M.»
  await region.getByRole('button', { name: 'Шаг 1 ниже' }).click()
  await region.getByRole('button', { name: 'Шаг 2: Критерий' }).click()
  await page.getByRole('complementary').getByRole('button', { name: /Редактировать описание/ }).click()
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Описание шага' })).toHaveValue(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. с макетом.\n\n2.1. Написать критерий.',
  )
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click()

  await page.getByRole('button', { name: 'Сохранить', exact: true }).click()
  await expect(page.getByText('Флоу сохранён и закоммичен в базу')).toBeVisible()
  expect((calls.flow[0] as { steps: Step[] }).steps[1].description).toBe(
    'Критерий пишется до кода.\n\n- проверяемый;\n1. с макетом.\n\n2.1. Написать критерий.',
  )
})

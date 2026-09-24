import { expect, test, type Page } from '@playwright/test'
import { mockAgentPanel, ndjson } from './agentPanel.ts'

const base = 'D:\\Projects\\app-knowledge'

const review = {
  title: 'Ревью',
  executor: 'reviewer',
  output: 'вердикт по sha',
  skip: null,
  description: '1. Собрать дифф.',
  helpers: [],
  slug: 'review',
}
const merge = { title: 'Мерж', executor: 'оркестратор', output: 'sha в dev', skip: null, description: null, helpers: [], slug: 'merge' }

const flows = [
  { name: 'полный', when: 'новая возможность', entries: [{ stage: 'Ревью', returns: [] }, { stage: 'Мерж', returns: [{ condition: 'красное', stage: 'Ревью' }] }] },
  { name: 'мелкий', when: 'правка в одном месте', entries: [{ stage: 'Ревью', returns: [] }] },
]

/**
 * /api подменяется: настоящая просьба запустила бы агента в живой копии оператора, а «Сохранить»
 * записало бы флоу в живую базу и закоммитило бы его.
 */
async function mockApi(page: Page) {
  const saved: unknown[] = []
  await page.route('**/api/workspaces', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/performers', (route) =>
    route.fulfill({
      json: [
        {
          base,
          project: 'Agents Kit Web',
          directory: `${base}\\agents`,
          performers: [{ name: 'reviewer', description: null, model: null, tools: null, prompt: '', path: `${base}\\agents\\reviewer.md` }],
          error: null,
        },
      ],
    }),
  )
  await page.route('**/api/flow', (route) => {
    if (route.request().method() === 'POST') {
      saved.push(route.request().postDataJSON())
      return route.fulfill({ json: { version: 'v2' } })
    }
    return route.fulfill({
      json: [{ base, project: 'Agents Kit Web', stages: [review, merge], flows, version: 'v1', error: null, icons: {} }],
    })
  })
  const panel = await mockAgentPanel(page, 'flow', '/api/flow/rewrite')
  return { panel, saved }
}

test('оператор просит Чудо-Юдо переписать стадию, принимает правки и сохраняет их', async ({ page }) => {
  const { panel, saved } = await mockApi(page)
  panel.reply(
    ndjson(
      { type: 'step', text: 'читает flow/stages/review.md' },
      {
        type: 'rewritten',
        text: '',
        stages: [
          { of: 'Ревью', stage: { ...review, title: 'Проверка', output: 'вердикт по sha и тестам' } },
          { stage: { title: 'Документация', executor: 'оператор', output: 'раздел', skip: null, description: null, helpers: [] } },
        ],
        durationMs: 42000,
      },
    ),
  )

  await page.goto('/')
  await page.getByRole('navigation', { name: 'Разделы панели' }).getByRole('button', { name: 'Флоу' }).click()
  await page.mouse.move(900, 400)
  await expect(page.getByRole('region', { name: 'Сценарий «полный»' })).toBeVisible()

  await page.getByRole('button', { name: 'Ещё действия' }).click()
  await page.getByRole('menuitem', { name: 'Переписать с Чудо-Юдо' }).click()
  const modal = page.getByRole('dialog', { name: 'Переписать с Чудо-Юдо' })
  await expect(modal.getByRole('button', { name: 'Написать стадию' })).toBeDisabled()

  await modal.getByLabel('Что поменять в стадиях').fill('Переименуй ревью в проверку, пусть смотрит тесты, и заведи документацию')
  await modal.getByRole('button', { name: 'Стадии' }).click()
  await modal.getByPlaceholder('Найти стадию').fill('рев')
  await modal.getByRole('option', { name: /Ревью/ }).click()
  await modal.getByPlaceholder('Найти стадию').press('Escape')
  await expect(modal.getByRole('listbox')).toBeHidden()
  await expect(modal.getByLabel('Стадии к просьбе')).toContainText('Ревью')
  await modal.getByRole('button', { name: 'Переписать' }).click()

  const changes = modal.getByLabel('Что изменилось в стадиях')
  await expect(changes.getByText('изменена')).toBeVisible()
  await expect(changes.getByText('вердикт по sha и тестам')).toBeVisible()
  await expect(changes.getByText(/Стадия стоит в сценариях «полный» и «мелкий»/)).toBeVisible()
  await expect(changes.getByText('добавлена')).toBeVisible()
  expect(panel.posts[0]).toMatchObject({ base, stages: [{ title: 'Ревью' }], titles: ['Ревью', 'Мерж'] })

  await modal.getByRole('button', { name: 'Принять правки' }).click()
  await expect(modal).toBeHidden()

  // Новая стадия встала карточкой на вкладке «Стадии», переименованная — под новым названием.
  const list = page.getByRole('list', { name: 'Стадии базы' })
  await expect(list.getByRole('button', { name: /^Документация/ })).toBeVisible()
  await expect(list.getByRole('button', { name: /^Проверка/ })).toBeVisible()

  // «Принять правки» пишет переписанное сразу, без полосы сохранения (B-226)
  await expect.poll(() => saved.length).toBe(1)
  expect(saved[0]).toMatchObject({
    flows: [
      { entries: [{ stage: 'Проверка' }, { stage: 'Мерж', returns: [{ condition: 'красное', stage: 'Проверка' }] }] },
      { entries: [{ stage: 'Проверка' }] },
    ],
  })
})

import { fireEvent, render, screen, waitForElementToBeRemoved, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'
import type { QuestionsResponse } from './ReplyModal'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

const row: WorkspaceRow = {
  project: 'app-knowledge',
  base: 'D:\\Projects\\app-knowledge',
  path: 'D:\\Projects\\app',
  branch: 'feat/reply',
  task: 'Окно ответа',
  flowStep: 'Критерий',
  progress: 0,
  status: 'waiting',
  error: null,
}

const questions: QuestionsResponse = {
  project: 'app-knowledge',
  copy: 'D:\\Projects\\app',
  task: 'Окно ответа',
  criteria: [
    { title: '1. Окно есть', text: 'Оператор отвечает из панели.\n\nБез IDE.' },
    { title: '2. Строка перестаёт ждать', text: null },
  ],
  outOfScope: 'Health баз.',
  design: null,
  vsCodeSession: true,
  questions: [
    { title: 'Подтвердить критерий?', context: 'За вами объём проверок', variants: [], answer: null },
    {
      title: 'Как быть с переносами?',
      context: 'Абзацы из поля теряются.\n\n- заменить пробелами\n  - и сказать об этом\n- не отправлять',
      variants: [
        { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
        { choice: 'Не отправлять', effect: 'Оператор переписывает', recommended: false },
      ],
      answer: null,
    },
  ],
}

type Route = (init?: RequestInit) => Response

function stubApi(answers: Route, data: QuestionsResponse = questions, openSession: Route = () => new Response(null, { status: 204 })) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/workspaces') return new Response(JSON.stringify([row]), { status: 200 })
    if (url.startsWith('/api/questions?')) return new Response(JSON.stringify(data), { status: 200 })
    if (url === '/api/answers') return answers(init)
    if (url === '/api/session/open') return openSession(init)
    return new Response(null, { status: 404 })
  })
  vi.stubGlobal('fetch', fetchMock)
  return calls
}

async function openReply() {
  render(<App />)
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
  return screen.findByRole('dialog', { name: 'Ответ оператора' })
}

test('окно показывает заголовок и текст каждого критерия и отдельно то, что не входит', async () => {
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())

  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  const titles = [...document.querySelectorAll('.criterion-title')]
  // номер критерия остаётся в заголовке, а не съедается разметкой как список
  expect(titles.map((t) => t.textContent)).toEqual(['1. Окно есть', '2. Строка перестаёт ждать'])
  const firstText = titles[0].parentElement!.querySelector('.criterion-text')
  // абзацы критерия — отдельные абзацы разметки, а не один кусок текста
  expect([...firstText!.querySelectorAll('p')].map((p) => p.textContent)).toEqual([
    'Оператор отвечает из панели.',
    'Без IDE.',
  ])
  expect(titles[1].parentElement!.querySelector('.criterion-text')).toBeNull()
  expect(dialog.getByText('Не входит')).toBeInTheDocument()
  expect(dialog.getByText('Health баз.')).toBeInTheDocument()
  expect(dialog.queryByText('Критерии не записаны')).not.toBeInTheDocument()
})

test('макет задачи показывается блоком «Дизайн» со ссылкой', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
    design: 'Макет окна ответа: https://claude.ai/artifact/AbC123',
  })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(dialog.getByText('Дизайн')).toBeInTheDocument()
  const link = document.querySelector('.design-label + .criterion-text a')!
  expect(link).toHaveAttribute('href', 'https://claude.ai/artifact/AbC123')
  expect(link).toHaveAttribute('target', '_blank')
})

test('у задачи без макета блока «Дизайн» в окне нет', async () => {
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(dialog.queryByText('Дизайн')).not.toBeInTheDocument()
  expect(document.querySelector('.design-label')).toBeNull()
})

test('окно без критериев говорит, что они не записаны', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, criteria: [], outOfScope: null })

  const dialog = within(await openReply())

  expect(await dialog.findByText('Критерии не записаны')).toBeInTheDocument()
  expect(dialog.queryByText('Не входит')).not.toBeInTheDocument()
})

test('окно показывает вопрос копии с контекстом, вариантами и критерием', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())

  expect(await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/questions?base=D%3A%5CProjects%5Capp-knowledge&copy=D%3A%5CProjects%5Capp')).toBe(true)
  expect(dialog.getByText('Вопрос 1 из 2')).toBeInTheDocument()
  expect(dialog.getByText('За вами объём проверок')).toBeInTheDocument()
  expect(document.querySelector('.criterion-title')!.textContent).toBe('1. Окно есть')
  expect(dialog.getByText('app-knowledge · D:\\Projects\\app')).toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  expect(dialog.getByText('Вопрос 2 из 2')).toBeInTheDocument()
  // контекст размечен: абзац и список с вложенным пунктом, а не строки простым текстом
  const context = document.querySelector('.question-box')!
  expect(context.querySelector('p')!.textContent).toBe('Абзацы из поля теряются.')
  expect([...context.querySelectorAll(':scope > ul > li')].map((li) => li.firstChild!.textContent)).toEqual([
    'заменить пробелами',
    'не отправлять',
  ])
  expect(context.querySelector('li > ul > li')!.textContent).toBe('и сказать об этом')
  expect(dialog.getByText('Рекомендовано')).toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Далее' })).not.toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами')
})

test('заголовок, контекст и критерий показываются размеченными, сырой HTML не рендерится', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
    criteria: [{ title: '1. Окно `ReplyModal` есть', text: 'Текст с **выделением**.' }],
    outOfScope: 'Разметка в *таблице копий*.',
    questions: [
      {
        title: 'Что делать с `white-space`?',
        context: 'Строка про **важное**, про `код` и [ссылку](https://example.com).\n\n<b>сырой HTML</b> не рендерится.',
        variants: [],
        answer: null,
      },
    ],
  })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Что делать с white-space?' })

  const context = document.querySelector('.question-box')!
  expect(context.querySelector('strong')!.textContent).toBe('важное')
  expect(context.querySelector('code')!.textContent).toBe('код')
  expect(context.querySelector('a')).toHaveAttribute('href', 'https://example.com')
  expect(context.querySelector('b')).toBeNull()
  expect(context.textContent).toContain('<b>сырой HTML</b> не рендерится.')

  expect(document.querySelector('.massive-title code')!.textContent).toBe('white-space')
  expect(document.querySelector('.criterion-title code')!.textContent).toBe('ReplyModal')
  expect(document.querySelector('.criterion-text strong')!.textContent).toBe('выделением')
  expect(dialog.getByText('таблице копий').tagName).toBe('EM')
})

test('адреса в заголовке, контексте и критериях — ссылки в новую вкладку, в вариантах — текст', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
    criteria: [{ title: '1. Смотреть https://example.com/c-title', text: 'Где: https://example.com/c-text' }],
    outOfScope: 'Не трогаем https://example.com/out',
    questions: [
      {
        title: 'Что с https://example.com/q-title?',
        context: 'Объявление: https://example.com/q-context',
        variants: [{ choice: 'Как в https://example.com/v', effect: 'См. https://example.com/e', recommended: false }],
        answer: null,
      },
    ],
  })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: /Что с/ })

  const hrefs = dialog.getAllByRole('link').map((link) => {
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    return link.getAttribute('href')
  })
  expect(hrefs.sort()).toEqual(
    [
      'https://example.com/c-text',
      'https://example.com/c-title',
      'https://example.com/out',
      'https://example.com/q-context',
      'https://example.com/q-title',
    ].sort(),
  )
  expect(dialog.getByRole('button', { name: /Как в https:\/\/example\.com\/v/ })).toBeInTheDocument()
})

test('пустой ответ не отправляется: окно открывает этот вопрос', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
  expect(dialog.getByText('Напишите свой ответ')).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'заменять' } })
  expect(dialog.queryByText('Напишите свой ответ')).not.toBeInTheDocument()
})

test('все ответы уходят одной отправкой, после записи окно закрывается и таблица перечитывается', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
  const post = calls.filter((c) => c.url === '/api/answers')
  expect(post).toHaveLength(1)
  expect(JSON.parse(post[0].init!.body as string)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'Заменять пробелами' },
    ],
  })
  expect(calls.filter((c) => c.url === '/api/workspaces')).toHaveLength(2)
  expect(screen.queryByText('Ответы записаны')).not.toBeInTheDocument()
})

test('вопрос, на который уже ответили, останавливает запись и показывается с причиной', async () => {
  stubApi(
    () =>
      new Response(JSON.stringify({ question: 'Подтвердить критерий?', problem: 'already-answered' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'заменять' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  expect(await dialog.findByText('Ответы не записаны')).toBeInTheDocument()
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByText(/уже ответили из другого места/)).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  expect(screen.getByRole('dialog', { name: 'Ответ оператора' })).toBeInTheDocument()
})

test('кнопка перехода открывает окно VS Code той копии, чей вопрос читают', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const open = dialog.getByRole('button', { name: 'Открыть в VS Code' })
  expect(open).toBeEnabled()
  fireEvent.click(open)

  const post = calls.filter((c) => c.url === '/api/session/open')
  expect(post).toHaveLength(1)
  expect(JSON.parse(post[0].init!.body as string)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
  })
  // аккордеон не раскрывается щелчком по кнопке внутри его шапки
  expect(document.querySelector('.context-accordion')).not.toHaveAttribute('open')
})

test('живой сессии в VS Code нет — кнопка не нажимается и говорит об этом', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }), { ...questions, vsCodeSession: false })
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const open = dialog.getByRole('button', { name: 'Нет сессии в VS Code' })
  expect(open).toBeDisabled()
  fireEvent.click(open)

  expect(calls.some((c) => c.url === '/api/session/open')).toBe(false)
})

test('переход не удался — окно на месте, ошибка видна, набранный ответ цел', async () => {
  stubApi(
    () => new Response(null, { status: 204 }),
    questions,
    () => new Response(JSON.stringify({ problem: 'not-raised' }), { status: 502 }),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })

  fireEvent.click(dialog.getByRole('button', { name: 'Открыть в VS Code' }))

  expect(await dialog.findByText('Не удалось открыть VS Code')).toBeInTheDocument()
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
})

test('сессия закрылась между опросами — переход говорит об этом отдельно', async () => {
  stubApi(
    () => new Response(null, { status: 204 }),
    questions,
    () => new Response(JSON.stringify({ problem: 'no-session' }), { status: 409 }),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.click(dialog.getByRole('button', { name: 'Открыть в VS Code' }))

  expect(await dialog.findByText('Сессия этой копии уже не открыта в VS Code')).toBeInTheDocument()
})

const draftsKey = 'agents-kit-web.answer-drafts|D:\\Projects\\app-knowledge|D:\\Projects\\app'

test('закрытое окно возвращает набранные ответы, каким бы способом его ни закрыли', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  let dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
  dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами')

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'Заменять пробелами и сказать' } })
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
  dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами и сказать')
})

test('после успешной отправки набранное забывается', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'заменять' } })
  expect(localStorage.getItem(draftsKey)).not.toBeNull()
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
  expect(localStorage.getItem(draftsKey)).toBeNull()
})

test('отправка не прошла — набранное остаётся', async () => {
  stubApi(
    () =>
      new Response(JSON.stringify({ question: 'Подтвердить критерий?', problem: 'already-answered' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'заменять' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  expect(await dialog.findByText('Ответы не записаны')).toBeInTheDocument()
  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
    'Подтвердить критерий?': 'принимаю',
    'Как быть с переносами?': 'заменять',
  })
})

test('черновик вопроса, которого больше нет среди ждущих, не показывается и забывается', async () => {
  const otherCopyKey = 'agents-kit-web.answer-drafts|D:\\Projects\\app-knowledge|D:\\Projects\\app-2'
  localStorage.setItem(
    draftsKey,
    JSON.stringify({ 'Подтвердить критерий?': 'принимаю', 'Старый вопрос?': 'устарело' }),
  )
  localStorage.setItem(otherCopyKey, JSON.stringify({ 'Как быть с переносами?': 'из другой копии' }))
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('')

  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({ 'Подтвердить критерий?': 'принимаю' })
  expect(JSON.parse(localStorage.getItem(otherCopyKey)!)).toEqual({ 'Как быть с переносами?': 'из другой копии' })
})

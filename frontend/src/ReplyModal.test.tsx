import { createEvent, fireEvent, render, screen, within } from '@testing-library/react'
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
  branch: 'feat/reply',
  task: 'Окно ответа',
  criteria: [
    { title: '1. Окно есть', text: 'Оператор отвечает из панели.\n\nБез IDE.' },
    { title: '2. Строка перестаёт ждать', text: null },
  ],
  outOfScope: 'Health баз.',
  artifacts: [],
  vsCodeSession: true,
  backgroundSession: true,
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

type Route = (init?: RequestInit) => Response | Promise<Response>

function stubApi(
  answers: Route,
  data: QuestionsResponse = questions,
  openSession: Route = () => new Response(null, { status: 204 }),
  openTerminal: Route = () => new Response(null, { status: 204 }),
  openArtifact: Route = () => new Response(null, { status: 204 }),
) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/workspaces') return new Response(JSON.stringify([row]), { status: 200 })
    if (url.startsWith('/api/questions?')) return new Response(JSON.stringify(data), { status: 200 })
    if (url === '/api/answers') return answers(init)
    if (url === '/api/session/open') return openSession(init)
    if (url === '/api/session/terminal') return openTerminal(init)
    if (url === '/api/artifact/open') return openArtifact(init)
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


// Ответ даётся строкой ввода внизу окна: набрать или выбрать вариант и нажать «Ответить».
function answerWith(dialog: ReturnType<typeof within>, text: string) {
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: text } })
  fireEvent.click(dialog.getByRole('button', { name: 'Ответить' }))
}

// Свёрнутый вопрос — кнопка с его заголовком; раскрытый — заголовок второго уровня.
function collapsed(dialog: ReturnType<typeof within>, title: string) {
  return dialog.getByRole('button', { name: new RegExp(`^${title.replace(/[?.]/g, '\\$&')}`) })
}

test('над лентой — полоса с задачей, проектом, именем копии и веткой, без полного пути копии', async () => {
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(document.querySelector('.strip-task')).toHaveTextContent('Окно ответа')
  expect(document.querySelector('.strip-meta')!.textContent).toBe('app-knowledge·app·feat/reply')
  expect(document.querySelector('.reply-window')!.textContent).not.toContain('D:\\Projects\\app')
})

test('задача не прочиталась — на её месте пусто, без тире; ветки нет — строка без неё', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, task: null, branch: null })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(document.querySelector('.strip-task')).toBeNull()
  expect(document.querySelector('.task-strip')!.textContent).not.toContain('—')
  expect(document.querySelector('.strip-meta')!.textContent).toBe('app-knowledge·app')
})

test('все вопросы видны сразу: раскрыт первый, остальные свёрнуты, без номеров, счётчика, вкладок и шагов', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())

  expect(await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/questions?base=D%3A%5CProjects%5Capp-knowledge&copy=D%3A%5CProjects%5Capp')).toBe(true)
  expect(dialog.getByText('За вами объём проверок')).toBeInTheDocument()
  // второй вопрос виден свёрнутым с самого открытия, и мимо него ещё не проходили
  expect(collapsed(dialog, 'Как быть с переносами?')).not.toHaveTextContent('Пропущен')
  expect(dialog.queryByRole('heading', { name: 'Как быть с переносами?' })).not.toBeInTheDocument()

  expect(dialog.queryByRole('tablist')).not.toBeInTheDocument()
  for (const name of ['Далее', 'Назад', 'Отправить']) expect(dialog.queryByRole('button', { name })).not.toBeInTheDocument()
  expect(document.querySelector('.reply-window')!.textContent).not.toMatch(/Вопрос \d|из \d|Агент/)
})

test('щелчок по свёрнутому вопросу раскрывает его: размеченный контекст и варианты с рекомендованным', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))

  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
  expect(collapsed(dialog, 'Подтвердить критерий?')).toBeInTheDocument()
  // контекст размечен: абзац и список с вложенным пунктом, а не строки простым текстом
  const context = document.querySelector('.q-context')!
  expect(context.querySelector('p')!.textContent).toBe('Абзацы из поля теряются.')
  expect([...context.querySelectorAll(':scope > ul > li')].map((li) => li.firstChild!.textContent)).toEqual([
    'заменить пробелами',
    'не отправлять',
  ])
  expect(context.querySelector('li > ul > li')!.textContent).toBe('и сказать об этом')
  const recommended = dialog.getByRole('button', { name: /Заменять пробелами/ })
  expect(recommended).toHaveTextContent('Рекомендовано ИИ')
  // описание варианта видно целиком
  expect(recommended).toHaveTextContent('Абзацы теряются')
  expect(dialog.getByRole('button', { name: /Не отправлять/ })).not.toHaveTextContent('Рекомендовано ИИ')
})

test('заголовок и контекст вопроса показываются размеченными, сырой HTML не рендерится', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
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

  const context = document.querySelector('.q-context')!
  expect(context.querySelector('strong')!.textContent).toBe('важное')
  expect(context.querySelector('code')!.textContent).toBe('код')
  expect(context.querySelector('a')).toHaveAttribute('href', 'https://example.com')
  expect(context.querySelector('b')).toBeNull()
  expect(context.textContent).toContain('<b>сырой HTML</b> не рендерится.')
  expect(document.querySelector('.q-title code')!.textContent).toBe('white-space')
})

test('адреса в заголовке и контексте вопроса — ссылки в новую вкладку, в вариантах и свёрнутом вопросе — текст', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
    questions: [
      {
        title: 'Что с https://example.com/q-title?',
        context: 'Объявление: https://example.com/q-context',
        variants: [{ choice: 'Как в https://example.com/v', effect: 'См. https://example.com/e', recommended: false }],
        answer: null,
      },
      { title: 'А с https://example.com/second?', context: null, variants: [], answer: null },
    ],
  })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: /Что с/ })

  const hrefs = dialog
    .getAllByRole('link')
    .map((link) => {
      expect(link).toHaveAttribute('target', '_blank')
      expect(link).toHaveAttribute('rel', 'noopener noreferrer')
      return link.getAttribute('href')
    })
    .sort()
  expect(hrefs).toEqual(['https://example.com/q-context', 'https://example.com/q-title'])
  expect(dialog.getByRole('button', { name: /Как в https:\/\/example\.com\/v/ })).toBeInTheDocument()
  // свёрнутый вопрос сам кнопка: ссылки внутри него нет
  expect(collapsed(dialog, 'А с https://example.com/second?').querySelector('a')).toBeNull()
})

test('вариант только вписывается в строку ввода, ответ встаёт пузырём после «Ответить», и лента идёт дальше', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))

  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами')
  expect(dialog.getByRole('button', { name: /Заменять пробелами/ })).toHaveAttribute('aria-pressed', 'true')
  expect(document.querySelector('.op-bubble')).toBeNull()

  fireEvent.click(dialog.getByRole('button', { name: 'Ответить' }))

  // ответ под своим вопросом: выбранный вариант жирно, под ним его описание
  const bubble = document.querySelector('.op-bubble')!
  expect(bubble.querySelector('.ans-choice')).toHaveTextContent('Заменять пробелами')
  expect(bubble.querySelector('.ans-effect')).toHaveTextContent('Абзацы теряются')
  // остался вопрос без ответа — лента перешла к нему, ничего не отправлено
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('')
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)
})

test('пустой ответ не принимается: под строкой ввода просьба ответить, набранное её снимает', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: '   ' } })
  fireEvent.click(dialog.getByRole('button', { name: 'Ответить' }))

  expect(dialog.getByRole('alert')).toHaveTextContent('Напишите свой ответ или выберите вариант')
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(document.querySelector('.op-bubble')).toBeNull()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'принимаю' } })
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
})

test('Enter в строке ввода — «Ответить», а Enter набора через IME ответа не даёт', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const field = dialog.getByLabelText('Ответ')
  fireEvent.change(field, { target: { value: 'принимаю' } })
  fireEvent.keyDown(field, { key: 'Enter', isComposing: true })
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()

  const plain = createEvent.keyDown(field, { key: 'Enter' })
  fireEvent(field, plain)
  expect(plain.defaultPrevented).toBe(true)
  expect(document.querySelector('.op-bubble')).toHaveTextContent('принимаю')
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
})

const three: QuestionsResponse = {
  ...questions,
  questions: [
    ...questions.questions,
    { title: 'Куда класть копию?', context: null, variants: [], answer: null },
  ],
}

test('«Пропустить» ведёт дальше, пройденный без ответа вопрос помечен «Пропущен», с последнего — к первому пропущенному', async () => {
  stubApi(() => new Response(null, { status: 204 }), three)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.click(dialog.getByRole('button', { name: 'Пропустить' }))
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
  expect(collapsed(dialog, 'Подтвердить критерий?')).toHaveTextContent('Пропущен')
  expect(collapsed(dialog, 'Куда класть копию?')).not.toHaveTextContent('Пропущен')

  answerWith(dialog, 'заменять')
  expect(dialog.getByRole('heading', { name: 'Куда класть копию?' })).toBeInTheDocument()

  // с последнего вопроса «Пропустить» ведёт к первому пропущенному
  fireEvent.click(dialog.getByRole('button', { name: 'Пропустить' }))
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(collapsed(dialog, 'Куда класть копию?')).toHaveTextContent('Пропущен')
})

test('у вопроса с ответом вместо «Пропустить» — «Дальше»; стрелка ведёт к предыдущему и на первом не нажимается', async () => {
  stubApi(() => new Response(null, { status: 204 }), three)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(dialog.getByRole('button', { name: 'Предыдущий вопрос' })).toBeDisabled()
  answerWith(dialog, 'принимаю')
  fireEvent.click(dialog.getByRole('button', { name: 'Предыдущий вопрос' }))

  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  expect(dialog.queryByRole('button', { name: 'Пропустить' })).not.toBeInTheDocument()
  fireEvent.click(dialog.getByRole('button', { name: 'Дальше' }))
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
})

test('данный ответ правится: «Изменить» открывает его вопрос, новый ответ встаёт на место прежнего', async () => {
  stubApi(() => new Response(null, { status: 204 }), three)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(dialog.getByRole('button', { name: 'Изменить' }))

  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  answerWith(dialog, 'принимаю с оговоркой')

  const bubbles = [...document.querySelectorAll('.op-bubble')]
  expect(bubbles.map((b) => b.querySelector('.ans-text, .ans-choice')!.textContent)).toEqual(['принимаю с оговоркой'])
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
})

const draftsKey = 'agents-kit-web.answer-drafts|D:\\Projects\\app-knowledge|D:\\Projects\\app'

test('закрытое с пропущенными окно ничего не отправляет и возвращает данные ответы, каким бы способом его ни закрыли', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }), three)
  let dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(dialog.getByRole('button', { name: 'Пропустить' }))
  answerWith(dialog, 'рядом')
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
  dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  // открыто на первом вопросе без ответа, данные ответы — в ленте
  await dialog.findByRole('heading', { name: 'Как быть с переносами?' })
  expect([...document.querySelectorAll('.op-bubble')].map((b) => b.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('принимаю'), expect.stringContaining('рядом')]),
  )

  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)
  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
    'Подтвердить критерий?': 'принимаю',
    'Куда класть копию?': 'рядом',
  })
})

test('черновик вопроса, которого больше нет среди ждущих, не показывается и забывается', async () => {
  const otherCopyKey = 'agents-kit-web.answer-drafts|D:\\Projects\\app-knowledge|D:\\Projects\\app-2'
  localStorage.setItem(draftsKey, JSON.stringify({ 'Подтвердить критерий?': 'принимаю', 'Старый вопрос?': 'устарело' }))
  localStorage.setItem(otherCopyKey, JSON.stringify({ 'Как быть с переносами?': 'из другой копии' }))
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Как быть с переносами?' })
  expect(document.querySelector('.op-bubble')).toHaveTextContent('принимаю')
  expect(dialog.getByLabelText('Ответ')).toHaveValue('')

  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({ 'Подтвердить критерий?': 'принимаю' })
  expect(JSON.parse(localStorage.getItem(otherCopyKey)!)).toEqual({ 'Как быть с переносами?': 'из другой копии' })
})

test('кнопка перехода открывает терминал с фоновой сессией той копии, чей вопрос читают', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const open = dialog.getByRole('button', { name: 'Открыть в терминале' })
  expect(open).toBeEnabled()
  fireEvent.click(open)

  const post = calls.filter((c) => c.url === '/api/session/terminal')
  expect(post).toHaveLength(1)
  expect(JSON.parse(post[0].init!.body as string)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    copy: 'D:\\Projects\\app',
  })
})

test('фоновой сессии нет — кнопка терминала не нажимается и говорит об этом', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, backgroundSession: false })
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const open = dialog.getByRole('button', { name: 'Нет сессии в фоне' })
  expect(open).toBeDisabled()
})

test('терминал не открылся — окно ответа говорит об этом и остаётся на месте', async () => {
  stubApi(
    () => new Response(null, { status: 204 }),
    questions,
    () => new Response(null, { status: 204 }),
    () => new Response(JSON.stringify({ problem: 'no-session' }), { status: 409 }),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.click(dialog.getByRole('button', { name: 'Открыть в терминале' }))

  expect(await dialog.findByText('Сессия этой копии уже не идёт в фоне')).toBeInTheDocument()
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

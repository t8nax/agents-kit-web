import { act, createEvent, fireEvent, render, screen, waitFor, waitForElementToBeRemoved, within } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'
import { UNDO_MS, WRITE_TIMEOUT_MS, type QuestionsResponse } from './ReplyModal'

afterEach(() => {
  vi.useRealTimers()
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


// Ответ ставится сразу, как его набирают: отдельной кнопки ответа нет.
function answerWith(dialog: ReturnType<typeof within>, text: string) {
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: text } })
}

// Свёрнутый вопрос — кнопка с его заголовком; раскрытый — заголовок второго уровня.
function collapsed(dialog: ReturnType<typeof within>, title: string) {
  return dialog.getByRole('button', { name: new RegExp(`^${title.replace(/[?.]/g, '\\$&')}`) })
}

test('в шапке — задача, проект и имя копии со значками, без ветки и полного пути копии', async () => {
  stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(document.querySelector('.strip-task')).toHaveTextContent('Окно ответа')
  const items = [...document.querySelectorAll('.strip-meta .meta-item')]
  expect(items.map((item) => [item.getAttribute('title'), item.textContent])).toEqual([
    ['Проект', 'app-knowledge'],
    ['Рабочая копия', 'app'],
  ])
  // у каждого свой значок, а разделителя между ними нет
  expect(items.every((item) => item.querySelector('svg'))).toBe(true)
  expect(document.querySelector('.strip-meta')!.textContent).toBe('app-knowledgeapp')
  expect(document.querySelector('.reply-window')!.textContent).not.toContain('feat/reply')
  expect(document.querySelector('.reply-window')!.textContent).not.toContain('D:\\Projects\\app')
})

test('задача не прочиталась — на её месте пусто, без тире', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, task: null })

  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(document.querySelector('.strip-task')).toBeNull()
  expect(document.querySelector('.task-strip')!.textContent).not.toContain('—')
  expect(document.querySelector('.strip-meta')!.textContent).toBe('app-knowledgeapp')
})

test('все вопросы видны сразу: раскрыт первый, остальные свёрнуты, без номеров, счётчика и шагов', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())

  expect(await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/questions?base=D%3A%5CProjects%5Capp-knowledge&copy=D%3A%5CProjects%5Capp')).toBe(true)
  expect(dialog.getByText('За вами объём проверок')).toBeInTheDocument()
  // второй вопрос виден свёрнутым с самого открытия, и мимо него ещё не проходили
  expect(collapsed(dialog, 'Как быть с переносами?')).not.toHaveTextContent('Пропущен')
  expect(dialog.queryByRole('heading', { name: 'Как быть с переносами?' })).not.toBeInTheDocument()

  for (const name of ['Далее', 'Назад', 'Ответить', 'Пропустить']) {
    expect(dialog.queryByRole('button', { name })).not.toBeInTheDocument()
  }
  expect(dialog.getByRole('button', { name: 'Отправить' })).toBeInTheDocument()
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

test('выбор варианта сразу ставит ответ пузырём, повторный щелчок его снимает', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))

  const choice = dialog.getByRole('button', { name: /Заменять пробелами/ })
  fireEvent.click(choice)

  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами')
  expect(choice).toHaveAttribute('aria-pressed', 'true')
  // ответ под своим вопросом: выбранный вариант жирно, под ним его описание
  const bubble = document.querySelector('.op-bubble')!
  expect(bubble.querySelector('.ans-choice')).toHaveTextContent('Заменять пробелами')
  expect(bubble.querySelector('.ans-effect')).toHaveTextContent('Абзацы теряются')
  // ничего не отправлено, лента осталась на том же вопросе
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  fireEvent.click(choice)
  expect(document.querySelector('.op-bubble')).toBeNull()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('')
})

test('набранное сразу видно пузырём и сохраняется черновиком, а меняют его возвратом к вопросу', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')

  expect(document.querySelector('.op-bubble')).toHaveTextContent('принимаю')
  expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({ 'Подтвердить критерий?': 'принимаю' })
  // «Изменить» и «Ответить» из ленты убраны
  expect(dialog.queryByRole('button', { name: 'Изменить' })).not.toBeInTheDocument()

  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  fireEvent.click(collapsed(dialog, 'Подтвердить критерий?'))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('принимаю')
  answerWith(dialog, 'принимаю с оговоркой')
  expect([...document.querySelectorAll('.op-bubble')].map((b) => b.textContent)).toEqual(['принимаю с оговоркой'])
})

test('«Отправить» с вопросом без ответа не отправляет: лента идёт к нему, под полем — просьба ответить', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  answerWith(dialog, 'заменять')
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))

  expect(dialog.getByRole('alert')).toHaveTextContent('Напишите свой ответ или выберите вариант')
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  answerWith(dialog, 'принимаю')
  expect(dialog.queryByRole('alert')).not.toBeInTheDocument()
})

test('Enter ведёт к следующему вопросу, а Enter набора через IME никуда не ведёт', async () => {
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

test('стрелки ведут по вопросам и упираются в первый и последний; пометки «Пропущен» нет', async () => {
  stubApi(() => new Response(null, { status: 204 }), three)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(dialog.getByRole('button', { name: 'Предыдущий вопрос' })).toBeDisabled()
  fireEvent.click(dialog.getByRole('button', { name: 'Следующий вопрос' }))

  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
  // мимо первого прошли без ответа, и он всё равно обычная свёрнутая строка
  expect(collapsed(dialog, 'Подтвердить критерий?')).not.toHaveTextContent('Пропущен')
  expect(document.querySelector('.q-compact.is-skipped')).toBeNull()

  fireEvent.click(dialog.getByRole('button', { name: 'Следующий вопрос' }))
  expect(dialog.getByRole('heading', { name: 'Куда класть копию?' })).toBeInTheDocument()
  expect(dialog.getByRole('button', { name: 'Следующий вопрос' })).toBeDisabled()

  fireEvent.click(dialog.getByRole('button', { name: 'Предыдущий вопрос' }))
  expect(dialog.getByRole('heading', { name: 'Как быть с переносами?' })).toBeInTheDocument()
})

const draftsKey = 'agents-kit-web.answer-drafts|D:\\Projects\\app-knowledge|D:\\Projects\\app'

test('закрытое окно ничего не отправляет и возвращает ответы, каким бы способом его ни закрыли', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }), three)
  let dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(collapsed(dialog, 'Куда класть копию?'))
  answerWith(dialog, 'рядом')
  fireEvent.click(dialog.getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
  dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  // открыто на первом вопросе без ответа, ответы — в ленте
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

// Отправка ждёт секунд с «Отменить»: часы подделываются перед нажатием и сдвигаются на эти секунды.
function sendAll(dialog: ReturnType<typeof within>) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.click(dialog.getByRole('button', { name: 'Отправить' }))
}

function waitOut(ms = UNDO_MS) {
  act(() => vi.advanceTimersByTime(ms))
  vi.useRealTimers()
}

test('«Отправить» показывает знак отправки с «Отменить», а запись идёт после секунд — одна со всеми ответами', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  sendAll(dialog)

  // ленты не видно: на её месте знак отправки, а внизу «Отменить» вместо «Отправить»
  expect(dialog.getByRole('status')).toHaveTextContent('Ответы отправлены агенту')
  expect(document.querySelector('.reply-feed')).toBeNull()
  expect(document.querySelector('.done-mark svg')).toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument()
  expect(dialog.queryByLabelText('Ответ')).not.toBeInTheDocument()
  const undo = dialog.getByRole('button', { name: 'Отменить' })
  expect(undo).toHaveFocus()

  // окно пока не закрывается ни Escape, ни щелчком мимо, ни крестиком
  fireEvent.keyDown(window, { key: 'Escape' })
  fireEvent.mouseDown(document.querySelector('.modal-overlay')!)
  expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeDisabled()
  act(() => vi.advanceTimersByTime(UNDO_MS - 1))
  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)

  waitOut(1)
  await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
  const post = calls.filter((c) => c.url === '/api/answers')
  expect(post).toHaveLength(1)
  expect(JSON.parse(post[0].init!.body as string)).toEqual({
    base: row.base,
    copy: row.path,
    answers: [
      { question: 'Подтвердить критерий?', answer: 'принимаю' },
      { question: 'Как быть с переносами?', answer: 'Заменять пробелами' },
    ],
  })
  await waitFor(() => expect(calls.filter((c) => c.url === '/api/workspaces')).toHaveLength(2))
  expect(localStorage.getItem(draftsKey)).toBeNull()
})

test('«Отменить» ничего не записывает: лента возвращается со всеми ответами', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  answerWith(dialog, 'заменять')
  sendAll(dialog)
  fireEvent.click(dialog.getByRole('button', { name: 'Отменить' }))
  waitOut()

  expect(calls.some((c) => c.url === '/api/answers')).toBe(false)
  expect(dialog.queryByRole('status')).not.toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('заменять')
  expect(document.querySelectorAll('.op-bubble')).toHaveLength(2)
  expect(dialog.getByRole('button', { name: 'Отправить' })).toBeInTheDocument()
})

test('Enter на последнем вопросе отправляет так же, и второй Enter второй отправки не начинает', async () => {
  let finish = () => {}
  const calls = stubApi(
    () => new Promise<Response>((resolve) => (finish = () => resolve(new Response(null, { status: 204 })))),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const field = dialog.getByLabelText('Ответ')
  fireEvent.change(field, { target: { value: 'принимаю' } })
  fireEvent.keyDown(field, { key: 'Enter' })
  fireEvent.change(dialog.getByLabelText('Ответ'), { target: { value: 'заменять' } })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  fireEvent.keyDown(dialog.getByLabelText('Ответ'), { key: 'Enter' })
  waitOut()

  await waitFor(() => expect(calls.filter((c) => c.url === '/api/answers')).toHaveLength(1))
  // пока запись идёт, окно не закрывается и отменить уже нельзя
  expect(dialog.getByRole('button', { name: 'Отменить' })).toBeDisabled()
  expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeDisabled()
  finish()
  await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
  expect(calls.filter((c) => c.url === '/api/answers')).toHaveLength(1)
})

function rejectWith(status: number, body?: object): Route {
  return () =>
    new Response(body ? JSON.stringify(body) : null, {
      status,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
    })
}

test.each([
  [
    'на вопрос уже ответили из другого места',
    rejectWith(409, { question: 'Подтвердить критерий?', problem: 'already-answered' }),
    'На этот вопрос уже ответили из другого места',
    'Подтвердить критерий?',
  ],
  [
    'вопроса уже нет в памяти',
    rejectWith(409, { question: 'Подтвердить критерий?', problem: 'missing' }),
    'Этого вопроса уже нет в памяти',
    'Подтвердить критерий?',
  ],
  ['памяти копии нет', rejectWith(404), 'Ответы не записаны: память копии не найдена', 'Как быть с переносами?'],
  [
    'нет связи с API',
    () => Promise.reject(new TypeError('Failed to fetch')),
    'Ответы не записаны: нет связи с API',
    'Как быть с переносами?',
  ],
] as [string, Route, string, string][])(
  'отказ записи (%s) — красной строкой под полем, лента на вопросе отказа, окно и ответы на месте',
  async (_, answers, text, heading) => {
    stubApi(answers)
    const dialog = within(await openReply())
    await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

    answerWith(dialog, 'принимаю')
    fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
    answerWith(dialog, 'заменять')
    sendAll(dialog)
    waitOut()

    expect(await dialog.findByRole('alert')).toHaveTextContent(text)
    // лента вернулась: отказ не оставляет окно на знаке отправки
    expect(document.querySelector('.reply-feed')).toBeInTheDocument()
    expect(document.querySelector('.composer .field-error')).toHaveTextContent(text)
    expect(dialog.getByRole('heading', { name: heading })).toBeInTheDocument()
    expect(dialog.getByLabelText('Ответ')).toHaveValue(heading === 'Подтвердить критерий?' ? 'принимаю' : 'заменять')
    expect(screen.getByRole('dialog', { name: 'Ответ оператора' })).toBeInTheDocument()
    expect(JSON.parse(localStorage.getItem(draftsKey)!)).toEqual({
      'Подтвердить критерий?': 'принимаю',
      'Как быть с переносами?': 'заменять',
    })
  },
)

const withArtifacts: QuestionsResponse = {
  ...questions,
  artifacts: [
    { label: 'макет **окна** ответа', address: 'https://claude.ai/artifact/AbC123' },
    { label: 'спецификация', address: 'docs/spec.md' },
  ],
}

// Вкладка шапки показывает свою часть окна на месте ленты.
function openTab(dialog: ReturnType<typeof within>, name: 'Переписка' | 'Контекст' | 'Артефакты') {
  fireEvent.click(dialog.getByRole('tab', { name }))
  return within(dialog.getByRole('tabpanel'))
}

test('в шапке вкладки «Переписка», «Контекст», «Артефакты», окно открывается на переписке, окон поверх нет', async () => {
  stubApi(() => new Response(null, { status: 204 }), withArtifacts)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const tabs = within(dialog.getByRole('tablist')).getAllByRole('tab')
  expect(tabs.map((t) => t.textContent)).toEqual(['Переписка', 'Контекст', 'Артефакты'])
  expect(dialog.getByRole('tab', { name: 'Переписка' })).toHaveAttribute('aria-selected', 'true')
  expect(dialog.getByRole('tabpanel')).toHaveClass('reply-feed')
  // прежних кнопок окон поверх нет, и числа у артефактов тоже
  expect(dialog.queryByRole('button', { name: /^Контекст задачи/ })).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: /^Артефакты/ })).not.toBeInTheDocument()

  openTab(dialog, 'Артефакты')
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(document.querySelector('.reply-window')).not.toHaveAttribute('inert')
})

test('«Контекст» — критерии заголовком и текстом без подписи над ними, отдельно «Не входит»; строки ответа нет', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const context = openTab(dialog, 'Контекст')

  expect(dialog.getByRole('tab', { name: 'Контекст' })).toHaveAttribute('aria-selected', 'true')
  const titles = [...document.querySelectorAll('.criterion-title')]
  // номер критерия остаётся в заголовке, а не съедается разметкой как список
  expect(titles.map((t) => t.textContent)).toEqual(['1. Окно есть', '2. Строка перестаёт ждать'])
  const firstText = titles[0].parentElement!.querySelector('.criterion-text')
  expect([...firstText!.querySelectorAll('p')].map((p) => p.textContent)).toEqual(['Оператор отвечает из панели.', 'Без IDE.'])
  expect(titles[1].parentElement!.querySelector('.criterion-text')).toBeNull()
  expect(context.queryByText('Критерии закрытия')).not.toBeInTheDocument()
  expect(context.getByText('Не входит')).toBeInTheDocument()
  expect(context.getByText('Health баз.')).toBeInTheDocument()
  // строка ответа живёт только у переписки
  expect(dialog.queryByLabelText('Ответ')).not.toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Отправить' })).not.toBeInTheDocument()

  // на переписке всё на месте: набранное, текущий вопрос и фокус в строке
  openTab(dialog, 'Переписка')
  expect(dialog.getByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(dialog.getByLabelText('Ответ')).toHaveFocus()
})

test('критерии и «Не входит» размечены, адреса в них — ссылки в новую вкладку', async () => {
  stubApi(() => new Response(null, { status: 204 }), {
    ...questions,
    criteria: [{ title: '1. Окно `ReplyModal` есть https://example.com/c-title', text: 'Текст с **выделением**.' }],
    outOfScope: 'Разметка в *таблице копий* https://example.com/out',
  })
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const context = openTab(dialog, 'Контекст')

  expect(document.querySelector('.criterion-title code')!.textContent).toBe('ReplyModal')
  expect(document.querySelector('.criterion-text strong')!.textContent).toBe('выделением')
  expect(context.getByText('таблице копий').tagName).toBe('EM')
  const hrefs = context.getAllByRole('link').map((link) => {
    expect(link).toHaveAttribute('target', '_blank')
    return link.getAttribute('href')
  })
  expect(hrefs.sort()).toEqual(['https://example.com/c-title', 'https://example.com/out'])
})

test('«Артефакты» — подпись, под ней адрес ссылкой или кнопкой файла; строки ответа нет', async () => {
  stubApi(() => new Response(null, { status: 204 }), withArtifacts)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  expect(dialog.getByRole('tab', { name: 'Артефакты' })).toHaveTextContent(/^Артефакты$/)
  const artifacts = openTab(dialog, 'Артефакты')

  const items = [...document.querySelectorAll('.artifacts li')]
  expect(items.map((li) => li.querySelector('.artifact-label')!.textContent)).toEqual(['макет окна ответа', 'спецификация'])
  expect(items[0].querySelector('.artifact-label strong')).toHaveTextContent('окна')
  expect(artifacts.getByRole('link', { name: 'https://claude.ai/artifact/AbC123' })).toHaveAttribute('target', '_blank')
  expect(items[1].querySelector('a')).toBeNull()
  expect(artifacts.getByRole('button', { name: 'docs/spec.md' })).toBeInTheDocument()
  expect(dialog.queryByLabelText('Ответ')).not.toBeInTheDocument()
})

test('щелчок по пути к файлу просит панель открыть этот артефакт в VS Code', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }), withArtifacts)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const artifacts = openTab(dialog, 'Артефакты')
  fireEvent.click(artifacts.getByRole('button', { name: 'docs/spec.md' }))

  await waitFor(() => expect(calls.some((c) => c.url === '/api/artifact/open')).toBe(true))
  const call = calls.find((c) => c.url === '/api/artifact/open')!
  // артефакт называется номером в памяти; адрес — чтобы панель не открыла другой, если память переписали
  expect(JSON.parse(call.init!.body as string)).toEqual({ base: row.base, copy: row.path, index: 1, address: 'docs/spec.md' })
  expect(artifacts.queryByRole('alert')).not.toBeInTheDocument()
})

test.each([
  [() => new Response(JSON.stringify({ problem: 'missing' }), { status: 404 }), 'Файла нет на диске: docs/spec.md'],
  [() => new Response(JSON.stringify({ problem: 'not-opened' }), { status: 502 }), 'Не удалось открыть файл в VS Code'],
] as [Route, string][])('файл артефакта не открылся — строка под артефактами держится до закрытия окна: %#', async (open, text) => {
  stubApi(() => new Response(null, { status: 204 }), withArtifacts, undefined, undefined, open)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const artifacts = openTab(dialog, 'Артефакты')
  fireEvent.click(artifacts.getByRole('button', { name: 'docs/spec.md' }))

  const alert = await artifacts.findByRole('alert')
  expect(alert).toHaveTextContent(text)
  // строка стоит под списком артефактов и одна: под шапкой окна её нет
  expect(alert.previousElementSibling).toHaveClass('artifacts')
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1)

  // уход на переписку и назад её не снимает
  openTab(dialog, 'Переписка')
  expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0)
  expect(openTab(dialog, 'Артефакты').getByRole('alert')).toHaveTextContent(text)

  // а закрытое окно её забывает
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Ответить' }))
  const again = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  await again.findByRole('heading', { name: 'Подтвердить критерий?' })
  expect(openTab(again, 'Артефакты').queryByRole('alert')).not.toBeInTheDocument()
})

test('показывать нечего — вкладки на месте, а в них серая надпись «Контекста нет» и «Артефактов нет»', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, criteria: [], outOfScope: null })
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const context = openTab(dialog, 'Контекст')
  expect(context.getByText('Контекста нет')).toHaveClass('modal-message')
  expect(dialog.getByRole('tabpanel')).toHaveClass('is-centered')
  expect(openTab(dialog, 'Артефакты').getByText('Артефактов нет')).toHaveClass('modal-message')
})

test('только «Не входит» без критериев — контекст есть, и в нём один этот раздел', async () => {
  stubApi(() => new Response(null, { status: 204 }), { ...questions, criteria: [] })
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  const context = openTab(dialog, 'Контекст')
  expect(context.getByText('Health баз.')).toBeInTheDocument()
  expect(context.queryByText('Контекста нет')).not.toBeInTheDocument()
  expect(document.querySelector('.criteria')).toBeNull()
})

test('Escape закрывает окно ответа с любой вкладки', async () => {
  stubApi(() => new Response(null, { status: 204 }), withArtifacts)
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  openTab(dialog, 'Контекст')
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('пока ответы уходят, вкладок нет, а «Отменить» возвращает на переписку', async () => {
  stubApi(() => new Response(null, { status: 204 }))
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  answerWith(dialog, 'заменять')
  sendAll(dialog)
  expect(dialog.queryByRole('tablist')).not.toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: 'Отменить' }))
  waitOut()
  expect(dialog.getByRole('tab', { name: 'Переписка' })).toHaveAttribute('aria-selected', 'true')
  expect(dialog.getByLabelText('Ответ')).toHaveValue('заменять')
})

// В разработке панель идёт в StrictMode: окно монтируется дважды, и отметка «окно открыто» должна это пережить —
// иначе записанные ответы не закрывали окно, а отказ не показывался (поймано e2e на B-208).
test('в StrictMode отказ записи показывается', async () => {
  const calls = stubApi(rejectWith(409, { question: 'Подтвердить критерий?', problem: 'missing' }), { ...questions, questions: [questions.questions[0]] })
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  sendAll(dialog)
  waitOut()
  expect(await dialog.findByRole('alert')).toHaveTextContent('Этого вопроса уже нет в памяти')
  expect(calls.filter((c) => c.url === '/api/answers')).toHaveLength(1)
})

test('запись, на которую панель не ответила за свой срок, отпускает окно строкой под полем', async () => {
  const calls = stubApi(
    (init) =>
      new Promise<Response>((_, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))),
      ),
  )
  const dialog = within(await openReply())
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  fireEvent.click(collapsed(dialog, 'Как быть с переносами?'))
  answerWith(dialog, 'заменять')
  sendAll(dialog)
  act(() => vi.advanceTimersByTime(UNDO_MS))
  expect(calls.filter((c) => c.url === '/api/answers')).toHaveLength(1)
  expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeDisabled()
  waitOut(WRITE_TIMEOUT_MS)

  expect(await dialog.findByRole('alert')).toHaveTextContent('Панель не ответила')
  expect(dialog.getByRole('button', { name: 'Закрыть' })).toBeEnabled()
  expect(dialog.getByLabelText('Ответ')).toHaveValue('заменять')
})

test('в StrictMode записанные ответы закрывают окно', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }), { ...questions, questions: [questions.questions[0]] })
  render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
  fireEvent.click(await screen.findByRole('button', { name: 'Ответить' }))
  const dialog = within(await screen.findByRole('dialog', { name: 'Ответ оператора' }))
  await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })

  answerWith(dialog, 'принимаю')
  sendAll(dialog)
  waitOut()
  await waitForElementToBeRemoved(() => screen.queryByRole('dialog'))
  expect(calls.filter((c) => c.url === '/api/answers')).toHaveLength(1)
})

import { fireEvent, render, screen, waitForElementToBeRemoved, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import App, { type WorkspaceRow } from './App'
import type { QuestionsResponse } from './ReplyModal'

afterEach(() => {
  vi.unstubAllGlobals()
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
  criterion: ['1. Окно есть.', 'Не входит: health.'],
  questions: [
    { title: 'Подтвердить критерий?', context: 'За вами объём проверок', variants: [], answer: null },
    {
      title: 'Как быть с переносами?',
      context: 'Абзацы из поля теряются.\n1. Заменить пробелами.\n2. Не отправлять.',
      variants: [
        { choice: 'Заменять пробелами', effect: 'Абзацы теряются', recommended: true },
        { choice: 'Не отправлять', effect: 'Оператор переписывает', recommended: false },
      ],
      answer: null,
    },
  ],
}

type Route = (init?: RequestInit) => Response

function stubApi(answers: Route) {
  const calls: { url: string; init?: RequestInit }[] = []
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init })
    if (url === '/api/workspaces') return new Response(JSON.stringify([row]), { status: 200 })
    if (url.startsWith('/api/questions?')) return new Response(JSON.stringify(questions), { status: 200 })
    if (url === '/api/answers') return answers(init)
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

test('окно показывает вопрос копии с контекстом, вариантами и критерием', async () => {
  const calls = stubApi(() => new Response(null, { status: 204 }))

  const dialog = within(await openReply())

  expect(await dialog.findByRole('heading', { name: 'Подтвердить критерий?' })).toBeInTheDocument()
  expect(calls.some((c) => c.url === '/api/questions?base=D%3A%5CProjects%5Capp-knowledge&copy=D%3A%5CProjects%5Capp')).toBe(true)
  expect(dialog.getByText('Вопрос 1 из 2')).toBeInTheDocument()
  expect(dialog.getByText('За вами объём проверок')).toBeInTheDocument()
  expect(dialog.getByText('1. Окно есть.')).toBeInTheDocument()
  expect(dialog.getByText('app-knowledge · D:\\Projects\\app')).toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: 'Далее' }))
  expect(dialog.getByText('Вопрос 2 из 2')).toBeInTheDocument()
  // каждая строка контекста — своя строка в окне, а не кусок общего абзаца
  const contextLines = ['Абзацы из поля теряются.', '1. Заменить пробелами.', '2. Не отправлять.'].map((line) =>
    dialog.getByText(line),
  )
  expect(new Set(contextLines).size).toBe(3)
  expect(dialog.getByText('Рекомендовано')).toBeInTheDocument()
  expect(dialog.queryByRole('button', { name: 'Далее' })).not.toBeInTheDocument()

  fireEvent.click(dialog.getByRole('button', { name: /Заменять пробелами/ }))
  expect(dialog.getByLabelText('Ответ')).toHaveValue('Заменять пробелами')
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

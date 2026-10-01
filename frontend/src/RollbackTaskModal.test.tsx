import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorkspaceRow } from './App'
import RollbackTaskModal from './RollbackTaskModal'

afterEach(() => {
  vi.unstubAllGlobals()
})

const row: WorkspaceRow = {
  project: 'house',
  base: 'D:\\Projects\\house-knowledge',
  path: 'D:\\Projects\\house-2',
  branch: 'b-42-export',
  task: 'B-42 Экспорт отчёта в CSV',
  flowStep: 'Реализация',
  progress: 40,
  status: 'in-work',
  error: null,
  letters: 'B',
}

type Plan = { task: string; source: string; dirty: boolean; blockers: { kind: string; name: string | null }[] }

const plan: Plan = { task: row.task!, source: 'backlog', dirty: false, blockers: [] }

/** API отката: план на GET, ответы шагов по очереди на POST; каждый шаг, о котором спросили, — в steps. */
function stubApi(planned: Plan, answer: (step: string) => Response | Promise<Response> = () => new Response(null, { status: 204 })) {
  const steps: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (!init) return Promise.resolve(Response.json(planned))
      const step = (JSON.parse(String(init.body)) as { step: string }).step
      steps.push(step)
      return Promise.resolve(answer(step))
    }),
  )
  return steps
}

function renderModal(which: WorkspaceRow = row) {
  const props = { onClose: vi.fn(), onRolledBack: vi.fn() }
  render(<RollbackTaskModal row={which} {...props} />)
  return props
}

async function stepTexts() {
  const dialog = screen.getByRole('dialog', { name: 'Откатить задачу' })
  await within(dialog).findByText('Сессия задачи будет погашена.')
  return within(dialog).getAllByRole('listitem').map((item) => item.textContent)
}

test('окно называет задачу, копию и проект и перечисляет, что сделает откат', async () => {
  stubApi(plan)
  renderModal()

  expect(await stepTexts()).toEqual([
    'Сессия задачи будет погашена.',
    'Запись B-42 вернётся в конец бэклога тем же номером и текстом.',
    'Копия вернётся на прежнюю ветку, а ветка задачи будет удалена на компьютере. На GitHub ветка задачи останется.',
    'Память задачи будет снята с базы.',
  ])
  const dialog = screen.getByRole('dialog', { name: 'Откатить задачу' })
  expect(dialog).toHaveTextContent('Задача B-42 «Экспорт отчёта в CSV» в копии house-2 проекта house будет отменена:')
  // Имён веток окно не называет
  expect(dialog).not.toHaveTextContent('b-42-export')
  expect(within(dialog).queryByText('Незакоммиченные правки будут потеряны')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Откатить задачу' })).toBeEnabled()
})

test('несохранённые правки — предупреждение, и откатить всё равно можно', async () => {
  stubApi({ ...plan, dirty: true })
  renderModal()

  expect(await screen.findByText('Незакоммиченные правки будут потеряны')).toBeInTheDocument()
  expect(screen.getByText('В копии house-2 есть правки, не попавшие в коммит. После отката вернуть их не получится.')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Откатить задачу' })).toBeEnabled()
})

test('задача из трекера: строки о бэклоге нет, а окно говорит, что в трекере она останется', async () => {
  const tracked = { ...row, task: 'GitHub #37 Фильтр по датам в журнале', tracker: 'GitHub' }
  stubApi({ ...plan, task: tracked.task, source: 'tracker' })
  renderModal(tracked)

  expect(await stepTexts()).not.toContainEqual(expect.stringContaining('бэклога'))
  expect(
    screen.getByText('В трекере задача GitHub #37 останется без изменений: вернуть её в очередь или закрыть там нужно самостоятельно.'),
  ).toBeInTheDocument()
})

test('задача, взятая словами, — о бэклоге и трекере окно молчит', async () => {
  const worded = { ...row, task: 'Починить вход' }
  stubApi({ ...plan, task: worded.task, source: 'none' })
  renderModal(worded)

  const texts = await stepTexts()
  expect(texts).toHaveLength(3)
  expect(screen.getByRole('dialog')).not.toHaveTextContent('трекер')
  expect(screen.getByRole('dialog')).not.toHaveTextContent('бэклог')
})

test('сессия в VS Code или терминале — отказ сразу, и откатить нельзя', async () => {
  const steps = stubApi({ ...plan, blockers: [{ kind: 'vscode', name: null }, { kind: 'terminal', name: 'ручная' }] })
  renderModal()

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Откат невозможен')
  expect(alert).toHaveTextContent('В копии house-2 открыта сессия задачи в VS Code — панель не может её погасить. Закройте её в VS Code и повторите откат.')
  expect(alert).toHaveTextContent('В копии house-2 идёт сессия задачи в терминале — панель не может её погасить. Завершите её в терминале и повторите откат.')
  expect(screen.getByRole('button', { name: 'Откатить задачу' })).toBeDisabled()
  expect(steps).toEqual([])
})

test('откат идёт шагами по порядку, отмечает сделанное и по удаче отдаёт окно', async () => {
  let release: () => void = () => {}
  const steps = stubApi(plan, (step) =>
    step === 'copy'
      ? new Promise<Response>((resolve) => (release = () => resolve(new Response(null, { status: 204 }))))
      : new Response(null, { status: 204 }),
  )
  const props = renderModal()
  await stepTexts()

  fireEvent.click(screen.getByRole('button', { name: 'Откатить задачу' }))

  // Пока шаг копии идёт: два сделаны, он идёт, память ждёт; кнопки погашены
  const busy = await screen.findByRole('button', { name: 'Откатывается…' })
  await waitFor(() => expect(steps).toEqual(['session', 'backlog', 'copy']))
  expect(busy).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Отмена' })).toBeDisabled()
  expect(screen.getAllByRole('listitem').map((item) => item.dataset.state)).toEqual(['done', 'done', 'running', 'pending'])

  release()

  await waitFor(() => expect(props.onRolledBack).toHaveBeenCalled())
  expect(steps).toEqual(['session', 'backlog', 'copy', 'memory'])
})

test('упавший шаг останавливает откат: сделанное отмечено, ошибка в окне, повтор проходит все шаги', async () => {
  let fail = true
  const steps = stubApi(plan, (step) =>
    step === 'copy' && fail
      ? Response.json({ problem: 'failed', message: 'Копия не перешла на ветку house-2: error: pathspec' }, { status: 400 })
      : new Response(null, { status: 204 }),
  )
  const props = renderModal()
  await stepTexts()

  fireEvent.click(screen.getByRole('button', { name: 'Откатить задачу' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('Откат остановился')
  expect(alert).toHaveTextContent('Копия не перешла на ветку house-2: error: pathspec')
  expect(screen.getAllByRole('listitem').map((item) => item.dataset.state)).toEqual(['done', 'done', 'failed', 'pending'])
  expect(steps).toEqual(['session', 'backlog', 'copy'])
  expect(props.onRolledBack).not.toHaveBeenCalled()

  fail = false
  fireEvent.click(screen.getByRole('button', { name: 'Откатить задачу' }))

  await waitFor(() => expect(props.onRolledBack).toHaveBeenCalled())
  expect(steps).toEqual(['session', 'backlog', 'copy', 'session', 'backlog', 'copy', 'memory'])
})

test('сессия, открытая уже при открытом окне, останавливает откат отказом', async () => {
  stubApi(plan, (step) =>
    step === 'session' ? Response.json({ problem: 'blocked', message: 'vscode' }, { status: 409 }) : new Response(null, { status: 204 }),
  )
  renderModal()
  await stepTexts()

  fireEvent.click(screen.getByRole('button', { name: 'Откатить задачу' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('открыта сессия задачи в VS Code')
  expect(screen.getByRole('button', { name: 'Откатить задачу' })).toBeDisabled()
})

test('«Отмена» закрывает окно, ничего не откатив', async () => {
  const steps = stubApi(plan)
  const props = renderModal()
  await stepTexts()

  fireEvent.click(screen.getByRole('button', { name: 'Отмена' }))

  expect(props.onClose).toHaveBeenCalled()
  expect(steps).toEqual([])
})

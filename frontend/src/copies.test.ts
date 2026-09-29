import { expect, test } from 'vitest'
import type { WorkspaceRow } from './App'
import { runningTasks } from './copies'

const base = 'D:\\Projects\\app-knowledge'

const row = (task: string | null, extra: Partial<WorkspaceRow> = {}): WorkspaceRow => ({
  project: 'Проект',
  base,
  path: 'D:\\Projects\\noble-keen-walrus',
  branch: 'dev',
  task,
  flowStep: null,
  progress: null,
  status: 'in-work',
  error: null,
  letters: 'B',
  ...extra,
})

test('задачи копий базы — номерами, какими они запускаются', () => {
  expect(
    runningTasks(
      [
        row('в-7 Кириллицей'),
        row('GitHub #037 Оплата падает'),
        row('youtrack abc-12 Письмо о сбросе пароля'),
        row('B-9 Чужая база', { base: 'D:\\Projects\\nota-knowledge' }),
        row('B-10 Сломанная копия', { error: 'Копии нет на диске' }),
        row(null, { status: 'free' }),
      ],
      base,
    ),
  ).toEqual(new Set(['B-7', 'GitHub #37', 'YouTrack ABC-12']))
})

test('номером признаётся только номер буквами проекта — decisions/backlog-numbers.md', () => {
  expect(runningTasks([row('UTF-8 в именах файлов'), row('ORD-3 Чужие буквы'), row('B-4 Без букв', { letters: null })], base)).toEqual(
    new Set(),
  )
})

import { expect, test } from 'vitest'
import type { WorkspaceRow, WorkspaceStatus } from './App'
import { statusChanges } from './statusChanges'

function row(path: string, status: WorkspaceStatus | null, error: string | null = null): WorkspaceRow {
  return {
    project: 'app-knowledge',
    base: 'D:\\Projects\\app-knowledge',
    path,
    branch: 'dev',
    task: status === 'free' || status === null ? null : 'Задача',
    flowStep: null,
    progress: null,
    status,
    error,
  }
}

test('без прошлого опроса смен нет', () => {
  expect(statusChanges(null, [row('D:\\a', 'waiting')])).toEqual([])
})

test('копия начала ждать оператора', () => {
  const next = [row('D:\\a', 'waiting'), row('D:\\b', 'waiting')]
  expect(statusChanges([row('D:\\a', 'in-work'), row('D:\\b', 'free')], next)).toEqual([
    { kind: 'waiting', row: next[0] },
    { kind: 'waiting', row: next[1] },
  ])
})

test('копия освободилась из работы или ожидания', () => {
  const next = [row('D:\\a', 'free'), row('D:\\b', 'free')]
  expect(statusChanges([row('D:\\a', 'in-work'), row('D:\\b', 'waiting')], next)).toEqual([
    { kind: 'freed', row: next[0] },
    { kind: 'freed', row: next[1] },
  ])
})

test('прочие смены и неизменный статус молчат', () => {
  expect(
    statusChanges(
      [row('D:\\a', 'free'), row('D:\\b', 'waiting'), row('D:\\c', 'waiting')],
      [row('D:\\a', 'in-work'), row('D:\\b', 'in-work'), row('D:\\c', 'waiting')],
    ),
  ).toEqual([])
})

test('копия переименованного в базе проекта не теряет смену статуса', () => {
  const next = [{ ...row('D:\\a', 'waiting'), project: 'App' }]
  expect(statusChanges([row('D:\\a', 'in-work')], next)).toEqual([{ kind: 'waiting', row: next[0] }])
})

test('копия с ошибкой чтения, новая или пропавшая из списка молчит', () => {
  expect(
    statusChanges(
      [row('D:\\a', 'in-work'), row('D:\\b', null, 'Копия не найдена'), row('D:\\gone', 'waiting')],
      [row('D:\\a', null, 'Копия не найдена'), row('D:\\b', 'waiting'), row('D:\\new', 'waiting')],
    ),
  ).toEqual([])
})

test('копия осталась с непрочитанным ответом', () => {
  const next = [row('D:\\a', 'unread'), row('D:\\b', 'unread')]
  expect(statusChanges([row('D:\\a', 'waiting'), row('D:\\b', 'in-work')], next)).toEqual([
    { kind: 'unread', row: next[0] },
    { kind: 'unread', row: next[1] },
  ])
})

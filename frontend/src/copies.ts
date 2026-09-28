import type { WorkspaceRow } from './App'
import { normalizeNumber } from './taskTitle'

/**
 * Свободные копии базы: занятая задачей копия вторую не принимает, и запускать в неё нечего.
 * По этому же списку гаснет кнопка записи в бэклоге.
 */
export function freeCopies(rows: WorkspaceRow[], base: string) {
  return rows.filter((row) => row.base === base && row.error === null && row.status === 'free')
}

/**
 * Задачи, которые запускаются или идут в копиях базы, — номерами, какими задача запускается: «B-7», «GitHub #37».
 * Задача в строке копии начата своим номером. Второй раз такую задачу панель не запустит, и кнопка её гаснет (B-89).
 */
export function runningTasks(rows: WorkspaceRow[], base: string): Set<string> {
  const numbers = new Set<string>()
  for (const row of rows) {
    if (row.base !== base || row.error !== null || !row.task) continue
    const issue = /^\s*github\s*#(\d{1,9})(?:\s|$)/i.exec(row.task)
    const number = issue ? `GitHub #${Number(issue[1])}` : normalizeNumber(row.task.trim().split(' ')[0])
    if (number) numbers.add(number)
  }
  return numbers
}

/** Имя копии — имя её каталога: путь почти повторяет его и в строке не нужен. */
export function copyName(path: string) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

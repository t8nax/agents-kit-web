import type { WorkspaceRow } from './App'

/**
 * Свободные копии базы: занятая задачей копия вторую не принимает, и запускать в неё нечего.
 * По этому же списку гаснет кнопка записи в бэклоге.
 */
export function freeCopies(rows: WorkspaceRow[], base: string) {
  return rows.filter((row) => row.base === base && row.error === null && row.status === 'free')
}

import type { WorkspaceRow } from './App'

export type StatusChange = { kind: 'waiting' | 'freed'; row: WorkspaceRow }

export function rowKey(row: WorkspaceRow) {
  return `${row.project}|${row.path}`
}

// Смены статуса между двумя удачными опросами. Без прошлого опроса смен нет;
// копия без статуса (ошибка чтения) или пропавшая из списка ничего не меняет.
export function statusChanges(previous: WorkspaceRow[] | null, next: WorkspaceRow[]): StatusChange[] {
  if (!previous) return []
  const before = new Map(previous.map((row) => [rowKey(row), row.status]))
  const changes: StatusChange[] = []
  for (const row of next) {
    const was = before.get(rowKey(row))
    if (!was || !row.status || was === row.status) continue
    if (row.status === 'waiting') changes.push({ kind: 'waiting', row })
    else if (row.status === 'free') changes.push({ kind: 'freed', row })
  }
  return changes
}

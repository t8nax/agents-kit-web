import { useCallback, useState } from 'react'
import { rowKey, type StatusChange } from './statusChanges'

export type NotificationPermissionState = NotificationPermission | 'unsupported'

export function currentPermission(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

export function useNotificationPermission() {
  const [permission, setPermission] = useState(currentPermission)

  const request = useCallback(() => {
    if (typeof Notification === 'undefined') return
    Notification.requestPermission().then(setPermission, () => setPermission(currentPermission()))
  }, [])

  return { permission, request }
}

export function notifyStatusChange({ kind, row }: StatusChange) {
  if (currentPermission() !== 'granted') return
  const title = kind === 'waiting' ? `${row.project}: ждёт оператора` : `${row.project}: копия свободна`
  const body = kind === 'waiting' && row.task ? `${row.path}\n${row.task}` : row.path
  const notification = new Notification(title, { body, tag: `${kind}|${rowKey(row)}` })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

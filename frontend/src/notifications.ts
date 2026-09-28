import { useCallback, useState } from 'react'
import { rowKey, type StatusChange } from './statusChanges'

export type NotificationPermissionState = NotificationPermission | 'unsupported'

const mutedKey = 'agents-kit-web.notifications-muted'

export function currentPermission(): NotificationPermissionState {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

// Разрешение браузера страница отозвать не может, поэтому выключатель — своя отметка
function isMuted() {
  return localStorage.getItem(mutedKey) === 'true'
}

// Уведомления показываются и держат опрос скрытой вкладки, только когда разрешены и не выключены
export function notificationsActive() {
  return currentPermission() === 'granted' && !isMuted()
}

export function useNotifications() {
  const [permission, setPermission] = useState(currentPermission)
  const [muted, setMuted] = useState(isMuted)

  const request = useCallback(() => {
    if (typeof Notification === 'undefined') return
    // Запрос разрешения — это и включение: иначе после разрешения уведомления остались бы выключенными
    localStorage.removeItem(mutedKey)
    setMuted(false)
    Notification.requestPermission().then(setPermission, () => setPermission(currentPermission()))
  }, [])

  const setEnabled = useCallback((enabled: boolean) => {
    if (enabled) localStorage.removeItem(mutedKey)
    else localStorage.setItem(mutedKey, 'true')
    setMuted(!enabled)
  }, [])

  return { permission, muted, request, setEnabled }
}

const titles: Record<StatusChange['kind'], string> = {
  waiting: 'ждёт оператора',
  unread: 'ответ не прочитан',
  freed: 'копия свободна',
}

export function notifyStatusChange({ kind, row }: StatusChange) {
  if (!notificationsActive()) return
  const title = `${row.project}: ${titles[kind]}`
  const body = kind !== 'freed' && row.task ? `${row.path}\n${row.task}` : row.path
  const notification = new Notification(title, { body, tag: `${kind}|${rowKey(row)}` })
  notification.onclick = () => {
    window.focus()
    notification.close()
  }
}

import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import NotificationsCard from './NotificationsCard'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

function stubNotification(permission: NotificationPermission, requestResult: NotificationPermission = permission) {
  class FakeNotification {
    static permission = permission
    static requestPermission = vi.fn(async () => {
      FakeNotification.permission = requestResult
      return requestResult
    })
  }
  vi.stubGlobal('Notification', FakeNotification)
  return FakeNotification
}

const toggle = () => screen.getByRole('switch', { name: 'Показывать уведомления' })

test('карточка называет себя и подписывает переключатель', () => {
  stubNotification('granted')

  render(<NotificationsCard />)

  expect(screen.getByRole('heading', { name: 'Уведомления' })).toBeInTheDocument()
  expect(screen.getByText('Сообщения браузера, когда копия меняет статус.')).toBeInTheDocument()
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
})

test('до разрешения браузера переключатель выключен, включение спрашивает разрешение', async () => {
  const FakeNotification = stubNotification('default', 'granted')

  render(<NotificationsCard />)
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(toggle())

  await vi.waitFor(() => expect(toggle()).toHaveAttribute('aria-checked', 'true'))
  expect(FakeNotification.requestPermission).toHaveBeenCalledTimes(1)
})

test('отказ в разрешении меняет переключатель на надпись о запрете', async () => {
  stubNotification('default', 'denied')

  render(<NotificationsCard />)
  fireEvent.click(toggle())

  expect(await screen.findByText('Уведомления запрещены в браузере')).toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
})

test('переключатель выключает и включает уведомления без нового запроса, выбор помнится', () => {
  const FakeNotification = stubNotification('granted')

  const { unmount } = render(<NotificationsCard />)
  fireEvent.click(toggle())
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
  unmount()

  render(<NotificationsCard />)
  expect(toggle()).toHaveAttribute('aria-checked', 'false')
  fireEvent.click(toggle())
  expect(toggle()).toHaveAttribute('aria-checked', 'true')
  expect(FakeNotification.requestPermission).not.toHaveBeenCalled()
})

test('запрещённые в браузере уведомления показаны надписью без переключателя', () => {
  stubNotification('denied')

  render(<NotificationsCard />)

  expect(screen.getByText('Уведомления запрещены в браузере')).toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
})

test('браузер без уведомлений показан надписью без переключателя', () => {
  render(<NotificationsCard />)

  expect(screen.getByText('Этот браузер не поддерживает уведомления')).toBeInTheDocument()
  expect(screen.queryByRole('switch')).not.toBeInTheDocument()
})

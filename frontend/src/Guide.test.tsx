import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import Guide from './Guide'

const openPage = (title: string) => {
  const toc = within(screen.getByRole('navigation', { name: 'Страницы руководства' }))
  fireEvent.click(toc.getByRole('button', { name: title }))
}

test('оглавление делится на «Начало» и «Разделы» и открывает страницу раздела', () => {
  render(<Guide />)
  const toc = screen.getByRole('navigation', { name: 'Страницы руководства' })
  expect(within(toc).getByText('Начало')).toBeInTheDocument()
  expect(within(toc).getByText('Разделы')).toBeInTheDocument()

  openPage('Рабочие копии')

  expect(screen.getByRole('heading', { name: 'Рабочие копии', level: 1 })).toBeInTheDocument()
  expect(within(toc).getByRole('button', { name: 'Рабочие копии' })).toHaveAttribute('aria-current', 'page')
  expect(screen.getByText('Раздел панели')).toBeInTheDocument()
})

test('названия из панели рисуются, как в панели: статус плашкой, кнопка плашкой', () => {
  render(<Guide />)
  openPage('Рабочие копии')

  expect(screen.getByText('Ждёт оператора', { selector: '.status-badge' })).toHaveClass('status-waiting')
  expect(screen.getByText('Сессия стоит', { selector: '.status-badge' })).toHaveClass('status-stopped')
  expect(screen.getByText('Ждёт в терминале', { selector: '.status-badge' })).toHaveClass('status-terminal')
  expect(screen.getAllByText('Новая копия', { selector: '.guide-ui' }).length).toBeGreaterThan(0)
  expect(screen.getAllByRole('img', { name: 'меню' }).length).toBeGreaterThan(0)
})

test('частые случаи стоят карточками, а «Назад» и «Дальше» ведут к соседним страницам', () => {
  render(<Guide />)
  openPage('Рабочие копии')

  const cases = screen.getByRole('heading', { name: 'Частые случаи', level: 2 }).closest('section')!
  expect(cases.querySelectorAll('.guide-card')).toHaveLength(5)

  const pager = within(screen.getByRole('navigation', { name: 'Соседние страницы' }))
  expect(pager.getByRole('button', { name: /Назад/ })).toBeInTheDocument()
  expect(pager.getByRole('button', { name: /Дальше/ })).toBeInTheDocument()
})

test('ссылка на другую страницу руководства открывает её в разделе', () => {
  render(<Guide />)
  openPage('Рабочие копии')

  fireEvent.click(screen.getAllByRole('link', { name: '«Бэклога»' })[0])

  const toc = within(screen.getByRole('navigation', { name: 'Страницы руководства' }))
  expect(toc.getByRole('button', { current: 'page' })).not.toHaveAccessibleName('Рабочие копии')
})

import { render, screen } from '@testing-library/react'
import { expect, test } from 'vitest'
import { InlineMarkdown, Markdown } from './Markdown'

test('голый адрес становится ссылкой в новую вкладку', () => {
  render(<Markdown text="Объявление: https://example.com/tickets/OPS-1" />)

  const link = screen.getByRole('link', { name: 'https://example.com/tickets/OPS-1' })
  expect(link).toHaveAttribute('href', 'https://example.com/tickets/OPS-1')
  expect(link).toHaveAttribute('target', '_blank')
  expect(link).toHaveAttribute('rel', 'noopener noreferrer')
})

test('ссылка разметкой тоже открывается в новой вкладке, без значка', () => {
  const { container } = render(<Markdown text="См. [заявку](https://example.com/t/1)." />)

  const link = screen.getByRole('link', { name: 'заявку' })
  expect(link).toHaveAttribute('target', '_blank')
  expect(container.querySelector('svg')).toBeNull()
})

test('в строке заголовка адрес тоже ссылка в новую вкладку', () => {
  render(<InlineMarkdown text="1. Смотреть https://example.com/a" />)

  const link = screen.getByRole('link', { name: 'https://example.com/a' })
  expect(link).toHaveAttribute('target', '_blank')
  expect(screen.getByText(/1\. Смотреть/)).toBeInTheDocument()
})

test('HTML и опасные схемы не исполняются, пути остаются текстом', () => {
  const { container } = render(
    <Markdown text={'<b>жирный</b> <script>alert(1)</script>\n\n[клик](javascript:alert(1))\n\n\\\\fs01\\reports и D:\\Projects\\app'} />,
  )

  expect(container.querySelector('b')).toBeNull()
  expect(container.querySelector('script')).toBeNull()
  expect(container).toHaveTextContent('<b>жирный</b>')
  const links = container.querySelectorAll('a')
  expect(links).toHaveLength(1)
  expect(links[0].getAttribute('href') ?? '').not.toMatch(/javascript/i)
  // markdown съедает одну косую черту в «\\», как и до GFM: здесь важно только, что путь не ссылка
  expect(container).toHaveTextContent('fs01\\reports и D:\\Projects\\app')
})

test('таблица, зачёркивание и список с галочками показываются разметкой', () => {
  const { container } = render(
    <Markdown text={'| a | b |\n| - | - |\n| 1 | 2 |\n\n~~старое~~\n\n- [x] сделано\n- [ ] нет'} />,
  )

  expect(container.querySelector('table')).not.toBeNull()
  expect(container.querySelector('del')).toHaveTextContent('старое')
  expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(2)
})

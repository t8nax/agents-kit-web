import { render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import Trackers from './Trackers'

afterEach(() => {
  vi.unstubAllGlobals()
})

// Ревью B-288 и B-285: битый файл ключей раздел называет сразу и с путём, а не молча прячет строку ключа
test('битый файл ключей к серверам — красная строка с его путём', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/trackers'
        ? Response.json({ problem: 'file-broken', detail: 'C:\\Users\\op\\AppData\\Local\\agents-kit-web\\trackers.json' }, { status: 500 })
        : Response.json([]),
    ),
  )

  render(<Trackers />)

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Файл ключей к серверам трекеров не разобран: C:\\Users\\op\\AppData\\Local\\agents-kit-web\\trackers.json. Поправьте или удалите его — после удаления ключи придётся ввести заново.',
  )
})

test('файл ключей прочитан — строки о нём нет', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))

  render(<Trackers />)

  expect(await screen.findByText('Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».')).toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

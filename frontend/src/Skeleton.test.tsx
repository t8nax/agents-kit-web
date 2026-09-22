import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { Sk, Skeleton } from './Skeleton'

describe('Skeleton', () => {
  it('говорит, что грузится, не показывая слов на экране', () => {
    render(
      <Skeleton label="Загрузка бэклога">
        <Sk w={120} />
      </Skeleton>,
    )

    const skeleton = screen.getByRole('status', { name: 'Загрузка бэклога' })
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
    expect(skeleton).toHaveTextContent('')
  })

  it('задаёт полосе ширину числом в пикселях, строкой — как есть', () => {
    const { container } = render(
      <>
        <Sk w={120} h={14} className="sk-pill" />
        <Sk w="46%" />
      </>,
    )

    const [pill, wide] = container.querySelectorAll('.sk')
    expect(pill).toHaveClass('sk-pill')
    expect(pill).toHaveStyle({ width: '120px', height: '14px' })
    expect(wide).toHaveStyle({ width: '46%', height: '10px' })
  })
})

import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SKELETON_DELAY_MS, useReveal } from './reveal'
import { Sk, Skeleton } from './Skeleton'

afterEach(() => vi.useRealTimers())

describe('Skeleton', () => {
  it('говорит, что грузится, не показывая слов на экране', () => {
    render(
      <Skeleton label="Загрузка бэклога" shown>
        <Sk w={120} />
      </Skeleton>,
    )

    const skeleton = screen.getByRole('status', { name: 'Загрузка бэклога' })
    expect(skeleton).toHaveAttribute('aria-busy', 'true')
    expect(skeleton).toHaveTextContent('')
    // Полосы читать нечего: диктор слышит только, что грузится
    expect(skeleton.firstElementChild).toHaveAttribute('aria-hidden', 'true')
  })

  it('пока загрузка не затянулась, полосы держат место невидимыми', () => {
    const { rerender } = render(
      <Skeleton label="Загрузка бэклога" shown={false}>
        <Sk w={120} />
      </Skeleton>,
    )
    const content = screen.getByRole('status', { name: 'Загрузка бэклога' }).firstElementChild
    expect(content).toHaveClass('sk-wait')

    rerender(
      <Skeleton label="Загрузка бэклога" shown>
        <Sk w={120} />
      </Skeleton>,
    )
    expect(content).not.toHaveClass('sk-wait')
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

describe('useReveal', () => {
  it('быстрая загрузка — без полос и без проявления', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ loading }) => useReveal(loading), { initialProps: { loading: true } })

    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS - 1))
    expect(result.current.shown).toBe(false)
    rerender({ loading: false })
    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS))

    expect(result.current.shown).toBe(false)
    expect(result.current.className).toBe('')
  })

  it('затянувшаяся загрузка показывает полосы, а пришедшее содержимое проявляет', () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ loading }) => useReveal(loading), { initialProps: { loading: true } })

    act(() => vi.advanceTimersByTime(SKELETON_DELAY_MS))
    expect(result.current.shown).toBe(true)
    rerender({ loading: false })

    expect(result.current.shown).toBe(false)
    expect(result.current.className).toBe('loaded')
  })
})

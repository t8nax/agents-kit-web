import { useState, type AnimationEvent } from 'react'

/**
 * Проявление содержимого на месте заготовки: класс `loaded` стоит, пока идёт анимация, и снимается
 * по её концу. Оставленный класс держал бы у обёртки свой слой отрисовки — окно внутри раздела уходило
 * под сайдбар, — и повторял бы проявление, когда блок монтируется заново над уже прочитанными данными
 * (возврат в «Рабочие копии», выход из выбора папки в «Настройках»). Новая заготовка — loading —
 * взводит проявление снова.
 * При «уменьшить движение» анимации нет, конца её не приходит, и класс остаётся — это безвредно:
 * без анимации своего слоя у обёртки нет.
 */
export function useReveal(loading: boolean) {
  const [done, setDone] = useState(false)
  if (loading && done) setDone(false)
  return {
    className: done ? '' : 'loaded',
    onAnimationEnd: (event: AnimationEvent) => {
      if (event.animationName === 'loaded-in') setDone(true)
    },
  }
}

/** Классы элемента вместе с классом проявления, если он сейчас нужен. */
export function withReveal(className: string, reveal: { className: string }) {
  return reveal.className ? `${className} ${reveal.className}` : className
}

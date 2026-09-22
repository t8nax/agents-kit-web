import { useEffect, useState, type AnimationEvent } from 'react'

/**
 * Сколько раздел читает данные, прежде чем показать заготовку. Быстрая загрузка обходится без неё:
 * полосы на долю секунды и следом проявление мигали — замечание оператора на приёмке B-201.
 */
export const SKELETON_DELAY_MS = 300

/**
 * Проявление содержимого на месте заготовки. Взводится, только если заготовку успели показать, —
 * загрузка шла дольше SKELETON_DELAY_MS; быстрая загрузка ставит содержимое сразу, без проявления.
 * Класс `loaded` стоит, пока идёт анимация, и снимается по её концу. Оставленный класс держал бы
 * у обёртки свой слой отрисовки — окно внутри раздела уходило под сайдбар, — и повторял бы проявление,
 * когда блок монтируется заново над уже прочитанными данными (возврат в «Рабочие копии», выход из выбора
 * папки в «Настройках»).
 * При «уменьшить движение» анимации нет, конца её не приходит, и класс остаётся — это безвредно:
 * без анимации своего слоя у обёртки нет.
 */
export function useReveal(loading: boolean) {
  const [done, setDone] = useState(true)
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => setDone(false), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])
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

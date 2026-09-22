import { useEffect, useState, type AnimationEvent } from 'react'

/**
 * Сколько раздел читает данные, прежде чем показать заготовку. Быстрая загрузка обходится без неё:
 * полосы на долю секунды и следом проявление мигали — замечание оператора на приёмке B-201.
 */
export const SKELETON_DELAY_MS = 300

/**
 * Заготовка и проявление раздела с одним счётом времени. Пока идёт загрузка, `shown` становится истинным
 * через SKELETON_DELAY_MS: до того заготовка держит место невидимой, и быстрая загрузка ставит содержимое
 * сразу, без полос и без проявления. Проявление взводится тем же сроком — только если полосы успели
 * показать, — и новая загрузка взводит его снова. loading — «идёт загрузка и на её месте заготовка»:
 * сбой вместо заготовки проявления не взводит.
 * Класс `loaded` стоит, пока идёт анимация, и снимается по её концу. Оставленный класс держал бы
 * у обёртки свой слой отрисовки — окно внутри раздела уходило под сайдбар, — и повторял бы проявление,
 * когда блок монтируется заново над уже прочитанными данными (возврат в «Рабочие копии», выход из выбора
 * папки в «Настройках»).
 * При «уменьшить движение» анимации нет, конца её не приходит, и класс остаётся — это безвредно:
 * без анимации своего слоя у обёртки нет.
 */
export function useReveal(loading: boolean) {
  const [shown, setShown] = useState(false)
  const [done, setDone] = useState(true)
  if (!loading && shown) setShown(false)
  useEffect(() => {
    if (!loading) return
    const timer = setTimeout(() => {
      setShown(true)
      setDone(false)
    }, SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [loading])
  return {
    shown: loading && shown,
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

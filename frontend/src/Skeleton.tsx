import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { SKELETON_DELAY_MS } from './reveal'
import './Skeleton.css'

/**
 * Полоса заготовки: серый прямоугольник размера будущего текста или элемента.
 * Число — ширина в пикселях, строка — любая ширина CSS («46%»).
 */
export function Sk({
  w,
  h = 10,
  className = '',
  style,
}: {
  w: number | string
  h?: number
  className?: string
  style?: CSSProperties
}) {
  return (
    <span
      className={className ? `sk ${className}` : 'sk'}
      style={{ width: typeof w === 'number' ? `${w}px` : w, height: `${h}px`, ...style }}
    />
  )
}

/**
 * Заготовка раздела, пока он в первый раз читает свои данные: полосы в форме того, что придёт.
 * label — что грузится, словами: его читает программа для незрячих, на экране его нет. Сами полосы
 * и настоящая шапка колонок под ними от неё скрыты — читать в них нечего. Видны полосы становятся
 * через SKELETON_DELAY_MS: быструю загрузку они не успевают перемигнуть, а место держат сразу.
 */
export function Skeleton({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), SKELETON_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <div className={className} role="status" aria-busy="true" aria-label={label}>
      <div className={shown ? 'sk-content' : 'sk-content sk-wait'} aria-hidden="true">
        {children}
      </div>
    </div>
  )
}

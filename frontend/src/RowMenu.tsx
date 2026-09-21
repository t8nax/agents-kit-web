import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * Меню действий строки таблицы: кнопка-точки и всплывающий список пунктов. Переходов в строке бывает
 * больше одного, и в строке они занимают больше места, чем стоят, — решение оператора. Пункты рисует
 * тот, кто меню вставляет; close закрывает его перед самим действием.
 */
export default function RowMenu({
  label,
  disabled = false,
  buttonClassName = 'action-btn-menu',
  title = 'Действия',
  children,
}: {
  label: string
  disabled?: boolean
  /** Вид кнопки-точек: в шапке раздела она стоит рядом с кнопками шапки и их размера. */
  buttonClassName?: string
  title?: string
  children: (close: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const host = useRef<HTMLDivElement>(null)

  // Меню закрывает и клик мимо него, и Escape: оно перекрывает соседние строки таблицы.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!host.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="row-menu" ref={host}>
      <button
        type="button"
        className={buttonClassName}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title}
        disabled={disabled}
        onClick={() => setOpen((was) => !was)}
      >
        <DotsIcon />
      </button>
      {open && (
        <div className="row-menu-popup" role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  )
}

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  )
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import './PickMenu.css'

export type PickOption = {
  id: string
  label: string
  /** Плашка рядом с названием — в списке и на кнопке, когда пункт выбран. */
  tag?: ReactNode
  /** Вторая строка пункта в раскрытом списке — на кнопке её нет. */
  note?: string | null
  title?: string
}

/**
 * Выбор из списка кнопкой: проект и флоу в разделе «Флоу», проект и копия в разговоре с Чудо-Юдо. В раскрытом
 * списке — названия, у выбранного — галочка.
 */
export default function PickMenu({
  label,
  value,
  options,
  selected,
  disabled = false,
  onPick,
}: {
  label: string
  value: string
  options: PickOption[]
  selected: string | null
  disabled?: boolean
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.id === selected)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div className="flow-pick" ref={box} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="flow-pick-btn"
        aria-label={`${label}: ${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {value}
        {current?.tag}
        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {open && (
        <ul className="flow-pick-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li
              key={option.id}
              role="option"
              aria-selected={option.id === selected}
              tabIndex={0}
              title={option.title}
              onClick={() => {
                onPick(option.id)
                setOpen(false)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onPick(option.id)
                setOpen(false)
              }}
            >
              {option.note === undefined ? (
                <>
                  {option.label}
                  {option.tag}
                </>
              ) : (
                <span className="flow-pick-item">
                  <span className="flow-pick-name">
                    {option.label}
                    {option.tag}
                  </span>
                  {option.note && <span className="flow-pick-note">{option.note}</span>}
                </span>
              )}
              {option.id === selected && (
                <span className="flow-pick-check">
                  <TickIcon />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

export function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  )
}

export function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

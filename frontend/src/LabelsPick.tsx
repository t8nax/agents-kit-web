import { useEffect, useRef, useState } from 'react'
import { samePicked, type PickedLabel } from './backlogView'
import { ChevronDownIcon, ChevronUpIcon } from './PickMenu'

/** Метки одного проекта в списке фильтра: все метки его репозитория. */
export type LabelGroup = { base: string; project: string; labels: string[] }

/** Сколько названий выбранных меток кнопка пишет сама; остальные — плашкой «+N». */
const NAMED = 3

/**
 * Фильтр «Метки» вкладки задач трекера (B-305): кнопка со списком галочек, выбор нескольких меток. Названия выбранных
 * стоят на самой кнопке, не влезшие — плашкой «+N» (вариант Б макета). Меток нескольких проектов список делит
 * по проектам с подписями: метка выбирается у своего проекта. Снимают метку в самом списке.
 */
export default function LabelsPick({
  groups,
  picked,
  onToggle,
}: {
  groups: LabelGroup[]
  /** Выбранные метки видимых проектов — те, что отбирают сейчас. */
  picked: PickedLabel[]
  onToggle: (label: PickedLabel) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const names = picked.map((label) => label.name)
  const shown = names.slice(0, NAMED)
  const more = names.length - shown.length
  const headed = groups.length > 1

  return (
    <div
      className="labels-pick"
      ref={box}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        setOpen(false)
        button.current?.focus()
      }}
    >
      <button
        ref={button}
        type="button"
        className={`labels-btn ${names.length > 0 ? 'has-picked' : ''}`}
        aria-label={names.length > 0 ? `Метки: ${names.join(', ')}` : 'Метки'}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {names.length > 0 ? (
          <>
            <span className="lbl-key">Метки:</span>
            <span className="lbl-names">{shown.join(', ')}</span>
            {more > 0 && <span className="lbl-more">+{more}</span>}
          </>
        ) : (
          'Метки'
        )}
        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {open && (
        <div className="labels-menu" role="listbox" aria-label="Метки" aria-multiselectable="true">
          {groups.map((group, index) => (
            <div key={group.base} role="group" aria-label={headed ? group.project : undefined}>
              {headed && index > 0 && <div className="labels-sep" aria-hidden="true" />}
              {headed && (
                <div className="labels-group" aria-hidden="true">
                  {group.project}
                </div>
              )}
              {group.labels.length === 0 && <div className="labels-none">Меток в репозитории нет</div>}
              {group.labels.map((name) => {
                const label = { base: group.base, name }
                const on = picked.some((one) => samePicked(one, label))
                const toggle = () => onToggle(label)
                return (
                  <div
                    key={name}
                    role="option"
                    aria-selected={on}
                    tabIndex={0}
                    className={`labels-opt ${on ? 'on' : ''}`}
                    onClick={toggle}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      toggle()
                    }}
                  >
                    <span className="labels-box" aria-hidden="true">
                      <TickIcon />
                    </span>
                    {name}
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

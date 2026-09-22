import './Choice.css'

/** Значок строки выбора: кружок, у выбранного залит и с галочкой. Стоит рядом со спрятанным radio внутри `label.choice`. */
export function ChoiceMark() {
  return (
    <span className="choice-mark" aria-hidden="true">
      <svg viewBox="0 0 24 24">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    </span>
  )
}

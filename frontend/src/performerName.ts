/**
 * Имя исполнителя: полное — то, каким его зовёт шаг флоу и каким назван его файл, короткое — то, что
 * видит оператор. Приставка проекта живёт только в полном имени. Правило то же, что у API
 * (Performers/PerformerName.cs): список исполнителей приходит короткими именами, а во флоу стоят полные,
 * поэтому сверять и записывать имя без приставки нельзя.
 */

/** Полное имя — то, как исполнителя зовёт шаг флоу. Приставки у проекта нет — имя остаётся как есть. */
export const fullName = (prefix: string, name: string) => (prefix ? `${prefix}-${name}` : name)

/** Имя без приставки; приставка чужая или её нет — null: исполнитель не этого проекта. */
export function shortName(prefix: string, full: string): string | null {
  if (!prefix) return null
  const head = `${prefix}-`
  return full.startsWith(head) && full.length > head.length ? full.slice(head.length) : null
}

/** Имя так, как его видит оператор: своё — без приставки, чужое — целиком. */
export const shownName = (prefix: string, full: string) => shortName(prefix, full) ?? full

/** Исполнитель этого проекта заведён: имя из флоу совпало с коротким именем из списка. */
export function knownPerformer(prefix: string, known: string[], full: string) {
  const short = shortName(prefix, full.trim())
  return short !== null && known.includes(short)
}

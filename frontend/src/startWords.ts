// Набранные начальные слова задачи живут в браузере оператора у каждой записи бэклога своими,
// пока задачу не запустили: закрытое окно их не теряет — решение оператора на B-197.
function wordsKey(base: string, number: string) {
  return `agents-kit-web.start-words|${base}|${number}`
}

export function readStartWords(base: string, number: string): string {
  try {
    return localStorage.getItem(wordsKey(base, number)) ?? ''
  } catch {
    return ''
  }
}

export function saveStartWords(base: string, number: string, text: string) {
  try {
    if (text === '') localStorage.removeItem(wordsKey(base, number))
    else localStorage.setItem(wordsKey(base, number), text)
  } catch {
    // хранилище недоступно — окно работает, как без черновика
  }
}

// Черновики записей, которых в прочитанном бэклоге больше нет, забываются — как черновики ответов на ушедшие
// вопросы: запись взяли не из панели или удалили, а номер новой записи не достаётся. Бэклог базы не прочитан —
// её черновики остаются; базы нет в списке панели — уходят и они.
export function forgetGoneStartWords(backlogs: { base: string; entries: { number: string | null }[]; error: string | null }[]) {
  try {
    const prefix = 'agents-kit-web.start-words|'
    const kept = new Set<string>()
    const unread = new Set<string>()
    for (const backlog of backlogs) {
      if (backlog.error !== null) unread.add(backlog.base)
      for (const entry of backlog.entries) if (entry.number) kept.add(wordsKey(backlog.base, entry.number))
    }
    const gone: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key === null || !key.startsWith(prefix) || kept.has(key)) continue
      const base = key.slice(prefix.length, key.lastIndexOf('|'))
      if (!unread.has(base)) gone.push(key)
    }
    for (const key of gone) localStorage.removeItem(key)
  } catch {
    // хранилище недоступно — забывать нечего
  }
}

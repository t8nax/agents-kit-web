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

const prefix = 'agents-kit-web.start-words|'

// Задачи трекера держат черновики под своим именем — «GitHub #37»: их забывает чтение трекера, а не бэклога.
const trackerName = /^GitHub #\d+$/

// Черновики записей, которых в прочитанном бэклоге больше нет, забываются — как черновики ответов на ушедшие
// вопросы: запись взяли не из панели или удалили, а номер новой записи не достаётся. Бэклог базы не прочитан —
// её черновики остаются; базы нет в списке панели — уходят и они.
export function forgetGoneStartWords(backlogs: { base: string; entries: { number: string | null }[]; error: string | null }[]) {
  const kept = new Set<string>()
  const unread = new Set<string>()
  const listed = new Set(backlogs.map((backlog) => backlog.base))
  for (const backlog of backlogs) {
    if (backlog.error !== null) unread.add(backlog.base)
    for (const entry of backlog.entries) if (entry.number) kept.add(wordsKey(backlog.base, entry.number))
  }
  forget((key, base, number) => {
    if (kept.has(key) || unread.has(base)) return false
    return !trackerName.test(number) || !listed.has(base)
  })
}

// Черновики задач трекера базы, которых среди прочитанных открытых и назначенных на оператора больше нет, забываются;
// трекер не прочитан — остаются.
export function forgetGoneIssueWords(base: string, names: string[]) {
  const kept = new Set(names)
  forget((_, keyBase, number) => keyBase === base && trackerName.test(number) && !kept.has(number))
}

function forget(gone: (key: string, base: string, number: string) => boolean) {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key === null || !key.startsWith(prefix)) continue
      const split = key.lastIndexOf('|')
      if (gone(key, key.slice(prefix.length, split), key.slice(split + 1))) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // хранилище недоступно — забывать нечего
  }
}

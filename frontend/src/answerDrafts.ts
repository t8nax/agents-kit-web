// Набранные, но не отправленные ответы живут в браузере оператора, а не в базе:
// панель пишет в базы только сам ответ.
type Drafts = Record<string, string>

function draftsKey(base: string, copy: string) {
  return `agents-kit-web.answer-drafts|${base}|${copy}`
}

function read(key: string): Drafts {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as Drafts) : {}
  } catch {
    return {}
  }
}

function write(key: string, drafts: Drafts) {
  try {
    if (Object.keys(drafts).length === 0) localStorage.removeItem(key)
    else localStorage.setItem(key, JSON.stringify(drafts))
  } catch {
    // хранилище недоступно — окно работает, как без черновиков
  }
}

// Черновики к вопросам, которых в памяти уже нет или на которые ответили, не возвращаются и забываются
export function takeDrafts(base: string, copy: string, titles: string[]): string[] {
  const key = draftsKey(base, copy)
  const stored = read(key)
  const kept: Drafts = {}
  for (const title of titles) {
    if (typeof stored[title] === 'string' && stored[title] !== '') kept[title] = stored[title]
  }
  write(key, kept)
  return titles.map((title) => kept[title] ?? '')
}

export function saveDraft(base: string, copy: string, title: string, text: string) {
  const key = draftsKey(base, copy)
  const drafts = read(key)
  if (text === '') delete drafts[title]
  else drafts[title] = text
  write(key, drafts)
}

export function forgetDrafts(base: string, copy: string, titles: string[]) {
  const key = draftsKey(base, copy)
  const drafts = read(key)
  for (const title of titles) delete drafts[title]
  write(key, drafts)
}

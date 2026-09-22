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

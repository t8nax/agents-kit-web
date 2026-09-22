// Номер записи бэклога по правилу кита: буквы проекта и число, «ORD-12». Буквы — латиница и цифры,
// первый знак буква, не больше десяти знаков. Регистр и кириллические двойники латинских букв
// в номере, набранном руками, ничего не значат: «в-7» — тот же номер, что «B-7».
const format = /^([A-Z][A-Z0-9]{0,9})-\d+$/

export const twins: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
}

/** Номер в виде кита — латиницей и прописными; не номер — null. */
export function normalizeNumber(text: string): string | null {
  const number = [...text.trim().toUpperCase()].map((c) => twins[c] ?? c).join('')
  return format.test(number) ? number : null
}

/** Буквы номера: «ORD-12» → «ORD»; не номер — null. */
export function numberLetters(number: string): string | null {
  return format.exec(normalizeNumber(number) ?? '')?.[1] ?? null
}

// Задача из бэклога начинает заголовок памяти своим номером: «ORD-24 Номер задачи…». Номером первое слово
// считается, только если оно начато буквами проекта: заголовок «UTF-8 в именах файлов» номера не несёт.
// Букв проекта панель не знает — номера не отделить. У задачи не из бэклога номера нет.
const numbered = /^(\S+)\s+(.+)$/

export function splitTask(task: string, letters: string | null | undefined): { number: string | null; title: string } {
  const match = numbered.exec(task)
  const number = match ? normalizeNumber(match[1]) : null
  return number && letters && numberLetters(number) === letters
    ? { number, title: match![2] }
    : { number: null, title: task }
}

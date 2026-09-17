// Задача из бэклога начинает заголовок памяти своим номером: «B-24 Номер задачи…».
// Номер пишется латиницей — так его пишет кит; у задачи не из бэклога номера нет.
const numbered = /^(B-\d+)\s+(.+)$/

export function splitTask(task: string): { number: string | null; title: string } {
  const match = numbered.exec(task)
  return match ? { number: match[1], title: match[2] } : { number: null, title: task }
}

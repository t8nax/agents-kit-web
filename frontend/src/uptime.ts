/**
 * Сколько сессия живёт: «14 мин», «2 ч 14 мин», «1 д 03 ч». Время старта реестр пишет в миллисекундах
 * epoch; его нет или оно из будущего — показывать нечего.
 */
export function uptime(startedAt: number | null, now: number): string {
  if (startedAt === null || !Number.isFinite(startedAt)) return '—'
  const minutes = Math.floor((now - startedAt) / 60000)
  if (minutes < 0) return '—'
  if (minutes < 60) return `${minutes} мин`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} ч ${pad(minutes % 60)} мин`
  return `${Math.floor(hours / 24)} д ${pad(hours % 24)} ч`
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

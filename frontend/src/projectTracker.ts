import type { TrackerInfo } from './tracker'

/**
 * Описание трекера проекта полями окна (B-293): три строки раздела «Где задачи» и слова пяти разделов кита —
 * where — «Где задачи» под строками, backlog — «Показ бэклога», take — «Взятие задачи», closed — «Задача закрыта»,
 * move — «Вынос записи бэклога».
 */
export type TrackerDescription = {
  tracker: string
  server: string
  project: string
  where: string
  backlog: string
  take: string
  closed: string
  move: string
}

export type DescriptionField = keyof TrackerDescription

/** Сколько строк и разделов описания тронул ответ агента. */
export type TrackerChanged = { lines: number; sections: number }

/** Задача трекера в работе: заголовок её памяти и копия. */
export type TrackerTask = { task: string; copy: string | null }

/** Строка карточки «Трекеры проектов» — база из списка панели. */
export type ProjectTrackerRow = {
  base: string
  project: string
  /** База не читается: слова раскладки. */
  problem: string | null
  /** Трекер, как его читает «Бэклог»; null — описания нет. */
  tracker: TrackerInfo | null
  description: TrackerDescription | null
  /** Отпечаток описания, поверх которого пишется правка; '' — описания нет. */
  version: string
  busy: TrackerTask[]
  newerFormat: boolean
  /** Что в описании сверка кита назовёт красным — по полям окна. */
  faults?: Partial<Record<DescriptionField, string>> | null
}

/** Трекеры, которые панель заводит, — все четыре из таблицы кита, в порядке макета. */
export const trackerNames = ['GitHub', 'GitLab', 'Jira', 'YouTrack'] as const

export type TrackerName = (typeof trackerNames)[number]

/** Имя трекера, как в таблице кита; не из таблицы — null. */
export function knownTracker(name: string | null | undefined): TrackerName | null {
  const lower = (name ?? '').trim().toLowerCase()
  return trackerNames.find((one) => one.toLowerCase() === lower) ?? null
}

/** Трекеры, задачи которых панель читает и проверяет перед записью описания. */
export function checked(name: TrackerName | null): boolean {
  return name === 'GitHub' || name === 'YouTrack'
}

export const emptyDescription: TrackerDescription = {
  tracker: '',
  server: '',
  project: '',
  where: '',
  backlog: '',
  take: '',
  closed: '',
  move: '',
}

/** Одно и то же значение поля: без пробелов по краям и разницы в переводах строк — как считает API. */
export function sameValue(a: string, b: string): boolean {
  const clean = (text: string) =>
    text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim()
  return clean(a) === clean(b)
}

export function sameField(field: DescriptionField, a: TrackerDescription, b: TrackerDescription): boolean {
  return field === 'tracker'
    ? (knownTracker(a.tracker) ?? a.tracker.trim()) === (knownTracker(b.tracker) ?? b.tracker.trim())
    : sameValue(a[field], b[field])
}

export const serverPlaceholder: Record<TrackerName, string> = {
  GitHub: 'https://github.com',
  GitLab: 'https://gitlab.com',
  Jira: 'https://acme.atlassian.net',
  YouTrack: 'https://acme.youtrack.cloud',
}

export const projectPlaceholder: Record<TrackerName, string> = {
  GitHub: 'владелец/репозиторий',
  GitLab: 'группа/проект',
  Jira: 'Ключ проекта, например PAY',
  YouTrack: 'ID проекта, например ABC',
}

export const sections: { field: Exclude<DescriptionField, 'tracker' | 'server' | 'project'>; label: string; hint: string }[] = [
  { field: 'where', label: 'Где задачи', hint: 'Чем ходить в трекер: программа, MCP-сервер, CLI' },
  { field: 'backlog', label: 'Показ бэклога', hint: 'Какие задачи показывать в бэклоге' },
  { field: 'take', label: 'Взятие задачи', hint: 'Что менять в задаче, когда её берут в работу' },
  { field: 'closed', label: 'Задача закрыта', hint: 'Что менять при закрытии, или «ничего, её закрывает мерж»' },
  { field: 'move', label: 'Вынос записи бэклога', hint: 'Куда и с какими полями заводить задачу из записи бэклога' },
]

/** Номер задачи трекера из заголовка её памяти: «GitHub #37 Выгрузка» — «#37», «Jira PAY-7 …» — «PAY-7». */
export function taskNumber(task: string): string {
  return /^\s*\S+\s*(#\d+|[A-Za-z][A-Za-z0-9_]*-\d+)/.exec(task)?.[1] ?? task
}

/** Имя копии — последняя папка её пути. */
export function copyName(path: string | null): string {
  return path?.split(/[\\/]/).filter(Boolean).pop() ?? 'без пути'
}

function listed(items: string[]): string {
  return items.length === 1 ? items[0] : `${items.slice(0, -1).join(', ')} и ${items[items.length - 1]}`
}

const faultLabels: Record<DescriptionField, string> = {
  tracker: 'вид трекера',
  server: 'адрес сервера',
  project: 'проект',
  where: 'раздел «Где задачи»',
  backlog: 'раздел «Показ бэклога»',
  take: 'раздел «Взятие задачи»',
  closed: 'раздел «Задача закрыта»',
  move: 'раздел «Вынос записи бэклога»',
}

/** Поломки описания, которые кит назовёт красными, — строкой под проектом в карточке (ревью B-293). */
export function kitFaultsText(faults: Partial<Record<DescriptionField, string>> | null | undefined): string | null {
  const named = Object.keys(faults ?? {}).map((field) => faultLabels[field as DescriptionField] ?? field)
  if (named.length === 0) return null
  return `Описание трекера записано не так, как требует кит: ${listed(named)}. Исправьте его кнопкой «Изменить».`
}

/** Почему описание не удалить: копии, где идут задачи из этого трекера (ответ оператора на B-293). */
export function busyText(busy: TrackerTask[]): string {
  const copies = [...new Set(busy.map((one) => copyName(one.copy)))]
  const tasks = busy.map((one) => taskNumber(one.task))
  return copies.length === 1 && tasks.length === 1
    ? `Трекер не удалить: в копии ${copies[0]} идёт задача из него — ${tasks[0]}.`
    : `Трекер не удалить: в ${copies.length === 1 ? 'копии' : 'копиях'} ${listed(copies)} идут задачи из него — ${listed(tasks)}.`
}

/** Каких строк нет или какие записаны не так — красной строкой под проектом, как у «Бэклога» (B-288). */
export function faultsText(faults: string[] | null | undefined): string {
  const named = (faults?.length ? faults : ['трекер', 'сервер', 'проект']).map((key) => `«${key}:»`)
  return named.length === 1
    ? `В описании трекера нет строки ${named[0]} или она записана не так.`
    : `В описании трекера нет строк ${listed(named)} или они записаны не так.`
}

/**
 * Почему трекер не прочитан при проверке перед записью — теми же словами, что причины «Бэклога», с концовкой
 * «Описание не записано.»
 */
export function checkText(code: string, detail: string | null | undefined, description: TrackerDescription): string {
  const server = description.server.trim()
  const project = description.project.trim()
  const card = 'в карточке «Серверы трекеров»'
  const said = (() => {
    switch (code) {
      case 'project-missing':
        return `На сервере ${server} нет проекта ${project} или у вашего ключа нет к нему доступа.`
      case 'repo-unreachable':
        return `GitHub не нашёл репозиторий ${project} или у вашего аккаунта нет к нему доступа${detail ? `: ${detail}` : ''}.`
      case 'no-key':
        return `Для сервера ${server} нет ключа. Добавьте сервер и ключ ${card}.`
      case 'key-rejected':
        return `Сервер ${server} отклонил ключ. Замените ключ ${card}.`
      case 'key-unreadable':
        return `Ключ сервера ${server} не прочитать на этом компьютере. Замените ключ ${card}.`
      case 'key-forbidden':
        return `Сервер ${server} принял ключ, но у его владельца нет прав на проект ${project}.`
      case 'server-silent':
        return `Сервер ${server} не ответил: ${detail ?? 'нет связи'}.`
      case 'gh-missing':
        return 'Программа gh не установлена. Установите GitHub CLI и войдите в аккаунт командой gh auth login.'
      case 'gh-login':
        return 'Программа gh не вошла в аккаунт GitHub. Войдите командой gh auth login.'
      case 'youtrack-error':
        return `YouTrack ответил ошибкой: ${detail ?? code}.`
      default:
        return `GitHub ответил ошибкой: ${detail ?? code}.`
    }
  })()
  return `${said} Описание не записано.`
}

/** Отказ записи или удаления описания, как его отдаёт API. */
export type TrackerRejected = {
  problem: string
  detail?: string | null
  faults?: Partial<Record<DescriptionField, string>> | null
  field?: DescriptionField | null
  code?: string | null
  busy?: TrackerTask[] | null
}

/** Отказ словами для оператора; output — дословный вывод кита или git, если он есть. */
export function rejectedText(rejected: TrackerRejected): { text: string; output?: string } {
  switch (rejected.problem) {
    case 'changed':
      return { text: 'Описание трекера изменилось с тех пор, как окно его прочитало. Панель перечитала его — проверьте правки и примите их снова.' }
    case 'dirty':
      return { text: 'В описании трекера есть незаписанная правка другой сессии. Её нужно записать или убрать в самой сессии.' }
    case 'busy':
      return { text: busyText(rejected.busy ?? []) }
    case 'newer-format':
      return { text: rejected.detail ?? 'Правка закрыта: кит перевёл базу на формат, которого эта версия панели не знает.' }
    case 'kit-not-set':
      return { text: 'Путь к киту не задан, а базу с сервером сводит скрипт кита. Задайте его в карточке «Кит».' }
    case 'kit-not-found':
      return { text: `У кита нет скрипта ${rejected.detail ?? 'sync.ps1'}, а базу с сервером сводит он. Проверьте путь к киту в карточке «Кит».` }
    case 'no-copy':
      return { text: 'На этом компьютере нет копии проекта, а без неё скрипт кита не сведёт базу с сервером.' }
    case 'pull':
      return { text: 'Базу не забрать с сервера, и описание не записано. Кит ответил:', output: rejected.detail ?? undefined }
    case 'invalid':
      return { text: 'Описание не в форме кита — причины стоят под полями.' }
    default:
      return { text: 'Git не записал описание.', output: rejected.detail ?? undefined }
  }
}

/** «1 строка, 3 раздела» — сколько тронул ответ; ничего — ''. */
export function changedText(changed: TrackerChanged): string {
  const plural = (n: number, one: string, few: string, many: string) => {
    const tens = n % 100
    const last = n % 10
    return tens >= 11 && tens <= 14 ? many : last === 1 ? one : last >= 2 && last <= 4 ? few : many
  }
  return [
    changed.lines > 0 ? `${changed.lines} ${plural(changed.lines, 'строка', 'строки', 'строк')}` : '',
    changed.sections > 0 ? `${changed.sections} ${plural(changed.sections, 'раздел', 'раздела', 'разделов')}` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

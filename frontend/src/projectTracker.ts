import type { TrackerInfo } from './tracker'

/**
 * Описание трекера проекта полями окна (B-293): три строки раздела «Где задачи» и слова пяти разделов кита —
 * where — «Где задачи» под строками, backlog — «Показ бэклога», take — «Взятие задачи», closed — «Задача закрыта»,
 * move — «Вынос записи бэклога». filter — прежняя строка «фильтр:» (B-300): в окне её нет, фильтр задаётся на вкладке
 * «Задачи трекера» (B-285), и API её больше не пишет.
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
  filter: string
}

export type DescriptionField = keyof TrackerDescription

/** Поле окна трекера: поля описания и почта с ключом к серверу, которые в базу не пишутся (B-285). */
export type WindowField = DescriptionField | 'email' | 'key'

/** Сколько строк и разделов описания тронул ответ агента. */
export type TrackerChanged = { lines: number; sections: number }

/** Задача трекера в работе: заголовок её памяти и копия. */
export type TrackerTask = { task: string; copy: string | null }

/** Проект раздела «Трекеры» — база из списка панели. */
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
  return name === 'GitHub' || name === 'YouTrack' || name === 'Jira'
}

/** Трекеры, к серверу которых нужен ключ из окна трекера (B-285); у Jira — ещё почта. */
export function keyed(name: TrackerName | null): boolean {
  return name === 'YouTrack' || name === 'Jira'
}

/** Описание, каким оно ляжет в базу: строки «фильтр:» больше нет — фильтр живёт на вкладке «Задачи трекера» (B-285). */
export function written(description: TrackerDescription): TrackerDescription {
  return { ...description, filter: '' }
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
  filter: '',
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
    : sameValue(a[field] ?? '', b[field] ?? '')
}

/** Подсказка в пустом поле «Ключ»: что за ключ нужен этому трекеру. */
export const keyPlaceholder: Partial<Record<TrackerName, string>> = {
  Jira: 'API-токен Atlassian',
  YouTrack: 'Постоянный токен YouTrack',
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

export const sections: { field: Exclude<DescriptionField, 'tracker' | 'server' | 'project' | 'filter'>; label: string; hint: string }[] = [
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
  filter: 'фильтр',
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

/**
 * Что в описании не указано или указано не так — красной строкой под проектом, как у «Бэклога» (B-288): названиями
 * полей окна, а не строками файла — оператор файлы руками не правит (B-285).
 */
export function faultsText(faults: string[] | null | undefined): string {
  const fields: Record<string, string> = { трекер: 'вид трекера', сервер: 'адрес сервера', проект: 'проект' }
  const named = (faults?.length ? faults : ['трекер', 'сервер', 'проект']).map((key) => fields[key] ?? key)
  return named.length === 1
    ? `В описании трекера не указан ${named[0]} или указан не так.`
    : `В описании трекера не указаны ${listed(named)} или указаны не так.`
}

/**
 * Почему трекер не прочитан при проверке перед записью — теми же словами, что причины «Бэклога», с концовкой
 * «Описание не записано.»
 */
export function checkText(code: string, detail: string | null | undefined, description: TrackerDescription): string {
  const server = description.server.trim()
  const project = description.project.trim()
  const jira = knownTracker(description.tracker) === 'Jira'
  const said = (() => {
    switch (code) {
      case 'project-missing':
        return `Проект ${project} не найден на сервере ${server} или у вашего ключа нет к нему доступа.`
      case 'repo-unreachable':
        return `GitHub не нашёл репозиторий ${project} или у вашего аккаунта нет к нему доступа${detail ? `: ${detail}` : ''}.`
      case 'no-key':
        return `Нет ключа к серверу ${server}. Введите ключ.`
      case 'key-rejected':
        return jira ? `Сервер ${server} отклонил почту или ключ.` : `Сервер ${server} отклонил ключ.`
      case 'key-unreadable':
        return `Ключ к серверу ${server} не прочитать на этом компьютере. Введите ключ заново.`
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
      case 'jira-error':
        return `Jira ответила ошибкой: ${detail ?? code}.`
      case 'filter-rejected':
        return `${knownTracker(description.tracker) ?? 'Трекер'} не принял фильтр${detail ? `: ${detail}` : ''}.`
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
  /** По полям окна: поля описания и email, key — почта и ключ к серверу (B-285). */
  faults?: Partial<Record<WindowField, string>> | null
  field?: WindowField | null
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
      return { text: 'Путь к киту не задан, а базу с сервером сводит скрипт кита. Задайте его в «Настройках», в карточке «Кит».' }
    case 'kit-not-found':
      return { text: `У кита нет скрипта ${rejected.detail ?? 'sync.ps1'}, а базу с сервером сводит он. Проверьте путь к киту в «Настройках», в карточке «Кит».` }
    case 'no-copy':
      return { text: 'На этом компьютере нет копии проекта, а без неё скрипт кита не сведёт базу с сервером.' }
    case 'pull':
      return { text: 'Базу не забрать с сервера, и описание не записано. Кит ответил:', output: rejected.detail ?? undefined }
    case 'invalid':
      return { text: 'Описание не в форме кита — причины стоят под полями.' }
    case 'keys-broken':
      return { text: `Файл ключей к серверам трекеров не прочитан, и ключ не сохранить: ${rejected.detail ?? 'trackers.json'}.` }
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

/**
 * Трекер проекта по строкам «трекер:», «сервер:», «проект:» описания трекера базы. Задачи панель читает у GitHub
 * (программой gh) и YouTrack (ключом из «Настроек»); other — трекер, которого панель не читает, name — как его
 * назвало описание; no-keys — строк нет или они записаны не так (B-288).
 */
export type TrackerInfo = {
  kind: 'github' | 'youtrack' | 'other' | 'no-keys' | 'unreadable'
  name?: string | null
  server?: string | null
  project?: string | null
  /** У no-keys — каких строк нет или какие записаны не так: «трекер», «сервер», «проект». */
  faults?: string[] | null
  /** Строка «запрос:» у GitHub и YouTrack — отбор задач, дописанный к запросу панели (B-300); нет — задачи без отбора. */
  query?: string | null
}

/** Незакрытая задача трекера, назначенная на оператора. name — как её называет кит: «GitHub #37», «YouTrack ABC-12». */
export type TrackerIssue = { name: string; number: number; title: string; url: string }

/** Задачи трекера базы: problem задан — задач панель не прочитала, detail — строка трекера. */
export type TrackerLoad =
  | { kind: 'loading' }
  | { kind: 'loaded'; issues: TrackerIssue[]; problem: string | null; detail: string | null }
  | { kind: 'failed'; message: string }

/** Трекер, задачи которого панель читает и в который переносит записи бэклога. */
export function readable(tracker: TrackerInfo | null | undefined): boolean {
  return tracker?.kind === 'github' || tracker?.kind === 'youtrack'
}

/** Задачи трекера читаются из трекера — дольше файла; трекер, которого панель не читает, — читать нечего. */
export function initialTrackerLoad(tracker: TrackerInfo): TrackerLoad {
  return readable(tracker) ? { kind: 'loading' } : { kind: 'loaded', issues: [], problem: tracker.kind, detail: null }
}

/** Номер задачи без имени трекера — как на плашке в строке: «#37», «ABC-12». */
export function issueLabel(issue: { name: string }): string {
  return issue.name.slice(issue.name.indexOf(' ') + 1)
}

const issuePattern = String.raw`(?:github\s*#(\d{1,9})|youtrack\s+([A-Za-z][A-Za-z0-9_]*-\d{1,9}))`

function canonical(match: RegExpExecArray | null): string | null {
  if (!match) return null
  if (match[1] !== undefined) return Number(match[1]) > 0 ? `GitHub #${Number(match[1])}` : null
  return `YouTrack ${match[2].toUpperCase()}`
}

/**
 * Имя задачи трекера, как его пишет кит: «GitHub #37», «YouTrack ABC-12»; регистр и пробел перед «#» ничего не
 * значат, буквы номера YouTrack — прописными. Не имя задачи — null.
 */
export function trackerIssueName(text: string): string | null {
  return canonical(new RegExp(`^${issuePattern}$`, 'i').exec(text.trim()))
}

/** Имя задачи трекера, которым начат заголовок задачи в строке копии: «YouTrack ABC-12 Заголовок». */
export function trackerIssueAtStart(task: string): string | null {
  return canonical(new RegExp(`^\\s*${issuePattern}(?:\\s|$)`, 'i').exec(task))
}

/**
 * Задача трекера, какой её заведёт перенос записи: заголовок без номера, описание — текст записи, её «Агенту»
 * и ссылки; files — файлы записи, которые в задачу не попадут. original — запись, как её видело окно.
 */
export type TrackerDraft = {
  number: string
  title: string
  body: string
  files: { label: string; address: string }[]
  original: string
}

/**
 * Чем кончился перенос. error — фраза для оператора, её пишет API: без issue — задача не заведена (problem — почему,
 * detail — строка трекера) или перенос не начат; с issue — задача заведена, а запись осталась в бэклоге.
 */
export type TrackerMoved = {
  issue: TrackerIssue | null
  problem?: string | null
  detail?: string | null
  error?: string | null
  output?: string | null
  commit?: string | null
  /** Файлы artifacts/, ушедшие вместе с записью: на них больше ничего не ссылалось. */
  removed?: string[] | null
}

export function loadTrackerIssues(base: string): Promise<TrackerLoad> {
  return fetch(`/api/backlog/tracker?base=${encodeURIComponent(base)}`)
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json() as Promise<{ issues: TrackerIssue[]; problem: string | null; detail?: string | null }>
    })
    .then(
      (answer): TrackerLoad => ({ kind: 'loaded', issues: answer.issues, problem: answer.problem, detail: answer.detail ?? null }),
      (e: unknown): TrackerLoad => ({
        kind: 'failed',
        message: e instanceof TypeError ? 'нет связи с API' : String((e as Error).message),
      }),
    )
}

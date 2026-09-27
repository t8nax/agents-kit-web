/** Трекер проекта из tracker.md базы: задачи панель читает только у GitHub с адресом репозитория. */
export type TrackerInfo = {
  kind: 'github' | 'no-address' | 'not-github' | 'unreadable'
  repo?: string | null
}

/** Открытая задача GitHub, назначенная на оператора. name — как её называет кит: «GitHub #37». */
export type TrackerIssue = { name: string; number: number; title: string; url: string }

/** Задачи трекера базы: problem задан — задач панель не прочитала, detail — строка GitHub. */
export type TrackerLoad =
  | { kind: 'loading' }
  | { kind: 'loaded'; issues: TrackerIssue[]; problem: string | null; detail: string | null }
  | { kind: 'failed'; message: string }

/** Задачи трекера читает gh из GitHub — дольше файла; трекер не GitHub с адресом — читать нечего. */
export function initialTrackerLoad(tracker: TrackerInfo): TrackerLoad {
  return tracker.kind === 'github'
    ? { kind: 'loading' }
    : { kind: 'loaded', issues: [], problem: tracker.kind, detail: null }
}

/**
 * Задачи трекера не прочитаны из-за поломки, которую надо чинить, — такая строка видна и при отборе, как ошибка
 * бэклога базы (B-78); спокойные строки — «задач нет», «не GitHub» — отбор скрывает.
 */
export function trackerBroken(load: TrackerLoad | undefined): boolean {
  return load?.kind === 'failed' || (load?.kind === 'loaded' && load.problem !== null && load.problem !== 'not-github')
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

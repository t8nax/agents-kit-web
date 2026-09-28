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
 * detail — строка GitHub) или перенос не начат; с issue — задача заведена, а запись осталась в бэклоге.
 */
export type TrackerMoved = {
  issue: TrackerIssue | null
  problem?: string | null
  detail?: string | null
  error?: string | null
  output?: string | null
  commit?: string | null
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

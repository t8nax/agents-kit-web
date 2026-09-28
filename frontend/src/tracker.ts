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
 * Чем кончился перенос. problem — задача не заведена (detail — строка GitHub); error без issue — перенос не начат,
 * error с issue — задача заведена, а запись осталась в бэклоге.
 */
export type TrackerMoved = {
  issue: TrackerIssue | null
  problem?: string | null
  detail?: string | null
  error?: string | null
  output?: string | null
  commit?: string | null
}

/** Почему задача не заведена — словами для оператора. */
export function createProblemText(problem: string, detail: string | null | undefined): string {
  switch (problem) {
    case 'gh-missing':
      return 'Программа gh не установлена. Установите GitHub CLI и войдите в аккаунт командой gh auth login.'
    case 'gh-login':
      return 'Программа gh не вошла в аккаунт GitHub. Войдите командой gh auth login.'
    case 'repo-unreachable':
      return `GitHub не нашёл репозиторий или у вашего аккаунта нет к нему доступа${detail ? `: ${detail}` : '.'}`
    case 'github-silent':
      return 'GitHub не ответил за минуту — задача могла завестись. Проверьте трекер, прежде чем пробовать снова.'
    default:
      return `GitHub ответил ошибкой: ${detail ?? problem}.`
  }
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

import type { CSSProperties, ReactNode } from 'react'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import type { TrackerInfo, TrackerIssue, TrackerLoad } from './tracker'

/** Строка на месте задач: спокойная — серая, поломка — красная со значком и советом. */
type State = { warning: boolean; text: ReactNode }

function trackerState(load: TrackerLoad, repo: string | null | undefined): State | null {
  if (load.kind === 'loading') return null
  if (load.kind === 'failed') return { warning: true, text: `Задачи трекера не загрузились: ${load.message}.` }
  switch (load.problem) {
    case null:
      return load.issues.length === 0 ? { warning: false, text: 'На вас в GitHub нет открытых задач этого репозитория.' } : null
    case 'not-github':
      return { warning: false, text: 'Трекер проекта — не GitHub. Панель пока читает только GitHub.' }
    case 'no-address':
      return { warning: true, text: 'В описании трекера нет адреса репозитория GitHub. Укажите его в описании трекера проекта.' }
    case 'unreadable':
      return { warning: true, text: 'Описание трекера проекта не прочитано.' }
    case 'gh-missing':
      return {
        warning: true,
        text: (
          <>
            Программа gh не установлена. Установите GitHub CLI и войдите в аккаунт командой <code>gh auth login</code>.
          </>
        ),
      }
    case 'gh-login':
      return {
        warning: true,
        text: (
          <>
            Программа gh не вошла в аккаунт GitHub. Войдите командой <code>gh auth login</code>.
          </>
        ),
      }
    case 'repo-unreachable':
      return {
        warning: true,
        text: (
          <>
            GitHub не нашёл репозиторий <code>{repo}</code> или у вашего аккаунта нет к нему доступа.
          </>
        ),
      }
    default:
      return { warning: true, text: `GitHub ответил ошибкой: ${load.detail ?? load.problem}.` }
  }
}

/**
 * Группа задач трекера в проекте — под записями бэклога, со своей подписью (макет B-277). Строка задачи — ссылка
 * на GitHub во вкладку браузера, а не окно: описание задачи лежит в трекере. «Взять задачу» — то же окно запуска.
 */
export default function TrackerGroup({
  tracker,
  load,
  issues,
  children,
}: {
  tracker: TrackerInfo
  load: TrackerLoad
  /** Задачи, прошедшие отбор раздела. */
  issues: TrackerIssue[]
  /** Кнопка запуска задачи — её держит раздел: окно запуска у него. */
  children: (issue: TrackerIssue) => ReactNode
}) {
  const reveal = useReveal(load.kind === 'loading')
  const state = trackerState(load, tracker.repo)
  const width = Math.max(0, ...issues.map((issue) => `#${issue.number}`.length))
  return (
    <>
      <div className="backlog-group-head">Задачи трекера, назначенные на вас</div>
      {load.kind === 'loading' && <TrackerSkeleton shown={reveal.shown} />}
      {state && (
        <p className={`tracker-state ${state.warning ? 'warning-text' : 'text-sec'}`}>
          {state.warning && <WarningIcon />}
          <span>{state.text}</span>
        </p>
      )}
      {issues.length > 0 && (
        <div
          className={`tracker-issues ${reveal.className}`}
          onAnimationEnd={reveal.onAnimationEnd}
          // Колонка номера — своя, по самому длинному «#NN»: номера задач не той длины, что номера записей
          style={{ '--entry-num-width': `${width}ch` } as CSSProperties}
        >
          {issues.map((issue) => (
            <div className="entry-row" key={issue.number}>
              <a
                className="entry"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                title={`Открыть ${issue.name} во вкладке браузера`}
              >
                <span className="entry-num-slot">
                  <span className="tracker-num">#{issue.number}</span>
                </span>{' '}
                <span className="entry-title">{issue.title}</span>
                <OutIcon />
              </a>
              {children(issue)}
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** Задачи трекера, пока они читаются: две полосы в форме строки задачи под подписью группы. */
function TrackerSkeleton({ shown }: { shown: boolean }) {
  const row = (title: string) => (
    <div className="entry-row sk-frame" key={title}>
      <div className="entry">
        <span className="entry-num-slot">
          <Sk w={34} h={18} />
        </span>
        <span style={{ flex: 1 }}>
          <Sk w={title} h={13} />
        </span>
        <Sk w={16} h={16} />
      </div>
      <Sk w={118} h={30} style={{ alignSelf: 'center', borderRadius: 6 }} />
    </div>
  )
  return (
    <Skeleton label="Загрузка задач трекера" shown={shown}>
      <div style={{ '--entry-num-width': '3ch' } as CSSProperties}>{['52%', '38%'].map(row)}</div>
    </Skeleton>
  )
}

function OutIcon() {
  return (
    <svg className="tracker-out" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  )
}

function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

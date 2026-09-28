import type { CSSProperties, ReactNode } from 'react'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import { issueLabel, type TrackerInfo, type TrackerIssue, type TrackerLoad } from './tracker'

/** Строка на месте задач: спокойная — серая, поломка — красная со значком и советом. */
type State = { warning: boolean; text: ReactNode }

/** Где на это посмотреть в «Настройках» — одними словами у всех причин ключа. */
const settingsCard = '«Настройках», в карточке «Серверы трекеров»'

function trackerState(load: TrackerLoad, tracker: TrackerInfo): State | null {
  if (load.kind === 'loading') return null
  if (load.kind === 'failed') return { warning: true, text: `Задачи трекера не загрузились: ${load.message}.` }
  const server = <code>{tracker.server}</code>
  switch (load.problem) {
    case null:
      if (load.issues.length > 0) return null
      return tracker.kind === 'youtrack'
        ? { warning: false, text: 'На вас в YouTrack нет незакрытых задач этого проекта.' }
        : { warning: false, text: 'На вас в GitHub нет открытых задач этого репозитория.' }
    case 'other':
      return {
        warning: false,
        text: `Трекер проекта — ${tracker.name ?? 'не GitHub и не YouTrack'}. Панель пока читает задачи только из GitHub и YouTrack.`,
      }
    case 'no-keys':
      return {
        warning: true,
        text: (
          <>
            В описании трекера проекта нет строк «трекер:», «сервер:» и «проект:» или одна из них записана не так. Допишите
            их навыком <code>/tracker</code>.
          </>
        ),
      }
    case 'no-key':
      return {
        warning: true,
        text: (
          <>
            Для сервера {server} нет ключа. Добавьте сервер и ключ в {settingsCard}.
          </>
        ),
      }
    case 'key-rejected':
      return {
        warning: true,
        text: (
          <>
            Сервер {server} отклонил ключ. Замените ключ в {settingsCard}.
          </>
        ),
      }
    case 'key-forbidden':
      return {
        warning: true,
        text: (
          <>
            Сервер {server} принял ключ, но у его владельца нет прав на проект <code>{tracker.project}</code>. Проверьте права
            владельца ключа в YouTrack.
          </>
        ),
      }
    case 'server-silent':
      return {
        warning: true,
        text: (
          <>
            Сервер {server} не ответил: {load.detail ?? 'нет связи'}. Проверьте адрес сервера в описании трекера проекта и
            подключение к сети.
          </>
        ),
      }
    case 'project-missing':
      return {
        warning: true,
        text: (
          <>
            На сервере {server} нет проекта <code>{tracker.project}</code> или у вашего ключа нет к нему доступа. Проверьте
            строку «проект:» в описании трекера проекта.
          </>
        ),
      }
    case 'youtrack-error':
      return { warning: true, text: `YouTrack ответил ошибкой: ${load.detail ?? load.problem}.` }
    case 'unreadable':
      return { warning: true, text: 'Описание трекера проекта не прочитано.' }
    // Описание трекера убрали, пока раздел его читал
    case 'no-tracker':
      return { warning: false, text: 'Описания трекера у проекта больше нет — нажмите «Обновить».' }
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
            GitHub не нашёл репозиторий <code>{tracker.project}</code> или у вашего аккаунта нет к нему доступа
            {load.detail ? <>: {load.detail}</> : '.'}
          </>
        ),
      }
    default:
      return { warning: true, text: `GitHub ответил ошибкой: ${load.detail ?? load.problem}.` }
  }
}

/**
 * Группа задач трекера в проекте — под записями бэклога, со своей подписью (макеты B-277 и B-288). Строка задачи —
 * ссылка на трекер во вкладку браузера, а не окно: описание задачи лежит в трекере. «Взять задачу» — то же окно запуска.
 */
export default function TrackerGroup({
  tracker,
  load,
  issues,
  children,
}: {
  tracker: TrackerInfo
  load: TrackerLoad
  /** Задачи, прошедшие отбор раздела; при отборе без подошедших задач раздел группу не показывает вовсе. */
  issues: TrackerIssue[]
  /** Кнопка запуска задачи — её держит раздел: окно запуска у него. */
  children: (issue: TrackerIssue) => ReactNode
}) {
  const reveal = useReveal(load.kind === 'loading')
  const state = trackerState(load, tracker)
  const width = Math.max(0, ...issues.map((issue) => issueLabel(issue).length))
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
          // Колонка номера — своя, по самому длинному «#NN» или «ABC-NN»: номера задач не той длины, что номера записей
          style={{ '--entry-num-width': `${width}ch` } as CSSProperties}
        >
          {issues.map((issue) => (
            <div className="entry-row" key={issue.name}>
              <a
                className="entry"
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                title={`Открыть ${issue.name} во вкладке браузера`}
              >
                <span className="entry-num-slot">
                  <span className="tracker-num">{issueLabel(issue)}</span>
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

export function OutIcon() {
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

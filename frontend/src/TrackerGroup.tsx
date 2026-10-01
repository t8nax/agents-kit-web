import type { CSSProperties, ReactNode } from 'react'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import { ISSUE_LIMIT, issueLabel, trackerTitle, type TrackerInfo, type TrackerIssue, type TrackerLoad } from './tracker'

/** Строка на месте задач: спокойная — серая, поломка — красная со значком и советом. */
type State = { warning: boolean; text: ReactNode }

/** Поле окна трекера проекта, куда ставится курсор после перехода из строки причины (B-285). */
export type TrackerField = 'server' | 'project' | 'key'

/** Что в описании не указано или указано не так — названиями полей окна, а не строками файла (оператор на B-285). */
const faultFields: Record<string, string> = { трекер: 'вид трекера', сервер: 'адрес сервера', проект: 'проект' }

function trackerState(load: TrackerLoad, tracker: TrackerInfo, onTrackers?: (field?: TrackerField) => void): State | null {
  if (load.kind === 'loading') return null
  // Трекеры — свой раздел панели (B-323): ссылка ведёт в него, к трекеру этого проекта, а у причины ключа, адреса
  // или проекта открывает окно трекера с курсором в этом поле (B-285).
  const section = (field?: TrackerField) => (
    <button type="button" className="tracker-link" onClick={() => onTrackers?.(field)}>
      «Трекеры»
    </button>
  )
  if (load.kind === 'failed') return { warning: true, text: `Задачи трекера не загрузились: ${load.message}.` }
  const server = <code>{tracker.server}</code>
  const name = trackerTitle(tracker)
  // Jira — она, GitHub и YouTrack — он
  const answered = tracker.kind === 'jira' ? 'ответила' : 'ответил'
  const took = tracker.kind === 'jira' ? 'не приняла' : 'не принял'
  const none = tracker.kind === 'github' ? 'открытых задач этого репозитория' : 'незакрытых задач этого проекта'
  switch (load.problem) {
    case null:
      if (load.issues.length > 0) return null
      // Отбор ничего не нашёл — строка называет его: задач может просто не быть, а может быть опечатка (ответ оператора на B-300)
      if (tracker.filter)
        return {
          warning: false,
          text: (
            <>
              По фильтру <code>{tracker.filter}</code> в {name} сейчас нет{' '}
              {tracker.kind === 'github' ? 'открытых задач этого репозитория' : 'задач этого проекта'}.
            </>
          ),
        }
      return { warning: false, text: `В ${name} нет ${none}.` }
    case 'other':
      return {
        warning: false,
        text: `Трекер проекта — ${tracker.name ?? 'не GitHub, не YouTrack и не Jira'}. Панель пока читает задачи только из GitHub, YouTrack и Jira.`,
      }
    case 'no-keys': {
      // Называются именно те поля, которых нет или что заданы не так; описание исправляется в разделе «Трекеры»
      const faults = (tracker.faults?.length ? tracker.faults : ['трекер', 'сервер', 'проект']).map((key) => faultFields[key] ?? key)
      const named = faults.length === 1 ? faults[0] : `${faults.slice(0, -1).join(', ')} и ${faults[faults.length - 1]}`
      return {
        warning: true,
        text: (
          <>
            {faults.length === 1
              ? `В описании трекера проекта не указан ${named} или указан не так. `
              : `В описании трекера проекта не указаны ${named} или указаны не так. `}
            Исправьте описание в разделе {section()}.
          </>
        ),
      }
    }
    case 'no-key':
      return {
        warning: true,
        text: (
          <>
            Нет ключа к серверу {server}. Введите ключ в разделе {section('key')}.
          </>
        ),
      }
    case 'key-rejected':
      return {
        warning: true,
        text:
          tracker.kind === 'jira' ? (
            <>
              Сервер {server} отклонил почту или ключ. Проверьте их в разделе {section('key')}.
            </>
          ) : (
            <>
              Сервер {server} отклонил ключ. Замените ключ в разделе {section('key')}.
            </>
          ),
      }
    case 'key-unreadable':
      return {
        warning: true,
        text: (
          <>
            Ключ к серверу {server} не прочитать на этом компьютере. Введите ключ заново в разделе {section('key')}.
          </>
        ),
      }
    case 'key-forbidden':
      return {
        warning: true,
        text: (
          <>
            Сервер {server} принял ключ, но у его владельца нет прав на проект <code>{tracker.project}</code>. Проверьте права
            владельца ключа в {name}.
          </>
        ),
      }
    case 'server-silent':
      return {
        warning: true,
        text: (
          <>
            Сервер {server} не ответил: {load.detail ?? 'нет связи'}. Проверьте адрес сервера в разделе {section('server')} и
            подключение к сети.
          </>
        ),
      }
    case 'project-missing':
      return {
        warning: true,
        text: (
          <>
            Проект <code>{tracker.project}</code> не найден на сервере {server} или у вашего ключа нет к нему доступа. Проверьте
            проект в разделе {section('project')}.
          </>
        ),
      }
    case 'youtrack-error':
    case 'jira-error':
      return { warning: true, text: `${name} ${answered} ошибкой: ${load.detail ?? load.problem}.` }
    case 'filter-rejected':
      // Фильтр — в шапке проекта, рядом с этой строкой: в «Трекеры» за ним ходить незачем (B-285)
      return {
        warning: true,
        text: (
          <>
            {/* Jira и YouTrack ставят точку в конце своей строки сами */}
            {name} {took} фильтр{load.detail ? <>: {load.detail.replace(/\.$/, '')}</> : ''}. Исправьте фильтр проекта.
          </>
        ),
      }
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
 * Задачи трекера проекта на вкладке «Задачи трекера» (B-305; раньше — подписанная группа под записями, макеты B-277
 * и B-288). Строка задачи — ссылка на трекер во вкладку браузера, а не окно: описание задачи лежит в трекере.
 * «Взять задачу» — то же окно запуска. Исполнитель — второй строкой под заголовком, у ничьей задачи — «никому»;
 * задач больше, чем панель показывает за раз, — строка под списком, а не молчаливая обрезка (макет AKW-17, вариант А).
 */
export default function TrackerGroup({
  tracker,
  load,
  issues,
  mine = false,
  onTrackers,
  children,
}: {
  tracker: TrackerInfo
  load: TrackerLoad
  /** Задачи, прошедшие отбор раздела; при отборе без подошедших задач раздел группу не показывает вовсе. */
  issues: TrackerIssue[]
  /** Включён флажок «Мои задачи»: проект без своих задач не прячется, а говорит это строкой. */
  mine?: boolean
  /** Переход в раздел «Трекеры» к трекеру проекта; field — открыть его окно с курсором в этом поле (B-285). */
  onTrackers?: (field?: TrackerField) => void
  /** Кнопка запуска задачи — её держит раздел: окно запуска у него. */
  children: (issue: TrackerIssue) => ReactNode
}) {
  const reveal = useReveal(load.kind === 'loading')
  const state =
    trackerState(load, tracker, onTrackers) ??
    (mine && issues.length === 0 && load.kind === 'loaded'
      ? // Задач больше сотни — свои могут быть за ней: строка не говорит, что их нет вовсе (ревью AKW-17)
        { warning: false, text: load.truncated ? `Среди первых ${ISSUE_LIMIT} задач проекта ваших нет.` : 'Ваших задач в этом проекте нет.' }
      : null)
  const width = Math.max(0, ...issues.map((issue) => issueLabel(issue).length))
  return (
    <>
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
                <span className="issue-main">
                  <span className="issue-line">
                    <span className="entry-title">{issue.title}</span>
                    {/* Метки — серыми плашками сразу за заголовком, не цветами GitHub: цвет в строке несёт только
                        приоритет записи (B-305) */}
                    {issue.labels && issue.labels.length > 0 && (
                      <span className="issue-labels">
                        {issue.labels.map((label) => (
                          <span key={label} className="issue-label">
                            {label}
                          </span>
                        ))}
                      </span>
                    )}
                  </span>{' '}
                  {issue.assignee ? (
                    <span className="issue-assignee">{issue.assignee}</span>
                  ) : (
                    <span className="issue-assignee nobody">никому</span>
                  )}
                </span>
                <OutIcon />
              </a>
              {children(issue)}
            </div>
          ))}
        </div>
      )}
      {load.kind === 'loaded' && load.problem === null && load.truncated && (
        <p className="tracker-state text-sec">
          <span>Показаны первые {ISSUE_LIMIT} задач — сузьте список фильтром проекта.</span>
        </p>
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

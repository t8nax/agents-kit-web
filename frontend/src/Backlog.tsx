import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { WorkspaceRow } from './App'
import './Backlog.css'
import BacklogWriteModal, { AGENT_NAME, WriteIcon } from './BacklogWriteModal'
import { arrange, emptySelection, isFiltering, matchesIssue, PRIORITIES, readOrder, readRemembered, remember, TYPES, writeOrder, type Order, type Selection, type SortField } from './backlogView'
import { InlineMarkdown, Markdown } from './Markdown'
import { FormatNotice, NEWER_FORMAT_REFUSAL } from './NewerFormat'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
import EntryArtifacts, { type Artifact } from './EntryArtifacts'
import { BugIcon, EntryFields, FeatureIcon } from './EntryFields'
import { freeCopies, runningTasks } from './copies'
import StartTaskModal, { PlayIcon } from './StartTaskModal'
import { forgetGoneIssueWords, forgetGoneStartWords } from './startWords'
import { normalizeNumber, numberLetters } from './taskTitle'
import TrackerGroup from './TrackerGroup'
import TrackerMoveModal, { SendIcon } from './TrackerMoveModal'
import { initialTrackerLoad, loadTrackerIssues, readable, type TrackerInfo, type TrackerLoad } from './tracker'

export type BacklogEntry = {
  number: string | null
  title: string
  text: string | null
  /** Поля кита: запись несёт их, когда шапка backlog.md личного репозитория объявила их строкой «поля:», иначе они пусты. */
  priority?: string | null
  type?: string | null
  /** Подраздел «Артефакты» записи — файлы в artifacts/ личного репозитория и ссылки; нет артефактов — пусто. */
  artifacts?: Artifact[] | null
}

export type BaseBacklog = {
  base: string
  project: string
  entries: BacklogEntry[]
  error: string | null
  /** Буквы номеров проекта: запись с другими буквами кит перенумерует, и задачей она не запускается. */
  letters?: string | null
  /** Трекер проекта из tracker.md базы; нет — у проекта нет трекера, и группы задач трекера нет. */
  tracker?: TrackerInfo | null
  /** База нового формата кита: записи видны и берутся в работу, но не правятся (B-281). */
  formatWarning?: string | null
}

/** Запись, которую берут в работу, вместе с базой её проекта: по ним идёт запуск. */
type Started = { base: string; entry: BacklogEntry & { number: string } }

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; backlogs: BaseBacklog[] }

// Фильтр по проектам: null — все проекты, иначе путь базы выбранного проекта.
/**
 * writeFor — база просьбы, к которой вернулся оператор: окно записи открывается сразу на ней.
 * onStarted — запущенная задача: сообщение о ней показывает App, потому что раздел оператор
 * тут же покидает, чтобы посмотреть строку копии.
 * onTrackers — переход в «Настройки» к карточке «Трекеры проектов» из строки о поломке описания трекера.
 */
export default function Backlog({
  writeFor = null,
  onStarted,
  onTrackers,
}: {
  writeFor?: string | null
  onStarted?: (copy: string) => void
  onTrackers?: () => void
} = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  // Проект просьбы главнее запомненного и дальше запоминается сам — решение оператора на B-267
  const [filter, setFilter] = useState<string | null>(() => writeFor ?? readRemembered().project)
  // Отбор и порядок записей внутри каждого проекта: порядок помнит браузер, чипы — страница,
  // а поиск каждое открытие раздела пуст
  const [selection, setSelection] = useState<Selection>(() => {
    const { types, priorities } = readRemembered()
    return { ...emptySelection, types, priorities }
  })
  const [order, setOrder] = useState<Order>(readOrder)

  useEffect(() => {
    remember({ project: filter, types: selection.types, priorities: selection.priorities })
  }, [filter, selection.types, selection.priorities])

  const changeOrder = useCallback((next: Order) => {
    setOrder(next)
    writeOrder(next)
  }, [])
  const [opened, setOpened] = useState<{ base: string; entry: BacklogEntry } | null>(null)
  const [writing, setWriting] = useState(writeFor !== null)
  // Запись, от которой окно Чудо-Юдо открыто кнопкой «Изменить»; null — окно из шапки раздела.
  const [editing, setEditing] = useState<{ base: string; entry: BacklogEntry } | null>(null)
  // Запись, которую берут в работу
  const [starting, setStarting] = useState<Started | null>(null)
  // Запись, которую переносят в трекер проекта
  const [moving, setMoving] = useState<Started | null>(null)
  // Копии всех баз: по ним видно, есть ли у проекта записи куда запускать. null — ещё не прочитаны.
  const [copies, setCopies] = useState<WorkspaceRow[] | null>(null)
  // Записи, добавленные из панели, ключом «база|номер»: отмечены новыми до следующего «Обновить».
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Закрытое окно возвращает фокус кнопке, с которой его открыли: клавиатура остаётся на месте в списке.
  const opener = useRef<HTMLButtonElement | null>(null)

  const focusOpener = useCallback(() => opener.current?.focus(), [])

  const closeEntry = useCallback(() => {
    setOpened(null)
    focusOpener()
  }, [focusOpener])

  // Задачи трекера по базам. Их читают из GitHub или YouTrack — дольше файла, поэтому своим запросом на базу: записи
  // бэклога их не ждут. Ответ прошлого чтения, пришедший после нового, отбрасывается.
  const [trackers, setTrackers] = useState<Record<string, TrackerLoad>>({})
  const trackerRound = useRef(0)

  // Трекер каждой базы — вид, сервер и проект, — как его знало последнее чтение: бэклог, перечитанный после записи или
  // запуска, узнаёт по нему базу, чей трекер появился или сменился, пока раздел открыт, — её трекер читается сразу,
  // а не висит заготовкой
  const trackerKinds = useRef<Record<string, string>>({})

  // all — читать трекеры всех баз (открытие раздела и «Обновить»); иначе только появившихся и сменившихся
  // и трекер базы reread — туда перенесли запись бэклога
  const loadTrackers = useCallback((backlogs: BaseBacklog[], all: boolean, reread: string | null) => {
    const round = all ? ++trackerRound.current : trackerRound.current
    const identity = (tracker: TrackerInfo) => `${tracker.kind}|${tracker.server ?? ''}|${tracker.project ?? ''}`
    const read = new Set(
      backlogs
        .filter((b) => b.tracker && (all || b.base === reread || trackerKinds.current[b.base] !== identity(b.tracker)))
        .map((b) => b.base),
    )
    trackerKinds.current = Object.fromEntries(backlogs.flatMap((b) => (b.tracker ? [[b.base, identity(b.tracker)]] : [])))
    setTrackers((prev) => {
      const next: Record<string, TrackerLoad> = {}
      for (const backlog of backlogs) {
        if (!backlog.tracker) continue
        next[backlog.base] = read.has(backlog.base) || !prev[backlog.base] ? initialTrackerLoad(backlog.tracker) : prev[backlog.base]
      }
      return next
    })
    for (const backlog of backlogs) {
      if (!readable(backlog.tracker) || !read.has(backlog.base)) continue
      void loadTrackerIssues(backlog.base).then((result) => {
        if (round !== trackerRound.current) return
        setTrackers((prev) => ({ ...prev, [backlog.base]: result }))
        if (result.kind === 'loaded' && result.problem === null)
          forgetGoneIssueWords(backlog.base, result.issues.map((issue) => issue.name))
      })
    }
  }, [])

  // Задачи трекера перечитываются при открытии раздела и по «Обновить» — критерий B-277: запись Чудо-Юдо и запуск
  // задачи перечитывают бэклог, но трекер заново читают только тот, которого раздел ещё не читал. Кроме переноса
  // записи в трекер — reread: трекер базы, куда ушла задача, перечитывается, и она видна в группе сразу (GitHub #3)
  const loadBacklogs = useCallback((readTrackers = false, reread: string | null = null) => {
    fetch('/api/backlog')
      .then((response) => {
        if (!response.ok) throw new Error(`Бэклог не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseBacklog[]>
      })
      .then(
        (backlogs) => {
          setLoad({ kind: 'loaded', backlogs })
          loadTrackers(backlogs, readTrackers, reread)
          forgetGoneStartWords(backlogs)
          // База могла уйти из списка, пока раздел был открыт: показываем тогда все проекты.
          setFilter((current) => (backlogs.some((b) => b.base === current) ? current : null))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [loadTrackers])

  // Занятость копий нужна одной кнопке записи, поэтому сбой чтения раздел не показывает: кнопки просто гаснут.
  const loadCopies = useCallback(() => {
    fetch('/api/workspaces')
      .then((response) => (response.ok ? (response.json() as Promise<WorkspaceRow[]>) : Promise.reject()))
      .then(
        (rows) => setCopies(rows),
        () => setCopies([]),
      )
  }, [])

  // Бэклог и копии читаются при открытии раздела и кнопкой «Обновить», без опроса по таймеру.
  useEffect(() => loadBacklogs(true), [loadBacklogs])
  useEffect(loadCopies, [loadCopies])

  const refresh = useCallback(() => {
    setLoad({ kind: 'loading' })
    // Ответ трекера прошлого чтения, пришедший после «Обновить», не встаёт на место заготовки
    trackerRound.current++
    setTrackers({})
    setFresh(new Set())
    loadBacklogs(true)
    loadCopies()
  }, [loadBacklogs, loadCopies])

  const markWritten = useCallback(
    (base: string, numbers: string[]) => {
      setFresh((prev) => new Set([...prev, ...numbers.map((n) => `${base}|${n}`)]))
      loadBacklogs()
    },
    [loadBacklogs],
  )

  const closeWrite = useCallback(() => {
    setWriting(false)
    setEditing(null)
  }, [])

  // Панель записала изменения по «Сохранить» — список показывает новый бэклог.
  const markSaved = useCallback(() => loadBacklogs(), [loadBacklogs])

  // Задачи трекера, которые завёл разговор с Чудо-Юдо и под которые трекер уже перечитан: окно, открытое заново,
  // называет их снова, а группа от этого не мигает заготовкой
  const trackedSeen = useRef(new Set<string>())
  const markTracked = useCallback(
    (base: string, issues: string[]) => {
      const fresh = issues.map((issue) => `${base}|${issue}`).filter((key) => !trackedSeen.current.has(key))
      if (fresh.length === 0) return
      fresh.forEach((key) => trackedSeen.current.add(key))
      loadBacklogs(false, base)
    },
    [loadBacklogs],
  )

  const backlogs = load.kind === 'loaded' ? load.backlogs : []
  const reveal = useReveal(load.kind === 'loading')
  // Пока отбор включён, проект, где под него ничего не подошло, не показывается. Проект, чей бэклог
  // не читается, виден всегда: иначе сломанную базу не заметить за фильтром — решение оператора на B-78
  const filtering = isFiltering(selection)
  // Задачи трекера отбираются тем же поиском и чипами; ничего не подошло — группа трекера скрыта целиком, со строкой
  // причины тоже: так записан критерий B-277
  const shown = (filter === null ? backlogs : backlogs.filter((b) => b.base === filter))
    .map((backlog) => {
      const issues = trackerIssues(trackers[backlog.base]).filter((issue) => matchesIssue(issue, selection))
      return {
        backlog,
        entries: arrange(backlog.entries, selection, order),
        issues,
        trackerShown: !!backlog.tracker && (!filtering || issues.length > 0),
        running: runningTasks(copies ?? [], backlog.base),
      }
    })
    .filter(({ backlog, entries, trackerShown }) => entries.length > 0 || trackerShown || !filtering || backlog.error)
  // База нового формата: просить Чудо-Юдо можно, пока в выбранном есть бэклог, который панель знает (B-281).
  const inScope = filter === null ? backlogs : backlogs.filter((b) => b.base === filter)
  const writeClosed = inScope.length > 0 && inScope.every((b) => b.formatWarning) ? NEWER_FORMAT_REFUSAL : null

  return (
    <>
      <div className="content-head">
        <h2>Бэклог</h2>
        <button
          type="button"
          className="bases-btn bases-btn-add head-end"
          onClick={() => {
            setEditing(null)
            setWriting(true)
          }}
          disabled={backlogs.length === 0 || writeClosed !== null}
          title={writeClosed ?? undefined}
        >
          <WriteIcon />
          Попросить {AGENT_NAME}
        </button>
        <button type="button" className="bases-btn" onClick={refresh} disabled={load.kind === 'loading'}>
          <RefreshIcon />
          Обновить
        </button>
      </div>

      {load.kind === 'loading' && <BacklogSkeleton shown={reveal.shown} />}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && backlogs.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в окне «Базы знаний».</p>
      )}

      {load.kind === 'loaded' && backlogs.length > 0 && (
        <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
          {backlogs.length > 1 && (
            <div className="filter-bar" role="group" aria-label="Фильтр по проектам">
              <FilterChip label="Все проекты" active={filter === null} onClick={() => setFilter(null)} />
              {backlogs.map((backlog) => (
                <FilterChip
                  key={backlog.base}
                  label={backlog.project}
                  active={filter === backlog.base}
                  onClick={() => setFilter(backlog.base)}
                />
              ))}
            </div>
          )}

          <div className="filter-bar" role="group" aria-label="Отбор и порядок записей">
            <SearchBox value={selection.query} onChange={(query) => setSelection((prev) => ({ ...prev, query }))} />
            <span className="tool-sep" />
            {TYPES.map((type) => (
              <FilterChip
                key={type}
                label={type}
                icon={type === 'фича' ? <FeatureIcon className="chip-type-feature" /> : <BugIcon className="chip-type-bug" />}
                active={selection.types.includes(type)}
                onClick={() => setSelection((prev) => ({ ...prev, types: toggle(prev.types, type) }))}
              />
            ))}
            <span className="tool-sep" />
            {PRIORITIES.map((priority) => (
              <FilterChip
                key={priority}
                label={priority}
                active={selection.priorities.includes(priority)}
                onClick={() => setSelection((prev) => ({ ...prev, priorities: toggle(prev.priorities, priority) }))}
              />
            ))}
            <OrderBox order={order} onChange={changeOrder} />
          </div>

          {filtering && shown.every(({ entries, issues }) => entries.length === 0 && issues.length === 0) && (
            <p className="empty-message">Под фильтр записей нет</p>
          )}

          <div className="backlog-list">
            {shown.map(({ backlog, entries, issues, trackerShown, running }) => (
              <section
                key={backlog.base}
                aria-label={backlog.project}
                // Колонка номера одной ширины на весь список проекта — по самому длинному номеру:
                // плашки и заголовки всех записей начинаются на одной вертикали (макет B-185)
                style={{ '--entry-num-width': `${numberWidth(backlog.entries)}ch` } as CSSProperties}
              >
                <div className="base-head">
                  <h3>{backlog.project}</h3>
                </div>
                {/* База нового формата — плашкой прямо под заголовком проекта, выбран он или нет: замечание оператора
                    на приёмке B-281 */}
                {backlog.formatWarning && <FormatNotice text={backlog.formatWarning} />}
                {/* У проекта с трекером в проекте две группы, и обе подписаны — ответ оператора на макет B-277 */}
                {backlog.tracker && (entries.length > 0 || !filtering || backlog.error) && (
                  <div className="backlog-group-head">Записи бэклога</div>
                )}
                {backlog.error && (
                  <p className="backlog-note warning-text">
                    <WarningIcon />
                    {backlog.error}
                  </p>
                )}
                {/* При отборе строки о пустом бэклоге нет, как и подписи записей: проект виден ради задач трекера */}
                {!backlog.error && backlog.entries.length === 0 && !filtering && (
                  <p className="backlog-note text-sec">В бэклоге этого проекта записей нет.</p>
                )}
                {entries.map((entry, index) => {
                  const isFresh = entry.number !== null && fresh.has(`${backlog.base}|${entry.number}`)
                  return (
                    <div className={`entry-row ${isFresh ? 'entry-fresh' : ''}`} key={entry.number ?? `${backlog.base}-${index}`}>
                      <button
                        type="button"
                        className="entry"
                        onClick={(e) => {
                          opener.current = e.currentTarget
                          setOpened({ base: backlog.base, entry })
                        }}
                      >
                        {/* Пробел не виден во flex-строке, но разделяет номер и заголовок в имени кнопки */}
                        {numberWidth(backlog.entries) > 0 && (
                          <span className="entry-num-slot">
                            {entry.number && <span className="entry-num">{entry.number}</span>}
                          </span>
                        )}{' '}
                        <EntryFields entry={entry} />{' '}
                        <InlineMarkdown className="entry-title" text={entry.title} />
                        {isFresh && <span className="entry-fresh-badge">новая</span>}
                        <ChevronIcon />
                      </button>
                      {/* Правку и запуск адресует номер записи, поэтому у записи без номера их нет вовсе */}
                      {entry.number && (
                        <button
                          type="button"
                          className="entry-start"
                          disabled={!!backlog.formatWarning}
                          title={backlog.formatWarning ? NEWER_FORMAT_REFUSAL : undefined}
                          onClick={(e) => {
                            opener.current = e.currentTarget
                            setEditing({ base: backlog.base, entry })
                            setWriting(true)
                          }}
                        >
                          <WriteIcon />
                          Изменить
                        </button>
                      )}
                      {/* Переносят в трекер GitHub или YouTrack со строками описания — B-286, B-288; между «Изменить» и «Взять задачу» */}
                      {entry.number && readable(backlog.tracker) && (
                        <button
                          type="button"
                          className="entry-start"
                          // Перенос вырезает запись из бэклога — у базы нового формата правка бэклога закрыта (B-281)
                          disabled={!!backlog.formatWarning}
                          title={backlog.formatWarning ? NEWER_FORMAT_REFUSAL : undefined}
                          onClick={(e) => {
                            opener.current = e.currentTarget
                            setMoving({ base: backlog.base, entry: { ...entry, number: entry.number! } })
                          }}
                        >
                          <SendIcon />
                          В трекер
                        </button>
                      )}
                      {entry.number && (
                        <button
                          type="button"
                          className="entry-start"
                          // Копий ещё не прочитали или свободных не осталось — запускать некуда; запись чужими
                          // буквами кит перенумерует — запускать её рано; запись уже взяли в копию — вторую
                          // сессию над ней панель не заводит (B-89). Почему, кнопка не пишет — как приглушённые
                          // переходы строки копии.
                          disabled={
                            copies === null ||
                            freeCopies(copies, backlog.base).length === 0 ||
                            numberLetters(entry.number) !== backlog.letters ||
                            running.has(normalizeNumber(entry.number) ?? entry.number)
                          }
                          onClick={(e) => {
                            opener.current = e.currentTarget
                            setStarting({ base: backlog.base, entry: { ...entry, number: entry.number! } })
                          }}
                        >
                          <PlayIcon />
                          Взять задачу
                        </button>
                      )}
                    </div>
                  )
                })}
                {backlog.tracker && trackerShown && (
                  <TrackerGroup
                    tracker={backlog.tracker}
                    load={trackers[backlog.base] ?? initialTrackerLoad(backlog.tracker)}
                    issues={issues}
                    onTrackers={onTrackers}
                  >
                    {(issue) => (
                      <button
                        type="button"
                        className="entry-start"
                        // Как у записи: копий ещё не прочитали, свободных не осталось или задача уже идёт в копии
                        disabled={copies === null || freeCopies(copies, backlog.base).length === 0 || running.has(issue.name)}
                        onClick={(e) => {
                          opener.current = e.currentTarget
                          setStarting({ base: backlog.base, entry: { number: issue.name, title: issue.title, text: null } })
                        }}
                      >
                        <PlayIcon />
                        Взять задачу
                      </button>
                    )}
                  </TrackerGroup>
                )}
              </section>
            ))}
          </div>
        </div>
      )}

      {opened && <EntryModal base={opened.base} entry={opened.entry} onClose={closeEntry} />}
      {starting && (
        <StartTaskModal
          base={starting.base}
          entry={starting.entry}
          onClose={() => {
            setStarting(null)
            focusOpener()
          }}
          onTaken={loadCopies}
          onStarted={(copy) => {
            setStarting(null)
            // Запущенная задача гасит свою кнопку (B-89), а погасшая кнопка роняет фокус — клавиатура остаётся
            // в строке, на её заголовке.
            ;(opener.current?.closest('.entry-row')?.querySelector<HTMLElement>('button, a') ?? opener.current)?.focus()
            onStarted?.(copy)
            // Копия становится занятой сразу, а запись из бэклога убирает агент, когда до неё дойдёт:
            // в этом чтении её обычно ещё видно.
            loadBacklogs()
            loadCopies()
          }}
        />
      )}
      {moving && (
        <TrackerMoveModal
          base={moving.base}
          entry={moving.entry}
          onClose={() => {
            setMoving(null)
            focusOpener()
          }}
          // Задача заведена — бэклог перечитывается: запись из него ушла или, если вырезать не вышло, осталась;
          // трекер этой базы перечитывается с заготовкой, как по «Обновить», и показывает заведённую задачу
          onMoved={() => loadBacklogs(false, moving.base)}
        />
      )}
      {writing && (
        <BacklogWriteModal
          bases={backlogs.map((b) => ({
            base: b.base,
            project: b.project,
            closed: b.formatWarning ? NEWER_FORMAT_REFUSAL : null,
          }))}
          initialBase={filter}
          subject={editing}
          findEntry={(base, number) =>
            backlogs.find((b) => b.base === base)?.entries.find((entry) => entry.number === number)
          }
          onClose={closeWrite}
          onEntries={markWritten}
          onSaved={markSaved}
          onTracked={markTracked}
        />
      )}
    </>
  )
}

// Окно записи: текст оператору читают здесь, а список держит одни заголовки.
function EntryModal({ base, entry, onClose }: { base: string; entry: BacklogEntry; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="entry-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="entry-modal" role="dialog" aria-modal="true" aria-labelledby="entry-modal-title">
        <div className="entry-modal-head">
          {/* Плашки стоят строкой под заголовком — выбор оператора на приёмке B-75 */}
          <div className="entry-modal-name">
            <div className="entry-modal-line">
              {entry.number && <span className="entry-num">{entry.number}</span>}
              <h3 id="entry-modal-title">
                <InlineMarkdown text={entry.title} />
              </h3>
            </div>
            {(entry.type || entry.priority) && (
              <div className="entry-modal-fields">
                <EntryFields entry={entry} />
              </div>
            )}
          </div>
          <button ref={closeRef} type="button" className="entry-close" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div className="entry-modal-body">
          {entry.text ? (
            <Markdown className="entry-text" text={entry.text} />
          ) : (
            <p className="entry-no-text">Описания нет</p>
          )}
          {entry.artifacts && entry.artifacts.length > 0 && (
            <EntryArtifacts base={base} number={entry.number} artifacts={entry.artifacts} />
          )}
        </div>
      </div>
    </div>
  )
}

/** Бэклог, пока он читается в первый раз: чипы проектов, строка отбора и записи проектов полосами (макет B-201). */
function BacklogSkeleton({ shown }: { shown: boolean }) {
  const round = { borderRadius: 6 }
  const entry = (title: string) => (
    <div className="entry-row sk-frame" key={title}>
      <div className="entry">
        <span className="entry-num-slot">
          <Sk w={46} h={18} />
        </span>
        <Sk w={54} h={12} />
        <Sk w={66} h={18} className="sk-pill" />
        <span style={{ flex: 1 }}>
          <Sk w={title} h={13} />
        </span>
        <Sk w={18} h={18} />
      </div>
      <Sk w={118} h={30} style={{ alignSelf: 'center', ...round }} />
    </div>
  )
  const project = (width: number, titles: string[]) => (
    <section style={{ '--entry-num-width': '5ch' } as CSSProperties}>
      <div className="base-head">
        <Sk w={width} h={13} style={{ marginBottom: 6 }} />
      </div>
      {titles.map(entry)}
    </section>
  )
  return (
    <Skeleton label="Загрузка бэклога" shown={shown}>
      <div className="filter-bar">
        {[92, 104, 80].map((w) => (
          <Sk key={w} w={w} h={28} className="sk-pill" />
        ))}
      </div>
      <div className="filter-bar">
        <Sk w={220} h={30} style={round} />
        <span className="tool-sep" />
        <Sk w={64} h={28} className="sk-pill" />
        <Sk w={72} h={28} className="sk-pill" />
        <span className="tool-sep" />
        {[74, 80, 76, 70].map((w) => (
          <Sk key={w} w={w} h={28} className="sk-pill" />
        ))}
        <span className="backlog-order">
          <Sk w={150} h={30} style={round} />
          <Sk w={110} h={30} style={round} />
        </span>
      </div>
      <div className="backlog-list">
        {project(120, ['58%', '44%', '66%', '38%'])}
        {project(84, ['52%', '40%'])}
      </div>
    </Skeleton>
  )
}

function trackerIssues(load: TrackerLoad | undefined) {
  return load?.kind === 'loaded' ? load.issues : []
}

/** Ширина колонки номера в знаках — по самому длинному номеру проекта; номеров нет — колонки нет. */
function numberWidth(entries: BacklogEntry[]): number {
  return Math.max(0, ...entries.map((entry) => entry.number?.length ?? 0))
}

function ChevronIcon() {
  return (
    <svg className="entry-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

function FilterChip({
  label,
  icon,
  active,
  onClick,
}: {
  label: string
  icon?: ReactNode
  active: boolean
  onClick: () => void
}) {
  return (
    <button type="button" className={`chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
      {icon}
      {label}
    </button>
  )
}

function toggle(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value]
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <label className="backlog-search">
      <SearchIcon />
      <input
        ref={input}
        type="text"
        className={value ? 'filled' : ''}
        placeholder="Поиск"
        aria-label="Поиск"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {value && (
        <button
          type="button"
          className="backlog-search-clear"
          aria-label="Очистить"
          onClick={() => {
            onChange('')
            // Кнопка с очисткой пропадает: клавиатура остаётся в поле, а не уходит в начало страницы
            input.current?.focus()
          }}
        >
          <CloseIcon />
        </button>
      )}
    </label>
  )
}

const SORT_LABEL: Record<SortField, string> = { number: 'По номеру', type: 'По типу', priority: 'По приоритету' }

function OrderBox({ order, onChange }: { order: Order; onChange: (order: Order) => void }) {
  return (
    <div className="backlog-order">
      <span className="backlog-order-select">
        <select
          aria-label="Порядок"
          value={order.field}
          onChange={(e) => onChange({ ...order, field: e.target.value as SortField })}
        >
          {(Object.keys(SORT_LABEL) as SortField[]).map((field) => (
            <option key={field} value={field}>
              {SORT_LABEL[field]}
            </option>
          ))}
        </select>
        <DownIcon />
      </span>
      <button
        type="button"
        className="bases-btn backlog-order-dir"
        onClick={() => onChange({ ...order, direction: order.direction === 'asc' ? 'desc' : 'asc' })}
      >
        {order.direction === 'asc' ? <AscIcon /> : <DescIcon />}
        {order.direction === 'asc' ? 'По возрастанию' : 'По убыванию'}
      </button>
    </div>
  )
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function DownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function AscIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="6 11 12 5 18 11" />
    </svg>
  )
}

function DescIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="6 13 12 19 18 13" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
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

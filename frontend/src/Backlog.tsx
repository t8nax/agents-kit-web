import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { WorkspaceRow } from './App'
import './Backlog.css'
import BacklogWriteModal, { AGENT_NAME, WriteIcon } from './BacklogWriteModal'
import { arrange, emptySelection, isFiltering, PRIORITIES, readOrder, TYPES, writeOrder, type Order, type Selection, type SortField } from './backlogView'
import { InlineMarkdown, Markdown } from './Markdown'
import { Sk, Skeleton } from './Skeleton'
import { freeCopies } from './copies'
import StartTaskModal, { PlayIcon } from './StartTaskModal'
import { numberLetters } from './taskTitle'

export type BacklogEntry = {
  number: string | null
  title: string
  text: string | null
  /** Поля кита: запись несёт их, когда шапка backlog.md базы объявила их строкой «поля:», иначе они пусты. */
  priority?: string | null
  type?: string | null
}

export type BaseBacklog = {
  base: string
  project: string
  entries: BacklogEntry[]
  error: string | null
  /** Буквы номеров проекта: запись с другими буквами кит перенумерует, и задачей она не запускается. */
  letters?: string | null
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
 */
export default function Backlog({
  writeFor = null,
  onStarted,
}: {
  writeFor?: string | null
  onStarted?: (copy: string) => void
} = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [filter, setFilter] = useState<string | null>(writeFor)
  // Отбор и порядок записей внутри каждого проекта: порядок помнит браузер, отбор каждое открытие раздела пуст
  const [selection, setSelection] = useState<Selection>(emptySelection)
  const [order, setOrder] = useState<Order>(readOrder)

  const changeOrder = useCallback((next: Order) => {
    setOrder(next)
    writeOrder(next)
  }, [])
  const [opened, setOpened] = useState<BacklogEntry | null>(null)
  const [writing, setWriting] = useState(writeFor !== null)
  // Запись, которую берут в работу
  const [starting, setStarting] = useState<Started | null>(null)
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

  const loadBacklogs = useCallback(() => {
    fetch('/api/backlog')
      .then((response) => {
        if (!response.ok) throw new Error(`Бэклог не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseBacklog[]>
      })
      .then(
        (backlogs) => {
          setLoad({ kind: 'loaded', backlogs })
          // База могла уйти из списка, пока раздел был открыт: показываем тогда все проекты.
          setFilter((current) => (backlogs.some((b) => b.base === current) ? current : null))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [])

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
  useEffect(loadBacklogs, [loadBacklogs])
  useEffect(loadCopies, [loadCopies])

  const refresh = useCallback(() => {
    setLoad({ kind: 'loading' })
    setFresh(new Set())
    loadBacklogs()
    loadCopies()
  }, [loadBacklogs, loadCopies])

  const markWritten = useCallback(
    (base: string, numbers: string[]) => {
      setFresh((prev) => new Set([...prev, ...numbers.map((n) => `${base}|${n}`)]))
      loadBacklogs()
    },
    [loadBacklogs],
  )

  const closeWrite = useCallback(() => setWriting(false), [])

  const backlogs = load.kind === 'loaded' ? load.backlogs : []
  // Пока отбор включён, проект, где под него ничего не подошло, не показывается. Проект, чей бэклог
  // не читается, виден всегда: иначе сломанную базу не заметить за фильтром — решение оператора на B-78
  const filtering = isFiltering(selection)
  const shown = (filter === null ? backlogs : backlogs.filter((b) => b.base === filter))
    .map((backlog) => ({ backlog, entries: arrange(backlog.entries, selection, order) }))
    .filter(({ backlog, entries }) => entries.length > 0 || !filtering || backlog.error)

  return (
    <>
      <div className="content-head">
        <h2>Бэклог</h2>
        <button
          type="button"
          className="bases-btn bases-btn-add head-end"
          onClick={() => setWriting(true)}
          disabled={backlogs.length === 0}
        >
          <WriteIcon />
          Добавить с помощью {AGENT_NAME}
        </button>
        <button type="button" className="bases-btn" onClick={refresh} disabled={load.kind === 'loading'}>
          <RefreshIcon />
          Обновить
        </button>
      </div>

      {load.kind === 'loading' && <BacklogSkeleton />}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && backlogs.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в окне «Базы знаний».</p>
      )}

      {load.kind === 'loaded' && backlogs.length > 0 && (
        <div className="loaded">
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

          {filtering && shown.every(({ entries }) => entries.length === 0) && (
            <p className="empty-message">Под фильтр записей нет</p>
          )}

          <div className="backlog-list">
            {shown.map(({ backlog, entries }) => (
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
                {backlog.error && (
                  <p className="backlog-note warning-text">
                    <WarningIcon />
                    {backlog.error}
                  </p>
                )}
                {!backlog.error && backlog.entries.length === 0 && (
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
                          setOpened(entry)
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
                      {/* Запуск адресует запись номером, поэтому у записи без номера его нет вовсе */}
                      {entry.number && (
                        <button
                          type="button"
                          className="entry-start"
                          // Копий ещё не прочитали или свободных не осталось — запускать некуда; запись чужими
                          // буквами кит перенумерует — запускать её рано. Почему, кнопка не пишет — как
                          // приглушённые переходы строки копии.
                          disabled={
                            copies === null ||
                            freeCopies(copies, backlog.base).length === 0 ||
                            numberLetters(entry.number) !== backlog.letters
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
              </section>
            ))}
          </div>
        </div>
      )}

      {opened && <EntryModal entry={opened} onClose={closeEntry} />}
      {starting && (
        <StartTaskModal
          base={starting.base}
          entry={starting.entry}
          onClose={() => {
            setStarting(null)
            focusOpener()
          }}
          onStarted={(copy) => {
            setStarting(null)
            focusOpener()
            onStarted?.(copy)
            // Копия становится занятой сразу, а запись из бэклога убирает агент, когда до неё дойдёт:
            // в этом чтении её обычно ещё видно.
            loadBacklogs()
            loadCopies()
          }}
        />
      )}
      {writing && (
        <BacklogWriteModal
          bases={backlogs.map((b) => ({ base: b.base, project: b.project }))}
          initialBase={filter}
          onClose={closeWrite}
          onEntries={markWritten}
        />
      )}
    </>
  )
}

// Окно записи: текст оператору читают здесь, а список держит одни заголовки.
function EntryModal({ entry, onClose }: { entry: BacklogEntry; onClose: () => void }) {
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
        </div>
      </div>
    </div>
  )
}

// Значения полей задаёт кит; своё значение панель не судит, а показывает плашкой без цвета.
const PRIORITY_CLASS: Record<string, string> = {
  низкий: 'entry-prio-low',
  средний: 'entry-prio-mid',
  высокий: 'entry-prio-high',
  блокер: 'entry-prio-blocker',
}

const TYPE_CLASS: Record<string, string> = { баг: 'entry-type-bug', фича: 'entry-type-feature' }

/** Бэклог, пока он читается в первый раз: чипы проектов, строка отбора и записи проектов полосами (макет B-201). */
function BacklogSkeleton() {
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
    <Skeleton label="Загрузка бэклога">
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

/** Ширина колонки номера в знаках — по самому длинному номеру проекта; номеров нет — колонки нет. */
function numberWidth(entries: BacklogEntry[]): number {
  return Math.max(0, ...entries.map((entry) => entry.number?.length ?? 0))
}

/** Тип и приоритет записи: тип — значок со словом, приоритет — плашка, цвет которой растёт со срочностью. */
function EntryFields({ entry }: { entry: BacklogEntry }) {
  return (
    <>
      {/* Пробелы не видны во flex-строке, но разделяют плашки в имени кнопки записи */}
      {entry.type && (
        <span className={`entry-type ${TYPE_CLASS[entry.type] ?? ''}`}>
          {entry.type === 'фича' ? <FeatureIcon /> : <BugIcon />}
          {entry.type}
        </span>
      )}{' '}
      {entry.priority && (
        <span className={`entry-prio ${PRIORITY_CLASS[entry.priority] ?? ''}`}>{entry.priority}</span>
      )}
    </>
  )
}

function BugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function FeatureIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z" />
    </svg>
  )
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

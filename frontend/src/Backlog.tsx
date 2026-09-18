import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceRow } from './App'
import './Backlog.css'
import BacklogWriteModal, { AGENT_NAME, WriteIcon } from './BacklogWriteModal'
import { InlineMarkdown, Markdown } from './Markdown'
import { freeCopies } from './freeCopies'
import StartTaskModal, { PlayIcon } from './StartTaskModal'

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
}

/** Запись, которую берут в работу, вместе с базой её проекта: по ним идёт запуск. */
type Started = { base: string; entry: BacklogEntry & { number: string } }

/** Сколько висит сообщение о запущенной задаче — решение оператора на приёмке B-40. */
const startedMs = 5000

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; backlogs: BaseBacklog[] }

// Фильтр по проектам: null — все проекты, иначе путь базы выбранного проекта.
/** writeFor — база просьбы, к которой вернулся оператор: окно записи открывается сразу на ней. */
export default function Backlog({ writeFor = null }: { writeFor?: string | null } = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [filter, setFilter] = useState<string | null>(writeFor)
  const [opened, setOpened] = useState<BacklogEntry | null>(null)
  const [writing, setWriting] = useState(writeFor !== null)
  // Запись, которую берут в работу, и имя копии, в которую задача ушла
  const [starting, setStarting] = useState<Started | null>(null)
  const [started, setStarted] = useState<string | null>(null)
  // Копии всех баз: по ним видно, есть ли у проекта записи куда запускать. null — ещё не прочитаны.
  const [copies, setCopies] = useState<WorkspaceRow[] | null>(null)
  // Записи, добавленные из панели, ключом «база|номер»: отмечены новыми до следующего «Обновить».
  const [fresh, setFresh] = useState<Set<string>>(() => new Set())
  // Закрытое окно возвращает фокус записи, с которой его открыли: клавиатура остаётся на месте в списке.
  const opener = useRef<HTMLButtonElement | null>(null)

  const closeEntry = useCallback(() => {
    setOpened(null)
    opener.current?.focus()
  }, [])

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

  // Сообщение о запущенной задаче гаснет само — решение оператора на приёмке B-40
  useEffect(() => {
    if (!started) return
    const timer = setTimeout(() => setStarted(null), startedMs)
    return () => clearTimeout(timer)
  }, [started])

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
  const shown = filter === null ? backlogs : backlogs.filter((b) => b.base === filter)

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

      {load.kind === 'loading' && <p className="message text-sec">Загрузка бэклога…</p>}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}

      {load.kind === 'loaded' && backlogs.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в окне «Базы знаний».</p>
      )}

      {load.kind === 'loaded' && backlogs.length > 0 && (
        <>
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

          <div className="backlog-list">
            {shown.map((backlog) => (
              <section key={backlog.base} aria-label={backlog.project}>
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
                {backlog.entries.map((entry, index) => {
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
                        {entry.number && <span className="entry-num">{entry.number}</span>}{' '}
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
                          // Копий ещё не прочитали или свободных не осталось — запускать некуда;
                          // почему, кнопка не пишет — как приглушённые переходы строки копии.
                          disabled={copies === null || freeCopies(copies, backlog.base).length === 0}
                          onClick={() => setStarting({ base: backlog.base, entry: { ...entry, number: entry.number! } })}
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
        </>
      )}

      {opened && <EntryModal entry={opened} onClose={closeEntry} />}
      {starting && (
        <StartTaskModal
          base={starting.base}
          entry={starting.entry}
          onClose={() => setStarting(null)}
          onStarted={(copy) => {
            setStarted(copy)
            setStarting(null)
            // Запись из бэклога убирает агент, а копия становится занятой — перечитываем и то и другое
            loadBacklogs()
            loadCopies()
          }}
        />
      )}
      {started && (
        <div className="nw-toast" role="status">
          <PlayIcon />
          <span>Задача запущена в {started}</span>
        </div>
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

function BugIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

function FeatureIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
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

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button type="button" className={`chip ${active ? 'active' : ''}`} aria-pressed={active} onClick={onClick}>
      {label}
    </button>
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

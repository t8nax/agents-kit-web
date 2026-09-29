import { useEffect, useRef, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { ChoiceMark } from './ChoiceMark'
import { Markdown } from './Markdown'
import { useAgentConversation } from './agentConversation'
import {
  changedText,
  checked,
  checkText,
  emptyDescription,
  knownTracker,
  projectPlaceholder,
  queryPlaceholder,
  rejectedText,
  sameField,
  sections,
  serverPlaceholder,
  trackerNames,
  type DescriptionField,
  type ProjectTrackerRow,
  type TrackerDescription,
  type TrackerChanged,
  type TrackerRejected,
} from './projectTracker'
import './Modal.css'
import './AskModal.css'
import './Tabs.css'
import './FlowRewriteModal.css'
import './TrackerProjectsCard.css'

/**
 * Событие переписки о трекере — как у переписки о флоу: у ответа proposal — описание целиком, до которого
 * договорились, changed — сколько тронул он сам; у ответа-вопроса их нет.
 */
export type TrackerEvent =
  | { type: 'reply'; text: string }
  | { type: 'step'; text: string }
  | { type: 'note'; text: string }
  | { type: 'rework'; text: string }
  | { type: 'stopped'; text: string }
  | { type: 'answer'; text: string; durationMs?: number; proposal?: TrackerDescription | null; changed?: TrackerChanged | null }
  | { type: 'error'; text: string; output?: string }

type Tab = 'talk' | 'changes'

/** Чем кончилась запись: отказ по полям, отказ целиком или сохранено, но база не ушла на сервер. */
type Outcome =
  | { kind: 'fields'; faults: Partial<Record<DescriptionField, string>> }
  | { kind: 'failed'; text: string; output?: string }
  | { kind: 'unpushed'; output: string }

const examples = [
  'Задачи в GitHub, в репозитории этого проекта; показывать назначенные на меня',
  'Трекер — YouTrack на acme.youtrack.cloud, проект PAY',
  'Задачи в Jira, проект BILL; при взятии ставить статус In Progress',
]

function readSeen(key: string | null) {
  if (!key) return 0
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

function stepsOfTurn(events: TrackerEvent[]) {
  const steps: string[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'reply' || event.type === 'rework') break
    if (event.type === 'step') steps.unshift(event.text)
  }
  return steps
}

type Props = {
  row: ProjectTrackerRow
  /** Описание записано — карточка перечитывает строки. */
  onSaved: () => void
  onClose: () => void
}

/**
 * Окно «Трекер проекта с Чудо-Юдо» — одно на «Завести» и «Изменить» (макет B-293): переписка с агентом, который
 * по правилам кита предлагает описание целиком, и вкладка «Изменения», где его поля правятся и руками. «Принять правки»
 * проверяет трекер, записывает описание в базу и отправляет базу на сервер.
 */
export default function TrackerRewriteModal({ row, onSaved, onClose }: Props) {
  const saved = row.description
  const [text, setText] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('talk')
  const [seenNow, setSeenNow] = useState(0)
  // Правка руками и итог записи помнят, поверх какого предложения агента они сделаны: новое предложение ложится
  // в поля целиком, и прежние правка и причины отказа уходят вместе с прежним предложением.
  const [edited, setEdited] = useState<{ at: number; draft: TrackerDescription } | null>(null)
  const [applying, setApplying] = useState(false)
  const [result, setResult] = useState<{ at: number; outcome: Outcome } | null>(null)
  const conversation = useAgentConversation<TrackerEvent>('tracker')
  const { running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  const foreign = conversation.base !== null && conversation.base !== row.base
  const events = foreign ? [] : conversation.events
  const started = events.length > 0
  const value = text ?? (foreign ? '' : (retry ?? ''))
  const steps = running && !foreign ? stepsOfTurn(events) : []
  const reworking = running && events.findLast((event) => event.type !== 'step')?.type === 'rework'
  const talk = useRef<HTMLDivElement>(null)
  const seenKey = conversation.id && !foreign ? `tracker-rewrite-seen:${conversation.id}` : null
  const seen = Math.max(seenNow, readSeen(seenKey))

  const proposalAt = events.findLastIndex((event) => event.type === 'answer' && !!event.proposal)
  const proposal = proposalAt < 0 ? null : (events[proposalAt] as Extract<TrackerEvent, { type: 'answer' }>).proposal!
  const lastChange = events.reduce(
    (last, event, i) => (event.type === 'answer' && event.changed && changedText(event.changed) ? i + 1 : last),
    0,
  )
  const dot = tab !== 'changes' && lastChange > seen
  const draft = edited?.at === proposalAt ? edited.draft : (proposal ?? saved ?? emptyDescription)
  const outcome = result?.at === proposalAt ? result.outcome : null
  const setOutcome = (next: Outcome | null) => setResult(next ? { at: proposalAt, outcome: next } : null)
  const kind = knownTracker(draft.tracker)
  // Пока Чудо-Юдо отвечает, поля не правятся: его предложение легло бы поверх набранного (ревью B-293).
  const answering = running && !foreign
  const fields: DescriptionField[] = ['tracker', 'server', 'project', 'query', 'where', 'backlog', 'take', 'closed', 'move']
  // Отбор задач — только у трекеров, задачи которых панель читает; у Jira и GitLab поля нет, и строка не пишется (B-300).
  const filtered = checked(kind)
  // Имеющееся описание без правок записывать нечего.
  const unchanged = saved !== null && fields.every((field) => sameField(field, saved, draft))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !applying) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, applying])

  useEffect(() => {
    const box = talk.current
    if (box && tab === 'talk') box.scrollTop = box.scrollHeight
  }, [events.length, steps.length, tab])

  function openChanges() {
    setTab('changes')
    setSeenNow(events.length)
    if (seenKey)
      try {
        localStorage.setItem(seenKey, String(events.length))
      } catch {
        // Хранилище браузера недоступно: отметка живёт, пока открыто окно.
      }
  }

  function edit(field: DescriptionField, next: string) {
    setEdited({ at: proposalAt, draft: { ...draft, [field]: next } })
    setOutcome(outcome?.kind === 'fields' ? { kind: 'fields', faults: { ...outcome.faults, [field]: undefined } } : null)
  }

  async function submit() {
    const said = value.trim()
    if (!said || running) return
    setText(null)
    // Реплика несёт описание, каким оно стоит в полях: правку руками агент видит.
    const sent = started ? await send(said, { description: draft }) : await start({ base: row.base, wish: said, description: draft })
    if (sent.ok) return
    setText(said)
    setFailure(
      sent.status === 404
        ? started
          ? 'Панель потеряла переписку: её больше нет в списке'
          : 'Базы нет в списке панели или на диске'
        : sent.status === 409
          ? `${AGENT_NAME} ещё отвечает на прошлую реплику`
          : sent.status === 422
            ? 'Панель не прочитала у кита правила описания трекера: путь к киту задаётся в «Настройках»'
            : sent.status === null
              ? 'Нет связи с API'
              : 'Панель не приняла реплику',
    )
  }

  async function newTalk() {
    setText(null)
    setTab('talk')
    setSeenNow(0)
    setEdited(null)
    setResult(null)
    await forget()
  }

  async function apply() {
    setApplying(true)
    setOutcome(null)
    try {
      const response = await fetch('/api/trackers/projects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: row.base, version: row.version, description: filtered ? draft : { ...draft, query: '' } }),
      })
      if (response.ok) {
        const answer = (await response.json()) as { pushed: boolean; message?: string | null }
        onSaved()
        if (answer.pushed) setTab('talk')
        else setOutcome({ kind: 'unpushed', output: answer.message ?? '' })
        return
      }
      const rejected = (await response.json().catch(() => null)) as TrackerRejected | null
      if (!rejected) {
        setOutcome({ kind: 'failed', text: `Описание не записано: HTTP ${response.status}.` })
        return
      }
      if (rejected.problem === 'invalid' && rejected.faults) setOutcome({ kind: 'fields', faults: rejected.faults })
      else if (rejected.problem === 'check' && rejected.field)
        setOutcome({ kind: 'fields', faults: { [rejected.field]: checkText(rejected.code ?? '', rejected.detail, draft) } })
      else if (rejected.problem === 'check') setOutcome({ kind: 'failed', text: checkText(rejected.code ?? '', rejected.detail, draft) })
      else {
        // Описание поменялось под окном: карточка перечитывает его, а набранное в полях остаётся.
        if (rejected.problem === 'changed') onSaved()
        setOutcome({ kind: 'failed', ...rejectedText(rejected) })
      }
    } catch {
      setOutcome({ kind: 'failed', text: 'Описание не записано: нет связи с API.' })
    } finally {
      setApplying(false)
    }
  }

  const folder = row.base.split(/[\\/]/).filter(Boolean).pop() ?? row.base
  const faults = outcome?.kind === 'fields' ? outcome.faults : {}
  const onChanges = tab === 'changes'

  // Поле, разошедшееся с описанием в базе: у имеющегося трекера — «изменено» и прежнее значение зачёркнутым.
  function fieldHead(field: DescriptionField, label: string, id?: string) {
    const changed = saved !== null && !sameField(field, saved, draft)
    return (
      <>
        {/* Пометка — рядом с подписью, а не в ней: имя поля остаётся «Проект», а не «Проект изменено» */}
        <div className="tf-label">
          {id ? <label htmlFor={id}>{label}</label> : <span>{label}</span>}
          {changed && <span className="rewrite-mark rewrite-mark-changed">изменено</span>}
        </div>
        {changed && (
          <p className={`rewrite-was ${field === 'server' || field === 'project' || field === 'query' ? 'mono' : ''}`}>
            {saved[field] || 'пусто'}
          </p>
        )}
      </>
    )
  }
  const changedClass = (field: DescriptionField) => (saved !== null && !sameField(field, saved, draft) ? 'tf-changed' : '')

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !applying && onClose()}>
      <div className="modal-wizard ask-modal rewrite-modal tf-modal" role="dialog" aria-modal="true" aria-label={`Трекер проекта с ${AGENT_NAME}`}>
        <div className="ask-head">
          <div className="ask-title">
            <TrackerIcon />
            <h2>Трекер проекта с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" disabled={applying} onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          <div className="rewrite-project">
            <span className="ask-pick-label">Проект</span>
            <span className="rewrite-project-name">{row.project}</span>
            <span className="rewrite-project-folder">{folder}</span>
          </div>
          <div className="vc-tabs rewrite-tabs" role="tablist" aria-label="Вкладки окна">
            <button type="button" role="tab" aria-selected={!onChanges} className={`flow-tab ${!onChanges ? 'is-on' : ''}`} onClick={() => setTab('talk')}>
              Переписка
            </button>
            <button type="button" role="tab" aria-selected={onChanges} className={`flow-tab ${onChanges ? 'is-on' : ''}`} onClick={openChanges}>
              Изменения
              {dot && <span className="rewrite-tab-dot" aria-label="Список изменён последним ответом" />}
            </button>
          </div>
        </div>

        {!onChanges && (
          <div className="ask-body" ref={talk}>
            {restoring && <p className="modal-message">Загрузка…</p>}
            {foreign && (
              <p className="rewrite-foreign">
                Идёт переписка о трекере {conversation.project}: первая реплика отсюда начнёт новую, а ту уберёт.
              </p>
            )}
            {!restoring && !started && !value && (
              <div className="ask-examples">
                <div className="ask-examples-title">Например</div>
                {examples.map((example) => (
                  <button key={example} type="button" className="ask-example" onClick={() => setText(example)}>
                    {example}
                  </button>
                ))}
              </div>
            )}
            {events.map((event, i) => (
              <Said key={i} event={event} onChanges={openChanges} />
            ))}
            {running && !foreign && (
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {reworking ? `${AGENT_NAME} дописывает ответ…` : `${AGENT_NAME} разбирает трекер ${row.project}…`}
                </span>
                {startedAt !== null && <Elapsed since={startedAt} />}
              </div>
            )}
            {steps.length > 0 && (
              <ol className="ask-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                {steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
            {failure && (
              <div className="ask-error" role="alert">
                <strong>{AGENT_NAME} не ответил</strong>
                <span>{failure}. Описание не менялось.</span>
              </div>
            )}
          </div>
        )}

        {onChanges && (
          <div className="ask-body" aria-label="Изменения описания трекера">
            {outcome?.kind === 'unpushed' && (
              <div className="ask-error" role="alert">
                <strong>База не отправлена на сервер</strong>
                <span>Описание трекера записано на этом компьютере, но на сервер не ушло. Кит ответил:</span>
                {outcome.output && <pre>{outcome.output}</pre>}
              </div>
            )}
            {outcome?.kind === 'failed' && (
              <div className="ask-error" role="alert">
                <strong>Описание не записано</strong>
                <span>{outcome.text}</span>
                {outcome.output && <pre>{outcome.output}</pre>}
              </div>
            )}
            <div className="tf">
              <div className="tf-group">
                <p className="rewrite-group-title">Трекер</p>
                <div className={`tf-field ${changedClass('tracker')}`}>
                  {fieldHead('tracker', 'Вид трекера')}
                  <div className="tf-kinds" role="radiogroup" aria-label="Вид трекера" aria-invalid={faults.tracker ? true : undefined}>
                    {trackerNames.map((name) => (
                      <label key={name} className={`choice ${kind === name ? 'is-on' : ''}`}>
                        <input
                          type="radio"
                          name="tf-kind"
                          className="visually-hidden"
                          checked={kind === name}
                          disabled={applying || answering}
                          onChange={() => edit('tracker', name)}
                        />
                        <ChoiceMark />
                        <span className="choice-name">{name}</span>
                      </label>
                    ))}
                  </div>
                  {faults.tracker && (
                    <p className="bases-error" role="alert">
                      {faults.tracker}
                    </p>
                  )}
                </div>
                <div className="tf-pair">
                  {(['server', 'project'] as const).map((field) => (
                    <div key={field} className={`tf-field ${changedClass(field)}`}>
                      {fieldHead(field, field === 'server' ? 'Адрес сервера' : 'Проект', `tf-${field}`)}
                      <input
                        id={`tf-${field}`}
                        className="inp"
                        type="text"
                        value={draft[field]}
                        placeholder={kind ? (field === 'server' ? serverPlaceholder : projectPlaceholder)[kind] : undefined}
                        autoComplete="off"
                        spellCheck={false}
                        disabled={applying || answering}
                        aria-invalid={faults[field] ? true : undefined}
                        onChange={(e) => edit(field, e.target.value)}
                      />
                      {faults[field] && (
                        <p className="bases-error" role="alert">
                          {faults[field]}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
                {filtered && (
                  <div className={`tf-field ${changedClass('query')}`}>
                    {fieldHead('query', 'Запрос', 'tf-query')}
                    <input
                      id="tf-query"
                      className="inp"
                      type="text"
                      value={draft.query ?? ''}
                      placeholder={kind ? queryPlaceholder[kind] : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={applying || answering}
                      aria-invalid={faults.query ? true : undefined}
                      onChange={(e) => edit('query', e.target.value)}
                    />
                    {faults.query && (
                      <p className="bases-error" role="alert">
                        {faults.query}
                      </p>
                    )}
                  </div>
                )}
              </div>
              <div className="tf-group">
                <p className="rewrite-group-title">Разделы</p>
                {sections.map(({ field, label, hint }) => (
                  <div key={field} className={`tf-field ${changedClass(field)}`}>
                    {fieldHead(field, label, `tf-${field}`)}
                    <textarea
                      id={`tf-${field}`}
                      className="tf-area"
                      rows={2}
                      value={draft[field]}
                      placeholder={hint}
                      disabled={applying || answering}
                      aria-invalid={faults[field] ? true : undefined}
                      onChange={(e) => edit(field, e.target.value)}
                    />
                    {faults[field] && (
                      <p className="bases-error" role="alert">
                        {faults[field]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="modal-footer ask-footer">
          {!onChanges && (
            <>
              <label htmlFor="tracker-wish" className="visually-hidden">
                {started ? 'Следующая реплика' : 'Просьба'}
              </label>
              <textarea
                id="tracker-wish"
                className={`custom-textarea ask-textarea ${started ? 'ask-textarea-next' : ''}`}
                autoFocus
                value={value}
                disabled={running && !foreign}
                placeholder={
                  running && !foreign
                    ? `${AGENT_NAME} отвечает — реплика уйдёт, когда он закончит`
                    : started
                      ? 'Уточните, ответьте на вопрос или попросите поправить ещё'
                      : 'Скажите своими словами, где задачи проекта и что с ними делать, или что поменять в описании'
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
                }}
              />
            </>
          )}
          <div className="ask-actions">
            {onChanges && applying && checked(kind) && (
              <span className="foot-note" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span>
                  Панель читает задачи проекта <span className="mono">{draft.project.trim()}</span> на сервере{' '}
                  <span className="mono">{draft.server.trim()}</span>…
                </span>
              </span>
            )}
            {onChanges && !applying && kind !== null && !checked(kind) && (
              <span className="foot-note">Задачи {kind} панель не проверяет: описание запишется без проверки.</span>
            )}
            <div className="footer-right">
              <button type="button" className="btn" disabled={!started || (running && !foreign) || applying} onClick={() => void newTalk()}>
                Новая переписка
              </button>
              {onChanges ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={applying || answering || unchanged || outcome?.kind === 'unpushed'}
                  onClick={() => void apply()}
                >
                  {applying ? (checked(kind) ? 'Проверка…' : 'Запись…') : 'Принять правки'}
                </button>
              ) : running && !foreign ? (
                <button type="button" className="btn" onClick={() => void stop()}>
                  Отменить
                </button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={!value.trim()} onClick={() => void submit()}>
                  Отправить
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Said({ event, onChanges }: { event: TrackerEvent; onChanges: () => void }) {
  if (event.type === 'step') return null
  if (event.type === 'reply') return <div className="ask-said">{event.text}</div>
  if (event.type === 'answer') {
    const changed = event.changed ? changedText(event.changed) : ''
    return (
      <div className="ask-answer">
        {event.text && <Markdown className="ask-answer-text" text={event.text} />}
        <div className={`ask-answer-meta ${changed ? 'rewrite-upd' : ''}`}>
          {changed && (
            <span className="rewrite-upd-text">
              <ListIcon />
              В изменениях:{' '}
              <button type="button" className="rewrite-upd-link" onClick={onChanges}>
                {changed}
              </button>
            </span>
          )}
          {event.durationMs !== undefined && <span className="ask-duration">{formatDuration(event.durationMs)}</span>}
        </div>
      </div>
    )
  }
  if (event.type === 'error') {
    return (
      <div className="ask-error" role="alert">
        <strong>{event.text}</strong>
        <span>Описание не менялось, прежние правки и переписка остались.</span>
        {event.output && <pre>{event.output}</pre>}
      </div>
    )
  }
  if (event.type === 'rework') {
    return (
      <p className="rework-note">
        <ReturnIcon />
        <span>{event.text}</span>
      </p>
    )
  }
  return <p className="ask-note">{event.text}</p>
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.floor((now - since) / 1000))
  return (
    <span className="ask-elapsed" aria-label="Прошло времени">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

function formatDuration(ms: number) {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`
}

function TrackerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="11" y1="8" x2="17" y2="8" />
      <line x1="11" y1="12" x2="17" y2="12" />
      <line x1="11" y1="16" x2="17" y2="16" />
      <circle cx="7.5" cy="8" r="1" />
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

function ReturnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9 14 4 9 9 4" />
      <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="9" y1="6" x2="20" y2="6" />
      <line x1="9" y1="12" x2="20" y2="12" />
      <line x1="9" y1="18" x2="20" y2="18" />
      <circle cx="4.5" cy="6" r="1" />
      <circle cx="4.5" cy="12" r="1" />
      <circle cx="4.5" cy="18" r="1" />
    </svg>
  )
}

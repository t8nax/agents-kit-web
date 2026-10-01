import { useEffect, useRef, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { AttachError } from './Attachments'
import { Markdown } from './Markdown'
import VoiceButton from './VoiceButton'
import { useAgentConversation } from './agentConversation'
import {
  changedText,
  checked,
  knownTracker,
  sameField,
  sections,
  type DescriptionField,
  type ProjectTrackerRow,
  type TrackerChanged,
  type TrackerDescription,
  written,
} from './projectTracker'
import { appendSpoken } from './voice'
import './Modal.css'
import './AskModal.css'
import './Tabs.css'
import './FlowRewriteModal.css'
import './PerformerModal.css'
import './TrackerModal.css'

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

const lines: { field: DescriptionField; label: string; mono?: boolean }[] = [
  { field: 'tracker', label: 'Вид трекера' },
  { field: 'server', label: 'Адрес сервера', mono: true },
  { field: 'project', label: 'Проект', mono: true },
  { field: 'filter', label: 'Фильтр', mono: true },
]

type Props = {
  row: ProjectTrackerRow
  /** Поля окна «Трекер проекта» сейчас: они уходят с каждой репликой, с ними сверяется предложение. */
  current: TrackerDescription
  /** «Принять правки»: предложение ложится в поля окна «Трекер проекта». */
  onAccept: (proposal: TrackerDescription) => void
  onClose: () => void
}

/**
 * Окно «Трекер проекта с Чудо-Юдо» поверх окна «Трекер проекта» — как переписка исполнителя (B-320, B-323):
 * агент по правилам кита предлагает описание целиком, «Изменения» сверяют предложение с полями окна, «Принять
 * правки» кладёт его в поля, а в базу описание ложится кнопкой «Сохранить» окна трекера.
 */
export default function TrackerChatModal({ row, current, onAccept, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('talk')
  const [seenNow, setSeenNow] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const conversation = useAgentConversation<TrackerEvent>('tracker')
  const { running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  const foreign = conversation.base !== null && conversation.base !== row.base
  const events = foreign ? [] : conversation.events
  const started = events.length > 0
  const value = text ?? (foreign ? '' : (retry ?? ''))
  const steps = running && !foreign ? stepsOfTurn(events) : []
  const reworking = running && events.findLast((event) => event.type !== 'step')?.type === 'rework'
  const answering = running && !foreign
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
  const offered = proposal === null ? null : written(proposal)
  const now = written(current)
  const differs = (field: DescriptionField) => offered !== null && !sameField(field, now, offered)
  const fields: DescriptionField[] = ['tracker', 'server', 'project', 'filter', ...sections.map((one) => one.field)]
  const acceptable = fields.some(differs)
  const filtered = offered !== null && checked(knownTracker(offered.tracker))

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

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

  async function submit() {
    const said = value.trim()
    // Пока окно не узнало о своей переписке, первая реплика начала бы новую и убрала бы её (ревью B-320).
    if (!said || answering || restoring) return
    setText(null)
    // Реплика несёт описание, каким оно стоит в полях окна трекера: правку руками агент видит.
    const sent = started ? await send(said, { description: current }) : await start({ base: row.base, wish: said, description: current })
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
    await forget()
  }

  const folder = row.base.split(/[\\/]/).filter(Boolean).pop() ?? row.base
  const onChanges = tab === 'changes'

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard ask-modal rewrite-modal tf-modal" role="dialog" aria-modal="true" aria-label={`Трекер проекта с ${AGENT_NAME}`}>
        <div className="ask-head">
          <div className="ask-title">
            <TrackerIcon />
            <h2>Трекер проекта с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
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
            <button
              type="button"
              role="tab"
              aria-selected={onChanges}
              className={`flow-tab ${onChanges ? 'is-on' : ''}`}
              disabled={proposal === null}
              onClick={openChanges}
            >
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
            {answering && (
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
            {/* Сбой чужой переписки скрыт, как и она сама: в этом окне ничего не спрашивали. */}
            {failure && !foreign && (
              <div className="ask-error" role="alert">
                <strong>{AGENT_NAME} не ответил</strong>
                <span>{failure}. Поля трекера не менялись.</span>
              </div>
            )}
          </div>
        )}

        {onChanges && offered && (
          <div className="ask-body">
            <p className="rewrite-group-title">Трекер</p>
            <dl className="pc-list tf-changes" aria-label="Изменения трекера">
              {lines
                .filter(({ field }) => field !== 'filter' || filtered || differs('filter'))
                .map(({ field, label, mono }) => (
                  <Row key={field} label={label} changed={differs(field)} was={now[field]} mono={mono}>
                    {offered[field] || 'пусто'}
                  </Row>
                ))}
            </dl>
            <p className="rewrite-group-title">Разделы описания</p>
            <dl className="pc-list tf-changes" aria-label="Изменения разделов описания">
              {sections.map(({ field, label }) => (
                <Row key={field} label={label} changed={differs(field)} was={now[field]}>
                  {offered[field] || 'пусто'}
                </Row>
              ))}
            </dl>
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
                disabled={answering}
                placeholder={
                  answering
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
              <AttachError text={voiceError} />
            </>
          )}
          <div className="ask-actions">
            {/* Микрофон — слева в подвале, напротив кнопок, как в переписке исполнителя; у списка изменений поля нет */}
            {!onChanges && (
              <VoiceButton disabled={answering} onText={(spoken) => setText(appendSpoken(value, spoken))} onError={setVoiceError} />
            )}
            <div className="footer-right">
              <button type="button" className="btn" disabled={!started || answering} onClick={() => void newTalk()}>
                Новая переписка
              </button>
              {onChanges ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={answering || !proposal || !acceptable}
                  onClick={() => proposal && onAccept(proposal)}
                >
                  Принять правки
                </button>
              ) : answering ? (
                <button type="button" className="btn" onClick={() => void stop()}>
                  Отменить
                </button>
              ) : (
                <button type="button" className="btn btn-primary" disabled={!value.trim() || restoring} onClick={() => void submit()}>
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

/** Строка поля на «Изменениях»: изменённое помечено, прежнее значение зачёркнуто. */
function Row({
  label,
  changed,
  was,
  mono = false,
  children,
}: {
  label: string
  changed: boolean
  was: string
  mono?: boolean
  children: string
}) {
  return (
    <div className="pc-row">
      <dt>{label}</dt>
      <dd className={changed ? '' : 'pc-same'}>
        {changed && <span className="rewrite-mark rewrite-mark-changed">изменено</span>}
        {changed && was.trim() && <p className={`rewrite-was ${mono ? 'mono' : ''}`}>{was}</p>}
        <span className={mono ? 'pc-mono' : 'tf-changes-text'}>{children}</span>
      </dd>
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
        <span>Поля трекера не менялись, прежнее предложение и переписка остались.</span>
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

export function TrackerIcon() {
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

export function CloseIcon() {
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

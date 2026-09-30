import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { Markdown } from './Markdown'
import { useAgentConversation } from './agentConversation'
import { AttachError } from './Attachments'
import { appendSpoken } from './voice'
import VoiceButton from './VoiceButton'
import { PerformerIcon } from './Performers'
import { changedText, foreignTalk, type DraftEvent, type DraftFields } from './performerTalk'
import './Modal.css'
import './AskModal.css'
import './Tabs.css'
import './Settings.css'
import './Flow.css'
import './FlowRewriteModal.css'
import './PerformerModal.css'

type Tab = 'talk' | 'changes'

const examples = [
  'Читает дифф ветки задачи и возвращает вердикт с замечаниями по критериям',
  'Гоняет проверки фронта и бэкенда и объясняет, что покраснело',
  'Отвечает на вопрос по коду копии файлом и строкой, ничего не правя',
]

function readSeen(key: string | null) {
  if (!key) return 0
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

function stepsOfTurn(events: DraftEvent[]) {
  const steps: string[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'reply' || event.type === 'rework') break
    if (event.type === 'step') steps.unshift(event.text)
  }
  return steps
}

const same = (a: string | null | undefined, b: string | null | undefined) =>
  (a ?? '').replace(/\r\n/g, '\n').trim() === (b ?? '').replace(/\r\n/g, '\n').trim()

type Props = {
  base: string
  project: string
  /** Имя заведённого, которого переписывают; null — исполнителя заводят. */
  subject: string | null
  /** Поля окна исполнителя сейчас: они уходят с каждой репликой, с ними сверяется предложение. */
  current: DraftFields
  /** Модель и инструменты, выбранные оператором вручную: предложение их не меняет. */
  kept: { model: boolean; tools: boolean }
  /** «Принять правки»: предложение ложится в поля окна исполнителя. */
  onAccept: (proposal: DraftFields) => void
  onClose: () => void
}

/**
 * Окно «Исполнитель с Чудо-Юдо» поверх окна исполнителя — макет B-320: переписка с агентом, который предлагает
 * исполнителя целиком, и вкладка «Изменения», где предложение сверено с полями окна. «Принять правки» кладёт его
 * в поля, а в базу исполнитель ложится, как и прежде, кнопкой «Сохранить» окна исполнителя.
 */
export default function PerformerChatModal({ base, project, subject, current, kept, onAccept, onClose }: Props) {
  const [text, setText] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('talk')
  const [seenNow, setSeenNow] = useState(0)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const conversation = useAgentConversation<DraftEvent>('performer')
  const { running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  const talkOwner = conversation.base === null ? null : { base: conversation.base, subject: conversation.subject }
  const foreign = foreignTalk(talkOwner, { base, subject })
  const events = foreign ? [] : conversation.events
  const started = events.length > 0
  const value = text ?? (foreign ? '' : (retry ?? ''))
  const steps = running && !foreign ? stepsOfTurn(events) : []
  const reworking = running && events.findLast((event) => event.type !== 'step')?.type === 'rework'
  const answering = running && !foreign
  const talk = useRef<HTMLDivElement>(null)
  const seenKey = conversation.id && !foreign ? `performer-talk-seen:${conversation.id}` : null
  const seen = Math.max(seenNow, readSeen(seenKey))

  const proposalAt = events.findLastIndex((event) => event.type === 'answer' && !!event.proposal)
  const proposal = proposalAt < 0 ? null : (events[proposalAt] as Extract<DraftEvent, { type: 'answer' }>).proposal!
  const keptNow = { ...kept, name: subject !== null }
  const lastChange = events.reduce(
    (last, event, i) => (event.type === 'answer' && changedText(event.changed, keptNow) ? i + 1 : last),
    0,
  )
  const dot = tab !== 'changes' && lastChange > seen
  // Что поменяет «Принять правки»: имя заведённого, выбранные вручную модель и инструменты остаются как есть.
  const differs = {
    name: proposal !== null && subject === null && !same(proposal.name, current.name),
    description: proposal !== null && !same(proposal.description, current.description),
    prompt: proposal !== null && !same(proposal.prompt, current.prompt),
    model: proposal !== null && !same(proposal.model, current.model),
    tools: proposal !== null && !same(proposal.tools, current.tools),
  }
  const acceptable =
    differs.name || differs.description || differs.prompt || (differs.model && !kept.model) || (differs.tools && !kept.tools)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (reading) setReading(false)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, reading])

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
    // Реплика несёт поля, какими они стоят в окне исполнителя: правку руками агент видит, и у нового тоже.
    const sent = started ? await send(said, { current }) : await start({ base, wish: said, current, subject })
    if (sent.ok) return
    setText(said)
    setFailure(
      sent.status === 404
        ? started
          ? 'Панель потеряла переписку: её больше нет в списке'
          : 'Панель не нашла базу или её основную копию'
        : sent.status === 409
          ? `${AGENT_NAME} ещё отвечает на прошлую реплику`
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

  const folder = base.split(/[\\/]/).filter(Boolean).pop() ?? base
  const onChanges = tab === 'changes'
  const who = conversation.subject ? `об исполнителе ${conversation.subject}` : 'о новом исполнителе'

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !reading && onClose()}>
      <div
        className="modal-wizard ask-modal rewrite-modal"
        role="dialog"
        aria-modal={!reading}
        aria-label={`Исполнитель с ${AGENT_NAME}`}
        inert={reading}
      >
        <div className="ask-head">
          <div className="ask-title">
            <PerformerIcon />
            <h2>Исполнитель с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div className="rewrite-project">
            <span className="ask-pick-label">Исполнитель</span>
            {subject ? <span className="pc-name">{subject}</span> : <span className="rewrite-project-name">новый</span>}
            <span className="pc-sep" />
            <span className="ask-pick-label">Проект</span>
            <span className="rewrite-project-name">{project}</span>
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
                Идёт переписка {who} проекта {conversation.project}: первая реплика отсюда начнёт новую, а ту уберёт.
              </p>
            )}
            {!restoring && !started && !value && subject === null && (
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
              <Said key={i} event={event} kept={keptNow} onChanges={openChanges} />
            ))}
            {answering && (
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {reworking
                    ? `${AGENT_NAME} дописывает ответ…`
                    : subject
                      ? `${AGENT_NAME} переписывает исполнителя ${subject}…`
                      : `${AGENT_NAME} пишет исполнителя ${project}…`}
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
                <span>{failure}. Поля исполнителя не менялись.</span>
              </div>
            )}
          </div>
        )}

        {onChanges && proposal && (
          <div className="ask-body">
            <dl className="pc-list" aria-label="Изменения исполнителя">
              {subject === null && (
                <Row label="Имя" changed={differs.name} was={current.name}>
                  <span className="pc-mono">{proposal.name}</span>
                </Row>
              )}
              <Row label="Описание" changed={differs.description} was={current.description}>
                <span>{proposal.description || 'пусто'}</span>
              </Row>
              <div className="pc-row pc-row-btn">
                <dt>Задание</dt>
                <dd>
                  <span className="rewrite-description">
                    <button type="button" className="bases-btn flow-description-btn" onClick={() => setReading(true)}>
                      <FileIcon />
                      Открыть задание
                    </button>
                    {differs.prompt && <span className="rewrite-description-mark">изменено</span>}
                  </span>
                </dd>
              </div>
              <Choice
                label="Модель"
                manual={kept.model}
                changed={differs.model}
                now={current.model}
                offered={proposal.model}
                empty="как у сессии"
                mark="выбрана вручную"
              />
              <Choice
                label="Инструменты"
                manual={kept.tools}
                changed={differs.tools}
                now={current.tools}
                offered={proposal.tools}
                empty="все инструменты сессии"
                mark="выбраны вручную"
              />
            </dl>
          </div>
        )}

        <div className="modal-footer ask-footer">
          {!onChanges && (
            <>
              <label htmlFor="performer-wish" className="visually-hidden">
                {started ? 'Следующая реплика' : 'Просьба'}
              </label>
              <textarea
                id="performer-wish"
                className={`custom-textarea ask-textarea ${started ? 'ask-textarea-next' : ''}`}
                autoFocus
                value={value}
                disabled={answering}
                placeholder={
                  answering
                    ? `${AGENT_NAME} отвечает — реплика уйдёт, когда он закончит`
                    : started
                      ? 'Уточните, ответьте на вопрос или попросите поправить ещё'
                      : subject
                        ? 'Что переписать: например, пусть ещё сверяет работу с решениями базы'
                        : 'Расскажите своими словами, что исполнитель делает и что возвращает'
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
            {/* Микрофон — слева в подвале, напротив кнопок (макет B-291); у списка изменений поля нет */}
            {!onChanges && (
              <VoiceButton
                disabled={answering}
                onText={(spoken) => setText(appendSpoken(value, spoken))}
                onError={setVoiceError}
              />
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

      {reading && proposal && (
        <TaskRead name={subject ?? proposal.name ?? ''} prompt={proposal.prompt} onClose={() => setReading(false)} />
      )}
    </div>
  )
}

/** Строка поля на «Изменениях»: изменённое помечено, прежнее значение зачёркнуто. */
function Row({
  label,
  changed,
  was,
  children,
}: {
  label: string
  changed: boolean
  was: string | null
  children: ReactNode
}) {
  return (
    <div className="pc-row">
      <dt>{label}</dt>
      <dd className={changed ? '' : 'pc-same'}>
        {changed && <span className="rewrite-mark rewrite-mark-changed">изменено</span>}
        {changed && was?.trim() && <p className="rewrite-was">{was}</p>}
        {children}
      </dd>
    </div>
  )
}

/** Модель или инструменты: выбранное вручную остаётся, а предложенное Чудо-Юдо названо строкой под ним. */
function Choice({
  label,
  manual,
  changed,
  now,
  offered,
  empty,
  mark,
}: {
  label: string
  mark: string
  manual: boolean
  changed: boolean
  now: string | null
  offered: string | null
  empty: string
}) {
  if (manual && changed)
    return (
      <div className="pc-row">
        <dt>{label}</dt>
        <dd>
          <span className="rewrite-mark">{mark}</span>
          <span className="pc-mono">{now || empty}</span>
          <span className="pc-kept">
            {AGENT_NAME} предложил {offered || empty}
          </span>
        </dd>
      </div>
    )
  return (
    <Row label={label} changed={changed} was={now || empty}>
      <span className="pc-mono">{offered || empty}</span>
    </Row>
  )
}

/** Предложенное задание — окном только для чтения, как описание этапа на «Изменениях» во «Флоу». */
function TaskRead({ name, prompt, onClose }: { name: string; prompt: string; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => close.current?.focus(), [])
  return (
    <div className="modal-overlay pf-task-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="modal-wizard pf-task flow-description" role="dialog" aria-modal="true" aria-labelledby="pc-task-title">
        <div className="ask-head">
          <div className="ask-title">
            <FileIcon />
            <h2 id="pc-task-title">
              {name ? (
                <>
                  Задание <span className="pf-title-name">{name}</span>
                </>
              ) : (
                'Задание исполнителя'
              )}
            </h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть задание" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>
        <div className="ask-body">
          <Markdown className="pf-task-view" text={prompt} />
        </div>
        <div className="modal-footer ask-footer">
          <div className="ask-actions">
            <div className="footer-right">
              <button type="button" ref={close} className="btn" onClick={onClose}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function Said({
  event,
  kept,
  onChanges,
}: {
  event: DraftEvent
  kept: { model: boolean; tools: boolean; name: boolean }
  onChanges: () => void
}) {
  if (event.type === 'step') return null
  if (event.type === 'reply') return <div className="ask-said">{event.text}</div>
  if (event.type === 'answer') {
    const changed = changedText(event.changed, kept)
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
        <span>Поля исполнителя не менялись, прежнее предложение и переписка остались.</span>
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

function FileIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
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

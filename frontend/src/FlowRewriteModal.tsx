import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import type { FlowStage, NamedFlow } from './Flow'
import { Markdown } from './Markdown'
import { useAgentConversation } from './agentConversation'
import {
  changedText,
  pending,
  proposalItems,
  type ChangeKind,
  type FlowChanged,
  type FlowProposal,
  type ScenarioItem,
  type StageFieldName,
  type StageItem,
} from './flowChanges'
import './Modal.css'
import './AskModal.css'
import './Tabs.css'
import './FlowRewriteModal.css'

/**
 * Событие переписки о флоу: реплика оператора, ход агента, его ответ с правками, сбой или слово панели. У ответа
 * proposal — все правки переписки, changed — сколько тронул он сам; у ответа-вопроса changed нет.
 */
export type RewriteEvent =
  | { type: 'reply'; text: string }
  | { type: 'step'; text: string }
  | { type: 'note'; text: string }
  | { type: 'stopped'; text: string }
  | { type: 'answer'; text: string; durationMs?: number; proposal?: FlowProposal; changed?: FlowChanged }
  | { type: 'error'; text: string; output?: string }

type Props = {
  base: string
  project: string
  /** Этапы и сценарии проекта такими, какие они в базе: их агент и получает, а принятые правки пишутся поверх них. */
  stages: FlowStage[]
  flows: NamedFlow[]
  /** Значок этапа — тот же, что на карточке вкладки «Этапы». */
  mark: (title: string) => ReactNode
  /** Задачи, которые держат этап или сценарий: его не записать, пока они в работе (B-226). */
  lockedStage: (title: string) => string[] | null
  lockedFlow: (name: string) => string[] | null
  /** Записать правки в базу; вернуть, почему не записались, или null. */
  onApply: (proposal: FlowProposal) => Promise<string | null>
  onClose: () => void
}

type Tab = 'talk' | 'changes'

const examples = [
  'Заведи этап документации после мержа в обоих сценариях',
  'Пропускай приёмку, если задача не меняет вида панели',
  'В мелком сценарии дизайн не нужен',
]

const fieldLabels: Record<StageFieldName, string> = {
  title: 'название',
  executor: 'исполнитель',
  output: 'выход',
  skip: 'пропуск',
  helpers: 'помощники',
  description: 'описание',
}

const kindLabels: Record<ChangeKind, string> = {
  added: 'новый',
  changed: 'изменён',
  removed: 'удалён',
}

const empty: FlowProposal = { scenarios: [], stages: [] }

/** Сколько событий переписки оператор уже видел на вкладке «Изменения»; хранилище недоступно — ноль. */
function readSeen(key: string | null) {
  if (!key) return 0
  try {
    return Number(localStorage.getItem(key)) || 0
  } catch {
    return 0
  }
}

/** Ход работы нынешней реплики: шаги, набежавшие после последней реплики оператора. */
function stepsOfTurn(events: RewriteEvent[]) {
  const steps: string[] = []
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    if (event.type === 'reply') break
    if (event.type === 'step') steps.unshift(event.text)
  }
  return steps
}

export default function FlowRewriteModal({ base, project, stages, flows, mark, lockedStage, lockedFlow, onApply, onClose }: Props) {
  // Поле не трогали, пока text — null: тогда в нём стоит реплика, на которой агент сорвался.
  const [text, setText] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('talk')
  // Сколько событий переписки было, когда оператор последний раз смотрел вкладку «Изменения»: точка на ней горит,
  // пока ответ, поменявший список, пришёл позже. Отметку помнит браузер по переписке: окно, открытое заново, не
  // зажигает точку от списка, который уже смотрели.
  const [seenNow, setSeenNow] = useState(0)
  // Описание этапа читается своим окном поверх списка: в пункте стоит только кнопка.
  const [description, setDescription] = useState<{ title: string; text: string } | null>(null)
  // Правки пишутся: окно не закрывается, пока запись не кончилась, — иначе отказ записи был бы некому показать.
  const [applying, setApplying] = useState(false)
  const [applyFailure, setApplyFailure] = useState<string | null>(null)
  // Переписку держит панель: закрытое окно её не трогает, а открытое заново видит с начала (B-79).
  const conversation = useAgentConversation<RewriteEvent>('flow')
  const { running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  // Разом идёт одна переписка этого вида: про флоу другого проекта окно её не показывает, а новая отсюда её уберёт.
  const foreign = conversation.base !== null && conversation.base !== base
  const events = foreign ? [] : conversation.events
  const started = events.length > 0
  const value = text ?? (foreign ? '' : (retry ?? ''))
  const steps = running && !foreign ? stepsOfTurn(events) : []
  const talk = useRef<HTMLDivElement>(null)
  const seenKey = conversation.id && !foreign ? `flow-rewrite-seen:${conversation.id}` : null
  const seen = Math.max(seenNow, readSeen(seenKey))

  // Правки — последние, что пришли с ответом; записанное оператором из них уходит само.
  const proposal = [...events].reverse().find((event) => event.type === 'answer' && event.proposal)
  const shown = pending(stages, flows, (proposal?.type === 'answer' && proposal.proposal) || empty)
  const items = proposalItems(stages, flows, shown)
  const count = items.scenarios.length + items.stages.length
  const lastChange = events.reduce(
    (last, event, i) => (event.type === 'answer' && event.changed && changedText(event.changed) ? i + 1 : last),
    0,
  )
  const dot = count > 0 && tab !== 'changes' && lastChange > seen
  const onChanges = tab === 'changes' && count > 0

  // Занятое задачами не записать: строка над списком называет, что и кем занято.
  const held = [
    ...items.scenarios.flatMap((item) => {
      const tasks = item.of === null ? null : lockedFlow(item.of)
      return tasks ? [{ what: `сценарий «${item.of}»`, tasks }] : []
    }),
    ...items.stages.flatMap((item) => {
      const tasks = item.of === null ? null : lockedStage(item.of)
      return tasks ? [{ what: `этап «${item.of}»`, tasks }] : []
    }),
  ]

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (description) setDescription(null)
      // Пока правки пишутся, окно не закрывается; чтение описания записи не мешает.
      else if (!applying) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, description, applying])

  // Переписка растёт вниз: свежая реплика и ответ видны без прокрутки руками.
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
    if (!said || running) return

    setText(null)
    // Реплика несёт флоу раздела, каким он стал: оператор мог записать правки, и они уходят из списка.
    const sent = started ? await send(said, { stages, flows }) : await start({ base, wish: said, stages, flows })
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
            ? 'Панель не прочитала у кита правила формы этапа: путь к киту задаётся в «Настройках»'
            : sent.status === null
              ? 'Нет связи с API'
              : 'Панель не приняла реплику',
    )
  }

  async function newTalk() {
    setText(null)
    setTab('talk')
    setSeenNow(0)
    setApplyFailure(null)
    await forget()
  }

  /** Правки пишутся в базу сразу, одной записью раздела; переписка после записи продолжается. */
  async function apply() {
    setApplying(true)
    setApplyFailure(null)
    const failed = await onApply(shown)
    setApplying(false)
    if (failed) setApplyFailure(failed)
    else setTab('talk')
  }

  const folder = base.split(/[\\/]/).filter(Boolean).pop() ?? base

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !applying && onClose()}>
      <div
        className="modal-wizard ask-modal rewrite-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Переписать с ${AGENT_NAME}`}
      >
        <div className="ask-head">
          <div className="ask-title">
            <RewriteIcon />
            <h2>Переписать с {AGENT_NAME}</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" disabled={applying} onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          {/* Проект берётся из раздела: правки лягут в тот флоу, который оператор перед собой видит. */}
          <div className="rewrite-project">
            <span className="ask-pick-label">Проект</span>
            <span className="rewrite-project-name">{project}</span>
            <span className="rewrite-project-folder">{folder}</span>
          </div>
          <div className="vc-tabs rewrite-tabs" role="tablist" aria-label="Вкладки окна">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'talk' || count === 0}
              className={`flow-tab ${tab === 'talk' || count === 0 ? 'is-on' : ''}`}
              onClick={() => setTab('talk')}
            >
              Переписка
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={onChanges}
              className={`flow-tab ${onChanges ? 'is-on' : ''}`}
              disabled={count === 0}
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
                Идёт переписка о флоу {conversation.project}: первая реплика отсюда начнёт новую, а ту уберёт.
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
                  {AGENT_NAME} читает флоу {project}…
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
                <span>{failure}. Флоу не менялся.</span>
              </div>
            )}
          </div>
        )}

        {onChanges && (
          <div className="ask-body rewrite-changes" aria-label="Изменения флоу">
            {held.length > 0 && (
              <p className="rewrite-held-line" role="status">
                <LockIcon />
                <span>
                  Правки не записать: заняты задачами в работе —{' '}
                  {held.map((one, i) => (
                    <span key={one.what}>
                      {i > 0 && '; '}
                      {one.what}
                      {one.tasks.map((task) => (
                        <span key={task} className="flow-task-tag">
                          {task}
                        </span>
                      ))}
                    </span>
                  ))}
                  .
                </span>
              </p>
            )}
            {items.scenarios.length > 0 && (
              <div className="rewrite-group">
                <p className="rewrite-group-title">Сценарии</p>
                <div className="rewrite-items">
                  {items.scenarios.map((item) => (
                    <ScenarioRow key={`${item.kind}-${item.of}-${item.name}`} item={item} held={item.of === null ? null : lockedFlow(item.of)} />
                  ))}
                </div>
              </div>
            )}
            {items.stages.length > 0 && (
              <div className="rewrite-group">
                <p className="rewrite-group-title">Этапы</p>
                <div className="rewrite-items">
                  {items.stages.map((item) => (
                    <StageRow
                      key={`${item.kind}-${item.of}-${item.title}`}
                      item={item}
                      mark={mark}
                      held={item.of === null ? null : lockedStage(item.of)}
                      onDescription={setDescription}
                    />
                  ))}
                </div>
              </div>
            )}
            {applyFailure && (
              <div className="ask-error" role="alert">
                <strong>Правки не записаны</strong>
                <span>{applyFailure}</span>
              </div>
            )}
          </div>
        )}

        <div className="modal-footer ask-footer">
          {!onChanges && (
            <>
              <label htmlFor="flow-wish" className="visually-hidden">
                {started ? 'Следующая реплика' : 'Просьба'}
              </label>
              <textarea
                id="flow-wish"
                className={`custom-textarea ask-textarea ${started ? 'ask-textarea-next' : ''}`}
                autoFocus
                value={value}
                disabled={running && !foreign}
                placeholder={
                  running && !foreign
                    ? `${AGENT_NAME} отвечает — реплика уйдёт, когда он закончит`
                    : started
                      ? 'Уточните, ответьте на вопрос или попросите поправить ещё'
                      : 'Скажите своими словами, что поменять в сценариях и этапах или какой этап завести'
                }
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
                }}
              />
            </>
          )}
          <div className="ask-actions">
            {/* Кнопки стоят на своих местах весь разговор: пока переписки нет, «Новая переписка» приглушена,
                а «Отменить» встаёт ровно туда, где была «Отправить». */}
            <div className="footer-right">
              <button
                type="button"
                className="btn"
                disabled={!started || (running && !foreign) || applying}
                onClick={() => void newTalk()}
              >
                Новая переписка
              </button>
              {onChanges ? (
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={held.length > 0 || applying || running}
                  onClick={() => void apply()}
                >
                  {applying ? 'Запись…' : 'Принять правки'}
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

      {description && (
        <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && setDescription(null)}>
          <div
            className="flow-confirm flow-description"
            role="dialog"
            aria-modal="true"
            aria-label={`Описание этапа «${description.title}»`}
          >
            <h3>Описание этапа «{description.title}»</h3>
            <pre className="rewrite-description-text">{description.text}</pre>
            <div className="flow-confirm-actions">
              <button type="button" className="bases-btn" onClick={() => setDescription(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** Одно событие переписки. У ответа, поменявшего список, внизу строка, сколько он поменял, и переход к списку. */
function Said({ event, onChanges }: { event: RewriteEvent; onChanges: () => void }) {
  // Ход работы виден, пока идёт ответ, и отдельным списком: в переписке он не остаётся.
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
        <span>Флоу не менялся, прежние правки и переписка остались.</span>
        {event.output && <pre>{event.output}</pre>}
      </div>
    )
  }

  // note и stopped — слово самой панели о разговоре: ни ответ, ни сбой.
  return <p className="ask-note">{event.text}</p>
}

function Held({ tasks }: { tasks: string[] | null }) {
  if (!tasks) return null
  return (
    <span className="rewrite-held" title={`Занят: ${tasks.join(', ')}`}>
      <LockIcon />
      {tasks.join(', ')}
    </span>
  )
}

function ScenarioRow({ item, held }: { item: ScenarioItem; held: string[] | null }) {
  return (
    <details className="rewrite-item">
      <summary>
        <ChevronIcon />
        <span className={`rewrite-mark rewrite-mark-${item.kind}`}>{kindLabels[item.kind]}</span>
        <span className="rewrite-item-name">{item.name}</span>
        <span className="rewrite-item-what" />
        <Held tasks={held} />
      </summary>
      <div className="rewrite-item-body">
        {item.gone && (
          <p className="rewrite-drift">
            Сценария «{item.gone}» в разделе уже нет: «Принять правки» заведёт его снова.
          </p>
        )}
        <dl className="rewrite-chain-list">
          <div className="rewrite-chain-row">
            <dt>порядок</dt>
            <dd className="rewrite-chain">
              {item.chain.map((link, i) => (
                <span key={`${i}-${link.title}`} className="rewrite-chain-link">
                  {i > 0 && <span className="rewrite-arrow">→</span>}
                  <span className={`rewrite-token rewrite-token-${link.mark}`}>{link.title}</span>
                </span>
              ))}
            </dd>
          </div>
          {item.kind !== 'removed' && (
            <div className="rewrite-chain-row">
              <dt>возвраты</dt>
              <dd className="rewrite-returns">
                {item.returns === null
                  ? item.kind === 'added'
                    ? 'нет'
                    : 'без правок'
                  : item.returns.map((line) => <span key={line}>{line}</span>)}
              </dd>
            </div>
          )}
          {item.flow?.when && item.kind === 'added' && (
            <div className="rewrite-chain-row">
              <dt>когда</dt>
              <dd className="rewrite-returns">{item.flow.when}</dd>
            </div>
          )}
        </dl>
      </div>
    </details>
  )
}

function StageRow({
  item,
  mark,
  held,
  onDescription,
}: {
  item: StageItem
  mark: (title: string) => ReactNode
  held: string[] | null
  onDescription: (description: { title: string; text: string }) => void
}) {
  const where =
    item.flows.length === 0
      ? item.kind === 'removed'
        ? 'не стоял в сценариях'
        : 'не стоит в сценариях'
      : `в ${item.flows.length === 1 ? 'сценарии' : 'сценариях'} ${item.flows.map((name) => `«${name}»`).join(', ')}`
  const stage = item.stage
  const descriptionChange = item.fields.find((field) => field.field === 'description')
  const keys = item.fields.filter((field) => field.field !== 'description')

  return (
    <details className="rewrite-item">
      <summary>
        <ChevronIcon />
        <span className={`rewrite-mark rewrite-mark-${item.kind}`}>{kindLabels[item.kind]}</span>
        {mark(item.of ?? item.title)}
        <span className="rewrite-item-name">{item.title}</span>
        <span className="rewrite-item-what">{where}</span>
        <Held tasks={held} />
      </summary>
      <div className="rewrite-item-body">
        {item.gone && (
          <p className="rewrite-drift">Этапа «{item.gone}» в разделе уже нет: «Принять правки» заведёт его снова.</p>
        )}
        {item.kind === 'removed' && <p className="rewrite-none">Этап уйдёт из базы.</p>}

        {item.kind === 'added' && stage && (
          <dl className="rewrite-fields">
            <dt>исполнитель</dt>
            <dd>{stage.executor}</dd>
            <dt>выход</dt>
            <dd>{stage.output}</dd>
            {stage.skip && (
              <>
                <dt>пропуск</dt>
                <dd>{stage.skip}</dd>
              </>
            )}
            {stage.helpers && stage.helpers.length > 0 && (
              <>
                <dt>помощники</dt>
                <dd>{stage.helpers.join(', ')}</dd>
              </>
            )}
            {stage.description && (
              <>
                <dt>описание</dt>
                <dd>
                  <DescriptionButton title={item.title} text={stage.description} onOpen={onDescription} />
                </dd>
              </>
            )}
          </dl>
        )}

        {item.kind === 'changed' && (
          <dl className="rewrite-fields">
            {keys.map((field) => (
              <div key={field.field} className="rewrite-field">
                <dt>{fieldLabels[field.field]}</dt>
                <dd>
                  <span className={`rewrite-was ${field.before === null ? 'rewrite-none' : ''}`}>{field.before ?? 'нет'}</span>
                  {field.after !== null ? (
                    <span className="rewrite-now">{field.after}</span>
                  ) : (
                    <span className="rewrite-now rewrite-none">нет</span>
                  )}
                </dd>
              </div>
            ))}
            {descriptionChange && (
              <div className="rewrite-field">
                <dt>{fieldLabels.description}</dt>
                <dd>
                  {descriptionChange.after !== null ? (
                    <DescriptionButton title={item.title} text={descriptionChange.after} onOpen={onDescription} changed />
                  ) : (
                    <span className="rewrite-now rewrite-none">описание убрано</span>
                  )}
                </dd>
              </div>
            )}
          </dl>
        )}
      </div>
    </details>
  )
}

/** Описание в списке не пересказывается: кнопка открывает его текст окном. */
function DescriptionButton({
  title,
  text,
  changed = false,
  onOpen,
}: {
  title: string
  text: string
  changed?: boolean
  onOpen: (description: { title: string; text: string }) => void
}) {
  return (
    <span className="rewrite-description">
      <button type="button" className="bases-btn flow-description-btn" onClick={() => onOpen({ title, text })}>
        <FileTextIcon />
        Открыть описание
      </button>
      {changed && <span className="rewrite-description-mark">изменено</span>}
    </span>
  )
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

export function RewriteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="2.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="15.5" width="16" height="6" rx="1.5" />
      <path d="M12 8.5v7" />
      <path d="M9.5 13l2.5 2.5 2.5-2.5" />
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

function ChevronIcon() {
  return (
    <svg className="rewrite-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
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

function FileTextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>
  )
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}

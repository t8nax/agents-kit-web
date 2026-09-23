import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BacklogEntry } from './Backlog'
import { EntryFields } from './EntryFields'
import { InlineMarkdown, Markdown } from './Markdown'
import { useAgentConversation } from './agentConversation'
import './Modal.css'
import './ReplyModal.css'
import './AskModal.css'
import './BacklogWriteModal.css'

// Имя агента, который ведёт бэклог и отвечает по базе, — выбор оператора.
export const AGENT_NAME = 'Чудо-Юдо'

export type WriteBase = { base: string; project: string }

export type WrittenEntry = BacklogEntry

/** Правка предложения: change — запись станет entry, delete — запись entry уходит (into — куда влита). */
export type ProposalChange = {
  kind: 'change' | 'delete'
  number: string
  entry: WrittenEntry
  into?: string | null
}

export type Proposal = { id: string; changes: ProposalChange[] }

/** События разговора о бэклоге — те, что пишет панель (BacklogWriteEvent в API). */
export type WriteEvent =
  | { type: 'reply'; text: string; number?: string | null }
  | { type: 'step'; text: string }
  | { type: 'note'; text: string }
  | { type: 'stopped'; text: string }
  | {
      type: 'answer'
      text: string
      entries?: WrittenEntry[] | null
      commit?: string | null
      durationMs?: number | null
      proposal?: Proposal | null
    }
  | { type: 'error'; text: string; output?: string | null; entries?: WrittenEntry[] | null }
  | { type: 'saved'; text: string; commit?: string | null; proposalId: string }
  | { type: 'refused'; text: string; proposalId: string }

/** Переспрос на месте поля ввода: вопрос и красная кнопка, которая выбрасывает ждущее предложение. */
type Asking = { question: string; yes: string; onYes: () => void }

/** Что стало с предложением: ждёт, сохранено, отклонено или заменено следующей просьбой. */
type ProposalState = 'pending' | 'saved' | 'refused' | 'replaced'

type Props = {
  bases: WriteBase[]
  initialBase: string | null
  /** Запись, от которой окно открыто кнопкой «Изменить»: разговор начнётся про неё. */
  subject?: { base: string; entry: WrittenEntry } | null
  /** Запись бэклога по номеру: окно, открытое заново, показывает запись, о которой шёл разговор. */
  findEntry?: (base: string, number: string) => WrittenEntry | undefined
  onClose: () => void
  // Записи появились в backlog.md базы — список бэклога перечитывается и отмечает их новыми.
  onEntries: (base: string, numbers: string[]) => void
  /** Панель записала изменения по «Сохранить»: список бэклога перечитывается. */
  onSaved?: (base: string) => void
}

export default function BacklogWriteModal({
  bases,
  initialBase,
  subject = null,
  findEntry,
  onClose,
  onEntries,
  onSaved,
}: Props) {
  const [chosen, setChosen] = useState<string | null>(subject?.base ?? initialBase ?? bases[0]?.base ?? null)
  // null — поле не трогали: в нём стоит реплика, на которой агент сорвался, если она есть.
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<{ id: string; text: string; output?: string | null } | null>(null)
  // Переспрос на месте поля ввода: несохранённое предложение не уходит молча — решение оператора на B-228.
  const [asking, setAsking] = useState<Asking | null>(null)
  // Окно от записи начинает свой разговор, а окно из шапки подхватывает идущий.
  const conversation = useAgentConversation<WriteEvent>('backlog', subject === null)
  const { events, running, startedAt, failure, restoring, retry, start, send, stop, forget, setFailure } = conversation
  const feed = useRef<HTMLDivElement>(null)

  const talking = events.length > 0
  // Реплика, на которой агент сорвался, возвращается в поле: отправить её снова — одно нажатие.
  const value = text ?? retry ?? ''
  const base = conversation.base ?? chosen
  const project = bases.find((b) => b.base === base)?.project ?? ''
  const firstReply = events.find((e) => e.type === 'reply')
  const aboutNumber = subject?.entry.number ?? (firstReply?.type === 'reply' ? (firstReply.number ?? null) : null)
  const savedCount = events.filter((e) => e.type === 'saved').length
  const current = aboutNumber && base && findEntry ? (findEntry(base, aboutNumber) ?? null) : null
  // После «Сохранить» запись разговора показывается такой, какой её записали, а удалённая — отметкой «удалена».
  // Что с ней стало, говорит сохранённое предложение, а не список раздела: тот мог и не перечитаться.
  const saved = savedChange(events, aboutNumber)
  const aboutGone = saved?.kind === 'delete'
  const about = saved ? (aboutGone ? saved.entry : (current ?? saved.entry)) : (subject?.entry ?? current)

  // Закрытое окно разговор не трогает: открытое снова, оно показывает его на месте, а кончает его только
  // «Новая переписка» — как в окне вопроса по базе, решение оператора на B-228.
  const close = onClose

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  // Лента — переписка: видна последняя реплика.
  useLayoutEffect(() => {
    const node = feed.current
    if (node) node.scrollTop = node.scrollHeight
  }, [events.length, running])

  // Записи появились — список бэклога перечитывается и отмечает их новыми, даже если окно открыли заново.
  const added = events
    .flatMap((e) => (e.type === 'answer' || e.type === 'error' ? (e.entries ?? []) : []))
    .map((entry) => entry.number)
    .filter((number): number is string => number !== null)
    .join(' ')
  useEffect(() => {
    if (base && added) onEntries(base, added.split(' '))
  }, [base, added, onEntries])

  useEffect(() => {
    if (base && savedCount > 0) onSaved?.(base)
  }, [base, savedCount, onSaved])

  const states = proposalStates(events)
  const pendingProposal =
    events
      .flatMap((e) => (e.type === 'answer' && e.proposal ? [e.proposal] : []))
      .find((p) => states.get(p.id) === 'pending') ?? null
  const pending = pendingProposal !== null

  async function submit() {
    const said = value.trim()
    if (!said || !base || running) return
    setFailure(null)
    const sent = talking
      ? await send(said)
      : await start({ base, text: said, number: subject?.entry.number ?? undefined })
    if (sent.ok) {
      setText(null)
      return
    }
    setFailure(
      sent.status === 404
        ? talking
          ? 'Разговор кончился: панель его больше не помнит'
          : 'Базы нет в списке панели или на диске'
        : sent.status === 409
          ? `${AGENT_NAME} ещё отвечает`
          : sent.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла текст',
    )
  }

  /** «Новая переписка»: разговор уходит из панели, окно остаётся открытым для первой просьбы. */
  function newTalk() {
    if (pending) setAsking({ question: 'Начать новую переписку?', yes: 'Начать новую', onYes: () => void reset() })
    else void reset()
  }

  async function reset() {
    setAsking(null)
    setText(null)
    setSaveError(null)
    await forget()
  }

  async function save(id: string) {
    setSaving(id)
    setSaveError(null)
    try {
      const response = await fetch('/api/backlog/write/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (response.status === 404) setSaveError({ id, text: 'Предложение уже не ждёт сохранения' })
      else if (!response.ok) setSaveError({ id, text: 'Панель не сохранила изменения' })
      else {
        const saved = (await response.json()) as { commit?: string | null; error?: string | null; output?: string | null }
        if (saved.error) setSaveError({ id, text: saved.error, output: saved.output })
      }
    } catch {
      setSaveError({ id, text: 'Нет связи с API' })
    } finally {
      setSaving(null)
    }
  }

  async function refuse(id: string) {
    setSaveError(null)
    try {
      const response = await fetch('/api/backlog/write/refuse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!response.ok) setSaveError({ id, text: 'Предложение уже не ждёт ответа' })
    } catch {
      setSaveError({ id, text: 'Нет связи с API' })
    }
  }

  const placeholder = pending
    ? 'Поправить предложение или попросить ещё'
    : about && !talking
      ? `Что поменять в ${about.number} — или почему она больше не нужна`
      : 'Что записать, поменять, удалить или объединить'
  const lastReply = events.map((e) => e.type).lastIndexOf('reply')

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal-wizard reply-window backlog-talk" role="dialog" aria-modal="true" aria-label={AGENT_NAME}>
        <div className="reply-head">
          <div className="task-strip">
            <div className="strip-task talk-name">
              <WriteIcon />
              {AGENT_NAME}
            </div>
            {!talking && !subject && bases.length > 1 ? (
              <div className="talk-bases" role="group" aria-label="Проект">
                {bases.map((b) => (
                  <button
                    key={b.base}
                    type="button"
                    className={`chip ${b.base === chosen ? 'active' : ''}`}
                    aria-pressed={b.base === chosen}
                    title={b.base}
                    onClick={() => setChosen(b.base)}
                  >
                    {b.project}
                  </button>
                ))}
              </div>
            ) : (
              base && (
                <div className="strip-meta">
                  <span className="strip-project">{project}</span>
                  <span className="strip-sep">·</span>
                  {folderName(base)}
                </div>
              )
            )}
          </div>
          <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={close}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="reply-feed talk-feed" ref={feed}>
          {restoring && <p className="modal-message">Загрузка…</p>}
          {about && (
            <div className="talk-subject">
              <p className="talk-label">Запись</p>
              <ul className="write-entries">
                {aboutGone ? (
                  <EntryCard entry={about} badge="удалена" tone="added" removed />
                ) : (
                  <EntryCard entry={about} />
                )}
              </ul>
            </div>
          )}
          {events.map((event, i) => {
            switch (event.type) {
              case 'reply':
                return (
                  <div className="op-row" key={i}>
                    <div className={`op-bubble talk-said ${i === lastReply ? 'is-current' : ''}`}>{event.text}</div>
                  </div>
                )
              case 'note':
              case 'stopped':
                return (
                  <p className="ask-note" key={i}>
                    {event.text}
                  </p>
                )
              case 'answer':
                return (
                  <Answer
                    key={i}
                    event={event}
                    state={event.proposal ? (states.get(event.proposal.id) ?? 'replaced') : null}
                    saving={saving}
                    saveError={saveError}
                    onSave={(id) => void save(id)}
                    onRefuse={(id) => void refuse(id)}
                  />
                )
              case 'error':
                return (
                  <div className="agent-q talk-agent" key={i}>
                    <div className="ask-error" role="alert">
                      <strong>{AGENT_NAME} не справился</strong>
                      <span>{event.text}</span>
                      {event.output && <pre>{event.output}</pre>}
                    </div>
                    {event.entries && event.entries.length > 0 && (
                      <ul className="write-entries" aria-label="Новые записи">
                        {event.entries.map((entry, k) => (
                          <EntryCard key={entry.number ?? k} entry={entry} badge="добавлена" tone="added" />
                        ))}
                      </ul>
                    )}
                  </div>
                )
              default:
                return null
            }
          })}
          {running && (
            <div className="agent-q talk-agent">
              <div className="ask-waiting talk-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} читает бэклог {project}…
                </span>
                {startedAt !== null && <Elapsed since={startedAt} />}
              </div>
              {stepsOfTurn(events).length > 0 && (
                <ol className="ask-steps talk-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                  {stepsOfTurn(events).map((step, k) => (
                    <li key={k}>{step}</li>
                  ))}
                </ol>
              )}
            </div>
          )}
          {failure && (
            <div className="ask-error" role="alert">
              <strong>{AGENT_NAME} не получил просьбу</strong>
              <span>{failure}. Текст остался в поле.</span>
            </div>
          )}
        </div>

        {/* Поле на всю ширину, кнопки строкой под ним — как в окне вопроса по базе (макет B-228). Переспрос встаёт
            на место поля той же высоты, а его кнопки — на места двух кнопок. */}
        {asking ? (
          <div className="composer talk-composer" role="alertdialog" aria-label={asking.question}>
            <div className="talk-confirm">
              <strong>{asking.question}</strong>
              {pendingProposal && (
                <span>
                  Предложение {pendingParts(pendingProposal).join(', ')} не сохранено — в новой переписке его не будет.
                </span>
              )}
            </div>
            <div className="talk-buttons">
              <button type="button" className="btn composer-send" autoFocus onClick={() => setAsking(null)}>
                Отмена
              </button>
              <button type="button" className="btn btn-danger composer-send" onClick={asking.onYes}>
                {asking.yes}
              </button>
            </div>
          </div>
        ) : (
          <div className="composer talk-composer">
            <textarea
              className="composer-field talk-field"
              aria-label={`Просьба к ${AGENT_NAME}`}
              rows={2}
              autoFocus
              value={value}
              placeholder={placeholder}
              // Пока панель пишет предложение, новая просьба не уходит: агент застал бы бэклог посреди записи.
              disabled={running || restoring || saving !== null}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void submit()
                }
              }}
            />
            {/* Кнопки стоят на своих местах весь разговор: пока переписки нет, «Новая переписка» приглушена,
                а «Отменить» встаёт ровно туда, где была «Отправить». */}
            <div className="talk-buttons">
              <button
                type="button"
                className="btn composer-send"
                disabled={!talking || running || restoring || saving !== null}
                onClick={newTalk}
              >
                Новая переписка
              </button>
              {running ? (
                <button type="button" className="btn composer-send" onClick={() => void stop()}>
                  Отменить
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn-primary composer-send"
                  disabled={!base || !value.trim() || restoring || saving !== null}
                  onClick={() => void submit()}
                >
                  <SendIcon />
                  Отправить
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/** Ответ Чудо-Юдо: его слова, записи, добавленные сразу, и предложение, которое ждёт «Сохранить». */
function Answer({
  event,
  state,
  saving,
  saveError,
  onSave,
  onRefuse,
}: {
  event: Extract<WriteEvent, { type: 'answer' }>
  state: ProposalState | null
  saving: string | null
  saveError: { id: string; text: string; output?: string | null } | null
  onSave: (id: string) => void
  onRefuse: (id: string) => void
}) {
  const entries = event.entries ?? []
  const proposal = event.proposal ?? null
  return (
    <div className="agent-q talk-agent">
      {event.text && <Markdown className="talk-text" text={event.text} />}
      {entries.length > 0 && (
        <ul className="write-entries" aria-label="Новые записи">
          {entries.map((entry, i) => (
            <EntryCard key={entry.number ?? i} entry={entry} badge="добавлена" tone="added" />
          ))}
        </ul>
      )}
      {proposal && state && (
        <div className={`talk-group ${state === 'refused' || state === 'replaced' ? 'is-void' : ''}`}>
          {state === 'pending' && (
            <div className="talk-pending" role="status">
              <ClockIcon />
              <span>{pendingTitle(proposal)}</span>
            </div>
          )}
          <ProposalEntries proposal={proposal} state={state} />
          {state === 'pending' && saveError?.id === proposal.id && (
            <div className="ask-error" role="alert">
              <strong>Не сохранено</strong>
              <span>{saveError.text}</span>
              {saveError.output && <pre>{saveError.output}</pre>}
            </div>
          )}
          {state === 'pending' && (
            <div className="talk-actions">
              <button type="button" className="btn" disabled={saving !== null} onClick={() => onRefuse(proposal.id)}>
                Отказаться
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={saving !== null}
                onClick={() => onSave(proposal.id)}
              >
                Сохранить
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Записи предложения: объединение — «Останется» и «Уйдёт в …», остальное — списком. */
function ProposalEntries({ proposal, state }: { proposal: Proposal; state: ProposalState }) {
  const targets = [...new Set(proposal.changes.filter((c) => c.kind === 'delete' && c.into).map((c) => c.into!))]
  const merged = new Set([
    ...targets,
    ...proposal.changes.filter((c) => c.kind === 'delete' && c.into).map((c) => c.number),
  ])
  const rest = proposal.changes.filter((c) => !merged.has(c.number))
  return (
    <>
      {rest.length > 0 && (
        <ul className="write-entries" aria-label="Изменения">
          {rest.map((change) => (
            <ChangeCard key={change.number} change={change} state={state} />
          ))}
        </ul>
      )}
      {targets.map((target) => {
        const kept = proposal.changes.find((c) => c.number === target && c.kind === 'change')
        const gone = proposal.changes.filter((c) => c.kind === 'delete' && c.into === target)
        return (
          <div className="talk-merge" key={target}>
            {kept && (
              <>
                <p className="talk-label">Останется</p>
                <ul className="write-entries">
                  <ChangeCard change={kept} state={state} />
                </ul>
              </>
            )}
            <p className="talk-label">Уйдёт в {target}</p>
            <ul className="write-entries">
              {gone.map((change) => (
                <ChangeCard key={change.number} change={change} state={state} />
              ))}
            </ul>
          </div>
        )
      })}
    </>
  )
}

function ChangeCard({ change, state }: { change: ProposalChange; state: ProposalState }) {
  const removed = change.kind === 'delete'
  const badge =
    state === 'pending'
      ? removed
        ? 'удалить'
        : 'изменить'
      : state === 'saved'
        ? removed
          ? 'удалена'
          : 'изменена'
        : state === 'refused'
          ? 'отказались'
          : 'заменено'
  // Сохранённое — в бэклоге, как добавленное: зелёным; удаляемое, пока ждёт, — красным.
  const tone = state === 'saved' ? 'added' : removed && state === 'pending' ? 'removed' : undefined
  return (
    <EntryCard
      entry={change.entry}
      badge={badge}
      tone={tone}
      removed={removed}
      struck={state === 'refused'}
    />
  )
}

/** Запись карточкой: номер, заголовок и отметка; удаляемая — только номером и зачёркнутым заголовком. */
function EntryCard({
  entry,
  badge,
  tone,
  removed = false,
  struck = false,
}: {
  entry: WrittenEntry
  badge?: string
  tone?: 'added' | 'removed'
  removed?: boolean
  struck?: boolean
}) {
  return (
    <li className={`write-entry ${removed ? 'is-removed' : ''} ${struck ? 'is-struck' : ''}`}>
      <div className="write-entry-head">
        {entry.number && <span className="entry-num">{entry.number}</span>}
        <InlineMarkdown className="write-entry-title" text={entry.title} />
        {badge && <span className={`change-badge ${tone ?? ''}`}>{badge}</span>}
      </div>
      {!removed && (entry.type || entry.priority) && (
        <div className="write-entry-fields">
          <EntryFields entry={entry} />
        </div>
      )}
      {!removed &&
        (entry.text ? (
          <Markdown className="write-entry-text" text={entry.text} />
        ) : (
          <p className="write-entry-text entry-no-text">Описания нет</p>
        ))}
    </li>
  )
}

/**
 * Что стало с каждым предложением: сохранено и отклонено — по событиям панели; ждёт — последнее, после
 * которого оператор ничего не сказал; остальные заменены следующей просьбой.
 */
function proposalStates(events: WriteEvent[]): Map<string, ProposalState> {
  const states = new Map<string, ProposalState>()
  events.forEach((event, i) => {
    if (event.type !== 'answer' || !event.proposal) return
    const id = event.proposal.id
    const later = events.slice(i + 1)
    const closed = later.find(
      (e): e is Extract<WriteEvent, { type: 'saved' | 'refused' }> =>
        (e.type === 'saved' || e.type === 'refused') && e.proposalId === id,
    )
    if (closed) states.set(id, closed.type === 'saved' ? 'saved' : 'refused')
    else if (later.some((e) => e.type === 'reply')) states.set(id, 'replaced')
    else states.set(id, 'pending')
  })
  return states
}

/** Последняя сохранённая правка записи: какой она стала или что удалена. */
function savedChange(events: WriteEvent[], number: string | null) {
  if (number === null) return null
  const saved = new Set(events.flatMap((e) => (e.type === 'saved' ? [e.proposalId] : [])))
  let last: ProposalChange | null = null
  for (const event of events)
    if (event.type === 'answer' && event.proposal && saved.has(event.proposal.id))
      last = event.proposal.changes.find((change) => change.number === number) ?? last
  return last
}

/** Шаги ответа на последнюю реплику: ход виден только у той, на которую сейчас отвечают. */
function stepsOfTurn(events: WriteEvent[]) {
  const from = events.map((e) => e.type).lastIndexOf('reply')
  return events
    .slice(from + 1)
    .filter((e) => e.type === 'step')
    .map((e) => e.text)
}

function pendingTitle(proposal: Proposal) {
  const parts = pendingParts(proposal)
  return `${parts.length === 1 ? 'Ждёт' : 'Ждут'} сохранения: ${parts.join(', ')}`
}

/** Что предлагается, словами: «изменить 1», «удалить 2», «объединить 2 записи в одну». */
function pendingParts(proposal: Proposal) {
  const into = proposal.changes.filter((c) => c.kind === 'delete' && c.into)
  const targets = new Set(into.map((c) => c.into!))
  const changes = proposal.changes.filter((c) => c.kind === 'change' && !targets.has(c.number)).length
  const deletes = proposal.changes.filter((c) => c.kind === 'delete' && !c.into).length
  const parts = [
    changes > 0 && `изменить ${changes}`,
    deletes > 0 && `удалить ${deletes}`,
    ...[...targets].map((target) => {
      const count = 1 + into.filter((c) => c.into === target).length
      return `объединить ${count} ${plural(count, 'запись', 'записи', 'записей')} в одну`
    }),
  ].filter((part): part is string => Boolean(part))
  return parts
}

function plural(count: number, one: string, few: string, many: string) {
  const mod10 = count % 10
  const mod100 = count % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Имя каталога базы: полный путь в шапке окна не нужен. */
function folderName(path: string) {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
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

export function WriteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
    </svg>
  )
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  )
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  )
}

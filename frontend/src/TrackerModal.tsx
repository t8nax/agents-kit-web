import { useEffect, useRef, useState, type FormEvent } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { ChoiceMark } from './ChoiceMark'
import { WarningIcon } from './Problems'
import TrackerChatModal, { CloseIcon, TrackerIcon } from './TrackerChatModal'
import type { TrackerField } from './TrackerGroup'
import {
  checked,
  checkText,
  emptyDescription,
  keyed,
  keyPlaceholder,
  knownTracker,
  projectPlaceholder,
  rejectedText,
  sameField,
  sameValue,
  sections,
  serverPlaceholder,
  trackerNames,
  type DescriptionField,
  type ProjectTrackerRow,
  type TrackerDescription,
  type TrackerRejected,
  type WindowField,
  written,
} from './projectTracker'
import type { TrackerServer } from './TrackerProjects'
import './Modal.css'
import './AskModal.css'
import './FlowRewriteModal.css'
import './PerformerModal.css'
import './TrackerModal.css'

/** Чем кончилась запись: отказ по полям, отказ целиком или записано, но база не ушла на сервер. */
type Outcome =
  | { kind: 'fields'; faults: Partial<Record<WindowField, string>> }
  | { kind: 'failed'; text: string; output?: string }
  | { kind: 'unpushed'; output: string }

// Фильтра в окне нет: он задаётся на вкладке «Задачи трекера» (B-285)
const fields: DescriptionField[] = ['tracker', 'server', 'project', 'where', 'backlog', 'take', 'closed', 'move']

type Props = {
  row: ProjectTrackerRow
  /** Поле, куда встаёт курсор, — переход из строки причины «Бэклога» (B-285). */
  focusField?: TrackerField | null
  /** Сохранённый ключ к серверу трекера — его владелец и почта; null — ключа нет. */
  keyOwner?: TrackerServer | null
  /** Другие проекты на том же сервере: их читает тот же ключ. */
  sharedWith?: string[]
  /** Окно открыто возвратом к переписке из шапки панели: переписка с Чудо-Юдо встаёт поверх сразу. */
  talking?: boolean
  /** Описание записано — раздел перечитывает проекты. */
  onSaved: () => void
  onClose: () => void
}

/**
 * Окно «Трекер проекта» — одно на «Завести» и «Изменить», устроено как окно исполнителя (B-323): поля описания
 * правятся руками, а с Чудо-Юдо их пишут перепиской в окне поверх этого. «Сохранить» проверяет трекер, записывает
 * описание в базу и отправляет базу на сервер (B-293).
 */
export default function TrackerModal({
  row,
  focusField = null,
  keyOwner = null,
  sharedWith = [],
  talking = false,
  onSaved,
  onClose,
}: Props) {
  const saved = row.description
  const [draft, setDraft] = useState<TrackerDescription>(saved ?? emptyDescription)
  // Поля, какими они были до принятых правок Чудо-Юдо: «вернуть как было» ставит их обратно.
  const [before, setBefore] = useState<TrackerDescription | null>(null)
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [saving, setSaving] = useState(false)
  const [chatting, setChatting] = useState(talking)
  // Ключ и почта к серверу — только у трекеров, которым они нужны; в базу они не пишутся (ответ оператора на B-285).
  const [key, setKey] = useState('')
  // Владельцев ключей раздел читает своим запросом, и окно, открытое переходом из «Бэклога», может их опередить:
  // пока оператор поле не трогал, в нём почта владельца ключа, какой она пришла (ревью B-285). null — не трогал.
  const [typedEmail, setTypedEmail] = useState<string | null>(null)
  const email = typedEmail ?? keyOwner?.email ?? ''
  const kind = knownTracker(draft.tracker)
  const filtered = checked(kind)
  const withKey = keyed(kind)
  const jira = kind === 'Jira'
  // Ключ сохранён к тому серверу, что сейчас в поле адреса: к другому серверу он не относится.
  const owner = keyOwner && sameValue(draft.server.replace(/\/+$/, ''), keyOwner.server.replace(/\/+$/, '')) ? keyOwner : null
  const keyEdited = withKey && (key.trim() !== '' || (jira && !sameValue(email, owner?.email ?? '')))
  // Имеющееся описание без правок и без нового ключа записывать нечего.
  const unchanged = saved !== null && !keyEdited && fields.every((field) => sameField(field, saved, written(draft)))
  const faults = outcome?.kind === 'fields' ? outcome.faults : {}

  // Переход из причины «Бэклога»: курсор — в поле, которое она называет.
  useEffect(() => {
    if (focusField) document.getElementById(`tf-${focusField}`)?.focus()
  }, [focusField])

  // Закрытая переписка возвращает фокус на свою кнопку в подвале.
  const chatButton = useRef<HTMLButtonElement>(null)
  const wasChatting = useRef(chatting)
  useEffect(() => {
    if (wasChatting.current && !chatting) chatButton.current?.focus()
    wasChatting.current = chatting
  }, [chatting])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Переписку закрывает Escape само: окно трекера под ней остаётся.
      if (event.key === 'Escape' && !saving && !chatting) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, saving, chatting])

  function edit(field: DescriptionField, next: string) {
    setDraft((prev) => ({ ...prev, [field]: next }))
    clearFault(field)
  }

  function clearFault(field: WindowField) {
    setOutcome((prev) => (prev?.kind === 'fields' ? { kind: 'fields', faults: { ...prev.faults, [field]: undefined } } : null))
  }

  /** «Принять правки» переписки: предложение ложится в поля целиком. */
  function accept(proposal: TrackerDescription) {
    setBefore(draft)
    setDraft({ ...emptyDescription, ...proposal })
    setOutcome(null)
    setChatting(false)
  }

  function revert() {
    if (before) setDraft(before)
    setBefore(null)
    setOutcome(null)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (saving || unchanged) return
    setSaving(true)
    setOutcome(null)
    const description = written(draft)
    try {
      const response = await fetch('/api/trackers/projects', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base: row.base,
          version: row.version,
          description,
          key: withKey ? key : null,
          email: jira ? email : null,
        }),
      })
      if (response.ok) {
        const answer = (await response.json()) as { pushed: boolean; message?: string | null }
        onSaved()
        setBefore(null)
        if (answer.pushed) onClose()
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
        setOutcome({ kind: 'fields', faults: { [rejected.field]: checkText(rejected.code ?? '', rejected.detail, description) } })
      else if (rejected.problem === 'check') setOutcome({ kind: 'failed', text: checkText(rejected.code ?? '', rejected.detail, description) })
      else {
        // Описание поменялось под окном: раздел перечитывает его, а набранное в полях остаётся.
        if (rejected.problem === 'changed') onSaved()
        setOutcome({ kind: 'failed', ...rejectedText(rejected) })
      }
    } catch {
      setOutcome({ kind: 'failed', text: 'Описание не записано: нет связи с API.' })
    } finally {
      setSaving(false)
    }
  }

  // Поле, разошедшееся с описанием в базе: у имеющегося трекера — «изменено» и прежнее значение зачёркнутым.
  const changed = (field: DescriptionField) => saved !== null && !sameField(field, saved, draft)
  function head(field: DescriptionField, label: string, id?: string) {
    return (
      <>
        {/* Пометка — рядом с подписью, а не в ней: имя поля остаётся «Проект», а не «Проект изменено» */}
        <div className="tf-head">
          {id ? (
            <label className="tf-label" htmlFor={id}>
              {label}
            </label>
          ) : (
            <span className="tf-label">{label}</span>
          )}
          {changed(field) && <span className="rewrite-mark rewrite-mark-changed">изменено</span>}
        </div>
        {changed(field) && (
          <p className={`rewrite-was ${field === 'server' || field === 'project' || field === 'filter' ? 'mono' : ''}`}>
            {saved?.[field] || 'пусто'}
          </p>
        )}
      </>
    )
  }
  function fault(field: WindowField) {
    return (
      faults[field] && (
        <p className="field-error tf-error" role="alert">
          <WarningIcon />
          <span>{faults[field]}</span>
        </p>
      )
    )
  }
  const fieldClass = (field: DescriptionField) => `tf-field ${changed(field) ? 'tf-changed' : ''}`

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && !saving && !chatting && onClose()}>
      <form
        className="modal-wizard pf-modal tf-modal"
        role="dialog"
        aria-modal={!chatting}
        aria-label="Трекер проекта"
        // Пока открыта переписка, окно трекера под ней недоступно: Tab и программа чтения — только в верхнем.
        inert={chatting}
        onSubmit={save}
        noValidate
      >
        <div className="ask-head">
          <div className="ask-title">
            <span className="pf-mark" aria-hidden="true">
              <TrackerIcon />
            </span>
            <h2 className="tf-title">Трекер проекта</h2>
            <span className="pf-project" title={row.base}>
              {row.project}
            </span>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" disabled={saving} onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="ask-body">
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
          {before && (
            <div className="pf-status">
              <span>Правки {AGENT_NAME} приняты</span>
              <button type="button" className="pf-link" disabled={saving} onClick={revert}>
                вернуть как было
              </button>
            </div>
          )}
          <div className="tf">
            <div className="tf-group">
              <p className="rewrite-group-title">Трекер</p>
              <div className={fieldClass('tracker')}>
                {head('tracker', 'Вид трекера')}
                <div className="tf-kinds" role="radiogroup" aria-label="Вид трекера" aria-invalid={faults.tracker ? true : undefined}>
                  {trackerNames.map((name) => (
                    <label key={name} className={`choice ${kind === name ? 'is-on' : ''} ${saving && kind !== name ? 'is-off' : ''}`}>
                      <input
                        type="radio"
                        name="tf-kind"
                        className="visually-hidden"
                        checked={kind === name}
                        disabled={saving}
                        onChange={() => edit('tracker', name)}
                      />
                      <ChoiceMark />
                      <span className="choice-name">{name}</span>
                    </label>
                  ))}
                </div>
                {fault('tracker')}
              </div>
              <div className="tf-pair">
                {(['server', 'project'] as const).map((field) => (
                  <div key={field} className={fieldClass(field)}>
                    {head(field, field === 'server' ? 'Адрес сервера' : 'Проект', `tf-${field}`)}
                    <input
                      id={`tf-${field}`}
                      className="tf-input"
                      type="text"
                      value={draft[field]}
                      placeholder={kind ? (field === 'server' ? serverPlaceholder : projectPlaceholder)[kind] : undefined}
                      autoComplete="off"
                      spellCheck={false}
                      disabled={saving}
                      aria-invalid={faults[field] ? true : undefined}
                      onChange={(e) => edit(field, e.target.value)}
                    />
                    {fault(field)}
                  </div>
                ))}
              </div>
            </div>
            {withKey && (
              <div className="tf-group">
                <p className="rewrite-group-title">Ключ к серверу</p>
                {jira && (
                  <div className="tf-field">
                    <div className="tf-head">
                      <label className="tf-label" htmlFor="tf-email">
                        Почта
                      </label>
                    </div>
                    <input
                      id="tf-email"
                      className="tf-input"
                      type="email"
                      value={email}
                      placeholder="Почта аккаунта Atlassian"
                      autoComplete="off"
                      spellCheck={false}
                      disabled={saving}
                      aria-invalid={faults.email ? true : undefined}
                      onChange={(e) => {
                        setTypedEmail(e.target.value)
                        clearFault('email')
                      }}
                    />
                    {fault('email')}
                  </div>
                )}
                <div className="tf-field">
                  <div className="tf-head">
                    <label className="tf-label" htmlFor="tf-key">
                      Ключ
                    </label>
                  </div>
                  <input
                    id="tf-key"
                    className="tf-input"
                    type="password"
                    value={key}
                    // Сохранённый ключ не показывается: пустое поле его оставляет
                    placeholder={
                      owner
                        ? `сохранён ключ пользователя ${owner.login} — оставьте пустым, чтобы не менять`
                        : kind
                          ? keyPlaceholder[kind]
                          : undefined
                    }
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                    aria-invalid={faults.key ? true : undefined}
                    onChange={(e) => {
                      setKey(e.target.value)
                      clearFault('key')
                    }}
                  />
                  {fault('key')}
                  {sharedWith.length > 0 && <p className="tf-note">Этот ключ читает и проекты: {sharedWith.join(', ')}.</p>}
                </div>
              </div>
            )}
            <div className="tf-group">
              <p className="rewrite-group-title">Разделы описания</p>
              {sections.map(({ field, label, hint }) => (
                <div key={field} className={fieldClass(field)}>
                  {head(field, label, `tf-${field}`)}
                  <textarea
                    id={`tf-${field}`}
                    className="tf-area"
                    rows={2}
                    value={draft[field]}
                    placeholder={hint}
                    disabled={saving}
                    aria-invalid={faults[field] ? true : undefined}
                    onChange={(e) => edit(field, e.target.value)}
                  />
                  {fault(field)}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-footer ask-footer">
          <div className="ask-actions">
            {saving && filtered && (
              <span className="foot-note" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span>
                  Панель читает задачи проекта <span className="mono">{draft.project.trim()}</span> на сервере{' '}
                  <span className="mono">{draft.server.trim()}</span>…
                </span>
              </span>
            )}
            {!saving && kind !== null && !filtered && (
              <span className="foot-note">Задачи {kind} панель не проверяет: описание запишется без проверки.</span>
            )}
            <div className="footer-right">
              {/* Переписку открывает видимая кнопка подвала рядом с «Сохранить», как у исполнителя (B-320) */}
              <button type="button" ref={chatButton} className="btn pf-chat" disabled={saving} onClick={() => setChatting(true)}>
                <ChatIcon />
                {saved ? `Переписать с ${AGENT_NAME}` : `Завести с ${AGENT_NAME}`}
              </button>
              <button type="submit" className="btn btn-primary" disabled={saving || unchanged}>
                {saving ? (filtered ? 'Проверка…' : 'Запись…') : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      </form>

      {chatting && <TrackerChatModal row={row} current={draft} onAccept={accept} onClose={() => setChatting(false)} />}
    </div>
  )
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="2.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="15.5" width="16" height="6" rx="1.5" />
      <path d="M12 8.5v7" />
      <path d="M9.5 13l2.5 2.5 2.5-2.5" />
    </svg>
  )
}

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { Markdown } from './Markdown'
import { AttachError } from './Attachments'
import { appendSpoken } from './voice'
import VoiceButton from './VoiceButton'
import { PerformerIcon, type BasePerformers, type Performer } from './Performers'
import { NEWER_FORMAT_REFUSAL } from './NewerFormat'
import DeletePerformerModal from './DeletePerformerModal'
import { TrashIcon } from './DeleteWorkspaceModal'
import PerformerChatModal from './PerformerChatModal'
import type { DraftFields } from './performerTalk'
import './Modal.css'
import './AskModal.css'
import './PerformerModal.css'

/** Модель исполнителя: пусто — он идёт на модели сессии, которая его позвала. */
const models = ['', 'opus', 'sonnet', 'haiku']

/** Набор «только чтение»; пусто — все инструменты сессии, иначе список, как его понимает Claude Code. */
const READ_ONLY = 'Read, Glob, Grep'

/** Описание — строка шапки файла исполнителя: переводы строк в нём, все, что понимает разбор файла, сводятся в пробел. */
function oneLine(text: string) {
  return text.replace(/[ \t]*[\r\n\f\u0085\u2028\u2029]+[ \t]*/g, ' ')
}

/** Инструменты файла — переключатель «Только чтение» и свой список: набор чтения списком не считается. */
function splitTools(tools: string | null) {
  const readOnly = (tools ?? '').trim() === READ_ONLY
  return { readOnly, custom: readOnly ? '' : (tools ?? '') }
}

type Props = {
  /** Проекты панели: из них выбирают, в чью базу ляжет исполнитель. */
  bases: BasePerformers[]
  initial: string
  /** Правится заведённый — поля заполнены им, а имя уже задано; null — заводится новый. */
  editing: Performer | null
  /** Окно открыто отметкой переписки в шапке панели: переписка с Чудо-Юдо встаёт поверх сразу. */
  talking?: boolean
  onClose: () => void
  onSaved: (name: string) => void
  onDeleted: (name: string) => void
}

type Failure = { text: string; git: boolean }

/**
 * Окно исполнителя — в рамке окон ответа и записи в бэклог. Имя нового, описание, задание, модель и инструменты
 * правятся руками, а с Чудо-Юдо их пишут перепиской в окне поверх этого — видимой кнопкой в подвале (B-320);
 * нового можно завести и вовсе без него — решения оператора на B-198. Имя заведённого не меняется.
 */
export default function PerformerModal({ bases, initial, editing, talking = false, onClose, onSaved, onDeleted }: Props) {
  const [base, setBase] = useState(initial)
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [model, setModel] = useState(editing?.model ?? '')
  // Переключатель держит своё состояние, а свой список помнится, пока он включён: переключение его не стирает.
  const [readOnly, setReadOnly] = useState(() => splitTools(editing?.tools ?? null).readOnly)
  const [tools, setTools] = useState(() => splitTools(editing?.tools ?? null).custom)
  const chosenTools = readOnly ? READ_ONLY : tools
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  // Переписка с Чудо-Юдо открыта своим окном поверх этого.
  const [chatting, setChatting] = useState(talking)
  // Задание открыто для чтения своим окном поверх этого.
  const [reading, setReading] = useState(false)
  // Удаление подтверждается своим окном поверх этого, как удаление рабочей копии (B-83).
  const [deleting, setDeleting] = useState(false)
  // Закрытое окно задания возвращает фокус на кнопку, которой его открыли, — после перерисовки:
  // пока окно задания открыто, окно исполнителя inert, и фокус в него не встаёт.
  const taskButton = useRef<HTMLButtonElement>(null)
  const wasReading = useRef(false)
  const closeTask = useCallback(() => setReading(false), [])
  // Задание открыто в правке: Escape его не закрывает, иначе набранное пропало бы без вопроса.
  const taskEditing = useRef(false)
  const setTaskEditing = useCallback((value: boolean) => {
    taskEditing.current = value
  }, [])
  useEffect(() => {
    if (wasReading.current && !reading) taskButton.current?.focus()
    wasReading.current = reading
  }, [reading])
  // Закрытая переписка возвращает фокус на свою кнопку в подвале.
  const chatButton = useRef<HTMLButtonElement>(null)
  const wasChatting = useRef(chatting)
  useEffect(() => {
    if (wasChatting.current && !chatting) chatButton.current?.focus()
    wasChatting.current = chatting
  }, [chatting])
  // То же с окном удаления: после «Отмены» фокус возвращается на «Удалить исполнителя».
  const deleteButton = useRef<HTMLButtonElement>(null)
  const wasDeleting = useRef(false)
  useEffect(() => {
    if (wasDeleting.current && !deleting) deleteButton.current?.focus()
    wasDeleting.current = deleting
  }, [deleting])

  // Поля, какими они были до принятых правок Чудо-Юдо: «вернуть как было» ставит их обратно.
  const [before, setBefore] = useState<DraftFields | null>(null)
  // Модель и инструменты, которые оператор выбрал сам: правки Чудо-Юдо их не перетирают.
  const [chose, setChose] = useState({ model: false, tools: false })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Окна удаления и переписки закрывает Escape само: окно исполнителя под ними остаётся.
      if (event.key !== 'Escape' || busy || deleting || chatting) return
      // Escape закрывает верхнее окно: сначала задание, потом само окно исполнителя.
      if (reading) {
        if (!taskEditing.current) closeTask()
      } else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, deleting, chatting, onClose, reading, closeTask])

  const fields: DraftFields = { name, description, model, tools: chosenTools, prompt }

  /** «Принять правки» переписки: предложение ложится в поля, кроме выбранных вручную модели и инструментов. */
  function accept(proposal: DraftFields) {
    setBefore(fields)
    // Имя заведённого не меняется: по нему его зовут шаги флоу, а другое имя бэкенд счёл бы переименованием.
    if (!editing) setName(proposal.name ?? '')
    setDescription(oneLine(proposal.description ?? ''))
    if (!chose.model) setModel(proposal.model ?? '')
    if (!chose.tools) {
      const offered = splitTools(proposal.tools)
      setReadOnly(offered.readOnly)
      setTools(offered.custom)
    }
    setPrompt(proposal.prompt)
    setChatting(false)
  }

  // В правке имя — всегда прежнее: поля имени в ней нет, и записывается тот, кого открыли.
  const trimmed = editing ? editing.name : name.trim()
  const chosen = bases.find((b) => b.base === base) ?? bases[0]
  // Имя занято другим исполнителем проекта: сохранение переписало бы его.
  const occupied =
    trimmed.length > 0 && trimmed !== editing?.name && (chosen?.performers ?? []).some((p) => p.name === trimmed)
  // Нового без задания не записать: исполнитель без задания ничего не умеет. У заведённого модель
  // и инструменты правятся, даже если задание в его файле пустое.
  const hasBasis = editing !== null || prompt.trim().length > 0
  // У заведённого «Сохранить» горит только после правки: сохранять поля, какими их открыли, нечего (B-333).
  const unchanged =
    editing !== null &&
    description.trim() === (editing.description ?? '').trim() &&
    model === (editing.model ?? '') &&
    chosenTools.trim() === (editing.tools ?? '').trim() &&
    prompt.trim() === (editing.prompt ?? '').trim()
  function revert() {
    if (before) {
      setName(before.name ?? '')
      setDescription(before.description ?? '')
      setModel(before.model ?? '')
      const prior = splitTools(before.tools)
      setReadOnly(prior.readOnly)
      setTools(prior.custom)
      setPrompt(before.prompt)
    }
    setBefore(null)
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !trimmed || occupied || !hasBasis || unchanged) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/performers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base,
          name: trimmed,
          description: description.trim() || null,
          model: model || null,
          tools: chosenTools.trim() || null,
          prompt,
          editing: editing?.name ?? null,
        }),
      })
      if (response.ok) {
        onSaved(trimmed)
        return
      }
      if (response.status === 400) {
        const body = (await response.json().catch(() => null)) as { problem?: string } | null
        setFailure({
          text:
            body?.problem === 'invalid-description'
              ? 'Описание не годится: в файле исполнителя оно одна строка.'
              : 'Имя не годится: строчная латиница, цифры и дефис — так исполнителя зовёт этап флоу.',
          git: false,
        })
      } else if (response.status === 409) {
        const body = (await response.json()) as { problem: string; detail?: string | null }
        if (body.problem === 'not-committed') {
          setFailure({ text: body.detail ?? 'База не приняла коммит.', git: true })
        } else if (body.problem === 'name-taken') {
          setFailure({
            text: 'Исполнитель с таким именем у этого проекта уже есть. Дайте другое имя или откройте его правку.',
            git: false,
          })
        } else if (body.problem === 'name-in-project') {
          // Путь копии приходит в detail: без него оператору негде посмотреть, с чем разводить имена.
          setFailure({
            text: body.detail
              ? `Исполнитель с таким именем уже есть в копии ${body.detail}. Выберите другое имя.`
              : 'Исполнитель уже есть в копии проекта. Выберите другое имя.',
            git: false,
          })
        } else if (body.problem === 'newer-format') {
          // Кит перевёл базу, пока окно было открыто: раздел не опрашивается, и о смене он узнаёт отсюда (B-281).
          setFailure({ text: body.detail ?? NEWER_FORMAT_REFUSAL, git: false })
        } else {
          setFailure({ text: `Исполнитель не записан: панель не поняла отказ «${body.problem}».`, git: false })
        }
      } else if (response.status === 404) {
        setFailure({ text: 'Этой базы больше нет в списке панели.', git: false })
      } else {
        setFailure({ text: `Исполнитель не записан: HTTP ${response.status}.`, git: false })
      }
    } catch {
      setFailure({ text: 'Исполнитель не записан: нет связи с API.', git: false })
    } finally {
      setBusy(false)
    }
  }

  const locked = busy
  // База нового формата кита: исполнитель читается, а ни правка, ни переписка с агентом его не запишут (B-281).
  const closed = chosen?.formatWarning ? NEWER_FORMAT_REFUSAL : null
  const frozen = locked || closed !== null
  const chatLabel = editing ? `Переписать с ${AGENT_NAME}` : `Завести с ${AGENT_NAME}`
  const over = reading || deleting || chatting
  const project = chosen?.project ?? ''
  const calledBy = editing?.calledBy ?? []

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && !locked && !over && onClose()}
    >
      <form
        className="modal-wizard pf-modal"
        role="dialog"
        aria-modal={!over}
        aria-labelledby="pf-title"
        // Пока открыто задание, удаление или переписка, окно исполнителя под ними недоступно: Tab и программа
        // чтения — только в верхнем.
        inert={over}
        onSubmit={save}
        noValidate
      >
        <div className="ask-head">
          <div className="ask-title">
            {editing ? (
              <>
                {/* Заведённого называют его имя и проект: имя уже не меняется, проект — тем более. */}
                <span className="pf-mark" aria-hidden="true">
                  <PerformerIcon />
                </span>
                <h2 id="pf-title" className="pf-title-name">
                  {editing.name}
                </h2>
                <span className="pf-project">{project}</span>
              </>
            ) : (
              <>
                <PerformerIcon />
                <h2 id="pf-title">Новый исполнитель</h2>
              </>
            )}
            <button type="button" className="btn btn-icon" aria-label="Закрыть" disabled={locked} onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          {/* Проект задаёт базу, куда ляжет файл, и его же код читает Чудо-Юдо: заведённому он уже задан. */}
          {!editing && bases.length > 1 && (
            <div className="pf-head-project">
              <label className="pf-head-label" htmlFor="pf-base">
                Проект
              </label>
              <Select id="pf-base" value={base} disabled={locked} onChange={setBase} wide>
                {bases.map((b) => (
                  // В базу нового формата исполнителя не завести: её проект не выбирается (B-281).
                  <option key={b.base} value={b.base} disabled={Boolean(b.formatWarning)}>
                    {b.project}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className="ask-body">
          {closed && (
            <p className="pf-closed" role="status">
              <WarnIcon />
              {closed}
            </p>
          )}
          {before && (
            <div className="pf-status">
              <span>Правки {AGENT_NAME} приняты</span>
              <button type="button" className="pf-link" disabled={busy} onClick={revert}>
                вернуть как было
              </button>
            </div>
          )}

          {/* Основа — список терминов: подпись и значение связаны так, что их читает и программа для незрячих.
              Она видна сразу, и у нового тоже: его можно завести руками, без просьбы (B-198). */}
          <dl className="pf-basis">
            {!editing && (
              <div className="pf-row">
                <dt className="pf-label">
                  <label htmlFor="pf-name">Имя</label>
                </dt>
                <dd className="pf-cell">
                  <input
                    id="pf-name"
                    className="pf-name-input"
                    type="text"
                    value={name}
                    autoComplete="off"
                    spellCheck={false}
                    disabled={frozen}
                    aria-invalid={occupied}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {/* Имя, уже занятое в базе проекта, панель бережёт: молча переписать чужого нельзя. */}
                  {occupied && (
                    <span className="pf-taken" role="status">
                      Исполнитель с таким именем у этого проекта уже есть. Дайте другое имя или закройте
                      окно и откройте его правку.
                    </span>
                  )}
                </dd>
              </div>
            )}
            {/* Описание правится полем от четырёх строк (B-198), а в файл ложится одной строкой шапки:
                Enter новой строки не начинает, вставленные переводы строк сводятся в пробел. */}
            <div className="pf-row pf-row-top">
              <dt className="pf-label">
                <label htmlFor="pf-description">Описание</label>
              </dt>
              <dd className="pf-cell">
                <textarea
                  id="pf-description"
                  className="pf-desc"
                  rows={4}
                  value={description}
                  disabled={frozen}
                  onChange={(event) => setDescription(oneLine(event.target.value))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.preventDefault()
                  }}
                />
              </dd>
            </div>
            <div className="pf-row">
              <dt className="pf-label">Задание</dt>
              <dd className="pf-cell">
                {/* Пустое задание пишется сразу: окно задания встаёт в правке (B-198). */}
                {prompt.trim() ? (
                  <button type="button" ref={taskButton} className="btn pf-small" onClick={() => setReading(true)}>
                    <FileIcon />
                    Показать задание
                  </button>
                ) : (
                  <button
                    type="button"
                    ref={taskButton}
                    className="btn pf-small"
                    disabled={frozen}
                    onClick={() => setReading(true)}
                  >
                    <PencilIcon />
                    Написать задание
                  </button>
                )}
              </dd>
            </div>
          </dl>

          <div className="pf-settings">
            <div className="pf-row pf-row-set">
              <label className="pf-label pf-label-set" htmlFor="pf-model">
                Модель
              </label>
              <Select
                id="pf-model"
                value={model}
                disabled={frozen}
                onChange={(value) => {
                  setChose((prev) => ({ ...prev, model: true }))
                  setModel(value)
                }}
              >
                {(models.includes(model) ? models : [...models, model]).map((value) => (
                  <option key={value || 'inherit'} value={value}>
                    {value || 'как у сессии'}
                  </option>
                ))}
              </Select>
            </div>
            <div className="pf-row pf-row-set">
              <span className="pf-label pf-label-set">Инструменты</span>
              <div className="pf-tools">
                {/* «Только чтение» — переключатель: включён — набор закреплён, выключен — свой список. */}
                <button
                  type="button"
                  className="pf-toggle"
                  aria-pressed={readOnly}
                  disabled={frozen}
                  onClick={() => {
                    setChose((prev) => ({ ...prev, tools: true }))
                    setReadOnly(!readOnly)
                  }}
                >
                  <span className="pf-toggle-box" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </span>
                  Только чтение
                </button>
                {readOnly ? (
                  <span className="pf-tools-fixed">{READ_ONLY}</span>
                ) : (
                  <input
                    className="pf-tools-input"
                    type="text"
                    aria-label="Инструменты"
                    value={tools}
                    placeholder="все инструменты сессии"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={frozen}
                    onChange={(event) => {
                      setChose((prev) => ({ ...prev, tools: true }))
                      setTools(event.target.value)
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {failure && (
            <div className="ask-error" role="alert">
              <strong>{failure.git ? 'База не приняла исполнителя' : 'Исполнитель не записан'}</strong>
              {failure.git ? <pre>{failure.text}</pre> : <span>{failure.text}</span>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <div className="ask-actions">
            {/* Удаляют заведённого — слева в подвале, как «Удалить этап» во «Флоу». Пока его зовут этапы флоу, кнопка
                погашена, а подсказка называет их: этап без исполнителя агент не выполнит — решения оператора на B-83. */}
            {editing && (
              <button
                type="button"
                ref={deleteButton}
                className="btn btn-danger"
                disabled={frozen || calledBy.length > 0}
                title={closed ?? (calledBy.length > 0 ? `Его зовут этапы: ${calledBy.join(', ')}` : undefined)}
                onClick={() => setDeleting(true)}
              >
                <TrashIcon />
                Удалить исполнителя
              </button>
            )}
            <div className="footer-right">
              {/* Переписку открывает видимая кнопка подвала рядом с «Сохранить», а не пункт меню — решение оператора
                  на B-320; сама переписка идёт своим окном поверх этого. */}
              <button
                type="button"
                ref={chatButton}
                className="btn pf-chat"
                disabled={busy || closed !== null}
                title={closed ?? undefined}
                onClick={() => setChatting(true)}
              >
                <ChatIcon />
                {chatLabel}
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={frozen || !trimmed || occupied || !hasBasis || unchanged}
                title={closed ?? (unchanged ? 'Изменений нет' : undefined)}
              >
                {busy ? 'Сохраняется…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      </form>

      {deleting && editing && (
        <DeletePerformerModal
          base={base}
          project={project}
          name={editing.name}
          onClose={() => setDeleting(false)}
          onRemoved={() => onDeleted(editing.name)}
        />
      )}

      {chatting && (
        <PerformerChatModal
          base={base}
          project={project}
          subject={editing?.name ?? null}
          current={fields}
          kept={chose}
          onAccept={accept}
          onClose={() => setChatting(false)}
        />
      )}

      {reading && (
        <TaskView
          name={trimmed}
          prompt={prompt}
          editable={!frozen}
          onDone={setPrompt}
          onEditing={setTaskEditing}
          onClose={closeTask}
        />
      )}
    </div>
  )
}

/**
 * Задание исполнителя: разметка markdown показана оформленной, «Редактировать» открывает поле с исходным текстом
 * (B-198). «Готово» возвращает к просмотру с правкой, «Отменить» — без неё; в файл задание ложится кнопкой
 * «Сохранить» окна исполнителя. Пустое задание открывается сразу в правке.
 */
function TaskView({
  name,
  prompt,
  editable,
  onDone,
  onEditing,
  onClose,
}: {
  name: string
  prompt: string
  editable: boolean
  onDone: (prompt: string) => void
  onEditing: (editing: boolean) => void
  onClose: () => void
}) {
  const empty = !prompt.trim()
  const [editing, setEditing] = useState(empty && editable)
  const [text, setText] = useState(prompt)
  const [voiceError, setVoiceError] = useState<string | null>(null)
  // Открытое окно задания забирает фокус: иначе он остался бы на кнопке под подложкой.
  const close = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => (editing ? field.current?.focus() : close.current?.focus()), [editing])
  useEffect(() => {
    onEditing(editing)
    return () => onEditing(false)
  }, [editing, onEditing])

  // Правка начинается с нынешнего задания: пока окно открыто, его мог переписать ответ Чудо-Юдо.
  function edit() {
    setText(prompt)
    setEditing(true)
  }

  function cancel() {
    // Пустое задание открывали, чтобы написать: без правки смотреть в нём нечего.
    if (empty) onClose()
    else {
      setText(prompt)
      setEditing(false)
    }
  }

  function done() {
    onDone(text)
    if (text.trim()) setEditing(false)
    else onClose()
  }

  return (
    <div
      className="modal-overlay pf-task-overlay"
      // В правке промах мимо окна не закрывает его: набранное задание пропало бы без вопроса.
      onMouseDown={(event) => event.target === event.currentTarget && !editing && onClose()}
    >
      <div className="modal-wizard pf-task" role="dialog" aria-modal="true" aria-labelledby="pf-task-title">
        <div className="ask-head">
          <div className="ask-title">
            <FileIcon />
            <h2 id="pf-task-title">
              {/* Имя нового могли стереть в поле: заголовок тогда говорит просто о задании исполнителя. */}
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
          {editing ? (
            <textarea
              ref={field}
              className="custom-textarea pf-task-edit"
              aria-label="Задание"
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <Markdown className="pf-task-view" text={prompt} />
          )}
          {editing && <AttachError text={voiceError} />}
        </div>
        <div className="modal-footer ask-footer">
          <div className="ask-actions">
            {/* В правке задание можно надиктовать: микрофон слева в подвале, напротив кнопок (макет B-291) */}
            {editing && (
              <VoiceButton onText={(spoken) => setText(appendSpoken(text, spoken))} onError={setVoiceError} />
            )}
            <div className="footer-right">
              {editing ? (
                <>
                  <button type="button" className="btn" onClick={cancel}>
                    Отменить
                  </button>
                  <button type="button" className="btn btn-primary" onClick={done}>
                    Готово
                  </button>
                </>
              ) : (
                <>
                  {editable && (
                    <button type="button" className="btn" onClick={edit}>
                      <PencilIcon />
                      Редактировать
                    </button>
                  )}
                  <button type="button" ref={close} className="btn" onClick={onClose}>
                    Закрыть
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** Выпадающий список исполнителей — в окне и над сеткой раздела: стрелка лежит поверх правого края самого списка. */
export function Select({
  id,
  value,
  disabled,
  onChange,
  wide = false,
  children,
}: {
  id: string
  value: string
  disabled?: boolean
  onChange: (value: string) => void
  wide?: boolean
  children: ReactNode
}) {
  return (
    <span className={`pf-select-wrap ${wide ? 'pf-select-wide' : ''}`}>
      <select
        id={id}
        className="pf-select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <polyline points="6 9 12 15 18 9" />
      </svg>
    </span>
  )
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

function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

function WarnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

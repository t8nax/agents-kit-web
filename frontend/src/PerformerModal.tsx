import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { Markdown } from './Markdown'
import { useAgentRequest } from './agentRequest'
import { PerformerIcon, type BasePerformers, type Performer } from './Performers'
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

/** Поля исполнителя, как их возвращает Чудо-Юдо: те же, что в окне, кроме копии. */
export type DraftFields = {
  name: string | null
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
}

export type DraftEvent =
  | { type: 'step'; text: string }
  | { type: 'drafted'; text: string; fields: DraftFields; durationMs?: number }
  | { type: 'error'; text: string; output?: string }

const examples = [
  'Читает дифф ветки задачи и возвращает вердикт с замечаниями по критериям',
  'Гоняет проверки фронта и бэкенда и объясняет, что покраснело',
  'Отвечает на вопрос по коду копии файлом и строкой, ничего не правя',
]

type Props = {
  /** Проекты панели: из них выбирают, в чью базу ляжет исполнитель. */
  bases: BasePerformers[]
  initial: string
  /** Правится заведённый — поля заполнены им, а имя уже задано; null — заводится новый. */
  editing: Performer | null
  onClose: () => void
  onSaved: (name: string) => void
}

type Failure = { text: string; git: boolean }

/**
 * Окно исполнителя — в рамке окон ответа и записи в бэклог. Имя нового, описание, задание, модель и инструменты
 * правятся руками, а Чудо-Юдо пишет их по просьбе; нового можно завести и вовсе без него — решения оператора
 * на B-198, прежнее «пишет только агент» (B-80) ими отменено. Имя заведённого не меняется.
 */
export default function PerformerModal({ bases, initial, editing, onClose, onSaved }: Props) {
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
  // Задание открыто для чтения своим окном поверх этого.
  const [reading, setReading] = useState(false)
  const field = useRef<HTMLTextAreaElement>(null)
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

  // Просьба к Чудо-Юдо живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу.
  // Окно подхватывает только свою просьбу: правка — просьбу об этом исполнителе этого проекта, новое — просьбу
  // о новом. Ответ про другого переписал бы этого, а переписанный заведённый лёг бы в окно нового (B-80).
  const draft = useAgentRequest<DraftEvent>('performer', {
    mine: (request) =>
      editing ? request.subject === editing.name && request.base === initial : !request.subject,
  })
  const [wish, setWish] = useState('')
  // Поля, какими они были до ответа агента: «Вернуть как было» ставит их обратно.
  const [before, setBefore] = useState<DraftFields | null>(null)
  const taken = useRef(false)
  // Модель и инструменты, которые оператор выбрал сам: ответ агента их не перетирает.
  const chose = useRef({ model: false, tools: false })

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busy) return
      // Escape закрывает верхнее окно: сначала задание, потом само окно исполнителя.
      if (reading) {
        if (!taskEditing.current) closeTask()
      } else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose, reading, closeTask])

  // Итог просьбы становится основой исполнителя — один раз: ответ не перетирает поправленное оператором.
  const outcome = draft.outcome
  useEffect(() => {
    if (outcome?.type !== 'drafted' || taken.current) return
    taken.current = true
    setBefore({ name, description, model, tools: chosenTools, prompt })
    // Имя заведённого не меняется: по нему его зовут шаги флоу, а другое имя бэкенд счёл бы переименованием.
    if (!editing) setName(outcome.fields.name ?? '')
    setDescription(outcome.fields.description ?? '')
    if (!chose.current.model) setModel(outcome.fields.model ?? '')
    if (!chose.current.tools) {
      const drafted = splitTools(outcome.fields.tools)
      setReadOnly(drafted.readOnly)
      setTools(drafted.custom)
    }
    setPrompt(outcome.fields.prompt)
    // Основа берётся из ответа: оператор же и попросил её написать. Модель и инструменты — только невыбранные.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])

  // В правке имя — всегда прежнее: поля имени в ней нет, и записывается тот, кого открыли.
  const trimmed = editing ? editing.name : name.trim()
  const chosen = bases.find((b) => b.base === base) ?? bases[0]
  // Имя занято другим исполнителем проекта: сохранение переписало бы его.
  const occupied =
    trimmed.length > 0 && trimmed !== editing?.name && (chosen?.performers ?? []).some((p) => p.name === trimmed)
  const draftError = draft.failure ?? (draft.outcome?.type === 'error' ? draft.outcome.text : null)
  const draftOutput = draft.outcome?.type === 'error' ? (draft.outcome.output ?? null) : null
  const phase: 'idle' | 'running' | 'taken' | 'failed' = draft.running
    ? 'running'
    : draftError
      ? 'failed'
      : outcome?.type === 'drafted'
        ? 'taken'
        : 'idle'
  const asked = draft.asked || wish.trim()
  // Нового без задания не записать: исполнитель без задания ничего не умеет. У заведённого модель
  // и инструменты правятся, даже если задание в его файле пустое.
  const hasBasis = editing !== null || prompt.trim().length > 0
  // Поля нового ещё пусты: окно показывает примеры просьб, а поле просьбы стоит в полный рост.
  const blank = !editing && !name.trim() && !description.trim() && !prompt.trim()

  const ask = useCallback(
    async (text: string) => {
      if (!text.trim()) return
      taken.current = false
      const current = editing ? { name, description, model, tools: chosenTools, prompt } : null
      const started = await draft.start('/api/performers/draft', {
        base,
        wish: text.trim(),
        current,
      })
      if (started.ok) return
      draft.setFailure(
        started.status === 404
          ? 'Панель не нашла базу или её основную копию'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла просьбу',
      )
    },
    [base, draft, editing, name, description, model, chosenTools, prompt],
  )

  /** Забывает просьбу и возвращает поле к набору: текст просьбы остаётся, чтобы переспросить. */
  async function again() {
    setWish(asked)
    taken.current = false
    await draft.forget()
  }

  async function revert() {
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
    await again()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !trimmed || occupied || !hasBasis) return
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
    field.current?.focus()
  }

  const locked = busy || phase === 'running'
  const askLabel = editing ? `Переписать с помощью ${AGENT_NAME}` : `Завести с помощью ${AGENT_NAME}`
  const project = chosen?.project ?? ''

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => event.target === event.currentTarget && !locked && !reading && onClose()}
    >
      <form
        className="modal-wizard pf-modal"
        role="dialog"
        aria-modal={!reading}
        aria-labelledby="pf-title"
        // Пока открыто задание, окно исполнителя под ним недоступно: Tab и программа чтения — только в задании.
        inert={reading}
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
                  <option key={b.base} value={b.base}>
                    {b.project}
                  </option>
                ))}
              </Select>
            </div>
          )}
        </div>

        <div className="ask-body">
          {/* Просьба — первое поле окна: отдельного окна у исполнителя нет — решение оператора на B-69. */}
          <label htmlFor="pf-wish" className="visually-hidden">
            Просьба к {AGENT_NAME}
          </label>
          <textarea
            id="pf-wish"
            ref={field}
            className={`custom-textarea pf-wish ${blank ? '' : 'pf-wish-short'}`}
            value={phase === 'running' ? asked : wish}
            placeholder={
              editing
                ? 'Что переписать: например, пусть ещё сверяет работу с решениями базы'
                : 'Расскажите своими словами, что исполнитель делает и что возвращает'
            }
            disabled={busy || phase === 'running'}
            onChange={(event) => setWish(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void ask(wish)
            }}
          />

          {phase === 'idle' && blank && !wish && (
            <div className="ask-examples">
              <span className="ask-examples-title">Например</span>
              {examples.map((example) => (
                <button key={example} type="button" className="ask-example" onClick={() => setWish(example)}>
                  {example}
                </button>
              ))}
            </div>
          )}

          {phase === 'running' && (
            <>
              <div className="ask-waiting" role="status">
                <span className="ask-spinner" aria-hidden="true" />
                <span className="ask-waiting-text">
                  {AGENT_NAME} {editing ? 'переписывает исполнителя' : 'заводит исполнителя'}…
                </span>
                {draft.startedAt !== null && <Elapsed since={draft.startedAt} />}
                <button type="button" className="pf-link" onClick={() => void draft.forget()}>
                  отменить
                </button>
              </div>
              {draft.steps.length > 0 && (
                <ol className="ask-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                  {draft.steps.map((step, i) => (
                    <li key={i}>{step}</li>
                  ))}
                </ol>
              )}
            </>
          )}

          {phase === 'taken' && (
            <div className="pf-status">
              <span>Основу написал {AGENT_NAME}</span>
              <button type="button" className="pf-link" disabled={busy} onClick={() => void revert()}>
                вернуть как было
              </button>
              <button type="button" className="pf-link" disabled={busy} onClick={() => void again()}>
                переспросить
              </button>
            </div>
          )}

          {/* Агент недоступен или не справился — одной строкой; его вывод, если был, читается подсказкой. */}
          {phase === 'failed' && (
            <p className="pf-down" role="alert" title={draftOutput ?? undefined}>
              <WarnIcon />
              {AGENT_NAME} не ответил: {draftError}
            </p>
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
                    disabled={locked}
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
                  disabled={locked}
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
                    disabled={locked}
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
                disabled={locked}
                onChange={(value) => {
                  chose.current.model = true
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
                  disabled={locked}
                  onClick={() => {
                    chose.current.tools = true
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
                    disabled={locked}
                    onChange={(event) => {
                      chose.current.tools = true
                      setTools(event.target.value)
                    }}
                  />
                )}
              </div>
            </div>
          </div>

          {/* Разом идёт одна просьба этого вида: просьба отсюда остановит ту, что идёт про другого. */}
          {draft.foreign && phase !== 'running' && (
            <p className="pf-foreign">
              {AGENT_NAME} {draft.foreign.state === 'running' ? 'сейчас занят' : 'уже ответил'}{' '}
              {draft.foreign.subject ? `про исполнителя ${draft.foreign.subject}` : 'про нового исполнителя'}{' '}
              {draft.foreign.project}: новая просьба отсюда {draft.foreign.state === 'running' ? 'остановит его' : 'уберёт этот ответ'}.
            </p>
          )}

          {failure && (
            <div className="ask-error" role="alert">
              <strong>{failure.git ? 'База не приняла исполнителя' : 'Исполнитель не записан'}</strong>
              {failure.git ? <pre>{failure.text}</pre> : <span>{failure.text}</span>}
            </div>
          )}
        </div>

        <div className="modal-footer ask-footer">
          <div className="footer-right">
            {/* Просьба уходит из подвала, рядом с «Сохранить»: она такое же действие окна — выбор оператора на B-69. */}
            {phase !== 'running' && (
              <button type="button" className="btn" disabled={busy || !wish.trim()} onClick={() => void ask(wish)}>
                {phase === 'failed' ? 'Попросить снова' : askLabel}
              </button>
            )}
            <button
              type="submit"
              className="btn btn-primary"
              disabled={locked || !trimmed || occupied || !hasBasis}
            >
              {busy ? 'Сохраняется…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </form>

      {reading && (
        <TaskView
          name={trimmed}
          prompt={prompt}
          editable={!locked}
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
        </div>
        <div className="modal-footer ask-footer">
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

/** Сколько идёт просьба: время считает панель, окно только показывает. */
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

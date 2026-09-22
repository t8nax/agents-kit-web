import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { forgetDrafts, saveDraft, takeDrafts } from './answerDrafts'
import { copyName } from './copies'
import { InlineMarkdown, Markdown } from './Markdown'
import { TerminalIcon } from './TerminalIcon'
import { VsCodeIcon } from './VsCodeIcon'
import './Modal.css'
import './ReplyModal.css'

export type QuestionVariant = {
  choice: string
  effect: string | null
  recommended: boolean
}

export type OperatorQuestion = {
  title: string
  context: string | null
  variants: QuestionVariant[]
  answer: string | null
}

export type ClosingCriterion = {
  title: string
  text: string | null
}

export type TaskArtifact = {
  label: string
  address: string
}

export type QuestionsResponse = {
  project: string
  copy: string
  branch: string | null
  task: string | null
  criteria: ClosingCriterion[]
  outOfScope: string | null
  artifacts: TaskArtifact[]
  questions: OperatorQuestion[]
  vsCodeSession: boolean
  backgroundSession: boolean
}

type Rejection = { question: string; problem: 'empty' | 'missing' | 'already-answered' }

type Load = { kind: 'loading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: QuestionsResponse }

// open — оператор отвечает; sending — ответы ждут своих секунд с «Отменить»; writing — запись идёт.
type Phase = 'open' | 'sending' | 'writing'

type Props = {
  base: string
  copy: string
  onClose: () => void
  onAnswered: () => void
}

const EMPTY = 'Напишите свой ответ или выберите вариант'

// Пока видно «Ответы отправлены агенту», отправку можно отменить: запись идёт после этих секунд.
export const UNDO_MS = 3000

// Запись без ответа дольше этого не держит окно: на время записи оно не закрывается ничем.
export const WRITE_TIMEOUT_MS = 30000

const problemText: Record<Rejection['problem'], string> = {
  empty: EMPTY,
  missing: 'Этого вопроса уже нет в памяти. Ничего не записано — закройте окно, чтобы увидеть актуальную память.',
  'already-answered':
    'На этот вопрос уже ответили из другого места. Ничего не записано — закройте окно, чтобы увидеть актуальную память.',
}

export default function ReplyModal({ base, copy, onClose, onAnswered }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  // Данные ответы — по вопросу; пустая строка — ответа нет.
  const [answers, setAnswers] = useState<string[]>([])
  // Вопросы, мимо которых уже прошли: без ответа такой — «Пропущен».
  const [passed, setPassed] = useState<boolean[]>([])
  const [current, setCurrent] = useState(0)
  // Набранное в строке ввода — ответ на текущий вопрос, пока его не дали.
  const [draft, setDraft] = useState('')
  // Набранное, но не отданное у других вопросов: уход к другому вопросу его не стирает.
  const [typed, setTyped] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('open')
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  // Контекст задачи и артефакты — своими окнами поверх окна ответа.
  const [shown, setShown] = useState<'context' | 'artifacts' | null>(null)

  const feed = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const undoButton = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)
  const contextButton = useRef<HTMLButtonElement>(null)
  const artifactsButton = useRef<HTMLButtonElement>(null)
  const wasShown = useRef<'context' | 'artifacts' | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ base, copy })
    fetch(`/api/questions?${params}`)
      .then((response) => {
        if (response.status === 404) throw new Error('Память копии не найдена')
        if (!response.ok) throw new Error(`Вопросы не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<QuestionsResponse>
      })
      .then((data) => {
        const given = takeDrafts(base, copy, data.questions.map((q) => q.title))
        // Открытое заново окно встаёт на первый вопрос без ответа; всё, что до него, уже пройдено.
        const first = Math.max(0, given.findIndex((a) => !a.trim()))
        setAnswers(given)
        setPassed(given.map((_, i) => i < first))
        setCurrent(first)
        setDraft(given[first] ?? '')
        setLoad({ kind: 'loaded', data })
      })
      .catch((error: unknown) =>
        setLoad({ kind: 'failed', message: error instanceof TypeError ? 'Нет связи с API' : String((error as Error).message) }),
      )
  }, [base, copy])

  // Закрытое окно ничего не отправляет: отложенная запись уходит вместе с ним.
  // Ответ записи, пришедший после закрытия окна, его уже не трогает: иначе он закрыл бы окно другой копии.
  // Отметка ставится в самом эффекте: в StrictMode разработки окно монтируется дважды, и первая уборка
  // иначе оставила бы его «закрытым» навсегда.
  const alive = useRef(false)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      window.clearTimeout(timer.current)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (shown) setShown(null)
      else if (phase === 'open') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, shown, phase])

  // Закрытое окно поверх возвращает фокус на свою кнопку — после перерисовки: пока оно открыто,
  // окно ответа inert, и фокус в него не встаёт.
  useEffect(() => {
    if (wasShown.current && !shown) (wasShown.current === 'context' ? contextButton : artifactsButton).current?.focus()
    wasShown.current = shown
  }, [shown])

  const loaded = load.kind === 'loaded'
  const questions = loaded ? load.data.questions : []

  // Текущий вопрос встаёт в начало ленты, а строка ввода получает фокус: отвечают, не берясь за мышь.
  useEffect(() => {
    if (!loaded || phase !== 'open') return
    const item = feed.current?.querySelector<HTMLElement>(`[data-q="${current}"]`)
    if (feed.current && item) feed.current.scrollTop = item.offsetTop - 16
    field.current?.focus()
  }, [loaded, current, phase])

  // Строка ввода ушла вместе с фокусом: «Отменить» получает его, чтобы успеть отменить с клавиатуры.
  useEffect(() => {
    if (phase !== 'sending') return
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
    undoButton.current?.focus()
  }, [phase])

  // `given` — ответ, только что данный текущему вопросу: набранное у него уже стало ответом.
  function go(index: number, given?: string) {
    const left = { ...typed }
    if (given !== undefined || draft === (answers[current] ?? '')) delete left[current]
    else left[current] = draft
    setTyped(left)
    setPassed((prev) => prev.map((p, i) => p || i === current))
    setCurrent(index)
    setDraft(left[index] ?? answers[index] ?? '')
    setError(null)
  }

  function unansweredIn(list: string[]) {
    return list.flatMap((a, i) => (a.trim() ? [] : [i]))
  }

  function skip() {
    if (current < questions.length - 1) return go(current + 1)
    const others = unansweredIn(answers).filter((i) => i !== current)
    if (others.length > 0) go(others[0])
  }

  function answer() {
    const value = draft.trim()
    if (!value) {
      setError(EMPTY)
      return
    }
    const next = answers.map((a, i) => (i === current ? value : a))
    setAnswers(next)
    saveDraft(base, copy, questions[current].title, value)
    const left = unansweredIn(next)
    if (left.length === 0) {
      setPassed((prev) => prev.map((p, i) => p || i === current))
      setError(null)
      setPhase('sending')
      timer.current = window.setTimeout(() => void write(next), UNDO_MS)
      return
    }
    const after = left.filter((i) => i > current)
    go(after.length > 0 ? after[0] : left[0], value)
  }

  function undo() {
    window.clearTimeout(timer.current)
    setPhase('open')
    setDraft(answers[current] ?? '')
  }

  // Все ответы пишутся разом и только все вместе; отказ оставляет окно и данные ответы на месте.
  async function write(given: string[]) {
    setPhase('writing')
    const fail = (text: string, question?: string) => {
      if (!alive.current) return
      const index = question ? questions.findIndex((q) => q.title === question) : -1
      if (index >= 0) {
        setCurrent(index)
        setDraft(given[index])
      }
      setError(text)
      setPhase('open')
    }
    const abort = new AbortController()
    const limit = window.setTimeout(() => abort.abort(), WRITE_TIMEOUT_MS)
    try {
      const response = await fetch('/api/answers', {
        signal: abort.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base,
          copy,
          answers: questions.map((q, i) => ({ question: q.title, answer: given[i] })),
        }),
      })
      if (response.ok) {
        forgetDrafts(base, copy, questions.map((q) => q.title))
        // ответы в памяти: окно больше не нужно, признак успеха — строка таблицы перестаёт ждать
        onAnswered()
        if (alive.current) onClose()
        return
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as Rejection
        fail(problemText[body.problem] ?? 'Ответы не записаны', body.question)
        return
      }
      fail(response.status === 404 ? 'Ответы не записаны: память копии не найдена' : 'Ответы не записаны')
    } catch {
      fail(
        abort.signal.aborted
          ? 'Панель не ответила: записались ли ответы, неизвестно. Закройте окно, чтобы увидеть актуальную память.'
          : 'Ответы не записаны: нет связи с API',
      )
    } finally {
      window.clearTimeout(limit)
    }
  }

  // Enter в строке ввода — «Ответить». Набор через IME заканчивается тем же Enter — его событие
  // пропускается, иначе ответ ушёл бы посреди набора.
  function onFieldKeyDown(event: ReactKeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    answer()
  }

  // Окно ответа остаётся на месте вместе с набранным ответом: переход его не трогает.
  async function openSession() {
    setOpening(true)
    setOpenError(null)
    try {
      const response = await fetch('/api/session/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, copy }),
      })
      if (response.ok) return
      if (response.status === 409) {
        setOpenError('Сессия этой копии уже не открыта в VS Code')
        return
      }
      setOpenError(
        response.status === 404
          ? 'VS Code не открыт: память копии не найдена'
          : 'Не удалось открыть VS Code',
      )
    } catch {
      setOpenError('Не удалось открыть VS Code: нет связи с API')
    } finally {
      setOpening(false)
    }
  }

  // Файл-артефакт открывает панель: в окне VS Code копии задачи, а без него — в новом окне.
  async function openArtifact(index: number, address: string) {
    setOpening(true)
    setOpenError(null)
    try {
      const response = await fetch('/api/artifact/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, copy, index, address }),
      })
      if (response.ok) return
      const problem =
        response.status === 404
          ? await response
              .json()
              .then((body: { problem?: string }) => body.problem ?? null)
              .catch(() => null)
          : null
      setOpenError(
        problem === 'missing'
          ? `Файла нет на диске: ${address}`
          : response.status === 404
            ? 'Файл не открыт: артефакта нет в памяти копии'
            : 'Не удалось открыть файл в VS Code',
      )
    } catch {
      setOpenError('Не удалось открыть файл в VS Code: нет связи с API')
    } finally {
      setOpening(false)
    }
  }

  // Переход в фоновую сессию: своего окна у неё нет, и панель открывает терминал, подключённый к ней.
  async function openTerminal() {
    setOpening(true)
    setOpenError(null)
    try {
      const response = await fetch('/api/session/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, copy }),
      })
      if (response.ok) return
      setOpenError(
        response.status === 409
          ? 'Сессия этой копии уже не идёт в фоне'
          : 'Не удалось открыть терминал',
      )
    } catch {
      setOpenError('Не удалось открыть терминал: нет связи с API')
    } finally {
      setOpening(false)
    }
  }

  const data = loaded ? load.data : null
  const hasContext = !!data && (data.criteria.length > 0 || !!data.outOfScope)
  const hasArtifacts = !!data && data.artifacts.length > 0
  const question = questions[current]
  const answered = !!answers[current]?.trim()
  const canSkip = current < questions.length - 1 || unansweredIn(answers).some((i) => i !== current)

  return (
    <>
      <div
        className="modal-overlay"
        onMouseDown={(e) => e.target === e.currentTarget && !shown && phase === 'open' && onClose()}
      >
        <div
          className="modal-wizard reply-window"
          role="dialog"
          aria-modal={!shown}
          aria-label="Ответ оператора"
          // Пока открыто окно поверх, окно ответа под ним недоступно: Tab и программа чтения — только в нём.
          inert={!!shown}
        >
          <div className="reply-head">
            <div className="task-strip">
              {data && (
                <>
                  {data.task && <div className="strip-task">{data.task}</div>}
                  <div className="strip-meta">
                    <span className="strip-project">{data.project}</span>
                    <span className="strip-sep">·</span>
                    {copyName(data.copy)}
                    {data.branch && (
                      <>
                        <span className="strip-sep">·</span>
                        {data.branch}
                      </>
                    )}
                  </div>
                  <div className="strip-actions">
                    <button
                      type="button"
                      className="btn-code"
                      disabled={!data.backgroundSession || opening}
                      title={
                        data.backgroundSession
                          ? 'Открыть терминал с сессией этой копии'
                          : 'В этой копии не идёт фоновая сессия'
                      }
                      onClick={() => void openTerminal()}
                    >
                      <TerminalIcon />
                      {data.backgroundSession ? 'Открыть в терминале' : 'Нет сессии в фоне'}
                    </button>
                    <button
                      type="button"
                      className="btn-code"
                      disabled={!data.vsCodeSession || opening}
                      title={
                        data.vsCodeSession ? 'Открыть окно VS Code этой копии' : 'Сессия этой копии не открыта в VS Code'
                      }
                      onClick={() => void openSession()}
                    >
                      <VsCodeIcon />
                      {data.vsCodeSession ? 'Открыть в VS Code' : 'Нет сессии в VS Code'}
                    </button>
                    {(hasContext || hasArtifacts) && <span className="strip-gap" aria-hidden="true" />}
                    {hasContext && (
                      <button
                        ref={contextButton}
                        type="button"
                        className="btn-ghost"
                        aria-haspopup="dialog"
                        onClick={() => setShown('context')}
                      >
                        <DocIcon />
                        Контекст задачи
                      </button>
                    )}
                    {hasArtifacts && (
                      <button
                        ref={artifactsButton}
                        type="button"
                        className="btn-ghost"
                        aria-haspopup="dialog"
                        onClick={() => setShown('artifacts')}
                      >
                        <LinkIcon />
                        Артефакты <span className="btn-count">{data.artifacts.length}</span>
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            {/* Пока ответы уходят, окно не закрывается ничем: закрытое сняло бы запись молча. */}
            <button
              type="button"
              className="btn btn-icon"
              aria-label="Закрыть"
              disabled={phase !== 'open'}
              onClick={onClose}
            >
              <CloseIcon />
            </button>
          </div>

          {/* ошибку открытия артефакта говорит окно артефактов, пока оно открыто, а не окно под ним */}
          {openError && shown !== 'artifacts' && (
            <p className="open-error error-text" role="alert">
              <WarningIcon />
              {openError}
            </p>
          )}

          <div className={`reply-feed ${!question ? 'is-centered' : ''}`} ref={feed}>
            {load.kind === 'loading' && <p className="modal-message">Загрузка вопросов…</p>}
            {load.kind === 'failed' && <p className="modal-message error-text">{load.message}</p>}
            {loaded && !question && <p className="modal-message">Вопросов без ответа нет</p>}
            {questions.map((q, i) => {
              const given = answers[i] ?? ''
              const effect = q.variants.find((v) => v.choice === given)?.effect
              const skipped = !given.trim() && passed[i] && i !== current
              return (
                <div className="feed-item" key={i} data-q={i}>
                  {i === current && phase === 'open' ? (
                    <section className="agent-q" aria-labelledby={`reply-q-${i}`}>
                      <h2 className="q-title" id={`reply-q-${i}`}>
                        <InlineMarkdown text={q.title} />
                      </h2>
                      {q.context && <Markdown className="q-context" text={q.context} />}
                      {q.variants.length > 0 && (
                        <div className="radio-list">
                          {q.variants.map((v, k) => (
                            <button
                              key={k}
                              type="button"
                              className="radio-opt"
                              aria-pressed={draft === v.choice}
                              onClick={() => {
                                setDraft(v.choice)
                                if (error === EMPTY) setError(null)
                                field.current?.focus()
                              }}
                            >
                              <span className="radio-dot" aria-hidden="true" />
                              <span className="opt-head">
                                <span className="opt-title">{v.choice}</span>
                                {v.recommended && <span className="tag-rec">Рекомендовано ИИ</span>}
                              </span>
                              {v.effect && <span className="opt-desc">{v.effect}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </section>
                  ) : (
                    <button
                      type="button"
                      className={`q-compact ${skipped ? 'is-skipped' : ''}`}
                      disabled={phase !== 'open'}
                      onClick={() => go(i)}
                    >
                      <span className="qc-title">
                        <InlineMarkdown text={q.title} plainLinks />
                      </span>
                      {skipped && (
                        <>
                          <span className="pill-skip">Пропущен</span>
                          <span className="qc-go">Ответить</span>
                        </>
                      )}
                    </button>
                  )}
                  {given.trim() && (
                    <div className="op-row">
                      <div className={`op-bubble ${i === current && phase === 'open' ? 'is-current' : ''}`}>
                        {effect ? (
                          <>
                            <p className="ans-choice">{given}</p>
                            <p className="ans-effect">{effect}</p>
                          </>
                        ) : (
                          <p className="ans-text">{given}</p>
                        )}
                        {i !== current && phase === 'open' && (
                          <button type="button" className="link-btn" onClick={() => go(i)}>
                            Изменить
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {phase !== 'open' && (
              <div className="sent" role="status">
                <span className="sent-msg">
                  <CheckIcon />
                  Ответы отправлены агенту
                </span>
                {phase === 'sending' && (
                  <button ref={undoButton} type="button" className="undo" onClick={undo}>
                    Отменить
                  </button>
                )}
              </div>
            )}
          </div>

          {question && phase === 'open' && (
            <div className={`composer ${error ? 'has-error' : ''}`}>
              <div className="composer-row">
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="Предыдущий вопрос"
                  title="Предыдущий вопрос"
                  disabled={current === 0}
                  onClick={() => go(current - 1)}
                >
                  <ChevronIcon direction="left" />
                </button>
                <input
                  ref={field}
                  id="reply-answer"
                  className="composer-field"
                  aria-label="Ответ"
                  autoComplete="off"
                  value={draft}
                  placeholder={question.variants.length > 0 ? 'Выберите вариант или напишите свой ответ' : 'Ваш ответ'}
                  onChange={(e) => {
                    setDraft(e.target.value)
                    if (error === EMPTY && e.target.value.trim()) setError(null)
                  }}
                  onKeyDown={onFieldKeyDown}
                />
                <button type="button" className="btn-ghost composer-skip" disabled={!canSkip} onClick={skip}>
                  {answered ? 'Дальше' : 'Пропустить'}
                  <ChevronIcon direction="right" />
                </button>
                <button type="button" className="btn btn-primary composer-send" onClick={answer}>
                  <SendIcon />
                  Ответить
                </button>
              </div>
              {error && (
                <span className="field-error error-text" role="alert">
                  <WarningIcon />
                  <span>{error}</span>
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      {data && shown && (
        <div className="modal-overlay reply-sub-overlay" onMouseDown={(e) => e.target === e.currentTarget && setShown(null)}>
          <div className="modal-wizard reply-sub" role="dialog" aria-modal="true" aria-labelledby="reply-sub-title">
            <div className="reply-sub-head">
              <h2 id="reply-sub-title">{shown === 'context' ? 'Контекст задачи' : 'Артефакты'}</h2>
              <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={() => setShown(null)}>
                <CloseIcon />
              </button>
            </div>
            <div className="reply-sub-body">
              {shown === 'context' ? (
                <>
                  {data.criteria.length > 0 && (
                    <div className="ctx-section">
                      <p className="acc-label">Критерии закрытия</p>
                      <ul className="criteria">
                        {data.criteria.map((criterion, i) => (
                          <li key={i}>
                            <div className="criterion-title">
                              <InlineMarkdown text={criterion.title} />
                            </div>
                            {criterion.text && <Markdown className="criterion-text" text={criterion.text} />}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {data.outOfScope && (
                    <div className="ctx-section">
                      <p className="acc-label">Не входит</p>
                      <Markdown className="criterion-text" text={data.outOfScope} />
                    </div>
                  )}
                </>
              ) : (
                <ul className="artifacts">
                  {data.artifacts.map((artifact, i) => (
                    <li key={i}>
                      <div className="artifact-label">
                        <InlineMarkdown text={artifact.label} />
                      </div>
                      {/* ссылку на сайт открывает браузер, а файл — панель, в VS Code */}
                      {/^https?:\/\//i.test(artifact.address) ? (
                        <a className="artifact-address" href={artifact.address} target="_blank" rel="noopener noreferrer">
                          {artifact.address}
                        </a>
                      ) : (
                        <button
                          type="button"
                          className="artifact-address artifact-file"
                          title="Открыть в VS Code"
                          disabled={opening}
                          onClick={() => void openArtifact(i, artifact.address)}
                        >
                          {artifact.address}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {openError && shown === 'artifacts' && (
                <p className="open-error error-text" role="alert">
                  <WarningIcon />
                  {openError}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </>
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

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points={direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
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

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

function DocIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  )
}

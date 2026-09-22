import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
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

type Props = {
  base: string
  copy: string
  onClose: () => void
  onAnswered: () => void
}

const problemText: Record<Rejection['problem'], string> = {
  empty: 'Напишите свой ответ',
  missing: 'Этого вопроса уже нет в памяти. Ничего не записано — закройте окно, чтобы увидеть актуальную память.',
  'already-answered':
    'На этот вопрос уже ответили из другого места. Ничего не записано — закройте окно, чтобы увидеть актуальную память.',
}

export default function ReplyModal({ base, copy, onClose, onAnswered }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [answers, setAnswers] = useState<string[]>([])
  const [current, setCurrent] = useState(0)
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const [footerError, setFooterError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  const [tab, setTab] = useState<'question' | 'context'>('question')

  useEffect(() => {
    const params = new URLSearchParams({ base, copy })
    fetch(`/api/questions?${params}`)
      .then((response) => {
        if (response.status === 404) throw new Error('Память копии не найдена')
        if (!response.ok) throw new Error(`Вопросы не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<QuestionsResponse>
      })
      .then((data) => {
        setAnswers(takeDrafts(base, copy, data.questions.map((q) => q.title)))
        setLoad({ kind: 'loaded', data })
      })
      .catch((error: unknown) =>
        setLoad({ kind: 'failed', message: error instanceof TypeError ? 'Нет связи с API' : String((error as Error).message) }),
      )
  }, [base, copy])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const questions = load.kind === 'loaded' ? load.data.questions : []

  // Переход к вопросу показывает сам вопрос, даже если оператор читал контекст задачи.
  function goTo(index: number) {
    setCurrent(index)
    setTab('question')
  }

  function setAnswer(index: number, value: string) {
    setAnswers((prev) => prev.map((a, i) => (i === index ? value : a)))
    if (questions[index]) saveDraft(base, copy, questions[index].title, value)
    if (rejection?.problem === 'empty' && questions[index]?.title === rejection.question && value.trim()) {
      setRejection(null)
    }
  }

  // Окно вопроса остаётся на месте вместе с набранным ответом: переход его не трогает.
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

  async function send() {
    const empty = answers.findIndex((a) => !a.trim())
    if (empty >= 0) {
      goTo(empty)
      setRejection({ question: questions[empty].title, problem: 'empty' })
      setFooterError(null)
      return
    }

    setSending(true)
    setFooterError(null)
    try {
      const response = await fetch('/api/answers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base,
          copy,
          answers: questions.map((q, i) => ({ question: q.title, answer: answers[i] })),
        }),
      })
      if (response.ok) {
        forgetDrafts(base, copy, questions.map((q) => q.title))
        // ответы в памяти: окно больше не нужно, признак успеха — строка таблицы перестаёт ждать
        onAnswered()
        onClose()
        return
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as Rejection
        const index = questions.findIndex((q) => q.title === body.question)
        if (index >= 0) goTo(index)
        setRejection(body)
        setFooterError('Ответы не записаны')
        return
      }
      setFooterError(response.status === 404 ? 'Ответы не записаны: память копии не найдена' : 'Ответы не записаны')
    } catch {
      setFooterError('Ответы не записаны: нет связи с API')
    } finally {
      setSending(false)
    }
  }

  // Enter в поле повторяет «Далее», а на последнем вопросе — «Отправить»: ответ всё равно
  // пишется одной строкой, так что перевод строки в поле не нужен. Shift и другие модификаторы
  // оставляют полю его обычное поведение, а набор через IME заканчивается тем же Enter — его
  // событие пропускается, иначе вопрос сменился бы посреди набора.
  function onAnswerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
    if (event.nativeEvent.isComposing) return
    event.preventDefault()
    if (current < questions.length - 1) setCurrent(current + 1)
    else if (!sending) void send()
  }

  const question = questions[current]

  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal-wizard" role="dialog" aria-modal="true" aria-label="Ответ оператора">
        <div className="wizard-stepper">
          <div className="stepper-main">
            {load.kind === 'loaded' && questions.length > 0 && (
              <>
                <div className="step-label">
                  Вопрос {current + 1} из {questions.length}
                </div>
                <div className="steps">
                  {questions.map((q, i) => (
                    <button
                      key={i}
                      type="button"
                      className="step-indicator"
                      aria-current={i === current ? 'step' : undefined}
                      aria-label={`Вопрос ${i + 1}: ${q.title}`}
                      title={q.title}
                      onClick={() => goTo(i)}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
          <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className={`modal-scroll-area ${load.kind !== 'loaded' || !question ? 'is-centered' : ''}`}>
          <div className="central-column">
            {load.kind === 'loading' && <p className="modal-message">Загрузка вопросов…</p>}
            {load.kind === 'failed' && <p className="modal-message error-text">{load.message}</p>}
            {load.kind === 'loaded' && !question && (
              <p className="modal-message">Вопросов без ответа нет</p>
            )}
            {load.kind === 'loaded' && question && (
              <>
                <div className="task-strip">
                  {load.data.task && <div className="strip-task">{load.data.task}</div>}
                  <div className="strip-meta">
                    <span className="strip-project">{load.data.project}</span>
                    <span className="strip-sep">·</span>
                    {copyName(load.data.copy)}
                    {load.data.branch && (
                      <>
                        <span className="strip-sep">·</span>
                        {load.data.branch}
                      </>
                    )}
                  </div>
                  <div className="strip-actions">
                    <button
                      type="button"
                      className="btn-code"
                      disabled={!load.data.backgroundSession || opening}
                      title={
                        load.data.backgroundSession
                          ? 'Открыть терминал с сессией этой копии'
                          : 'В этой копии не идёт фоновая сессия'
                      }
                      onClick={() => void openTerminal()}
                    >
                      <TerminalIcon />
                      {load.data.backgroundSession ? 'Открыть в терминале' : 'Нет сессии в фоне'}
                    </button>
                    <button
                      type="button"
                      className="btn-code"
                      disabled={!load.data.vsCodeSession || opening}
                      title={
                        load.data.vsCodeSession
                          ? 'Открыть окно VS Code этой копии'
                          : 'Сессия этой копии не открыта в VS Code'
                      }
                      onClick={() => void openSession()}
                    >
                      <VsCodeIcon />
                      {load.data.vsCodeSession ? 'Открыть в VS Code' : 'Нет сессии в VS Code'}
                    </button>
                  </div>
                </div>

                {openError && (
                  <p className="open-error error-text" role="alert">
                    <WarningIcon />
                    {openError}
                  </p>
                )}

                <div className="reply-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    id="reply-tab-question"
                    className="reply-tab"
                    aria-selected={tab === 'question'}
                    aria-controls="reply-panel"
                    onClick={() => setTab('question')}
                  >
                    Вопрос
                  </button>
                  <button
                    type="button"
                    role="tab"
                    id="reply-tab-context"
                    className="reply-tab"
                    aria-selected={tab === 'context'}
                    aria-controls="reply-panel"
                    onClick={() => setTab('context')}
                  >
                    Контекст задачи
                  </button>
                </div>

                {tab === 'context' ? (
                  <div
                    className="ctx-sections"
                    role="tabpanel"
                    id="reply-panel"
                    aria-labelledby="reply-tab-context"
                  >
                    <div className="ctx-section">
                      <p className="acc-label">Критерии закрытия</p>
                      {load.data.criteria.length > 0 ? (
                        <ul className="criteria">
                          {load.data.criteria.map((criterion, i) => (
                            <li key={i}>
                              <div className="criterion-title">
                                <InlineMarkdown text={criterion.title} />
                              </div>
                              {criterion.text && <Markdown className="criterion-text" text={criterion.text} />}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="criterion-text">Критерии не записаны</p>
                      )}
                    </div>
                    {load.data.outOfScope && (
                      <div className="ctx-section">
                        <p className="acc-label">Не входит</p>
                        <Markdown className="criterion-text" text={load.data.outOfScope} />
                      </div>
                    )}
                    {load.data.artifacts.length > 0 && (
                      <div className="ctx-section">
                        <p className="acc-label">Артефакты</p>
                        <ul className="artifacts">
                          {load.data.artifacts.map((artifact, i) => (
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
                      </div>
                    )}
                  </div>
                ) : (
                  <section role="tabpanel" id="reply-panel" aria-labelledby="reply-tab-question">
                    <h2 className="massive-title">
                      <InlineMarkdown text={question.title} />
                    </h2>
                    {question.context && <Markdown className="question-box" text={question.context} />}
                    {question.variants.length > 0 && (
                      <div className="options-grid">
                        {question.variants.map((v, i) => (
                          <button
                            key={i}
                            type="button"
                            className="option-card"
                            aria-pressed={answers[current] === v.choice}
                            onClick={() => setAnswer(current, v.choice)}
                          >
                            <span className="option-head">
                              <span className="option-title">{v.choice}</span>
                              {v.recommended && <span className="tag-rec">Рекомендовано ИИ</span>}
                            </span>
                            {v.effect && <span className="option-desc">{v.effect}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="input-group">
                      <label htmlFor="reply-answer">Ответ</label>
                      <textarea
                        id="reply-answer"
                        className="custom-textarea"
                        value={answers[current]}
                        placeholder={question.variants.length > 0 ? 'Выберите вариант или напишите свой ответ' : 'Ваш ответ'}
                        onChange={(e) => setAnswer(current, e.target.value)}
                        onKeyDown={onAnswerKeyDown}
                      />
                      {rejection?.question === question.title ? (
                        <div className="field-status error-text" role="alert">
                          <WarningIcon />
                          {problemText[rejection.problem]}
                        </div>
                      ) : (
                        <div className="field-status">Ответ записывается одной строкой</div>
                      )}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          {load.kind === 'loaded' && question && (
            <button type="button" className="btn" disabled={current === 0} onClick={() => goTo(current - 1)}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <polyline points="15 18 9 12 15 6" />
              </svg>
              Назад
            </button>
          )}
          <div className="footer-right">
            {footerError && (
              <span className="footer-msg error-text" role="alert">
                <WarningIcon />
                {footerError}
              </span>
            )}
            {load.kind === 'loaded' && question ? (
              <>
                {current < questions.length - 1 && (
                  <button type="button" className="btn" onClick={() => goTo(current + 1)}>
                    Далее
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </button>
                )}
                <button type="button" className="btn btn-primary" disabled={sending} onClick={send}>
                  Отправить
                </button>
              </>
            ) : (
              <button type="button" className="btn btn-primary" onClick={onClose}>
                Закрыть
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
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

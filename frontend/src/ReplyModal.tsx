import { useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { forgetDrafts, saveDraft, takeDrafts } from './answerDrafts'
import { InlineMarkdown, Markdown } from './Markdown'
import { VsCodeIcon } from './VsCodeIcon'
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

export type QuestionsResponse = {
  project: string
  copy: string
  task: string | null
  criteria: ClosingCriterion[]
  outOfScope: string | null
  design: string | null
  questions: OperatorQuestion[]
  vsCodeSession: boolean
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

  async function send() {
    const empty = answers.findIndex((a) => !a.trim())
    if (empty >= 0) {
      setCurrent(empty)
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
        if (index >= 0) setCurrent(index)
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
                      onClick={() => setCurrent(i)}
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
                <details className="context-accordion">
                  <summary>
                    <span className="acc-title">
                      <span>Контекст задачи</span>
                      <span className="acc-task">{load.data.task ?? '—'}</span>
                      <span className="acc-copy">
                        {load.data.project} · {load.data.copy}
                      </span>
                    </span>
                    <button
                      type="button"
                      className="btn-code"
                      disabled={!load.data.vsCodeSession || opening}
                      title={
                        load.data.vsCodeSession
                          ? 'Открыть окно VS Code этой копии'
                          : 'Сессия этой копии не открыта в VS Code'
                      }
                      // Кнопка живёт в summary: без этого щелчок по ней складывал бы аккордеон.
                      onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        void openSession()
                      }}
                    >
                      <VsCodeIcon />
                      {load.data.vsCodeSession ? 'Открыть в VS Code' : 'Нет сессии в VS Code'}
                    </button>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </summary>
                  <div className="accordion-content">
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
                    {load.data.outOfScope && (
                      <>
                        <p className="acc-label out-of-scope-label">Не входит</p>
                        <Markdown className="criterion-text" text={load.data.outOfScope} />
                      </>
                    )}
                    {load.data.design && (
                      <>
                        <p className="acc-label design-label">Дизайн</p>
                        <Markdown className="criterion-text" text={load.data.design} />
                      </>
                    )}
                  </div>
                </details>

                {openError && (
                  <p className="open-error error-text" role="alert">
                    <WarningIcon />
                    {openError}
                  </p>
                )}

                <section>
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
                            {v.recommended && <span className="tag-rec">Рекомендовано</span>}
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
              </>
            )}
          </div>
        </div>

        <div className="modal-footer">
          {load.kind === 'loaded' && question && (
            <button type="button" className="btn" disabled={current === 0} onClick={() => setCurrent(current - 1)}>
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
                  <button type="button" className="btn" onClick={() => setCurrent(current + 1)}>
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

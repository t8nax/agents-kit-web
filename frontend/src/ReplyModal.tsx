import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { forgetDrafts, saveDraft, takeDrafts } from './answerDrafts'
import { forgetAttachmentDrafts, saveAttachmentDraft, takeAttachmentDrafts } from './attachmentDrafts'
import { AttachButton, AttachedInFeed, AttachError, AttachmentTiles } from './Attachments'
import { payload, pastedFileName, pastedFiles, readAttachments, revokePreview, useRevokeOnClose, type Attachment } from './attachFiles'
import { copyName } from './copies'
import { InlineMarkdown, Markdown } from './Markdown'
import { TerminalIcon } from './TerminalIcon'
import { VsCodeIcon } from './VsCodeIcon'
import './Modal.css'
import './ReplyModal.css'
import './Tabs.css'

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

// open — оператор отвечает; sending — ответы ждут своих секунд с «Отменить»; writing — запись идёт;
// leaving — записанные ответы уходят вместе с окном, и оно гаснет.
type Phase = 'open' | 'sending' | 'writing' | 'leaving'

// Вкладки окна: переписка с агентом, контекст задачи и её артефакты.
type Tab = 'feed' | 'context' | 'artifacts'

const TABS: { id: Tab; label: string }[] = [
  { id: 'feed', label: 'Переписка' },
  { id: 'context', label: 'Контекст' },
  { id: 'artifacts', label: 'Артефакты' },
]

type Props = {
  base: string
  copy: string
  onClose: () => void
  onAnswered: () => void
}

const EMPTY = 'Напишите свой ответ или выберите вариант'

// Пока видно «Ответы отправлены агенту», отправку можно отменить: запись идёт после этих полутора секунд —
// три секунды оператору показались долгими.
export const UNDO_MS = 1500

// Записанные ответы уводят окно угасанием; обычное закрытие мгновенно — решение оператора.
export const FADE_MS = 220

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
  // Файлы, приложенные к ответу, — по вопросу; в черновик браузера они не идут: ответ пишется в память, а файлы — в
  // artifacts/ базы только отправкой (B-260).
  const [files, setFiles] = useState<Attachment[][]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  useRevokeOnClose(() => files.flat())
  const [current, setCurrent] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('open')
  const [opening, setOpening] = useState(false)
  const [openError, setOpenError] = useState<string | null>(null)
  // Ошибка открытия файла стоит под артефактами до закрытия окна: переход по вкладкам её не снимает.
  const [fileError, setFileError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('feed')

  const feed = useRef<HTMLDivElement>(null)
  const field = useRef<HTMLInputElement>(null)
  const undoButton = useRef<HTMLButtonElement>(null)
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    const params = new URLSearchParams({ base, copy })
    fetch(`/api/questions?${params}`)
      .then((response) => {
        if (response.status === 404) throw new Error('Память копии не найдена')
        if (!response.ok) throw new Error(`Вопросы не загрузились: HTTP ${response.status}`)
        return response.json() as Promise<QuestionsResponse>
      })
      .then((data) => {
        const titles = data.questions.map((q) => q.title)
        const given = takeDrafts(base, copy, titles)
        // Приложенное к ответам тоже переживает закрытие окна; черновик файлов читается следом за текстом.
        void takeAttachmentDrafts(base, copy, titles).then((kept) => {
          if (kept.some((list) => list.length > 0)) setFiles(kept)
        })
        // Открытое заново окно встаёт на первый вопрос без ответа; всё, что до него, уже пройдено.
        const first = Math.max(0, given.findIndex((a) => !a.trim()))
        setAnswers(given)
        setCurrent(first)
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
      if (event.key === 'Escape' && phase === 'open') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, phase])

  const loaded = load.kind === 'loaded'
  const questions = loaded ? load.data.questions : []

  // Текущий вопрос встаёт в начало ленты, а строка ввода получает фокус: отвечают, не берясь за мышь.
  // Со вкладок контекста и артефактов фокус не уводится: строки ввода там нет.
  useEffect(() => {
    if (!loaded || phase !== 'open' || tab !== 'feed') return
    const item = feed.current?.querySelector<HTMLElement>(`[data-q="${current}"]`)
    if (feed.current && item) feed.current.scrollTop = item.offsetTop - 16
    field.current?.focus()
  }, [loaded, current, phase, tab])

  // Строка ввода ушла вместе с фокусом: «Отменить» получает его, чтобы успеть отменить с клавиатуры.
  useEffect(() => {
    if (phase !== 'sending') return
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight
    undoButton.current?.focus()
  }, [phase])

  function go(index: number) {
    setCurrent(index)
    setError(null)
  }

  // Приложенный файл — тоже ответ: его адрес панель впишет в строку ответа.
  function unansweredIn(list: string[]) {
    return list.flatMap((a, i) => (a.trim() || files[i]?.length ? [] : [i]))
  }

  async function attach(chosen: File[], name?: (file: File) => string) {
    const at = current
    setAttachError(null)
    const { read, error: refused } = await readAttachments(chosen, name)
    setAttachError(refused)
    if (read.length === 0) return
    const next = [...(files[at] ?? []), ...read]
    setFiles((prev) => {
      const all = [...prev]
      all[at] = [...(all[at] ?? []), ...read]
      return all
    })
    void saveAttachmentDraft(base, copy, questions[at].title, next)
    if (error === EMPTY) setError(null)
  }

  function detach(id: number) {
    files.flat().filter((item) => item.id === id).forEach(revokePreview)
    const at = files.findIndex((list) => list?.some((item) => item.id === id))
    setFiles((prev) => prev.map((list) => list?.filter((item) => item.id !== id)))
    if (at >= 0) void saveAttachmentDraft(base, copy, questions[at].title, files[at].filter((item) => item.id !== id))
  }

  // Ответ пишется сразу, как его набирают или выбирают: в ленту и в черновик браузера.
  function setAnswer(value: string) {
    setAnswers((prev) => prev.map((a, i) => (i === current ? value : a)))
    saveDraft(base, copy, questions[current].title, value.trim())
    if (error === EMPTY && value.trim()) setError(null)
  }

  function send() {
    const left = unansweredIn(answers)
    if (left.length > 0) {
      go(left[0])
      setError(EMPTY)
      return
    }
    setError(null)
    setPhase('sending')
    const given = answers
    const attached = files
    timer.current = window.setTimeout(() => void write(given, attached), UNDO_MS)
  }

  function undo() {
    window.clearTimeout(timer.current)
    setPhase('open')
  }

  // Все ответы пишутся разом и только все вместе; отказ оставляет окно и данные ответы на месте.
  async function write(given: string[], attached: Attachment[][]) {
    setPhase('writing')
    const fail = (text: string, question?: string) => {
      if (!alive.current) return
      const index = question ? questions.findIndex((q) => q.title === question) : -1
      if (index >= 0) setCurrent(index)
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
          answers: questions.map((q, i) => ({ question: q.title, answer: given[i], files: payload(attached[i] ?? []) })),
        }),
      })
      if (response.ok) {
        forgetDrafts(base, copy, questions.map((q) => q.title))
        void forgetAttachmentDrafts(base, copy, questions.map((q) => q.title))
        // ответы в памяти: окно больше не нужно, признак успеха — строка таблицы перестаёт ждать
        onAnswered()
        // окно уходит угасанием, а закрывается, когда оно закончилось
        if (!alive.current) return
        setPhase('leaving')
        timer.current = window.setTimeout(onClose, FADE_MS)
        return
      }
      if (response.status === 413) {
        // Без имени файла отказал сам сервер: все файлы вместе больше, чем он принимает одним запросом.
        const body = (await response.json().catch(() => ({}))) as { name?: string }
        fail(
          body.name
            ? `Ответы не записаны: файл ${body.name} крупнее 5 МБ`
            : 'Ответы не записаны: приложенные файлы вместе слишком большие для одной отправки',
        )
        return
      }
      if (response.status === 400 || response.status === 409) {
        const body = (await response.json()) as Rejection & { name?: string }
        if (body.name) {
          fail(`Ответы не записаны: файл ${body.name} не прочитан`)
          return
        }
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
    if (current < questions.length - 1) go(current + 1)
    else send()
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
    setFileError(null)
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
      setFileError(
        problem === 'missing'
          ? `Файла нет на диске: ${address}`
          : response.status === 404
            ? 'Файл не открыт: артефакта нет в памяти копии'
            : 'Не удалось открыть файл в VS Code',
      )
    } catch {
      setFileError('Не удалось открыть файл в VS Code: нет связи с API')
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

  return (
    <div
      className={`modal-overlay ${phase === 'leaving' ? 'is-leaving' : ''}`}
      // длительность угасания живёт в коде: стили берут её отсюда, чтобы числа не разошлись
      style={{ '--fade-ms': `${FADE_MS}ms` } as CSSProperties}
      onMouseDown={(e) => e.target === e.currentTarget && phase === 'open' && onClose()}
    >
      <div className="modal-wizard reply-window" role="dialog" aria-modal="true" aria-label="Ответ оператора">
        <div className="reply-head">
          <div className="task-strip">
            {data && (
              <>
                {data.task && <div className="strip-task">{data.task}</div>}
                {/* Проект и копия — значками, без ветки: она почти повторяла имя копии (решение оператора). */}
                <div className="strip-meta">
                  <span className="meta-item" title="Проект">
                    <BoxIcon />
                    <span className="strip-project">{data.project}</span>
                  </span>
                  <span className="meta-item" title="Рабочая копия">
                    <FolderIcon />
                    <span>{copyName(data.copy)}</span>
                  </span>
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
                  {/* Пока ответы уходят, вкладок нет: окно показывает только отправку. */}
                  {phase === 'open' && (
                    <div className="vc-tabs reply-tabs" role="tablist" aria-label="Вкладки окна">
                      {TABS.map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          role="tab"
                          id={`reply-tab-${t.id}`}
                          // панель на месте одна — выбранной вкладки
                          aria-controls={tab === t.id ? `reply-panel-${t.id}` : undefined}
                          aria-selected={tab === t.id}
                          className={`flow-tab ${tab === t.id ? 'is-on' : ''}`}
                          onClick={() => setTab(t.id)}
                        >
                          {t.label}
                        </button>
                      ))}
                    </div>
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

        {openError && (
          <p className="open-error error-text" role="alert">
            <WarningIcon />
            {openError}
          </p>
        )}

        {phase !== 'open' ? (
          // Ответы ушли: ленты не видно, на её месте — знак отправки, а внизу «Отменить».
          <div className="reply-done" role="status">
            <span className="done-mark">
              <CheckIcon />
            </span>
            <p className="done-text">Ответы отправлены агенту</p>
          </div>
        ) : tab === 'context' ? (
          <div
            className={`tab-body ${hasContext ? '' : 'is-centered'}`}
            role="tabpanel"
            id="reply-panel-context"
            aria-labelledby="reply-tab-context"
          >
            {data && hasContext ? (
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
                    <Markdown className="criterion-text scope-text" text={data.outOfScope} />
                  </div>
                )}
              </>
            ) : (
              loaded && <p className="modal-message">Контекста нет</p>
            )}
          </div>
        ) : tab === 'artifacts' ? (
          <div
            className={`tab-body ${hasArtifacts ? '' : 'is-centered'}`}
            role="tabpanel"
            id="reply-panel-artifacts"
            aria-labelledby="reply-tab-artifacts"
          >
            {data && hasArtifacts ? (
              <>
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
                {fileError && (
                  <p className="open-error error-text" role="alert">
                    <WarningIcon />
                    {fileError}
                  </p>
                )}
              </>
            ) : (
              loaded && <p className="modal-message">Артефактов нет</p>
            )}
          </div>
        ) : (
          <div
            className={`reply-feed ${!question ? 'is-centered' : ''}`}
            ref={feed}
            role="tabpanel"
            id="reply-panel-feed"
            aria-labelledby="reply-tab-feed"
          >
            {load.kind === 'loading' && <p className="modal-message">Загрузка вопросов…</p>}
            {load.kind === 'failed' && <p className="modal-message error-text">{load.message}</p>}
            {loaded && !question && <p className="modal-message">Вопросов без ответа нет</p>}
            {questions.map((q, i) => {
              const given = answers[i] ?? ''
              const effect = q.variants.find((v) => v.choice === given)?.effect
              return (
                <div className="feed-item" key={i} data-q={i}>
                  {i === current ? (
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
                              aria-pressed={given === v.choice}
                              // повторный щелчок по выбранному снимает ответ: иначе его не убрать
                              onClick={() => {
                                setAnswer(given === v.choice ? '' : v.choice)
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
                    <button type="button" className="q-compact" onClick={() => go(i)}>
                      <span className="qc-title">
                        <InlineMarkdown text={q.title} plainLinks />
                      </span>
                    </button>
                  )}
                  {(given.trim() || (files[i]?.length ?? 0) > 0) && (
                    <div className="op-row">
                      <div className={`op-bubble ${i === current ? 'is-current' : ''}`}>
                        {effect ? (
                          <>
                            <p className="ans-choice">{given}</p>
                            <p className="ans-effect">{effect}</p>
                          </>
                        ) : (
                          given.trim() && <p className="ans-text">{given}</p>
                        )}
                        <AttachedInFeed items={files[i] ?? []} />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* строка ответа — только у переписки; на время отправки на её месте «Отменить» */}
        {question && (phase !== 'open' || tab === 'feed') && (
          <div className={`composer ${error ? 'has-error' : ''}`}>
            {phase === 'open' && <AttachmentTiles items={files[current] ?? []} onRemove={detach} />}
            {phase === 'open' ? (
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
                  value={answers[current] ?? ''}
                  placeholder={question.variants.length > 0 ? 'Выберите вариант или напишите свой ответ' : 'Ваш ответ'}
                  onChange={(e) => setAnswer(e.target.value)}
                  onKeyDown={onFieldKeyDown}
                  onPaste={(e) => {
                    const pasted = pastedFiles(e)
                    if (pasted.length === 0) return
                    e.preventDefault()
                    void attach(pasted, pastedFileName)
                  }}
                />
                <button
                  type="button"
                  className="btn btn-icon"
                  aria-label="Следующий вопрос"
                  title="Следующий вопрос"
                  disabled={current === questions.length - 1}
                  onClick={() => go(current + 1)}
                >
                  <ChevronIcon direction="right" />
                </button>
                <AttachButton label="Приложить" onFiles={(chosen) => void attach(chosen)} />
                <button type="button" className="btn btn-primary composer-send" onClick={send}>
                  <SendIcon />
                  Отправить
                </button>
              </div>
            ) : (
              <div className="composer-row is-undo">
                <button
                  ref={undoButton}
                  type="button"
                  className="btn composer-undo"
                  disabled={phase !== 'sending'}
                  onClick={undo}
                >
                  Отменить
                </button>
              </div>
            )}
            {/* отказ приложенному файлу — под полем, по критерию B-260 */}
            {phase === 'open' && <AttachError text={attachError} />}
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

function BoxIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="16.5" y1="9.4" x2="7.5" y2="4.21" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
      <polyline points="3.27 6.96 12 12.01 20.73 6.96" />
      <line x1="12" y1="22.08" x2="12" y2="12" />
    </svg>
  )
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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

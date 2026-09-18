import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import { useAgentRequest } from './agentRequest'
import type { Performer, PerformerCopy } from './Performers'
import './PerformerModal.css'

/** Модель исполнителя: пусто — он идёт на модели сессии, которая его позвала. */
const models = ['', 'opus', 'sonnet', 'haiku']

/** Наборы инструментов: пусто — все инструменты сессии, иначе список, как его понимает Claude Code. */
const READ_ONLY = 'Read, Glob, Grep'

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
  base: string
  copies: PerformerCopy[]
  /** Правится заведённый — поля заполнены им, копия и имя уже выбраны; null — заводится новый. */
  editing: Performer | null
  onClose: () => void
  onSaved: (name: string) => void
}

type Failure = { text: string; git: boolean }

export default function PerformerModal({ base, copies, editing, onClose, onSaved }: Props) {
  const [name, setName] = useState(editing?.name ?? '')
  const [description, setDescription] = useState(editing?.description ?? '')
  const [model, setModel] = useState(editing?.model ?? '')
  const [tools, setTools] = useState(editing?.tools ?? '')
  const [prompt, setPrompt] = useState(editing?.prompt ?? '')
  const [copy, setCopy] = useState(
    () => editing?.copy ?? copies.find((c) => c.main)?.path ?? copies[0]?.path ?? '',
  )
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const field = useRef<HTMLInputElement>(null)

  // Просьба к Чудо-Юдо живёт в панели: закрытое окно агента не трогает, а открытое заново видит его работу.
  const draft = useAgentRequest<DraftEvent>('performer')
  const [wish, setWish] = useState('')
  // Поля, какими они были до ответа агента: «Вернуть как было» ставит их обратно.
  const [before, setBefore] = useState<DraftFields | null>(null)
  const taken = useRef(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Итог просьбы становится полями окна — один раз: дальше их правит оператор, и ответ их не перетирает.
  const outcome = draft.outcome
  useEffect(() => {
    if (outcome?.type !== 'drafted' || taken.current) return
    taken.current = true
    setBefore({ name, description, model, tools, prompt })
    setName(outcome.fields.name ?? '')
    setDescription(outcome.fields.description ?? '')
    setModel(outcome.fields.model ?? '')
    setTools(outcome.fields.tools ?? '')
    setPrompt(outcome.fields.prompt)
    // Поля берутся из ответа, а не из того, что оператор набрал до него: он же и попросил их заполнить.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])

  const trimmed = name.trim()
  const chosen = copies.find((c) => c.path === copy) ?? null
  const file = chosen && trimmed ? `${chosen.path}\\.claude\\agents\\${trimmed}.md` : null
  const draftError =
    draft.failure ?? (draft.outcome?.type === 'error' ? draft.outcome.text : null)
  const draftOutput = draft.outcome?.type === 'error' ? (draft.outcome.output ?? null) : null
  const phase: 'idle' | 'running' | 'taken' | 'failed' = draft.running
    ? 'running'
    : draftError
      ? 'failed'
      : outcome?.type === 'drafted'
        ? 'taken'
        : 'idle'
  const asked = draft.asked || wish.trim()

  const ask = useCallback(
    async (text: string) => {
      if (!text.trim() || !chosen) return
      taken.current = false
      const current = editing
        ? { name, description, model, tools, prompt }
        : null
      const started = await draft.start('/api/performers/draft', {
        base,
        copy: chosen.path,
        wish: text.trim(),
        current,
      })
      if (started.ok) return
      draft.setFailure(
        started.status === 404
          ? 'Панель не нашла базу или копию'
          : started.status === null
            ? 'Нет связи с API'
            : 'Панель не приняла просьбу',
      )
    },
    [base, chosen, draft, editing, name, description, model, tools, prompt],
  )

  /** Забывает просьбу и возвращает полосу к набору: текст просьбы остаётся, чтобы переспросить. */
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
      setTools(before.tools ?? '')
      setPrompt(before.prompt)
    }
    setBefore(null)
    await again()
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    if (busy || !chosen || !trimmed) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/performers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          base,
          copy: chosen.path,
          name: trimmed,
          description: description.trim() || null,
          model: model || null,
          tools: tools.trim() || null,
          prompt,
        }),
      })
      if (response.ok) {
        onSaved(trimmed)
        return
      }
      if (response.status === 400) {
        setFailure({
          text: 'Имя не годится: строчная латиница, цифры и дефис — так исполнителя зовёт шаг флоу.',
          git: false,
        })
      } else if (response.status === 409) {
        const body = (await response.json()) as { detail: string | null }
        setFailure({
          text: body.detail ?? 'git не объяснил причину.',
          git: true,
        })
      } else if (response.status === 404) {
        setFailure({ text: 'Этой копии больше нет у проекта.', git: false })
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

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !locked && onClose()}>
      <form className="pf-modal" role="dialog" aria-modal="true" aria-labelledby="pf-title" onSubmit={save} noValidate>
        <div className="pf-head">
          <h3 id="pf-title">{editing ? 'Исполнитель' : 'Новый исполнитель'}</h3>
          <button type="button" className="btn btn-icon pf-close" aria-label="Закрыть" disabled={locked} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="pf-body">
          {/* Просьба — первое поле формы: отдельного окна у исполнителя нет — решение оператора на B-69. */}
          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-wish">
              Просьба к {AGENT_NAME}{' '}
              <span className="text-ter">{editing ? '— он перепишет поля ниже' : '— он заполнит поля ниже'}</span>
            </label>
            <textarea
              id="pf-wish"
              className="pf-input pf-text"
              rows={2}
              value={phase === 'running' ? asked : wish}
              placeholder={
                editing
                  ? 'Пусть ещё сверяет работу с критериями задачи и не чинит найденное сам'
                  : 'Читает дифф ветки задачи, ищет ошибки по критериям и возвращает вердикт с замечаниями'
              }
              disabled={busy || phase === 'running'}
              onChange={(event) => setWish(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) void ask(wish)
              }}
            />

            {phase === 'idle' && !editing && !wish && (
              <div className="pf-examples">
                {examples.map((example) => (
                  <button key={example} type="button" className="pf-example" onClick={() => setWish(example)}>
                    {example}
                  </button>
                ))}
              </div>
            )}

            {phase === 'running' && (
              <>
                <div className="pf-status" role="status">
                  <span className="pf-spinner" aria-hidden="true" />
                  <span className="pf-status-text">
                    {AGENT_NAME} {editing ? 'переписывает исполнителя' : 'заводит исполнителя'}…
                  </span>
                  {draft.startedAt !== null && <Elapsed since={draft.startedAt} />}
                  <button type="button" className="pf-preset" onClick={() => void draft.forget()}>
                    отменить
                  </button>
                </div>
                {draft.steps.length > 0 && (
                  <ol className="pf-steps" aria-label={`Ход работы ${AGENT_NAME}`}>
                    {draft.steps.map((step, i) => (
                      <li key={i}>{step}</li>
                    ))}
                  </ol>
                )}
                <p className="pf-note">
                  Окно можно закрыть: просьба останется в шапке панели, и открытое заново окно покажет её ход с начала.
                </p>
              </>
            )}

            {phase === 'taken' && (
              <div className="pf-status">
                <span className="pf-status-text">Поля ниже заполнил {AGENT_NAME}</span>
                <button type="button" className="pf-preset" disabled={busy} onClick={() => void revert()}>
                  вернуть как было
                </button>
                <button type="button" className="pf-preset" disabled={busy} onClick={() => void again()}>
                  переспросить
                </button>
              </div>
            )}

            {phase === 'failed' && (
              <div className="pf-error" role="alert">
                <span className="pf-error-title">{AGENT_NAME} не заполнил поля</span>
                <p className="pf-error-text">{draftError}. Поля окна не тронуты.</p>
                {draftOutput && <p className="pf-error-text mono">{draftOutput}</p>}
              </div>
            )}
          </div>

          <div className="pf-sep">поля исполнителя</div>

          <div className="pf-row">
            <div className="pf-field pf-grow">
              <label className="pf-label" htmlFor="pf-name">
                Имя
              </label>
              <input
                id="pf-name"
                ref={field}
                className="pf-input mono"
                type="text"
                value={name}
                placeholder="reviewer"
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-model">
                Модель
              </label>
              <select
                id="pf-model"
                className="pf-input"
                value={model}
                disabled={locked}
                onChange={(event) => setModel(event.target.value)}
              >
                {(models.includes(model) ? models : [...models, model]).map((value) => (
                  <option key={value || 'inherit'} value={value}>
                    {value || 'наследовать от сессии'}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-description">
              Описание <span className="text-ter">— когда его звать</span>
            </label>
            <textarea
              id="pf-description"
              className="pf-input pf-text"
              rows={2}
              value={description}
              placeholder="Читает дифф ветки задачи и возвращает вердикт."
              disabled={locked}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="pf-row">
            <div className="pf-field pf-grow">
              <label className="pf-label" htmlFor="pf-tools">
                Инструменты
              </label>
              <input
                id="pf-tools"
                className="pf-input mono"
                type="text"
                value={tools}
                placeholder="все инструменты сессии"
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                onChange={(event) => setTools(event.target.value)}
              />
              <button
                type="button"
                className="pf-preset"
                disabled={locked}
                onClick={() => setTools(tools === READ_ONLY ? '' : READ_ONLY)}
              >
                {tools === READ_ONLY ? 'все инструменты' : 'только чтение'}
              </button>
            </div>
            <div className="pf-field">
              <label className="pf-label" htmlFor="pf-copy">
                Копия
              </label>
              <select
                id="pf-copy"
                className="pf-input mono"
                value={copy}
                disabled={locked || editing !== null}
                onChange={(event) => setCopy(event.target.value)}
              >
                {copies.map((c) => (
                  <option key={c.path} value={c.path}>
                    {c.name}
                    {c.branch ? ` — ${c.branch}` : ''}
                    {c.main ? ' · основная' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pf-field">
            <label className="pf-label" htmlFor="pf-prompt">
              Задание
            </label>
            <textarea
              id="pf-prompt"
              className="pf-input pf-text mono"
              rows={8}
              value={prompt}
              placeholder="Что исполнитель делает и что возвращает."
              disabled={locked}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>

          {failure && (
            <div className="pf-error" role="alert">
              <span className="pf-error-title">{failure.git ? 'Файл записан, но не закоммичен' : 'Исполнитель не записан'}</span>
              <p className={failure.git ? 'mono pf-error-text' : 'pf-error-text'}>{failure.text}</p>
            </div>
          )}
        </div>

        <div className="pf-footer">
          {/* Файл ложится в репозиторий копии, и панель его коммитит: рядом идёт чужая работа. */}
          <span className="mono text-ter pf-file">{file ?? 'путь появится, когда задано имя'}</span>
          <div className="pf-footer-end">
            <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            {/* Просьба уходит из подвала, рядом с «Сохранить»: она такое же действие окна — выбор оператора на B-69. */}
            {phase !== 'running' && (
              <button
                type="button"
                className="bases-btn"
                disabled={busy || !chosen || !wish.trim()}
                onClick={() => void ask(wish)}
              >
                {phase === 'failed' ? 'Попросить снова' : askLabel}
              </button>
            )}
            <button type="submit" className="bases-btn bases-btn-primary" disabled={locked || !chosen || !trimmed}>
              {busy ? 'Сохраняется…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </form>
    </div>
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
    <span className="pf-elapsed" aria-label="Прошло времени">
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  )
}

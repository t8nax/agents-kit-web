import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { Performer, PerformerCopy } from './Performers'
import './PerformerModal.css'

/** Модель исполнителя: пусто — он идёт на модели сессии, которая его позвала. */
const models = ['', 'opus', 'sonnet', 'haiku']

/** Наборы инструментов: пусто — все инструменты сессии, иначе список, как его понимает Claude Code. */
const READ_ONLY = 'Read, Glob, Grep'

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const trimmed = name.trim()
  const chosen = copies.find((c) => c.path === copy) ?? null
  const file = chosen && trimmed ? `${chosen.path}\\.claude\\agents\\${trimmed}.md` : null

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

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="pf-modal" role="dialog" aria-modal="true" aria-labelledby="pf-title" onSubmit={save} noValidate>
        <div className="pf-head">
          <h3 id="pf-title">{editing ? 'Исполнитель' : 'Новый исполнитель'}</h3>
          <button type="button" className="btn btn-icon pf-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="pf-body">
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
                disabled={busy}
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
                disabled={busy}
                onChange={(event) => setModel(event.target.value)}
              >
                {models.map((value) => (
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
              disabled={busy}
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
                disabled={busy}
                onChange={(event) => setTools(event.target.value)}
              />
              <button
                type="button"
                className="pf-preset"
                disabled={busy}
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
                disabled={busy || editing !== null}
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
              disabled={busy}
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
            <button type="submit" className="bases-btn bases-btn-primary" disabled={busy || !chosen || !trimmed}>
              {busy ? 'Сохраняется…' : 'Сохранить'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

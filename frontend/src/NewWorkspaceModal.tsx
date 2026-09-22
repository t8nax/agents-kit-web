import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { WorkspaceRow } from './App'
import { plural } from './plural'
import { WarningIcon } from './Problems'
import './Modal.css'
import './NewWorkspaceModal.css'

/** Проект в окне: база, копия, от которой кит заводит новые, и свободные копии. */
type Project = {
  base: string
  name: string
  source: WorkspaceRow | null
  copies: number
  free: WorkspaceRow[]
}

type Problem = 'kit-not-set' | 'kit-not-found' | 'no-copy' | 'refused'

type Failure = { kind: 'kit'; text: string } | { kind: 'refused'; text: string } | { kind: 'other'; text: string }

type Props = {
  rows: WorkspaceRow[]
  onClose: () => void
  onCreated: (base: string, name: string | null) => void
  onSettings: () => void
}

function projectsOf(rows: WorkspaceRow[]): Project[] {
  const projects = new Map<string, Project>()
  for (const row of rows) {
    const project = projects.get(row.base) ?? { base: row.base, name: row.project, source: null, copies: 0, free: [] }
    projects.set(row.base, project)
    if (row.error) continue
    project.copies++
    if (row.copiesDir) project.source ??= row
    if (row.status === 'free') project.free.push(row)
  }
  return [...projects.values()]
}

function failureOf(problem: Problem, message: string | null): Failure {
  switch (problem) {
    case 'kit-not-set':
      return { kind: 'kit', text: 'Путь к киту не задан, а копию заводит скрипт кита. Задайте его в «Настройках».' }
    case 'kit-not-found':
      return { kind: 'kit', text: `Скрипт кита не найден: ${message ?? 'worktree-add.ps1'}. Проверьте путь к киту в «Настройках».` }
    case 'no-copy':
      return { kind: 'other', text: 'Ни одной копии проекта нет на диске — заводить новую не от чего.' }
    default:
      return { kind: 'refused', text: message ?? 'Кит не объяснил причину.' }
  }
}

export default function NewWorkspaceModal({ rows, onClose, onCreated, onSettings }: Props) {
  // Список проектов берётся на открытии: опрос таблицы не должен двигать выбор под рукой
  const [projects] = useState(() => projectsOf(rows))
  const [base, setBase] = useState(() => (projects.find((p) => p.source) ?? projects[0])?.base ?? null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(() =>
    rows.some((row) => row.problemsState === 'kit-not-set') ? failureOf('kit-not-set', null) : null,
  )
  const field = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const project = projects.find((p) => p.base === base) ?? null
  const trimmed = name.trim()

  async function create(event: FormEvent) {
    event.preventDefault()
    if (!project?.source || busy) return
    setBusy(true)
    setFailure(null)
    try {
      const response = await fetch('/api/workspaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: project.base, name: trimmed || null }),
      })
      if (response.ok) {
        const body = (await response.json()) as { name: string | null }
        onCreated(project.base, body.name ?? (trimmed || null))
        return
      }
      if (response.status === 400) {
        const body = (await response.json()) as { problem: Problem; message: string | null }
        setFailure(failureOf(body.problem, body.message))
      } else if (response.status === 404) {
        setFailure({ kind: 'other', text: 'Этой базы больше нет в списке панели.' })
      } else {
        setFailure({ kind: 'other', text: `Копия не заведена: HTTP ${response.status}.` })
      }
    } catch {
      setFailure({ kind: 'other', text: 'Копия не заведена: нет связи с API.' })
    } finally {
      setBusy(false)
    }
    field.current?.focus()
  }

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !busy && onClose()}>
      <form className="nw-modal" role="dialog" aria-modal="true" aria-labelledby="nw-title" onSubmit={create} noValidate>
        <div className="nw-head">
          <h3 id="nw-title">Новая рабочая копия</h3>
          <button type="button" className="nw-close" aria-label="Закрыть" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="nw-body">
          {projects.length === 0 ? (
            <p className="text-sec nw-empty">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          ) : (
            <>
              <fieldset className="nw-field">
                <legend className="nw-label">Проект</legend>
                <ul className="nw-projects">
                  {projects.map((p) => (
                    <li key={p.base}>
                      <label className={`nw-project ${p.base === base ? 'is-on' : ''} ${p.source ? '' : 'is-off'}`}>
                        <input
                          type="radio"
                          name="nw-project"
                          className="visually-hidden"
                          checked={p.base === base}
                          disabled={busy || !p.source}
                          onChange={() => {
                            setBase(p.base)
                            if (failure?.kind !== 'kit') setFailure(null)
                          }}
                        />
                        <span className="nw-radio" aria-hidden="true" />
                        <span className="nw-project-text">
                          <span className="nw-project-name">{p.name}</span>
                          <span className="mono text-ter">{p.source ? p.source.path : 'копии проекта нет на диске'}</span>
                        </span>
                        <span className="nw-project-meta">
                          {plural(p.copies, 'копия', 'копии', 'копий')}
                          <br />
                          {p.free.length > 0 ? `${p.free.length} ${p.free.length === 1 ? 'свободна' : 'свободны'}` : 'свободных нет'}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>

              <div className="nw-field">
                <label className="nw-label" htmlFor="nw-name">
                  Имя копии <span className="text-ter">— необязательно</span>
                </label>
                <input
                  id="nw-name"
                  ref={field}
                  className="nw-input"
                  type="text"
                  value={name}
                  placeholder="кит придумает сам, например brave-sunny-otter"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  aria-invalid={failure?.kind === 'refused' ? true : undefined}
                  aria-describedby="nw-name-hint"
                  onChange={(event) => {
                    setName(event.target.value)
                    if (failure?.kind !== 'kit') setFailure(null)
                  }}
                />
                <p className="nw-hint" id="nw-name-hint">
                  Строчная латиница и цифры через дефис.
                </p>
              </div>

              {project?.source && (
                <dl className="nw-preview" aria-label="Что будет заведено">
                  <dt>Папка</dt>
                  <dd className="mono">
                    {project.source.copiesDir}\{trimmed || <span className="text-ter">&lt;имя от кита&gt;</span>}
                  </dd>
                  <dt>Ветка</dt>
                  <dd className="mono">{trimmed || <span className="text-ter">с тем же именем</span>}</dd>
                  <dt>От ветки</dt>
                  <dd className="mono">
                    {project.source.branch}
                    {project.source.branch && ' '}
                    <span className="text-ter">· основная копия {project.source.path}</span>
                  </dd>
                </dl>
              )}

              {project && project.free.length > 0 && !failure && !busy && (
                <p className="nw-notice">
                  <InfoIcon />
                  <span>
                    {project.free.length === 1 ? 'У проекта уже есть свободная копия ' : 'У проекта уже есть свободные копии '}
                    {project.free.map((row, i) => (
                      <span key={row.path}>
                        {i > 0 && ', '}
                        <span className="mono nw-strong">{row.branch ?? row.path}</span>
                      </span>
                    ))}{' '}
                    — задачу можно взять и в {project.free.length === 1 ? 'ней' : 'них'}.
                  </span>
                </p>
              )}

              {failure && (
                <div className="nw-error" role="alert">
                  <span className="nw-error-title">
                    <WarningIcon />
                    {failure.kind === 'refused' ? 'Кит не завёл копию' : 'Копия не заведена'}
                  </span>
                  <p className={failure.kind === 'refused' ? 'mono nw-error-text' : 'nw-error-text'}>{failure.text}</p>
                  {failure.kind === 'kit' && (
                    <button type="button" className="bases-btn bases-btn-small nw-error-action" onClick={onSettings}>
                      Открыть «Настройки»
                    </button>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="nw-footer">
          {busy && <span className="text-ter nw-busy-note">Кит проверяет связь с базой и заводит worktree — несколько секунд.</span>}
          <div className="nw-footer-end">
            <button type="button" className="bases-btn" disabled={busy} onClick={onClose}>
              Отмена
            </button>
            <button
              type="submit"
              className="bases-btn bases-btn-primary"
              disabled={busy || !project?.source || failure?.kind === 'kit'}
            >
              {busy && <span className="nw-spinner" aria-hidden="true" />}
              {busy ? 'Заводится…' : failure?.kind === 'refused' ? 'Попробовать снова' : 'Завести копию'}
            </button>
          </div>
        </div>
      </form>
    </div>
  )
}

export function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  )
}

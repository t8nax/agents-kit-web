import { useCallback, useEffect, useRef, useState } from 'react'
import { plural } from './plural'
import './Problems.css'

export type HealthProblem = {
  severity: 'error' | 'warning'
  /** Файл базы; null — проблема связи копии. */
  file: string | null
  message: string
}

export type BaseHealth = {
  base: string
  project: string
  status: 'checked' | 'unchecked' | 'unavailable' | 'failed'
  error: string | null
  problems: HealthProblem[]
  copies: { path: string; problems: HealthProblem[] }[]
}

export type HealthSnapshot = {
  pending: boolean
  kit: 'ok' | 'not-set' | 'not-found'
  bases: BaseHealth[]
  checkedAt: string | null
}

const refreshIntervalMs = 5000

/**
 * Раздел «Проблемы баз»: находки сверки кита и разорванные связи копий по каждой базе.
 * API проверяет базы в фоне, раздел только перечитывает готовый снимок.
 */
export default function Problems({ onSettings }: { onSettings: () => void }) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const lastRequest = useRef(0)

  const load = useCallback(() => {
    const request = ++lastRequest.current
    fetch('/api/health')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<HealthSnapshot>
      })
      .then(
        (value) => {
          if (request !== lastRequest.current) return
          setSnapshot(value)
          setFailed(false)
        },
        () => {
          if (request === lastRequest.current) setFailed(true)
        },
      )
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, refreshIntervalMs)
    return () => clearInterval(timer)
  }, [load])

  return (
    <div className="problems">
      <div className="content-head">
        <h2>Проблемы баз</h2>
        <span className="sub">сверка кита, обновляется сама</span>
      </div>
      {failed && <p className="message warning-text">Нет связи с API</p>}
      {snapshot === null && !failed && <p className="empty-message">Загрузка…</p>}
      {snapshot?.pending && <p className="empty-message">Идёт первая проверка баз…</p>}
      {snapshot && !snapshot.pending && (
        <>
          {snapshot.kit !== 'ok' && <KitNotice kit={snapshot.kit} onSettings={onSettings} />}
          {snapshot.bases.length === 0 && (
            <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          )}
          {snapshot.bases.map((base) => (
            <BaseCard key={base.base} base={base} />
          ))}
        </>
      )}
    </div>
  )
}

export function KitNotice({ kit, onSettings }: { kit: 'not-set' | 'not-found'; onSettings: () => void }) {
  return (
    <div className="kit-notice" role="status">
      <WarningIcon />
      <span className="kit-notice-text">
        {kit === 'not-set'
          ? 'Проблемы баз не проверяются: не задан путь к киту.'
          : 'Проблемы баз не проверяются: по заданному пути кита нет.'}
      </span>
      <button type="button" className="kit-notice-btn" onClick={onSettings}>
        Открыть настройки
      </button>
    </div>
  )
}

function BaseCard({ base }: { base: BaseHealth }) {
  const copies = base.copies.filter((copy) => copy.problems.length > 0)
  const all = [...base.problems, ...copies.flatMap((copy) => copy.problems)]

  return (
    <section className="problems-card" aria-label={`${base.project} — ${base.base}`}>
      <div className="problems-card-head">
        <h3>{base.project}</h3>
        <span className="mono text-ter">{base.base}</span>
        <Summary base={base} problems={all} />
      </div>
      {base.status === 'failed' && (
        <p className="problems-reason">
          Скрипт кита завершился с ошибкой — число проблем этой базы неизвестно.
          {base.error && <span className="mono problems-error"> {base.error}</span>}
        </p>
      )}
      {base.problems.length > 0 && (
        <ProblemGroup title="База" problems={base.problems} />
      )}
      {copies.map((copy) => (
        <ProblemGroup key={copy.path} title={`Копия ${copy.path}`} problems={copy.problems} />
      ))}
    </section>
  )
}

function Summary({ base, problems }: { base: BaseHealth; problems: HealthProblem[] }) {
  if (base.status === 'failed') return <span className="problems-summary problems-failed">сверка не выполнена</span>
  if (base.status === 'unavailable') return <span className="problems-summary problems-failed">база не читается</span>
  if (base.status === 'unchecked') return <span className="problems-summary text-ter">не проверена</span>
  if (problems.length === 0) return <span className="problems-summary problems-none">проблем нет</span>

  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.length - errors
  const parts = [
    errors > 0 && plural(errors, 'ошибка', 'ошибки', 'ошибок'),
    warnings > 0 && plural(warnings, 'предупреждение', 'предупреждения', 'предупреждений'),
  ].filter(Boolean)
  return <span className="problems-summary text-sec">{parts.join(' · ')}</span>
}

function ProblemGroup({ title, problems }: { title: string; problems: HealthProblem[] }) {
  return (
    <div className="problems-group">
      <div className="problems-group-title">{title}</div>
      <ul className="problems-list" aria-label={title}>
        {problems.map((problem, i) => (
          <li key={i} className="problems-item">
            <span>
              <span className={`severity severity-${problem.severity}`}>
                {problem.severity === 'error' ? 'Ошибка' : 'Предупреждение'}
              </span>
            </span>
            <span className="mono text-sec problems-file">{problem.file ?? 'связь'}</span>
            <span className="problems-message">{problem.message}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function WarningIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

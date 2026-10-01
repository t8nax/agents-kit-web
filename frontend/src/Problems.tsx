import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { plural } from './plural'
import { Sk, Skeleton } from './Skeleton'
import { useReveal } from './reveal'
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
  /** База нового формата кита: её проверяет кит, как любую, а предупреждение идёт над находками — B-281. */
  formatWarning?: string | null
  /** База прежнего формата: панель её не читает, а переводит китом по кнопке в карточке — B-314. */
  outdated?: boolean
  /** Перевод базы идёт сейчас — и тогда, когда карточку открыли заново посреди перевода. */
  migrating?: boolean
}

/** Каталог кита и номер его версии; null — номер не прочитан. */
export type KitVersion = {
  path: string
  version: string | null
}

export type HealthSnapshot = {
  pending: boolean
  kit: 'ok' | 'not-set' | 'not-found'
  bases: BaseHealth[]
  checkedAt: string | null
  /** Установленная новая версия плагина кита, на которую панель ещё не перешла. */
  kitUpdate?: KitVersion | null
  currentKitVersion?: string | null
}

const refreshIntervalMs = 5000
// Пока идёт проверка по кнопке, снимок перечитывается чаще: ответ оператор ждёт глазами
const checkingIntervalMs = 1000

/**
 * Раздел «Проблемы баз»: находки сверки кита и разорванные связи копий по каждой базе.
 * API проверяет базы в фоне, раздел только перечитывает готовый снимок.
 */
export default function Problems({ onSettings }: { onSettings: () => void }) {
  const [snapshot, setSnapshot] = useState<HealthSnapshot | null>(null)
  const [failed, setFailed] = useState(false)
  const reveal = useReveal(snapshot === null && !failed)
  const [checking, setChecking] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)
  const lastRequest = useRef(0)
  // Время проверки на момент нажатия: новый снимок с другим временем — проверка по кнопке прошла
  const checkedBefore = useRef<string | null | undefined>(undefined)

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
          if (checkedBefore.current !== undefined && !value.pending && value.checkedAt !== checkedBefore.current) {
            checkedBefore.current = undefined
            setChecking(false)
          }
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

  useEffect(() => {
    if (!checking) return
    const timer = setInterval(load, checkingIntervalMs)
    return () => clearInterval(timer)
  }, [checking, load])

  async function check() {
    checkedBefore.current = snapshot?.checkedAt ?? null
    setChecking(true)
    setCheckError(null)
    try {
      const response = await fetch('/api/health/check', { method: 'POST' })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch (e) {
      checkedBefore.current = undefined
      setChecking(false)
      setCheckError(
        e instanceof TypeError ? 'Проверка не запущена: нет связи с API' : `Проверка не запущена: ${(e as Error).message}`,
      )
    }
  }

  return (
    <div className="problems">
      <div className="content-head">
        <h2>Проблемы баз</h2>
        <span className="sub">
          {snapshot?.checkedAt ? `проверено в ${formatTime(snapshot.checkedAt)}` : 'сверка кита, обновляется сама'}
        </span>
        <div className="head-end">
          <button type="button" className="check-btn" disabled={checking} onClick={() => void check()}>
            <RefreshIcon />
            {checking ? 'Проверяется…' : 'Проверить сейчас'}
          </button>
        </div>
      </div>
      {failed && <p className="message warning-text">Нет связи с API</p>}
      {checkError && <p className="message warning-text">{checkError}</p>}
      {snapshot === null && !failed && <ProblemsSkeleton shown={reveal.shown} />}
      {snapshot?.pending && <p className="empty-message">Идёт первая проверка баз…</p>}
      {snapshot && !snapshot.pending && (
        <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
          {snapshot.kitUpdate && snapshot.kit !== 'not-set' ? (
            <KitUpdateNotice
              found={snapshot.kit === 'ok'}
              current={snapshot.currentKitVersion ?? null}
              update={snapshot.kitUpdate}
              action="Открыть настройки"
              onAction={onSettings}
            />
          ) : (
            snapshot.kit !== 'ok' && <KitNotice kit={snapshot.kit} onSettings={onSettings} />
          )}
          {snapshot.bases.length === 0 && (
            <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
          )}
          {snapshot.bases.map((base) => (
            <BaseCard key={base.base} base={base} onMigrated={() => void check()} onSettings={onSettings} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Проблемы, пока снимок сверки читается в первый раз: карточки баз полосами (макет B-201). */
function ProblemsSkeleton({ shown }: { shown: boolean }) {
  const item = (file: number, message: string) => (
    <li className="problems-item" style={{ alignItems: 'center' }} key={`${file}-${message}`}>
      <span>
        <Sk w={76} h={20} />
      </span>
      <span>
        <Sk w={file} h={10} />
      </span>
      <span>
        <Sk w={message} h={12} />
      </span>
    </li>
  )
  const group = (title: number, items: ReactNode[]) => (
    <div className="problems-group">
      <div className="problems-group-title">
        <Sk w={title} h={9} />
      </div>
      <ul className="problems-list">{items}</ul>
    </div>
  )
  const card = (name: number, path: number, summary: number, groups: ReactNode = null) => (
    <section className="problems-card sk-frame">
      <div className="problems-card-head" style={{ alignItems: 'center' }}>
        <Sk w={name} h={13} />
        <Sk w={path} h={10} />
        <span className="problems-summary">
          <Sk w={summary} h={11} />
        </span>
      </div>
      {groups}
    </section>
  )
  return (
    <Skeleton label="Загрузка проблем баз" shown={shown}>
      {card(
        110,
        250,
        190,
        <>
          {group(40, [item(150, '62%'), item(120, '48%')])}
          {group(170, [item(90, '54%')])}
        </>,
      )}
      {card(80, 210, 90)}
      {card(96, 230, 90)}
    </Skeleton>
  )
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
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

/** Текст о новой версии кита: found — прежняя версия по сохранённому пути на месте. */
function kitUpdateText(found: boolean, current: string | null, update: KitVersion): string {
  const number = update.version ? ` ${update.version}` : ''
  if (!found)
    return `Прежней версии кита по сохранённому пути больше нет, проблемы баз не проверяются. Установлена новая версия${number}.`
  return `Установлена новая версия кита${number}` + (current ? `, панель работает версией ${current}.` : '.')
}

/** Переход на новую версию кита: кнопкой в «Настройках», ссылкой туда — из «Проблем баз». */
export function KitUpdateNotice({
  found,
  current,
  update,
  action,
  busy = false,
  onAction,
}: {
  found: boolean
  current: string | null
  update: KitVersion
  action: string
  busy?: boolean
  onAction: () => void
}) {
  return (
    <div className="kit-notice" role="status">
      <WarningIcon />
      <span className="kit-notice-text">{kitUpdateText(found, current, update)}</span>
      <button type="button" className="kit-notice-btn" disabled={busy} onClick={onAction}>
        {action}
      </button>
    </div>
  )
}

/**
 * Итог перевода базы прежнего формата — как его отдаёт POST /api/bases/migrate. Слов кита карточка не показывает:
 * «это технические детали» — решение оператора на B-314.
 */
type MigrateOutcome =
  | 'migrated'
  | 'not-pushed'
  | 'not-synced'
  | 'need-name'
  | 'invalid-name'
  | 'kit-old'
  | 'kit-missing'
  | 'failed'
  | 'offline'
  | 'running'

/** Перевод в карточке: running — идёт; name — имя оператора, с которым переводят, пустое — без имени. */
type Migration = { phase: 'idle' | MigrateOutcome; name: string; terminalFailed?: boolean }

function BaseCard({
  base,
  onMigrated,
  onSettings,
}: {
  base: BaseHealth
  onMigrated: () => void
  onSettings: () => void
}) {
  const copies = base.copies.filter((copy) => copy.problems.length > 0)
  const all = [...base.problems, ...copies.flatMap((copy) => copy.problems)]
  const [migration, setMigration] = useState<Migration>({ phase: 'idle', name: '' })

  // Переводится сразу по кнопке, без подтверждения и без окна — решение оператора на B-314.
  async function migrate(name: string) {
    setMigration({ phase: 'running', name })
    let phase: MigrateOutcome = 'failed'
    try {
      const response = await fetch('/api/bases/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: base.base, operator: name.trim() || null }),
      })
      if (response.ok) phase = ((await response.json()) as { outcome: MigrateOutcome }).outcome
    } catch {
      // Нет связи с API — перевод не прошёл, как и при любом другом сбое.
    }
    // Брошенный по сроку перевод ещё идёт: его держит пометка migrating снимка, а не ответ запроса.
    setMigration({ phase: phase === 'running' ? 'idle' : phase, name })
    onMigrated()
  }

  async function openTerminal() {
    setMigration((m) => ({ ...m, terminalFailed: false }))
    let opened = false
    try {
      const response = await fetch('/api/bases/terminal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: base.base }),
      })
      opened = response.ok
    } catch {
      opened = false
    }
    if (!opened) setMigration((m) => ({ ...m, terminalFailed: true }))
  }

  return (
    <section className="problems-card" aria-label={`${base.project} — ${base.base}`}>
      <div className="problems-card-head">
        <h3>{base.project}</h3>
        <span className="mono text-ter">{base.base}</span>
        <Summary base={base} problems={all} />
      </div>
      {base.formatWarning && (
        <p className="problems-format" role="status">
          <WarningIcon />
          {base.formatWarning}
        </p>
      )}
      {base.outdated ? (
        <MigrateBlock
          migration={base.migrating ? { ...migration, phase: 'running' } : migration}
          onName={(name) => setMigration((m) => ({ ...m, name }))}
          onMigrate={(name) => void migrate(name)}
          onTerminal={() => void openTerminal()}
          onSettings={onSettings}
        />
      ) : (
        (migration.phase === 'not-pushed' || migration.phase === 'not-synced') && (
          <p className="problems-format" role="status">
            <WarningIcon />
            {migration.phase === 'not-pushed'
              ? 'База переведена на новый формат, но не отправлена на сервер: сервер недоступен.'
              : 'База переведена на новый формат, но не отправлена на сервер.'}
          </p>
        )
      )}
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

const nameHint =
  'Имя состоит из строчных латинских букв и цифр; части имени можно разделять одиночным дефисом, например b-ignatyev.'

/** Полоса перевода в карточке базы прежнего формата — по макету B-314. */
function MigrateBlock({
  migration,
  onName,
  onMigrate,
  onTerminal,
  onSettings,
}: {
  migration: Migration
  onName: (name: string) => void
  onMigrate: (name: string) => void
  onTerminal: () => void
  onSettings: () => void
}) {
  const { phase, name } = migration
  // Удачный перевод итогом не показывается: пока снимок проверки не прочёл переведённую базу, полоса говорит, что
  // перевод идёт, а потом карточка просто становится обычной.
  if (phase === 'running' || phase === 'migrated' || phase === 'not-pushed' || phase === 'not-synced')
    return (
      <div className="problems-format" role="status">
        <WarningIcon />
        <span className="problems-format-text">Выполняется перевод базы на новый формат.</span>
        <button type="button" className="kit-notice-btn" disabled>
          <span className="dw-spinner" aria-hidden="true" />
          Перевести базу
        </button>
      </div>
    )
  if (phase === 'need-name' || phase === 'invalid-name')
    return (
      <>
        <div className="problems-format" role="status">
          <WarningIcon />
          <span className="problems-format-text">
            Для перевода базы необходимо указать имя оператора этого компьютера.
          </span>
        </div>
        <form
          className="problems-migrate-name"
          onSubmit={(e) => {
            e.preventDefault()
            onMigrate(name)
          }}
        >
          <div className="problems-migrate-row">
            <input
              className="nw-input"
              type="text"
              aria-label="Имя оператора этого компьютера"
              aria-invalid={phase === 'invalid-name'}
              spellCheck={false}
              value={name}
              onChange={(e) => onName(e.target.value)}
            />
            <button type="submit" className="bases-btn" disabled={name.trim() === ''}>
              Перевести с указанным именем
            </button>
          </div>
          {phase === 'invalid-name' && (
            <p className="problems-migrate-error" role="alert">
              Указанное имя не соответствует требованиям.
            </p>
          )}
          <p className="nw-hint">{nameHint}</p>
        </form>
      </>
    )
  if (phase === 'failed' || phase === 'offline')
    return (
      <div className="problems-format problems-format-error" role="alert">
        <WarningIcon />
        <span className="problems-format-text">
          {phase === 'offline'
            ? 'Не удалось перевести базу на новый формат: сервер недоступен.'
            : 'Не удалось перевести базу на новый формат.'}
          {migration.terminalFailed && ' Терминал не открылся.'}
        </span>
        <div className="problems-format-actions">
          <button type="button" className="bases-btn bases-btn-small" onClick={() => onMigrate(name)}>
            Повторить
          </button>
          <button type="button" className="bases-btn bases-btn-small" onClick={onTerminal}>
            Открыть терминал в копии
          </button>
        </div>
      </div>
    )
  if (phase === 'kit-old' || phase === 'kit-missing')
    return (
      <div className="problems-format" role="status">
        <WarningIcon />
        <span className="problems-format-text">
          {phase === 'kit-old'
            ? 'Установленная версия кита не может перевести базу на формат, который поддерживает панель. Обновите кит в разделе «Настройки».'
            : 'Для перевода базы необходимо указать путь к киту в разделе «Настройки».'}
        </span>
        <button type="button" className="kit-notice-btn" onClick={onSettings}>
          Открыть настройки
        </button>
      </div>
    )
  return (
    <div className="problems-format" role="status">
      <WarningIcon />
      <span className="problems-format-text">
        База хранится в прежнем формате, поэтому панель не может её прочитать. Переведите базу на новый формат.
      </span>
      <button type="button" className="kit-notice-btn" onClick={() => onMigrate(name)}>
        Перевести базу
      </button>
    </div>
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

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="23 4 23 10 17 10" />
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
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

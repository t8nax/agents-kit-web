import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import { AGENT_NAME } from './BacklogWriteModal'
import Flow from './Flow'
import PickMenu from './PickMenu'
import { WarningIcon } from './Problems'
import { Sk, Skeleton } from './Skeleton'
import { useAgentRequest } from './agentRequest'
import { plural } from './plural'
import { useReveal } from './reveal'
import './Tabs.css'
import './Reports.css'

export type Priority = 'high' | 'medium' | 'low'

/** Требование к флоу из справки кита — таким, каким было при разборе. */
export type Requirement = { code: string; ring: string; priority: Priority; title: string; text: string }

export type RingScore = { name: string; score: number; band: 'pass' | 'avg' | 'fail'; total: number; passed: number }

export type ReportFinding = {
  id: string
  requirements: string[]
  place: string
  quotes: { where: string; text: string }[]
  why: string
  fix: string
}

export type ReportDiscussion = { title: string; place: string; now: string; for: string; against: string }

export type FlowReport = {
  built: string
  checked: string
  rings: RingScore[]
  requirements: Requirement[]
  findings: ReportFinding[]
  discussions: ReportDiscussion[]
}

/** Дни — по-дотнетовски: 0 — воскресенье, 1 — понедельник. */
export type ReportSchedule = { enabled: boolean; days: number[]; hour: number }

/** Почему отчёт не строится: kit — кита или требований нет, health — ошибки сверки во флоу, flow — нет сценариев. */
export type ReportBlock = { kind: 'kit' | 'health' | 'flow'; reason: string }

export type FlowReportItem = {
  base: string
  project: string
  schedule: ReportSchedule
  report: FlowReport | null
  blocked: ReportBlock | null
}

type ReportEvent = { type: 'step' | 'reported' | 'error'; text: string; output?: string }

type Order = 'priority' | 'ring'

/** Вычет за находку по приоритету требования — тот же, что считает панель на сервере. */
const weights: Record<Priority, number> = { high: 15, medium: 7, low: 2 }

const priorityNames: Record<Priority, string> = { high: 'Высокий', medium: 'Средний', low: 'Низкий' }

const priorityGroups: Record<Priority, string> = {
  high: 'Высокий приоритет',
  medium: 'Средний приоритет',
  low: 'Низкий приоритет',
}

const priorities: Priority[] = ['high', 'medium', 'low']

/** Дни недели по порядку с понедельника и их номера. */
const weekDays: { day: number; label: string }[] = [
  { day: 1, label: 'Пн' },
  { day: 2, label: 'Вт' },
  { day: 3, label: 'Ср' },
  { day: 4, label: 'Чт' },
  { day: 5, label: 'Пт' },
  { day: 6, label: 'Сб' },
  { day: 0, label: 'Вс' },
]

const hours = Array.from({ length: 24 }, (_, hour) => ({ id: String(hour), label: hourLabel(hour) }))

/** Вид отчёта — один, но раздел ждёт и другие (ответ оператора на B-270). */
const kinds = [{ id: 'flow', label: 'Как устроен флоу' }]

function hourLabel(hour: number) {
  return `${String(hour).padStart(2, '0')}:00`
}

/** «15 баллов» — число вместе со словом. */
function balls(count: number) {
  return plural(count, 'балл', 'балла', 'баллов')
}

function stamp(at: string) {
  return new Date(at).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

/** Строка отчёта — находка в одном требовании: под двумя требованиями находка стоит двумя строками (B-270, Н2). */
type Row = { key: string; finding: ReportFinding; requirement: Requirement; twins: Requirement[] }

function rowsOf(report: FlowReport): Row[] {
  const byCode = new Map(report.requirements.map((requirement) => [requirement.code, requirement]))
  return report.findings.flatMap((finding) => {
    const own = finding.requirements.flatMap((code) => byCode.get(code) ?? [])
    return own.map((requirement) => ({
      key: `${finding.id}-${requirement.code}`,
      finding,
      requirement,
      twins: own.filter((other) => other !== requirement),
    }))
  })
}

function passedOf(report: FlowReport) {
  const failed = new Set(report.findings.flatMap((finding) => finding.requirements))
  return report.requirements.filter((requirement) => !failed.has(requirement.code))
}

/** Просьба к Чудо-Юдо исправить находку — её вписывают в поле окна «Переписать с Чудо-Юдо», отправляет оператор. */
function rewriteWish(row: Row) {
  const titles = [row.requirement, ...row.twins].map((requirement) => `«${requirement.title}»`)
  const by = titles.length > 1 ? `по требованиям ${titles.slice(0, -1).join(', ')} и ${titles.at(-1)}` : `по требованию ${titles[0]}`
  return [
    `Прошу исправить находку отчёта «Как устроен флоу» ${by}. Место во флоу: ${row.finding.place}.`,
    row.finding.why,
    `Предлагаемое исправление: ${row.finding.fix}`,
  ].join('\n\n')
}

/**
 * Раздел «Отчёты»: отчёт о том, как устроен флоу выбранного проекта. Разбирает флоу Чудо-Юдо по требованиям кита,
 * баллы колец считает панель, и хранится отчёт у панели, а не в базе. Сравнения с прошлым отчётом нет — сужение
 * оператора на B-270.
 */
export default function Reports({
  reportFor = null,
  onProblems,
}: {
  /** База просьбы, к которой оператор вернулся из шапки: раздел открывается сразу на ней. */
  reportFor?: string | null
  onProblems: () => void
}) {
  const [items, setItems] = useState<FlowReportItem[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [selected, setSelected] = useState<string | null>(reportFor)
  const [order, setOrder] = useState<Order>('priority')
  const [runFailure, setRunFailure] = useState<string | null>(null)
  const [scheduleFailure, setScheduleFailure] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Окно переписывания флоу поверх отчёта: просьба по находке живёт только в нём (ревью B-270, М.1 и м.1).
  const [rewrite, setRewrite] = useState<{ base: string; wish: string; at: number } | null>(null)
  const reveal = useReveal(items === null && !failed)
  const request = useAgentRequest<ReportEvent>('report')

  const load = useCallback(() => {
    fetch('/api/reports/flow')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<FlowReportItem[]>
      })
      .then(
        (list) => {
          setItems(list)
          setFailed(false)
          setSelected((current) => (list.some((item) => item.base === current) ? current : (list[0]?.base ?? null)))
        },
        () => setFailed(true),
      )
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // Разбор кончился — отчёт перечитывается: его записала панель.
  const outcome = request.outcome
  useEffect(() => {
    if (outcome) load()
  }, [outcome, load])

  // Время идущего разбора тикает само.
  useEffect(() => {
    if (!request.running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [request.running])

  const item = items?.find((one) => one.base === selected) ?? null
  const mine = item !== null && request.base === item.base
  const running = request.running
  const error = mine && outcome?.type === 'error' ? outcome : null

  async function run() {
    if (!item) return
    setRunFailure(null)
    // Ход и итог разбора читаются потоком просьбы — тем же, что подхватывает раздел, открытый заново.
    const started = await request.start('/api/reports/flow/run', { base: item.base })
    if (started.ok) return
    // Отчёт не строится: причину раздел показывает на месте отчёта, как при открытии.
    if (started.status === 409) load()
    else
      setRunFailure(
        started.status === 404
          ? 'Базы нет в списке панели или на диске.'
          : started.status === null
            ? 'Нет связи с API.'
            : 'Панель не запустила разбор.',
      )
  }

  async function saveSchedule(next: ReportSchedule) {
    if (!item) return
    const previous = item.schedule
    setScheduleFailure(null)
    setItems((list) => list?.map((one) => (one.base === item.base ? { ...one, schedule: next } : one)) ?? null)
    try {
      const response = await fetch('/api/reports/flow/schedule', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: item.base, ...next }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
    } catch {
      setItems((list) => list?.map((one) => (one.base === item.base ? { ...one, schedule: previous } : one)) ?? null)
      setScheduleFailure('Расписание не записано.')
    }
  }

  const report = item?.report ?? null
  const blocked = item?.blocked ?? null
  const elapsed = request.startedAt === null ? 0 : Math.max(0, Math.floor((now - request.startedAt) / 1000))

  return (
    <div className="rp">
      <div className="rp-head">
        <h2>Отчёты</h2>
        <PickMenu label="Вид отчёта" value={kinds[0].label} options={kinds} selected="flow" onPick={() => {}} />
        <div className="rp-head-end">
          {report && (
            <button type="button" className="bases-btn" disabled={running || blocked !== null} onClick={() => void run()}>
              <RefreshIcon />
              Проверить заново
            </button>
          )}
          <span className="rp-head-sep" aria-hidden="true" />
          {/* Выбор проекта приходит с данными: пока список читается, на его месте заготовка (decisions/loading.md). */}
          {items === null && !failed && <Sk w={136} h={30} style={{ borderRadius: 6 }} />}
          {items && items.length > 0 && (
            <PickMenu
              label="Проект"
              value={item?.project ?? ''}
              options={items.map((one) => ({ id: one.base, label: one.project, title: one.base }))}
              selected={selected}
              onPick={(base) => {
                setSelected(base)
                setRunFailure(null)
              }}
            />
          )}
        </div>
      </div>

      {failed && <p className="message warning-text">Нет связи с API</p>}
      {items === null && !failed && <ReportsSkeleton shown={reveal.shown} />}
      {items?.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}

      {item && (
        <div className={reveal.className} onAnimationEnd={reveal.onAnimationEnd}>
          <ScheduleLine
            schedule={item.schedule}
            report={blocked?.kind === 'health' ? null : report}
            onChange={(next) => void saveSchedule(next)}
          />
          {scheduleFailure && <p className="message warning-text">{scheduleFailure}</p>}
          {runFailure && <p className="message warning-text">{runFailure}</p>}

          {running && (
            <div className="rp-waiting" role="status">
              <span className="rp-spinner" aria-hidden="true" />
              <span className="rp-waiting-text">
                {mine ? `Идёт разбор флоу ${item.project}.` : `Идёт разбор флоу ${request.request?.project ?? ''}.`}
              </span>
              <span className="rp-elapsed" aria-label="Прошло времени">
                {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
              </span>
              <button type="button" className="bases-btn bases-btn-small" onClick={() => void request.forget()}>
                Отменить
              </button>
            </div>
          )}

          {error && (
            <div className="rp-failed" role="alert">
              <strong>
                <WarningIcon />
                Отчёт не построен
              </strong>
              <p>{error.text}</p>
              {error.output && (
                <details className="rp-output">
                  <summary>Ответ {AGENT_NAME}</summary>
                  <pre>{error.output}</pre>
                </details>
              )}
            </div>
          )}

          {blocked ? (
            <div className="rp-failed" role="alert">
              <strong>
                <WarningIcon />
                Отчёт не построен
              </strong>
              <p>{blocked.reason}</p>
              {blocked.kind === 'health' && (
                <div className="rp-acts">
                  <button type="button" className="bases-btn" onClick={onProblems}>
                    <WarningIcon />
                    Открыть «Проблемы баз»
                  </button>
                </div>
              )}
            </div>
          ) : report ? (
            <ReportView
              report={report}
              order={order}
              onOrder={setOrder}
              onRewrite={(row) => setRewrite({ base: item.base, wish: rewriteWish(row), at: Date.now() })}
            />
          ) : running && mine ? (
            <ReportSkeleton />
          ) : (
            !running && (
              <div className="rp-empty">
                <span className="rp-empty-mark">
                  <ReportIcon />
                </span>
                <h3>Отчёта ещё нет</h3>
                <p>Отчёт о флоу проекта {item.project} ещё не строился.</p>
                <button type="button" className="bases-btn" onClick={() => void run()}>
                  <PlayIcon />
                  Построить отчёт
                </button>
              </div>
            )
          )}
        </div>
      )}

      {/* Правки флоу пишет раздел «Флоу»: от него здесь только окно, тем же путём записи и с теми же замками задач. */}
      {rewrite && (
        <Flow
          baseFor={rewrite.base}
          rewriteAt={rewrite.at}
          rewriteWish={rewrite.wish}
          rewriteOnly
          onRewriteClosed={() => setRewrite(null)}
        />
      )}
    </div>
  )
}

/**
 * Строка расписания проекта в одну линию: выключатель, дни, час; справа — когда построен отчёт и когда проверяли флоу.
 * Изменение действует сразу — вариант Р1 макета, выбор оператора на B-270.
 */
function ScheduleLine({
  schedule,
  report,
  onChange,
}: {
  schedule: ReportSchedule
  report: FlowReport | null
  onChange: (next: ReportSchedule) => void
}) {
  const on = schedule.enabled
  // Проверка позже построения — расписание нашло флоу прежним и отчёт не строило.
  const unchanged = report !== null && new Date(report.checked).getTime() > new Date(report.built).getTime()
  return (
    <div className="rp-sched">
      <label className="rp-inline">
        <button
          type="button"
          className="rp-switch"
          role="switch"
          aria-checked={on}
          aria-label="Проверять по расписанию"
          onClick={() => onChange({ ...schedule, enabled: !on })}
        />
        <span>По расписанию</span>
      </label>
      <span className={`rp-inline ${on ? '' : 'is-off'}`}>
        <span className="rp-days" role="group" aria-label="Дни недели">
          {weekDays.map(({ day, label }) => {
            const pressed = schedule.days.includes(day)
            return (
              <button
                key={day}
                type="button"
                className="rp-day"
                aria-pressed={on && pressed}
                disabled={!on}
                onClick={() =>
                  onChange({
                    ...schedule,
                    days: pressed ? schedule.days.filter((one) => one !== day) : [...schedule.days, day],
                  })
                }
              >
                {label}
              </button>
            )
          })}
        </span>
      </span>
      <span className={`rp-inline ${on ? '' : 'is-off'}`}>
        <span className="rp-sched-label">в</span>
        <PickMenu
          label="Час проверки"
          value={hourLabel(schedule.hour)}
          options={hours}
          selected={String(schedule.hour)}
          disabled={!on}
          onPick={(hour) => onChange({ ...schedule, hour: Number(hour) })}
        />
      </span>
      {report && (
        <span className="rp-stamps">
          <span>
            Отчёт <b>{stamp(report.built)}</b>
          </span>
          <span title={unchanged ? 'Флоу после построения отчёта не изменялся' : undefined}>
            Проверка флоу <b>{stamp(report.checked)}</b>
          </span>
        </span>
      )}
    </div>
  )
}

function ReportView({
  report,
  order,
  onOrder,
  onRewrite,
}: {
  report: FlowReport
  order: Order
  onOrder: (order: Order) => void
  onRewrite: (row: Row) => void
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const [lit, setLit] = useState<string | null>(null)
  // Кольцо, к которому ведёт щелчок, и когда щёлкнули: порядок по кольцам мог уже стоять, и прокрутка нужна всё равно.
  const goRing = useRef<string | null>(null)
  const [goAt, setGoAt] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const rows = rowsOf(report)
  const passed = passedOf(report)
  const ringScore = (name: string) => report.rings.find((ring) => ring.name === name)

  // Щелчок по кольцу ставит порядок по кольцам и ведёт к его разделу — когда тот уже отрисован.
  useEffect(() => {
    const ring = goRing.current
    if (!ring || order !== 'ring') return
    goRing.current = null
    list.current?.querySelector(`[data-ring="${CSS.escape(ring)}"]`)?.scrollIntoView({ block: 'start', behavior: smooth() })
  }, [goAt, order])

  // Строка-близнец раскрыта и подсвечена ненадолго: видно, куда увела ссылка.
  useEffect(() => {
    if (!lit) return
    list.current?.querySelector(`[data-row="${CSS.escape(lit)}"]`)?.scrollIntoView({ block: 'nearest', behavior: smooth() })
    const timer = setTimeout(() => setLit(null), 1600)
    return () => clearTimeout(timer)
  }, [lit])

  const toggle = (key: string, value: boolean) =>
    setOpen((prev) => {
      if (prev.has(key) === value) return prev
      const next = new Set(prev)
      if (value) next.add(key)
      else next.delete(key)
      return next
    })

  const findingRow = (row: Row, inRing: boolean) => (
    <FindingRow
      key={row.key}
      row={row}
      inRing={inRing}
      open={open.has(row.key)}
      lit={lit === row.key}
      onToggle={(value) => toggle(row.key, value)}
      onTwin={(twin) => {
        const key = `${row.finding.id}-${twin.code}`
        toggle(key, true)
        setLit(key)
      }}
      onRewrite={() => onRewrite(row)}
    />
  )

  return (
    <div className="rp-report">
      <div className="rp-rings">
        {report.rings.map((ring) => (
          <button
            key={ring.name}
            type="button"
            className="rp-ring"
            title={`${ring.name}: ${ring.score} из 100.`}
            aria-label={`${ring.name}: ${ring.score} из 100.`}
            onClick={() => {
              goRing.current = ring.name
              setGoAt(Date.now())
              onOrder('ring')
            }}
          >
            <Gauge ring={ring} size={72} />
            <span className="rp-ring-name">{ring.name}</span>
          </button>
        ))}
      </div>

      <div className="rp-order">
        <div className="vc-tabs" role="tablist" aria-label="Порядок находок">
          <button
            type="button"
            role="tab"
            className={`flow-tab ${order === 'priority' ? 'is-on' : ''}`}
            aria-selected={order === 'priority'}
            onClick={() => onOrder('priority')}
          >
            По приоритету
          </button>
          <button
            type="button"
            role="tab"
            className={`flow-tab ${order === 'ring' ? 'is-on' : ''}`}
            aria-selected={order === 'ring'}
            onClick={() => onOrder('ring')}
          >
            По кольцам
          </button>
        </div>
      </div>

      <div className="rp-list" ref={list}>
        {order === 'priority' ? (
          <>
            {rows.length === 0 && <p className="rp-clean">Нарушенных требований нет.</p>}
            {priorities.map((priority) => {
              const group = rows.filter((row) => row.requirement.priority === priority)
              return (
                group.length > 0 && (
                  <section key={priority} className="rp-group">
                    <p className="rp-group-title">{priorityGroups[priority]}</p>
                    <div className="rp-items">{group.map((row) => findingRow(row, false))}</div>
                  </section>
                )
              )
            })}
            <Discussions discussions={report.discussions} />
            <Passed requirements={passed} withRing />
          </>
        ) : (
          <>
            {report.rings.map((ring) => {
              const group = rows
                .filter((row) => row.requirement.ring === ring.name)
                .sort((a, b) => priorities.indexOf(a.requirement.priority) - priorities.indexOf(b.requirement.priority))
              return (
                <section key={ring.name} className="rp-ring-section" data-ring={ring.name}>
                  <div className="rp-ring-head">
                    <Gauge ring={ringScore(ring.name) ?? ring} size={88} />
                    <div>
                      <h3>{ring.name}</h3>
                      <span className="rp-ring-count">
                        Требований {ring.total}, выполнено {ring.passed}.
                      </span>
                    </div>
                  </div>
                  {group.length > 0 && <div className="rp-items">{group.map((row) => findingRow(row, true))}</div>}
                  <Passed requirements={passed.filter((requirement) => requirement.ring === ring.name)} withRing={false} />
                </section>
              )
            })}
            <Discussions discussions={report.discussions} />
          </>
        )}
      </div>
    </div>
  )
}

function FindingRow({
  row,
  inRing,
  open,
  lit,
  onToggle,
  onTwin,
  onRewrite,
}: {
  row: Row
  inRing: boolean
  open: boolean
  lit: boolean
  onToggle: (open: boolean) => void
  onTwin: (twin: Requirement) => void
  onRewrite: () => void
}) {
  const { finding, requirement, twins } = row
  const points = weights[requirement.priority]
  const back = [requirement, ...twins]
    .map((one) => `кольцу «${one.ring}» ${balls(weights[one.priority])}`)
    .join(' и ')
  return (
    <details
      className={`rp-finding ${lit ? 'is-lit' : ''}`}
      data-row={row.key}
      open={open}
      onToggle={(event) => onToggle(event.currentTarget.open)}
    >
      <summary>
        <ChevronIcon />
        <PriorityTag priority={requirement.priority} />
        <span className="rp-finding-main">
          <span className="rp-finding-title">{requirement.title}</span>
          {twins.map((twin) => (
            <span key={twin.code} className="rp-twin-tag">
              <LinkIcon />
              одно исправление с «{twin.title}»
            </span>
          ))}
          <span className="rp-finding-where">{finding.place}</span>
        </span>
        <span className="rp-finding-ring">{inRing ? '' : requirement.ring}</span>
        <span className="rp-finding-gain" title={`Исправление вернёт кольцу ${balls(points)}`}>
          +{points}
        </span>
      </summary>
      <div className="rp-finding-body">
        <dl className="rp-fields">
          <div>
            <dt>Проверяет</dt>
            <dd>{requirement.text}</dd>
          </div>
          {twins.map((twin) => (
            <div key={twin.code}>
              <dt>Та же находка</dt>
              <dd>
                <span>
                  Эта же находка нарушает требование «{twin.title}» в кольце «{twin.ring}». Одно исправление устраняет
                  обе.{' '}
                  <button type="button" className="rp-link" onClick={() => onTwin(twin)}>
                    Показать строку
                  </button>
                </span>
              </dd>
            </div>
          ))}
          {finding.quotes.length > 0 && (
            <div>
              <dt>Где во флоу</dt>
              <dd>
                {finding.quotes.map((quote, i) => (
                  <span key={i} className="rp-quote">
                    <span className="rp-quote-place">{quote.where}</span>
                    <span>{quote.text}</span>
                  </span>
                ))}
              </dd>
            </div>
          )}
          <div>
            <dt>Почему это плохо</dt>
            <dd>{finding.why}</dd>
          </div>
          <div>
            <dt>Что сделать</dt>
            <dd>
              <span className="rp-fix">{finding.fix}</span>
            </dd>
          </div>
        </dl>
        <div className="rp-finding-foot">
          <span>Исправление вернёт {back}.</span>
          <button type="button" className="bases-btn" onClick={onRewrite}>
            <RewriteIcon />
            Переписать с {AGENT_NAME}
          </button>
        </div>
      </div>
    </details>
  )
}

function Discussions({ discussions }: { discussions: ReportDiscussion[] }) {
  if (discussions.length === 0) return null
  return (
    <section className="rp-group">
      <p className="rp-group-title">Стоит обсудить</p>
      <div className="rp-items">
        {discussions.map((discussion, i) => (
          <details key={i} className="rp-finding">
            <summary>
              <ChevronIcon />
              <span className="rp-pr rp-pr-q">Вопрос</span>
              <span className="rp-finding-main">
                <span className="rp-finding-title">{discussion.title}</span>
                {discussion.place && <span className="rp-finding-where">{discussion.place}</span>}
              </span>
              <span />
              <span />
            </summary>
            <div className="rp-finding-body">
              <dl className="rp-fields">
                {[
                  ['Сейчас', discussion.now],
                  ['За изменение', discussion.for],
                  ['За то, чтобы оставить', discussion.against],
                ]
                  .filter(([, text]) => text)
                  .map(([label, text]) => (
                    <div key={label}>
                      <dt>{label}</dt>
                      <dd>{text}</dd>
                    </div>
                  ))}
              </dl>
            </div>
          </details>
        ))}
      </div>
    </section>
  )
}

function Passed({ requirements, withRing }: { requirements: Requirement[]; withRing: boolean }) {
  if (requirements.length === 0) return null
  return (
    <details className="rp-passed">
      <summary>
        <ChevronIcon />
        <span className="rp-group-title">Выполненные требования</span>
      </summary>
      <div className="rp-items">
        {requirements.map((requirement) => (
          <div key={requirement.code} className="rp-passed-row">
            <span className="rp-ok">
              <TickIcon />
            </span>
            <span className="rp-passed-name">
              {requirement.title}
              {withRing && <span className="rp-passed-ring">{requirement.ring}</span>}
            </span>
            <span className="rp-passed-text">{requirement.text}</span>
          </div>
        ))}
      </div>
    </details>
  )
}

function PriorityTag({ priority }: { priority: Priority }) {
  const points = weights[priority]
  return (
    <span
      className={`rp-pr rp-pr-${priority}`}
      title={`${priorityNames[priority]} приоритет: −${balls(points)} кольцу. С находкой высокого приоритета кольцо не бывает зелёным.`}
    >
      {priorityNames[priority]}
    </span>
  )
}

/** Кольцо баллов: цвет по баллам — зелёный от 90, жёлтый от 50, ниже красный; с высоким приоритетом не зелёное. */
function Gauge({ ring, size }: { ring: RingScore; size: number }) {
  const width = size > 80 ? 7 : 6
  const radius = size / 2 - width / 2 - 1
  const length = 2 * Math.PI * radius
  return (
    <span className={`rp-gauge rp-${ring.band}`} style={{ width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true">
        <circle className="rp-gauge-track" cx={size / 2} cy={size / 2} r={radius} strokeWidth={width} />
        <circle
          className="rp-gauge-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeWidth={width}
          strokeDasharray={`${(length * ring.score) / 100} ${length}`}
        />
      </svg>
      <span className="rp-gauge-num" style={{ fontSize: size > 80 ? 26 : 22 }}>
        {ring.score}
      </span>
    </span>
  )
}

function smooth(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

/** Раздел, пока читается в первый раз: строка расписания и кольца полосами. */
function ReportsSkeleton({ shown }: { shown: boolean }) {
  return (
    <Skeleton label="Загрузка отчётов" shown={shown}>
      <div className="rp-sched">
        <Sk w={140} h={20} />
        <Sk w={240} h={28} />
      </div>
      <SkeletonRings />
    </Skeleton>
  )
}

/** Первый разбор идёт: на месте отчёта — его форма полосами. */
function ReportSkeleton() {
  return (
    <div aria-hidden="true">
      <SkeletonRings />
      <div className="rp-order">
        <Sk w={220} h={30} />
      </div>
      <div className="rp-list">
        <div className="rp-group">
          <Sk w={140} />
          <div className="rp-items">
            {[320, 260, 380, 290].map((width) => (
              <div key={width} className="rp-skeleton-row">
                <Sk w={76} h={20} />
                <Sk w={width} />
                <Sk w={28} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function SkeletonRings() {
  return (
    <div className="rp-rings">
      {[0, 1, 2, 3, 4].map((i) => (
        <Fragment key={i}>
          <div className="rp-skeleton-ring">
            <Sk w={72} h={72} className="sk-round" />
            <Sk w={84} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

export function ReportIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <path d="M8 18v-3M12 18v-6M16 18v-4" />
    </svg>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="6 4 20 12 6 20 6 4" />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg className="rp-chevron" viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="9 6 15 12 9 18" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
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

function RewriteIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="2.5" width="16" height="6" rx="1.5" />
      <rect x="4" y="15.5" width="16" height="6" rx="1.5" />
      <path d="M12 8.5v7" />
      <path d="M9.5 13l2.5 2.5 2.5-2.5" />
    </svg>
  )
}

import { useCallback, useEffect, useState } from 'react'
import { plural } from './plural'
import './Usage.css'

/** Окно лимита: свой счёт панели по журналам и процент лимита из учётной записи. */
export type UsageWindow = {
  since: string
  tokens: number
  answers: number
  /** null — проценты получить не удалось; счёт токенов при этом остаётся. */
  percent: number | null
  resetsAt: string | null
}

/** Последние сутки: процента за сутки Anthropic не даёт, поэтому percent — оценка. */
export type UsageDay = {
  since: string
  tokens: number
  answers: number
  /** Оценка из процента недели по расходу с её сброса; null — процента недели нет. */
  percent: number | null
}

export type ModelUsage = {
  model: string
  answers: number
  tokens: number
  /** Во сколько раз модель тратит лимит быстрее Sonnet. */
  weight: number
  /** Доля израсходованного за неделю, от нуля до единицы. */
  share: number
}

export type UsageView = {
  fiveHours: UsageWindow
  week: UsageWindow
  day: UsageDay
  models: ModelUsage[]
  /** Почему нет процентов; null — проценты пришли. */
  limitsProblem: string | null
  fetchedAt: string
}

/**
 * Раздел «Расход»: сколько лимита подписки израсходовано. Проценты приходят из учётной записи
 * оператора, токены панель считает сама по журналам Claude Code на диске.
 */
export default function Usage() {
  const [view, setView] = useState<UsageView | null>(null)
  const [failed, setFailed] = useState(false)
  const [loading, setLoading] = useState(false)

  const load = useCallback(() => {
    fetch('/api/usage')
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json() as Promise<UsageView>
      })
      .then(
        (value) => {
          setView(value)
          setFailed(false)
          setLoading(false)
        },
        () => {
          setFailed(true)
          setLoading(false)
        },
      )
  }, [])

  // Раздел перечитывается при открытии и кнопкой: проценты меняются не быстрее работы агентов,
  // а за каждым обновлением стоит запрос к Anthropic — дёргать его по таймеру незачем.
  useEffect(() => {
    load()
  }, [load])

  return (
    <div className="usage">
      <div className="content-head">
        <h2>Расход</h2>
        <div className="head-end">
          <button
            type="button"
            className="usage-refresh"
            disabled={loading}
            onClick={() => {
              // Работу показывает только кнопка: при открытии раздела на её месте «Загрузка…»
              setLoading(true)
              load()
            }}
          >
            {loading ? 'Обновляется…' : 'Обновить'}
          </button>
        </div>
      </div>

      {failed && <p className="message warning-text">Нет связи с API</p>}
      {view === null && !failed && <p className="empty-message">Загрузка…</p>}

      {view && (
        <>
          {view.limitsProblem && (
            <p className="usage-failure">
              <b>Проценты лимита сейчас недоступны.</b> {view.limitsProblem} Панель спрашивает их тем же способом,
              что и Claude Code, а он у Anthropic не опубликован и может измениться. Свой счёт расхода ниже остался:
              он считается по журналам на диске. Точные проценты пока смотрите командой <code>/usage</code> в
              Claude Code.
            </p>
          )}

          <div className="usage-windows">
            <Window title="Пятичасовое окно" window={view.fiveHours} reset={formatTime} />
            <Window title="Недельное окно" window={view.week} reset={formatDateTime} />
            <Day day={view.day} week={view.week} now={view.fetchedAt} />
          </div>

          <p className="usage-source">
            Проценты — <b>из вашей учётной записи Anthropic</b>, те же, что показывает <code>/usage</code> в
            Claude Code; обновлены в {formatTime(view.fetchedAt)}. Ключ доступа берётся из профиля Claude Code
            только на время запроса: в браузер он не уходит и в журналы не пишется. Токены ниже панель считает
            сама, по журналам сессий на диске.
          </p>

          <section className="usage-card">
            <div className="usage-card-head">
              <h3>Кто съедает лимит</h3>
              <span className="sub">за неделю, по журналам</span>
            </div>
            {view.models.length === 0 ? (
              <p className="empty-message">За неделю агенты в этой машине не работали.</p>
            ) : (
              <div className="usage-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Модель</th>
                      <th className="num">Ответов</th>
                      <th className="num">Токенов</th>
                      <th className="num">Вес</th>
                      <th className="num">Доля израсходованного</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.models.map((model) => (
                      <tr key={model.model}>
                        <td className="mono">{model.model}</td>
                        <td className="num muted">{model.answers.toLocaleString('ru-RU')}</td>
                        <td className="num muted">{shortTokens(model.tokens)}</td>
                        <td className="num muted">×{formatWeight(model.weight)}</td>
                        <td className="num">
                          <span className="usage-share">
                            <span className="usage-share-bar">
                              <span style={{ width: `${Math.round(model.share * 100)}%` }} />
                            </span>
                            {formatShare(model.share)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function Window({
  title,
  window,
  reset,
}: {
  title: string
  window: UsageWindow
  reset: (iso: string) => string
}) {
  return (
    <section className={`usage-window ${window.percent === null ? 'failed' : ''}`}>
      <div className="usage-window-head">
        <h3>{title}</h3>
        <span className="usage-when">
          {window.resetsAt ? `сбросится ${reset(window.resetsAt)}` : 'лимит неизвестен'}
        </span>
      </div>
      <div className="usage-share-line">
        <span className="usage-percent">{window.percent === null ? '—' : `${window.percent}%`}</span>
        <span className="usage-of">лимита израсходовано</span>
      </div>
      <div className="usage-track">
        <div
          className={`usage-fill ${window.percent !== null && window.percent >= 70 ? 'warn' : ''}`}
          style={{ width: `${Math.min(100, window.percent ?? 0)}%` }}
        />
      </div>
      <div className="usage-window-foot">
        <span>
          панель насчитала <b>{shortTokens(window.tokens)} токенов</b>
        </span>
        <span>
          <b>{plural(window.answers, 'ответ', 'ответа', 'ответов')} агента</b>
        </span>
      </div>
    </section>
  )
}

/**
 * Последние сутки — карточка без полосы: у суток нет своего лимита, к которому её мерить.
 * Выбор оператора по макету B-131 против выделенного куска недельной полосы и строки под ней;
 * долю суток в недельном расходе он убрал на приёмке — подпись к ней не читалась без объяснения.
 */
function Day({ day, week, now }: { day: UsageDay; week: UsageWindow; now: string }) {
  const estimate =
    day.percent === null || week.percent === null
      ? undefined
      : `Оценка: часть расхода с последнего сброса недели, пришедшаяся на сутки, × ${week.percent}% лимита недели`
  return (
    <section className={`usage-window day ${day.percent === null ? 'failed' : ''}`}>
      <div className="usage-window-head">
        <h3>24 часа</h3>
        <span className="usage-when">{firstHour(day.since, now)}</span>
      </div>
      <div className="usage-share-line">
        <span className="usage-percent" title={estimate}>
          {day.percent === null ? '—' : `≈${formatShare(day.percent / 100)}`}
        </span>
        <span className="usage-of">лимита недели</span>
      </div>
      <div className="usage-window-foot">
        <span>
          <b>{shortTokens(day.tokens)} токенов</b>
        </span>
      </div>
    </section>
  )
}

/**
 * Расход лежит часовыми порциями, и порция, на которую край суток лёг серединой, не считается —
 * поэтому счёт идёт с первого целого часа после края.
 */
function firstHour(since: string, now: string) {
  const start = new Date(since)
  if (start.getUTCMinutes() || start.getUTCSeconds() || start.getUTCMilliseconds()) {
    start.setUTCMinutes(60, 0, 0)
  }
  const today = start.toDateString() === new Date(now).toDateString()
  return `с ${formatTime(start.toISOString())} ${today ? 'сегодня' : 'вчера'}`
}

/** Токенов бывают миллиарды, и в разделе важен порядок величины, а не единицы. */
function shortTokens(value: number) {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1).replace('.', ',')} млрд`
  if (value >= 1e6) return `${(value / 1e6).toFixed(1).replace('.', ',')} млн`
  if (value >= 1e3) return `${Math.round(value / 1e3)} тыс.`
  return String(value)
}

function formatWeight(weight: number) {
  return String(weight).replace('.', ',')
}

function formatShare(share: number) {
  const percent = share * 100
  return `${percent.toFixed(percent < 10 ? 1 : 0).replace('.', ',')}%`
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

function formatDateTime(iso: string) {
  const date = new Date(iso)
  return `${date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })} в ${formatTime(iso)}`
}

export function UsageIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
    </svg>
  )
}

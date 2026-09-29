import { useEffect, useRef, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Guide.css'
import { guidePages, guideText, guideTitle, pageLink } from './guidePages'

// Страница делится на заголовок с вводным абзацем и разделы второго уровня, а три раздела
// подаются по макету своим видом: действия в два столбца, частые случаи карточками, запреты списком.
const layouts: Record<string, string> = {
  'Что можно сделать': 'guide-acts',
  'Частые случаи': 'guide-cases',
  'Чего панель не даст сделать': 'guide-limits',
}

type Part = { title: string | null; body: string }

function splitPage(text: string): { title: string; lead: string; parts: Part[] } {
  const [head, ...sections] = text.split(/^## /m)
  const title = head.match(/^# (.+)$/m)?.[1].trim() ?? ''
  const lead = head.replace(/^# .+$/m, '').trim()
  const parts = sections.map((section) => {
    const newline = section.indexOf('\n')
    return { title: section.slice(0, newline).trim(), body: section.slice(newline + 1) }
  })
  return { title, lead, parts }
}

// Карточки частых случаев — подразделы третьего уровня, каждый своей рамкой.
function splitCases(body: string): string[] {
  return body.split(/^(?=### )/m).filter((card) => card.trim())
}

const statusClasses: Record<string, string> = {
  Свободна: 'status-free',
  Запускается: 'status-starting',
  'В работе': 'status-in-work',
  'Ждёт оператора': 'status-waiting',
  'Ответ не прочитан': 'status-unread',
}

const dotClasses: Record<string, string> = {
  зелёная: 'session-working',
  жёлтая: 'session-waiting',
  серая: 'session-idle',
  пустая: 'session-none',
}

const dotNames: Record<string, string> = {
  зелёная: 'Зелёная',
  жёлтая: 'Жёлтая',
  серая: 'Серая',
  пустая: 'Пустой кружок',
}

// Код в тексте руководства — название того, что оператор видит в панели, и рисуется так же,
// как в панели: кнопка — плашкой, статус — плашкой статуса, точка сессии — точкой.
function UiName({ text }: { text: string }): ReactNode {
  const [kind, value] = text.includes(': ') ? text.split(': ', 2) : [null, text]
  if (kind === 'статус' && statusClasses[value])
    return <span className={`status-badge ${statusClasses[value]}`}>{value}</span>
  if (kind === 'точка' && dotClasses[value])
    return (
      <span className="guide-dot">
        <span className={`session-dot ${dotClasses[value]}`} aria-hidden="true" />
        {dotNames[value]}
      </span>
    )
  if (kind === 'метка') return <span className="main-tag">{value}</span>
  if (text === '⋯')
    return (
      <span className="guide-menu" role="img" aria-label="меню">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.8" />
          <circle cx="12" cy="12" r="1.8" />
          <circle cx="19" cy="12" r="1.8" />
        </svg>
      </span>
    )
  if (text === 'Ответить') return <span className="guide-reply">{text}</span>
  return <span className="guide-ui">{text}</span>
}

const plugins = [remarkGfm]

function PageMarkdown({ text, onPage }: { text: string; onPage: (file: string) => void }) {
  const components: Components = {
    code: ({ children }) => <UiName text={String(children)} />,
    a: ({ href, children }) => {
      const file = pageLink(href)
      if (!file) return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
      return (
        <a
          href={`#${file}`}
          onClick={(event) => {
            event.preventDefault()
            onPage(file)
          }}
        >
          {children}
        </a>
      )
    },
    table: ({ children }) => <table className="guide-defs">{children}</table>,
  }
  return (
    <ReactMarkdown remarkPlugins={plugins} components={components}>
      {text}
    </ReactMarkdown>
  )
}

export default function Guide() {
  const [current, setCurrent] = useState(guidePages[0].file)
  const article = useRef<HTMLElement>(null)

  // Новая страница открывается с начала, а не с места, где читали прежнюю.
  useEffect(() => {
    article.current?.scrollTo?.({ top: 0 })
  }, [current])

  const index = guidePages.findIndex((page) => page.file === current)
  const page = guidePages[index]
  const previous = guidePages[index - 1]
  const next = guidePages[index + 1]
  const { title, lead, parts } = splitPage(guideText(current) ?? '')
  const groups = [...new Set(guidePages.map((p) => p.group))]

  return (
    <>
      <div className="content-head">
        <h2>Руководство</h2>
      </div>
      <div className="guide">
        <nav className="guide-toc" aria-label="Страницы руководства">
          {groups.map((group) => (
            <div key={group} className="guide-toc-group">
              <div className="guide-toc-title">{group}</div>
              {guidePages
                .filter((p) => p.group === group)
                .map((p) => (
                  <button
                    key={p.file}
                    type="button"
                    className={`guide-toc-item ${p.file === current ? 'active' : ''}`}
                    aria-current={p.file === current ? 'page' : undefined}
                    onClick={() => setCurrent(p.file)}
                  >
                    {guideTitle(p.file)}
                  </button>
                ))}
            </div>
          ))}
        </nav>
        <article className="guide-page" ref={article}>
          <section>
            <p className="guide-eyebrow">{page.group === 'Разделы' ? 'Раздел панели' : page.group}</p>
            <h1>{title}</h1>
            <div className="guide-lead">
              <PageMarkdown text={lead} onPage={setCurrent} />
            </div>
          </section>
          {parts.map((part) => (
            <section key={part.title} className={layouts[part.title ?? ''] ?? undefined}>
              <h2>{part.title}</h2>
              {part.title === 'Частые случаи' ? (
                <div className="guide-cards">
                  {splitCases(part.body).map((card) => (
                    <div key={card} className="guide-card">
                      <PageMarkdown text={card} onPage={setCurrent} />
                    </div>
                  ))}
                </div>
              ) : (
                <PageMarkdown text={part.body} onPage={setCurrent} />
              )}
            </section>
          ))}
          <nav className="guide-pager" aria-label="Соседние страницы">
            {previous && (
              <button type="button" onClick={() => setCurrent(previous.file)}>
                <span className="guide-pager-dir">← Назад</span>
                <span className="guide-pager-name">{guideTitle(previous.file)}</span>
              </button>
            )}
            {next && (
              <button type="button" className="guide-pager-next" onClick={() => setCurrent(next.file)}>
                <span className="guide-pager-dir">Дальше →</span>
                <span className="guide-pager-name">{guideTitle(next.file)}</span>
              </button>
            )}
          </nav>
        </article>
      </div>
    </>
  )
}

import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './Markdown.css'

// Сырой HTML из текстов памяти не рендерится: react-markdown без rehype-raw показывает его текстом.
// GFM делает голые адреса ссылками и показывает таблицы, зачёркивание и списки с галочками.
const plugins = [remarkGfm]

// Ссылка открывается в новой вкладке: панель с окном и набранным ответом остаётся на месте.
const link: Components['a'] = ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noopener noreferrer" />

type Props = { text: string; className?: string }

// Внутри кнопки ссылка не нажимается отдельно: адрес остаётся текстом.
const plainLink: Components['a'] = ({ children }) => <>{children}</>

const block: Components = { a: link }

/** Абзацы, списки и код текста агента — блоком. */
export function Markdown({ text, className }: Props) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <ReactMarkdown remarkPlugins={plugins} components={block}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

// Заголовок — одна строка: абзац markdown не заворачивается в <p>, блочное в заголовке не ожидается.
const inline: Components = { p: ({ children }) => <>{children}</>, a: link }
const inlinePlain: Components = { ...inline, a: plainLink }

// Номер критерия «1. » и дефис в начале заголовка — часть текста: экранируются, чтобы markdown
// не принял их за список и не съел номер.
const escapeLeadingMarker = (text: string) => text.replace(/^(\s*)(\d+[.)]|[-+*])(\s)/, (_, indent, marker, space) =>
  `${indent}${marker.slice(0, -1)}\\${marker.at(-1)}${space}`,
)

/** Разметка внутри строки — для заголовков, где блочная вёрстка не нужна. `plainLinks` — для текста внутри кнопки. */
export function InlineMarkdown({ text, className, plainLinks = false }: Props & { plainLinks?: boolean }) {
  return (
    <span className={className ? `markdown-inline ${className}` : 'markdown-inline'}>
      <ReactMarkdown remarkPlugins={plugins} components={plainLinks ? inlinePlain : inline}>
        {escapeLeadingMarker(text)}
      </ReactMarkdown>
    </span>
  )
}

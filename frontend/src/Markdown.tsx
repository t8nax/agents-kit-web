import ReactMarkdown, { type Components } from 'react-markdown'
import './Markdown.css'

// Сырой HTML из текстов памяти не рендерится: react-markdown без rehype-raw показывает его текстом.

type Props = { text: string; className?: string }

/** Абзацы, списки и код текста агента — блоком. */
export function Markdown({ text, className }: Props) {
  return (
    <div className={className ? `markdown ${className}` : 'markdown'}>
      <ReactMarkdown>{text}</ReactMarkdown>
    </div>
  )
}

// Заголовок — одна строка: абзац markdown не заворачивается в <p>, блочное в заголовке не ожидается.
const inline: Components = { p: ({ children }) => <>{children}</> }

// Номер критерия «1. » и дефис в начале заголовка — часть текста: экранируются, чтобы markdown
// не принял их за список и не съел номер.
const escapeLeadingMarker = (text: string) => text.replace(/^(\s*)(\d+[.)]|[-+*])(\s)/, (_, indent, marker, space) =>
  `${indent}${marker.slice(0, -1)}\\${marker.at(-1)}${space}`,
)

/** Разметка внутри строки — для заголовков, где блочная вёрстка не нужна. */
export function InlineMarkdown({ text, className }: Props) {
  return (
    <span className={className ? `markdown-inline ${className}` : 'markdown-inline'}>
      <ReactMarkdown components={inline}>{escapeLeadingMarker(text)}</ReactMarkdown>
    </span>
  )
}

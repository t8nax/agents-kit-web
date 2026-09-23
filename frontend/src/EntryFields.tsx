import type { BacklogEntry } from './Backlog'

// Значения полей задаёт кит; своё значение панель не судит, а показывает плашкой без цвета.
const PRIORITY_CLASS: Record<string, string> = {
  низкий: 'entry-prio-low',
  средний: 'entry-prio-mid',
  высокий: 'entry-prio-high',
  блокер: 'entry-prio-blocker',
}

const TYPE_CLASS: Record<string, string> = { баг: 'entry-type-bug', фича: 'entry-type-feature' }

/** Тип и приоритет записи: тип — значок со словом, приоритет — плашка, цвет которой растёт со срочностью. */
export function EntryFields({ entry }: { entry: BacklogEntry }) {
  return (
    <>
      {/* Пробелы не видны во flex-строке, но разделяют плашки в имени кнопки записи */}
      {entry.type && (
        <span className={`entry-type ${TYPE_CLASS[entry.type] ?? ''}`}>
          {entry.type === 'фича' ? <FeatureIcon /> : <BugIcon />}
          {entry.type}
        </span>
      )}{' '}
      {entry.priority && (
        <span className={`entry-prio ${PRIORITY_CLASS[entry.priority] ?? ''}`}>{entry.priority}</span>
      )}
    </>
  )
}

export function BugIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <line x1="12" y1="8" x2="12" y2="13" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  )
}

export function FeatureIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l2.2 5.6L20 11l-5.8 2.4L12 19l-2.2-5.6L4 11l5.8-2.4z" />
    </svg>
  )
}

import './NewerFormat.css'

/**
 * Причина закрытой правки базы нового формата кита — та же, что в отказе сервера (BaseLayout.NewerFormatRefusal):
 * панель её читает, а флоу, исполнителей и бэклог в неё не пишет, пока не узнает формат (B-281).
 */
export const NEWER_FORMAT_REASON = 'кит перевёл базу на формат, которого эта версия панели не знает.'

/** Подсказка у погашенной правки такой базы. */
export const NEWER_FORMAT_REFUSAL = `Правка закрыта: ${NEWER_FORMAT_REASON}`

/**
 * Плашка о базе нового формата — под выбором проекта в «Исполнителях», под заголовком проекта в «Бэклоге» и под шапкой
 * окна Чудо-Юдо. Вид плашки о ките, но свои стили: разделы, где она стоит, не подключают ради неё стили «Проблем баз»
 * (ревью B-281).
 */
export function FormatNotice({ text }: { text: string }) {
  return (
    <div className="format-notice" role="status">
      <FormatIcon />
      <span className="format-notice-text">{text}</span>
    </div>
  )
}

/** Значок предупреждения о формате — тот же треугольник, что у прочих предупреждений панели. */
export function FormatIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

/** Значок терминала: им помечены и пункт меню строки, и кнопка перехода в окне ответа. */
export function TerminalIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 9 12 6 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </svg>
  )
}

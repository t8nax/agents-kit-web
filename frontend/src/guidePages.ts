// Страницы руководства — markdown-файлы в guide/: их же читает Чудо-Юдо, когда оператор спрашивает о панели.
const files = import.meta.glob('./guide/*.md', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>

export type GuidePage = { file: string; group: string }

/** Оглавление в порядке чтения: «Начало», затем разделы в порядке полосы разделов. */
export const guidePages: GuidePage[] = [
  { file: 'start.md', group: 'Начало' },
  { file: 'header.md', group: 'Начало' },
  { file: 'workspaces.md', group: 'Разделы' },
  { file: 'backlog.md', group: 'Разделы' },
  { file: 'flow.md', group: 'Разделы' },
  { file: 'performers.md', group: 'Разделы' },
  { file: 'sessions.md', group: 'Разделы' },
  { file: 'usage.md', group: 'Разделы' },
  { file: 'reports.md', group: 'Разделы' },
  { file: 'problems.md', group: 'Разделы' },
  { file: 'trackers.md', group: 'Разделы' },
  { file: 'settings.md', group: 'Разделы' },
]

/** Все файлы каталога guide/ — и те, которых нет в оглавлении. */
export const guideFiles = () => Object.keys(files).map((path) => path.slice('./guide/'.length))

export const guideText = (file: string): string | undefined => files[`./guide/${file}`]

// Название страницы — её заголовок первого уровня: оглавление не держит второй копии названий.
export const guideTitle = (file: string) => guideText(file)?.match(/^# (.+)$/m)?.[1].trim() ?? file

// Ссылка на другую страницу руководства — имя её файла, как на диске: так её понимает и Чудо-Юдо.
export const pageLink = (href: string | undefined) => (href && /^[a-z-]+\.md$/.test(href) ? href : null)

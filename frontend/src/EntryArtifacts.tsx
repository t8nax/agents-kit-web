import { useState } from 'react'
import './EntryArtifacts.css'
import { InlineMarkdown } from './Markdown'
import { WarningIcon } from './Problems'

/** Строка «Артефактов» памяти задачи или записи бэклога: подпись и адрес — ссылка на сайт или путь к файлу. */
export type Artifact = { label: string; address: string }

/** Адрес — ссылка на сайт: её открывает браузер, а файл — панель, в VS Code. */
const isLink = (address: string) => /^https?:\/\//i.test(address)

/**
 * Артефакты записи бэклога блоком под её описанием — как вкладка «Артефакты» окна ответа (макет B-260): подпись,
 * под ней адрес. Файл из artifacts/ базы открывается в VS Code; у записи без номера адресовать его нечем, и путь
 * остаётся строкой. `compact` — тот же блок плотнее, внутри карточки записи в окне Чудо-Юдо.
 */
export default function EntryArtifacts({
  base,
  number,
  artifacts,
  compact = false,
}: {
  base: string
  number: string | null
  artifacts: Artifact[]
  compact?: boolean
}) {
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function open(index: number, address: string) {
    setOpening(true)
    setError(null)
    try {
      const response = await fetch('/api/backlog/artifact/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base, number, index, address }),
      })
      if (response.ok) return
      const problem = await response
        .json()
        .then((body: { problem?: string }) => body.problem ?? null)
        .catch(() => null)
      setError(
        problem === 'missing'
          ? `Файла нет в базе: ${address}`
          : response.status === 404
            ? 'Файл не открыт: артефакта нет в записи'
            : problem === 'unsafe-path'
              ? `Файл не открыт: у записи файл только в artifacts/ базы — ${address}`
              : 'Не удалось открыть файл в VS Code',
      )
    } catch {
      setError('Не удалось открыть файл в VS Code: нет связи с API')
    } finally {
      setOpening(false)
    }
  }

  return (
    <section className={`entry-artifacts ${compact ? 'is-compact' : ''}`} aria-label="Артефакты">
      <div className="entry-artifacts-label">Артефакты</div>
      <ul>
        {artifacts.map((artifact, i) => (
          <li key={i}>
            <div className="entry-artifact-label">
              <InlineMarkdown text={artifact.label} />
            </div>
            {isLink(artifact.address) ? (
              <a className="entry-artifact-address" href={artifact.address} target="_blank" rel="noopener noreferrer">
                {artifact.address}
              </a>
            ) : number ? (
              <button
                type="button"
                className="entry-artifact-address is-file"
                title="Открыть в VS Code"
                disabled={opening}
                onClick={() => void open(i, artifact.address)}
              >
                {artifact.address}
              </button>
            ) : (
              <span className="entry-artifact-address">{artifact.address}</span>
            )}
          </li>
        ))}
      </ul>
      {error && (
        <p className="entry-artifacts-error" role="alert">
          <WarningIcon />
          {error}
        </p>
      )}
    </section>
  )
}

import { useRef } from 'react'
import './Attachments.css'
import { fileName, formatSize, isImage, type Attachment } from './attachFiles'
import { WarningIcon } from './Problems'

export function ClipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  )
}

/** Кнопка со словом и скрытый выбор файлов: вставку картинки из буфера ловит само поле (макет B-260, вариант Б). */
export function AttachButton({
  label,
  disabled,
  onFiles,
}: {
  label: string
  disabled?: boolean
  onFiles: (files: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label={label}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          // Тот же файл можно выбрать снова, только если поле забыло прежний выбор.
          e.target.value = ''
          if (files.length > 0) onFiles(files)
        }}
      />
      <button
        type="button"
        className="btn composer-send attach-button"
        title="Приложить файл или вставить картинку Ctrl+V"
        disabled={disabled}
        onClick={() => input.current?.click()}
      >
        <ClipIcon />
        {label}
      </button>
    </>
  )
}

function Thumb({ name, preview }: { name: string; preview: string | null }) {
  if (preview) {
    return (
      <span className="att-thumb">
        <img src={preview} alt="" />
      </span>
    )
  }
  const extension = name.includes('.') ? name.split('.').pop()!.slice(0, 4) : ''
  return <span className="att-thumb is-file">{extension || 'файл'}</span>
}

/** Приложенное до отправки — плитками над полем; крестик в углу снимает файл. */
export function AttachmentTiles({ items, onRemove }: { items: Attachment[]; onRemove: (id: number) => void }) {
  if (items.length === 0) return null
  return (
    <ul className="att-list" aria-label="Приложенные файлы">
      {items.map((item) => (
        <li className="att-tile" key={item.id}>
          <Thumb name={item.name} preview={item.preview} />
          <span className="att-meta">
            <span className="att-name" title={item.name}>
              {item.name}
            </span>
            <span className="att-size">{formatSize(item.size)}</span>
          </span>
          <button
            type="button"
            className="att-remove"
            aria-label={`Убрать ${item.name}`}
            title="Убрать"
            onClick={() => onRemove(item.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </li>
      ))}
    </ul>
  )
}

/** Строка отказа под приложенным: файл крупнее 5 МБ или не прочитан. */
export function AttachError({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p className="att-error" role="alert">
      <WarningIcon />
      {text}
    </p>
  )
}

/**
 * Приложенное к реплике в ленте: адреса artifacts/ из переписки. Картинку, чья миниатюра ещё есть в окне, видно
 * картинкой, прочий файл — плиткой; на приложенное в ленте не нажимают (макет B-260).
 */
export function SentFiles({ files, previews }: { files: string[]; previews?: Map<string, string> }) {
  if (files.length === 0) return null
  return (
    <div className="att-list att-sent" aria-label="Приложено">
      {files.map((address) => {
        const name = fileName(address)
        const preview = isImage(name) ? (previews?.get(address) ?? null) : null
        return preview ? (
          <div className="att-shot" key={address}>
            <img src={preview} alt={name} />
            <span className="att-name">{name}</span>
          </div>
        ) : (
          <span className="att-tile" key={address}>
            <Thumb name={name} preview={null} />
            <span className="att-meta">
              <span className="att-name" title={address}>
                {name}
              </span>
            </span>
          </span>
        )
      })}
    </div>
  )
}

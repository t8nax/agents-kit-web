import { useCallback, useEffect, useRef, useState, type ClipboardEvent } from 'react'

/** Потолок артефакта по раскладке кита: крупнее файл в базу не кладётся. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024

/** Приложенный файл до отправки: preview — адрес картинки для миниатюры, у прочих файлов его нет. */
export type Attachment = { id: number; name: string; size: number; data: string; preview: string | null }

/** Отправленный файл в ленте: миниатюра и размер, пока окно их помнит; адрес — ключ, под которым он лёг в базу. */
export type SentFile = { preview: string | null; size: number }

/** Адрес миниатюры больше не нужен: память вкладки его отпускает. */
export function revokePreview(item: { preview: string | null }) {
  if (item.preview && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(item.preview)
}

/** Миниатюры окна живут, пока открыто окно: закрытое отпускает все, что завело. */
export function useRevokeOnClose(items: () => { preview: string | null }[]) {
  const latest = useRef(items)
  useEffect(() => {
    latest.current = items
  })
  useEffect(() => () => latest.current().forEach(revokePreview), [])
}

/** Файл, каким его принимает API: имя и содержимое в base64. */
export type AttachedFile = { name: string; data: string }

/** «12,4 МБ», «312 КБ», «900 Б» — размер у плитки и в строке отказа. */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} КБ`
  return `${bytes} Б`
}

/** Снимок из буфера безымянный: он получает имя по дате и времени вставки (макет B-260). */
export function pastedName(type: string, now = new Date()): string {
  const two = (n: number) => String(n).padStart(2, '0')
  const extension = type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
  return `снимок-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}.${extension}`
}

export const tooLargeText = (name: string, size: number) =>
  `Файл не приложен: ${name} весит ${formatSize(size)}, а принимается до 5 МБ`

/** Имя файла из адреса artifacts/<имя>. */
export const fileName = (address: string) => address.split('/').pop() ?? address

export const isImage = (name: string) => /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(name)

function readData(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function previewOf(file: File): string | null {
  // В тестах jsdom адресов для файлов не заводит: без миниатюры плитка показывает значок файла.
  return file.type.startsWith('image/') && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null
}

let nextId = 1

/** Имя вставленного из буфера: у безымянного снимка браузер пишет image.png — ему имя по дате. */
export const pastedFileName = (file: File) => (file.name && file.name !== 'image.png' ? file.name : pastedName(file.type))

/** Картинки из буфера вставки; нет их — вставляется текст, как обычно. */
export const pastedFiles = (event: ClipboardEvent) => Array.from(event.clipboardData?.files ?? [])

/**
 * Файлы с диска или из буфера — в приложенное: крупнее 5 МБ не прикладывается, error говорит, какой и почему.
 */
export async function readAttachments(
  files: File[],
  name: (file: File) => string = (file) => file.name,
): Promise<{ read: Attachment[]; error: string | null }> {
  let error: string | null = null
  const read: Attachment[] = []
  for (const file of files) {
    const own = name(file)
    if (file.size > MAX_ATTACHMENT_BYTES) {
      error = tooLargeText(own, file.size)
      continue
    }
    try {
      read.push({ id: nextId++, name: own, size: file.size, data: await readData(file), preview: previewOf(file) })
    } catch {
      error = `Файл не приложен: ${own} не прочитан`
    }
  }
  return { read, error }
}

/**
 * Файлы, приложенные к реплике: выбранные с диска и вставленные из буфера. Крупнее 5 МБ не прикладывается —
 * error говорит, какой и почему; снимает его следующее приложение или отправка.
 */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([])
  const [error, setError] = useState<string | null>(null)
  // Все миниатюры, заведённые окном: отправленные остаются в ленте до закрытия окна.
  const made = useRef<Attachment[]>([])
  useRevokeOnClose(() => made.current)

  const add = useCallback(async (files: File[], name?: (file: File) => string) => {
    setError(null)
    const { read, error } = await readAttachments(files, name)
    setError(error)
    made.current.push(...read)
    if (read.length > 0) setItems((list) => [...list, ...read])
  }, [])

  const remove = useCallback((id: number) => {
    setItems((list) => {
      list.filter((item) => item.id === id).forEach(revokePreview)
      return list.filter((item) => item.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setItems([])
    setError(null)
  }, [])

  /** Вставка в поле: картинка из буфера прикладывается, текст вставляется как обычно. */
  const onPaste = useCallback(
    (event: ClipboardEvent) => {
      const files = pastedFiles(event)
      if (files.length === 0) return
      event.preventDefault()
      void add(files, pastedFileName)
    },
    [add],
  )

  return { items, error, add, remove, clear, onPaste }
}

/** Приложенное — в тело запроса: без него поле files не уходит вовсе. */
export const payload = (items: Attachment[]): AttachedFile[] | undefined =>
  items.length > 0 ? items.map(({ name, data }) => ({ name, data })) : undefined

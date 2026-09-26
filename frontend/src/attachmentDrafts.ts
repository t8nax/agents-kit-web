// Файлы, приложенные к ответу, но не отправленные, живут в браузере оператора, как черновик текста (answerDrafts.ts):
// закрытое окно их не теряет — замечание оператора на приёмке B-260. Файлы до 5 МБ в localStorage не помещаются,
// поэтому они лежат в IndexedDB. Нет её — окно работает, как без черновиков.
import { restoreAttachment, type Attachment, type StoredAttachment } from './attachFiles'

type Drafts = Record<string, StoredAttachment[]>

const DB = 'agents-kit-web'
const STORE = 'attachment-drafts'

const draftsKey = (base: string, copy: string) => `${base}|${copy}`

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function read(key: string): Promise<Drafts> {
  const db = await open()
  if (!db) return {}
  return new Promise((resolve) => {
    try {
      const request = db.transaction(STORE).objectStore(STORE).get(key)
      request.onsuccess = () => resolve((request.result as Drafts | undefined) ?? {})
      request.onerror = () => resolve({})
    } catch {
      resolve({})
    }
  }).finally(() => db.close()) as Promise<Drafts>
}

async function write(key: string, drafts: Drafts): Promise<void> {
  const db = await open()
  if (!db) return
  await new Promise<void>((resolve) => {
    try {
      const transaction = db.transaction(STORE, 'readwrite')
      const store = transaction.objectStore(STORE)
      if (Object.keys(drafts).length === 0) store.delete(key)
      else store.put(drafts, key)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => resolve()
    } catch {
      resolve()
    }
  })
  db.close()
}

// Черновики к вопросам, которых в памяти уже нет или на которые ответили, не возвращаются и забываются.
export async function takeAttachmentDrafts(base: string, copy: string, titles: string[]): Promise<Attachment[][]> {
  const key = draftsKey(base, copy)
  const stored = await read(key)
  const kept: Drafts = {}
  for (const title of titles) if (stored[title]?.length) kept[title] = stored[title]
  if (Object.keys(kept).length !== Object.keys(stored).length) await write(key, kept)
  return titles.map((title) => (kept[title] ?? []).map(restoreAttachment))
}

export async function saveAttachmentDraft(base: string, copy: string, title: string, files: Attachment[]) {
  const key = draftsKey(base, copy)
  const drafts = await read(key)
  if (files.length === 0) delete drafts[title]
  else drafts[title] = files.map(({ name, size, data, type }) => ({ name, size, data, type }))
  await write(key, drafts)
}

export async function forgetAttachmentDrafts(base: string, copy: string, titles: string[]) {
  const key = draftsKey(base, copy)
  const drafts = await read(key)
  for (const title of titles) delete drafts[title]
  await write(key, drafts)
}

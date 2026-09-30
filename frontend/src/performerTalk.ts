/** Поля исполнителя, как их видит окно и предлагает Чудо-Юдо. */
export type DraftFields = {
  name: string | null
  description: string | null
  model: string | null
  tools: string | null
  prompt: string
}

export type DraftField = 'name' | 'description' | 'model' | 'tools' | 'prompt'

/**
 * Событие переписки об исполнителе — как у переписки о трекере: у ответа proposal — исполнитель целиком, до которого
 * договорились, changed — какие поля тронул он сам; у ответа-вопроса их нет.
 */
export type DraftEvent =
  | { type: 'reply'; text: string }
  | { type: 'step'; text: string }
  | { type: 'note'; text: string }
  | { type: 'rework'; text: string }
  | { type: 'stopped'; text: string }
  | { type: 'answer'; text: string; durationMs?: number; proposal?: DraftFields | null; changed?: DraftField[] | null }
  | { type: 'error'; text: string; output?: string }

/** Чья переписка идёт в панели: проект и имя переписываемого; null — заводится новый. */
export type TalkOwner = { base: string; subject: string | null }

/**
 * Переписка чужая окну: о другом проекте или о другом исполнителе. Окно её не подхватывает, а предупреждает, что
 * первая реплика её уберёт, — иначе ответ, написанный для нового исполнителя одного проекта, лёг бы в окно нового
 * исполнителя другого, и «Сохранить» записал бы его не туда (B-193).
 */
export function foreignTalk(talk: TalkOwner | null, mine: TalkOwner) {
  return talk !== null && (talk.base !== mine.base || (talk.subject ?? null) !== mine.subject)
}

const labels: Record<DraftField, string> = {
  name: 'имя',
  description: 'описание',
  model: 'модель',
  tools: 'инструменты',
  prompt: 'задание',
}

/**
 * Строка «В изменениях: …» под ответом. Модель и инструменты, выбранные оператором вручную, ответ не меняет, и их
 * в ней нет; имя заведённого не меняется вовсе.
 */
export function changedText(changed: DraftField[] | null | undefined, kept: { model: boolean; tools: boolean; name: boolean }) {
  return (changed ?? [])
    .filter((field) => !(field === 'model' && kept.model) && !(field === 'tools' && kept.tools) && !(field === 'name' && kept.name))
    .map((field) => labels[field])
    .join(', ')
}

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import './Modal.css'
import './AskModal.css'
import './Backlog.css'
import './PerformerModal.css'
import './ReplyModal.css'
import './Flow.css'
import { AGENT_NAME } from './BacklogWriteModal'
import FlowRewriteModal, { RewriteIcon } from './FlowRewriteModal'
import type { RewrittenStage } from './flowChanges'
import './Tabs.css'
import { Markdown } from './Markdown'
import type { BasePerformers } from './Performers'
import { plural } from './plural'
import RowMenu from './RowMenu'
import { Sk, Skeleton } from './Skeleton'
import { useReveal, withReveal } from './reveal'
import { VsCodeIcon } from './VsCodeIcon'

/**
 * Стадия флоу — файл flow/stages/ базы, один на все флоу, где она стоит. slug — имя файла; у стадии,
 * заведённой в панели и ещё не записанной, его нет.
 */
export type FlowStage = {
  title: string
  executor: string
  output: string
  skip: string | null
  /** Описание стадии как в файле: правится текстом в окне описания. */
  description: string | null
  /** Помощники: исполнители, которых оркестратор зовёт внутри своей стадии. */
  helpers?: string[]
  slug?: string | null
}

/** Возврат стадии во флоу: при condition работа идёт заново к стадии stage, стоящей в этом флоу раньше. */
export type StageReturn = { condition: string; stage: string }

/** Пункт флоу: стадия по названию и её возвраты — у той же стадии в другом флоу они свои. */
export type FlowEntry = { stage: string; returns?: StageReturn[] }

export type NamedFlow = { name: string; when: string | null; entries: FlowEntry[] }

export type BaseFlow = {
  base: string
  project: string
  stages: FlowStage[]
  flows: NamedFlow[]
  activeTasks: number
  version: string | null
  error: string | null
  /** Значки стадий, выбранные оператором: название стадии — значок. Их помнит панель, а не база. */
  icons: Record<string, string>
  /**
   * Строки файлов флоу, которые панель не сохранит: «flow/flow.md, строка 7: «…»». Пока они есть, флоу не
   * пишется — запись стёрла бы их из базы; правят их руками.
   */
  unread?: string[]
}

type Load =
  | { kind: 'loading' }
  | { kind: 'failed'; message: string }
  | { kind: 'loaded'; flows: BaseFlow[] }

// Стадия в форме: key держит её, пока правится название, исполнитель разложен на выбор и имя субагента.
type DraftStage = {
  key: number
  slug: string | null
  title: string
  kind: 'оркестратор' | 'оператор' | 'субагент'
  agent: string
  output: string
  skip: string
  description: string | null
  icon: string
  helpers: string[]
}

// Пункты и возвраты ссылаются на стадию её key: переименование стадии не рвёт их. stage === null —
// пункт ведёт на стадию, которой в базе нет, и title хранит, как он назван в файле.
type DraftReturn = { condition: string; target: number | null }
type DraftEntry = { key: number; stage: number | null; title: string; returns: DraftReturn[] }
type DraftFlow = { key: number; name: string; when: string; entries: DraftEntry[] }
type Draft = { stages: DraftStage[]; flows: DraftFlow[] }

type Tab = 'stages' | 'flow'
// Что открыто на вкладке «Сценарии»: окно возвратов стадии — по key пункта, а не месту, место меняется
// перетаскиванием, — или сайдбар сценария.
type Opened = { kind: 'returns'; key: number } | { kind: 'flow' } | null
// Куда вернуть фокус на схеме: блок пункта по key, а null — «Добавить стадию», когда блока уже нет.
type Focus = { key: number | null } | null

type Notice = { kind: 'done' | 'error'; text: string } | null

const kinds: DraftStage['kind'][] = ['оркестратор', 'оператор', 'субагент']

let nextKey = 1

/** Название стадии и имя флоу как адрес — как у сверки кита: подряд идущие пробелы — один, регистр не важен. */
const norm = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase()

function stageDraft(stage: FlowStage, icon = ''): DraftStage {
  const executor = stage.executor.trim()
  const known = executor === 'оркестратор' || executor === 'оператор'
  return {
    key: nextKey++,
    slug: stage.slug ?? null,
    title: stage.title,
    kind: known ? executor : 'субагент',
    agent: known ? '' : executor,
    output: stage.output,
    skip: stage.skip ?? '',
    description: stage.description,
    icon,
    helpers: stage.helpers ?? [],
  }
}

function toDraft(flow: BaseFlow): Draft {
  const stages = flow.stages.map((stage) => stageDraft(stage, flow.icons?.[stage.title] ?? ''))
  const keyOf = (title: string) => stages.find((stage) => norm(stage.title) === norm(title))?.key ?? null
  return {
    stages,
    flows: flow.flows.map((f) => ({
      key: nextKey++,
      name: f.name,
      when: f.when ?? '',
      entries: f.entries.map((entry) => ({
        key: nextKey++,
        stage: keyOf(entry.stage),
        title: entry.stage,
        returns: (entry.returns ?? []).map((back) => ({ condition: back.condition, target: keyOf(back.stage) })),
      })),
    })),
  }
}

function toStage(draft: DraftStage): FlowStage {
  return {
    title: draft.title.trim(),
    executor: draft.kind === 'субагент' ? draft.agent.trim() : draft.kind,
    output: draft.output.trim(),
    skip: draft.skip.trim() || null,
    description: draft.description,
    // Помощников зовёт только оркестратор: у стадии оператора и у стадии субагента их в файле не бывает.
    helpers: draft.kind === 'оркестратор' ? draft.helpers.map((name) => name.trim()).filter(Boolean) : [],
    slug: draft.slug,
  }
}

/** Стадии и флоу так, как их запишет API. */
function toApi(draft: Draft): { stages: FlowStage[]; flows: NamedFlow[] } {
  const titleOf = (key: number | null) => draft.stages.find((stage) => stage.key === key)?.title.trim() ?? ''
  return {
    stages: draft.stages.map(toStage),
    flows: draft.flows.map((f) => ({
      name: f.name.trim(),
      when: f.when.trim() || null,
      entries: f.entries.map((entry) => ({
        stage: entry.stage === null ? entry.title : titleOf(entry.stage),
        returns: entry.returns.map((back) => ({ condition: back.condition.trim(), stage: titleOf(back.target) })),
      })),
    })),
  }
}

/** Значки стадий для записи: название стадии — значок. Стадия без своего значка в запись не идёт. */
function toIcons(draft: Draft): Record<string, string> {
  const icons: Record<string, string> = {}
  for (const stage of draft.stages) {
    const title = stage.title.trim()
    if (title && stage.icon) icons[title] = stage.icon
  }
  return icons
}

/**
 * Стадия зовёт субагента, которого нет в базе проекта: пока имя пустое, это просто незаполненная стадия.
 * known === null — список исполнителей ещё не прочитан, и помечать нечего: иначе при открытии
 * раздела все стадии разом выглядели бы сломанными.
 */
const missingPerformer = (stage: DraftStage, known: string[] | null) =>
  known !== null && stage.kind === 'субагент' && stage.agent.trim().length > 0 && !known.includes(stage.agent.trim())

const breaks = (value: string) => /[\r\n]/.test(value)

/** Что мешает записать стадию в форме кита; пустой список — стадия годится. */
function stageErrors(stage: DraftStage, stages: DraftStage[], known: string[] | null) {
  const errors: string[] = []
  if (!stage.title.trim()) errors.push('нет названия')
  // Название стоит текстом ссылки во флоу и в кавычках возврата: скобки и кавычки его разорвут.
  else if (/[[\]«»]/.test(stage.title)) errors.push('в названии скобки [ ] или кавычки « »')
  else if (stages.some((other) => other.key !== stage.key && norm(other.title) === norm(stage.title)))
    errors.push('стадия с таким названием уже есть')
  if (stage.kind === 'субагент' && !stage.agent.trim()) errors.push('не указано имя субагента')
  // Исполнителя, которого нет в базе, агент не позовёт: с таким именем флоу не сохраняется.
  if (missingPerformer(stage, known)) errors.push('исполнителя нет в базе')
  // То же и с помощниками: их зовёт оркестратор внутри своей стадии, и незаведённого он не найдёт.
  if (stage.kind === 'оркестратор' && known !== null
      && stage.helpers.some((name) => name.trim() && !known.includes(name.trim())))
    errors.push('помощника нет в базе')
  if (!stage.output.trim()) errors.push('не указан выход')
  else if (breaks(stage.output.trim())) errors.push('выход — одна строка')
  return errors
}

/** Что мешает записать пункт флоу: возврат ведёт только к стадии, стоящей в этом флоу раньше. */
function entryErrors(flow: DraftFlow, index: number) {
  const entry = flow.entries[index]
  const errors: string[] = []
  if (entry.stage === null) errors.push('стадии нет в базе')
  else if (flow.entries.slice(0, index).some((other) => other.stage === entry.stage))
    errors.push('стадия уже стоит в этом флоу')
  for (const back of entry.returns) {
    if (!back.condition.trim()) errors.push('в возврате не указано условие')
    const target = flow.entries.findIndex((other) => back.target !== null && other.stage === back.target)
    if (target < 0) errors.push('возврат ведёт на стадию, которой во флоу нет')
    else if (target >= index) errors.push('возврат ведёт на стадию, которая стоит не раньше')
  }
  return errors
}

function flowErrors(flow: DraftFlow, flows: DraftFlow[]) {
  const errors: string[] = []
  if (!flow.name.trim()) errors.push('нет названия')
  else if (flows.some((other) => other.key !== flow.key && norm(other.name) === norm(flow.name)))
    errors.push('флоу с таким названием уже есть')
  // «Когда брать» кит требует, как только флоу больше одного: иначе не из чего выбрать.
  if (flows.length > 1 && !flow.when.trim()) errors.push('не указано «когда»')
  else if (breaks(flow.when.trim())) errors.push('«когда» — одна строка')
  if (flow.entries.length === 0) errors.push('во флоу нет стадий')
  return errors
}

const stageName = (stage: DraftStage) => stage.title.trim() || 'без названия'
const flowName = (flow: DraftFlow) => flow.name.trim() || 'без названия'

/** Первое, из-за чего правки не записать, — словами для полосы сохранения; null — всё годится. */
function firstProblem(draft: Draft, known: string[] | null): string | null {
  for (const stage of draft.stages) {
    const errors = stageErrors(stage, draft.stages, known)
    if (errors.length > 0) return `стадия «${stageName(stage)}» — ${errors.join(', ')}`
  }
  for (const flow of draft.flows) {
    const errors = flowErrors(flow, draft.flows)
    if (errors.length > 0) return `флоу «${flowName(flow)}» — ${errors.join(', ')}`
    for (let index = 0; index < flow.entries.length; index++) {
      const entryProblems = entryErrors(flow, index)
      if (entryProblems.length > 0)
        return `флоу «${flowName(flow)}», стадия «${entryTitle(draft, flow.entries[index])}» — ${entryProblems.join(', ')}`
    }
  }
  return null
}

const entryTitle = (draft: Draft, entry: DraftEntry) => {
  const stage = draft.stages.find((s) => s.key === entry.stage)
  return stage ? stageName(stage) : entry.title
}

/**
 * Стадии в порядке работы: как они идут во флоу базы — сначала первого, потом следующих, — а стоящие вне флоу
 * в конце. Файлы стадий лежат по слагам, и в этом порядке список читался бы вразброс.
 */
function stagesInOrder(draft: Draft): DraftStage[] {
  const keys: number[] = []
  for (const flow of draft.flows)
    for (const entry of flow.entries) if (entry.stage !== null && !keys.includes(entry.stage)) keys.push(entry.stage)
  const placed = keys.map((key) => draft.stages.find((stage) => stage.key === key)).filter((s): s is DraftStage => !!s)
  return [...placed, ...draft.stages.filter((stage) => !keys.includes(stage.key))]
}

const sameIcons = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

/** Имя, которого нет среди флоу: «новый флоу», «новый флоу 2»… */
function freeName(flows: DraftFlow[]) {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'новый сценарий' : `новый сценарий ${n}`
    if (!flows.some((flow) => norm(flow.name) === norm(name))) return name
  }
}

const emptyStage: FlowStage = { title: '', executor: 'оркестратор', output: '', skip: null, description: null }

const invalidLabels: Record<string, string> = {
  'stage-empty-title': 'у стадии нет названия',
  'stage-duplicate-title': 'две стадии с одним названием',
  'stage-bad-title': 'в названии стадии скобки [ ] или кавычки « »',
  'stage-empty-executor': 'у стадии не указан исполнитель',
  'stage-empty-output': 'у стадии не указан выход',
  'helpers-not-orchestrator': 'помощники не у оркестратора',
  'line-break': 'перевод строки в поле',
  'flow-empty-name': 'у флоу нет названия',
  'flow-duplicate-name': 'два флоу с одним названием',
  'flow-without-when': 'у флоу не указано «когда»',
  'flow-without-stages': 'во флоу нет стадий',
  'stage-unknown': 'стадии нет в базе',
  'stage-twice': 'стадия дважды в одном флоу',
  'return-without-condition': 'в возврате не указано условие',
  'return-unknown-stage': 'возврат ведёт на стадию, которой во флоу нет',
  'return-stage-not-earlier': 'возврат ведёт на стадию, которая стоит не раньше',
}

/**
 * baseFor — база просьбы агента, к которой вернулся оператор: раздел открывается сразу на ней.
 * onPerformers — переход в раздел «Исполнители»: оттуда заводят того, кого стадия не нашла.
 */
export default function Flow({
  baseFor = null,
  rewriteAt = null,
  onPerformers,
}: {
  baseFor?: string | null
  /**
   * Когда оператор щёлкнул отметку просьбы в шапке: поверх раздела — окно переписывания стадий. Раздел,
   * уже открытый, не пересоздаётся, а только открывает окно: несохранённые правки остаются на месте.
   */
  rewriteAt?: number | null
  onPerformers?: () => void
} = {}) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [selected, setSelected] = useState<string | null>(baseFor)
  // Заведённые в базах исполнители: из них стадии и выбирают субагента. null — ещё не прочитаны.
  const [performers, setPerformers] = useState<BasePerformers[] | null>(null)
  // Список не прочитан: стадии не метятся и запись не запирается, но сказать об этом оператору надо.
  const [performersFailed, setPerformersFailed] = useState(false)
  // Правки поверх прочитанного флоу: ключ — база и её отпечаток, поэтому правки чужого
  // или перечитанного флоу не всплывают.
  const [edits, setEdits] = useState<{ key: string; draft: Draft } | null>(null)
  const [tab, setTab] = useState<Tab>('flow')
  // Выбранные стадия вкладки «Стадии» и флоу вкладки «Сценарии» — по key, как в форме.
  const [stageKey, setStageKey] = useState<number | null>(null)
  // Правка стадии — окном поверх карточек: открыто ли оно (B-192).
  const [stageOpen, setStageOpen] = useState(false)
  const [flowKey, setFlowKey] = useState<number | null>(null)
  const [opened, setOpened] = useState<Opened>(null)
  // Пункт сценария, из меню которого открыли правку стадии или описания: на закрытии фокус встаёт на его блок.
  const [origin, setOrigin] = useState<number | null>(null)
  const [focus, setFocus] = useState<Focus>(null)
  // Выбор до записи — по именам: перечитанный флоу собирается в форму заново, с новыми key.
  const [keep, setKeep] = useState<{ flow: string | null } | null>(null)
  // Какое окно открыто поверх раздела: описание стадии, выбор стадии во флоу или переписывание с Чудо-Юдо.
  const [modal, setModal] = useState<'description' | 'add' | 'rewrite' | null>(rewriteAt !== null ? 'rewrite' : null)
  const [rewriteSeen, setRewriteSeen] = useState(rewriteAt)
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)

  const loadFlows = useCallback(() => {
    fetch('/api/flow')
      .then((response) => {
        if (!response.ok) throw new Error(`Флоу не загрузился: HTTP ${response.status}`)
        return response.json() as Promise<BaseFlow[]>
      })
      .then(
        (flows) => {
          setLoad({ kind: 'loaded', flows })
          // Выбранная база могла уйти из списка — тогда показывается первая.
          setSelected((current) => (flows.some((f) => f.base === current) ? current : (flows[0]?.base ?? null)))
        },
        (e: unknown) =>
          setLoad({
            kind: 'failed',
            message: e instanceof TypeError ? 'Нет связи с API' : String((e as Error).message),
          }),
      )
  }, [])

  // Флоу читается при открытии раздела и пунктом «Обновить», как бэклог.
  useEffect(loadFlows, [loadFlows])

  // Не прочитали список — оставляем null: пустой список пометил бы незаведёнными все стадии разом
  // и запер бы сохранение флоу из-за временного отказа API.
  useEffect(() => {
    fetch('/api/performers')
      .then((response) => (response.ok ? (response.json() as Promise<BasePerformers[]>) : null))
      .then(
        (bases) => (bases === null ? setPerformersFailed(true) : setPerformers(bases)),
        () => setPerformersFailed(true),
      )
  }, [])

  const flows = load.kind === 'loaded' ? load.flows : []
  const reveal = useReveal(load.kind === 'loading')
  const flow = flows.find((f) => f.base === selected) ?? null
  // Стадия зовёт исполнителя именем; здесь — ровно те, кто лежит в базе проекта.
  const project = flow && performers ? (performers.find((p) => p.base === flow.base) ?? null) : null
  const known = performers === null ? null : (project?.performers.map((p) => p.name) ?? [])

  // Флоу базы кладётся в форму: править его можно сразу, отдельного режима правки нет.
  const baseKey = flow ? `${flow.base}@${flow.version ?? ''}` : ''
  const saved = useMemo(
    () => (flow ? toDraft(flow) : { stages: [], flows: [] }),
    [baseKey], // eslint-disable-line react-hooks/exhaustive-deps
  )
  const draft = edits?.key === baseKey ? edits.draft : saved
  const setDraft = (next: Draft) => setEdits({ key: baseKey, draft: next })

  const savedApi = useMemo(() => JSON.stringify(toApi(saved)), [saved])
  const dirty =
    flow !== null && (JSON.stringify(toApi(draft)) !== savedApi || !sameIcons(toIcons(draft), flow.icons ?? {}))
  // Отметка в шапке щёлкнута при открытом разделе: окно встаёт поверх, а проект переключается на проект
  // просьбы, только если переключать нечего терять — как в выборе проекта. С несохранёнными правками окно
  // остаётся на своём проекте и говорит, что просьба про другой.
  if (rewriteAt !== rewriteSeen) {
    setRewriteSeen(rewriteAt)
    if (rewriteAt !== null) {
      setModal('rewrite')
      if (baseFor !== null && baseFor !== selected && !dirty) {
        setSelected(baseFor)
        setOpened(null)
        setStageKey(null)
        setStageOpen(false)
        setFlowKey(null)
        setKeep(null)
      }
    }
  }
  const unread = flow?.unread ?? []
  const problem =
    unread.length > 0
      ? `в файлах флоу есть строка, которую панель не сохранит, — ${unread[0]}. Поправьте её в файле: «…» → «Открыть в VS Code»`
      : firstProblem(draft, known)

  // Записанный флоу перечитан с новыми key: выбор находится по имени, а не падает на первый флоу.
  const currentFlow =
    draft.flows.find((f) => f.key === flowKey) ??
    draft.flows.find((f) => keep?.flow != null && norm(f.name) === norm(keep.flow)) ??
    draft.flows[0] ??
    null
  // Стадия выбрана, только пока её правят окном: оно открывается вместе с выбором карточки (B-192).
  const currentStage = draft.stages.find((s) => s.key === stageKey) ?? null

  const refresh = useCallback(() => {
    setNotice(null)
    setLoad({ kind: 'loading' })
    loadFlows()
  }, [loadFlows])

  const forget = () => {
    setEdits(null)
    setOpened(null)
    setModal(null)
    setStageOpen(false)
  }

  async function openInVsCode(base: string) {
    setNotice(null)
    try {
      const response = await fetch('/api/flow/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base }),
      })
      if (!response.ok) setNotice({ kind: 'error', text: 'Не удалось открыть флоу в VS Code' })
    } catch {
      setNotice({ kind: 'error', text: 'Не удалось открыть флоу в VS Code: нет связи с API' })
    }
  }

  async function save(target: BaseFlow, next: Draft) {
    setConfirming(false)
    setSaving(true)
    setNotice(null)
    try {
      const response = await fetch('/api/flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: target.base, version: target.version, ...toApi(next), icons: toIcons(next) }),
      })
      if (response.ok) {
        setNotice({ kind: 'done', text: 'Флоу сохранён и закоммичен в базу' })
        setKeep({ flow: currentFlow?.name ?? null })
        setOpened(null)
        loadFlows()
        return
      }
      const body = (await response.json().catch(() => null)) as RejectedBody | null
      setNotice({ kind: 'error', text: saveError(response.status, body) })
    } catch {
      setNotice({ kind: 'error', text: 'Флоу не сохранён: нет связи с API' })
    } finally {
      setSaving(false)
    }
  }

  const updateStage = (key: number, patch: Partial<DraftStage>) =>
    setDraft({ ...draft, stages: draft.stages.map((stage) => (stage.key === key ? { ...stage, ...patch } : stage)) })

  const updateFlow = (key: number, change: (flow: DraftFlow) => DraftFlow) =>
    setDraft({ ...draft, flows: draft.flows.map((f) => (f.key === key ? change(f) : f)) })

  const addStage = (stage: FlowStage) => {
    const added = stageDraft(stage)
    return { added, stages: [...draft.stages, added] }
  }

  /**
   * Правки Чудо-Юдо ложатся на стадии черновика: переписанная сохраняет key, и пункты сценариев и возвраты,
   * которые ссылаются на неё key, идут за новым названием сами — как при ручном переименовании. Новая стадия
   * встаёт в конец вкладки «Стадии»: во флоу её ставят уже со вкладки «Сценарии».
   */
  const applyRewritten = (rewritten: RewrittenStage[]) => {
    let stages = draft.stages
    for (const { of, stage } of rewritten) {
      const fields = stageDraft(stage)
      const was = of == null ? undefined : stages.find((one) => norm(one.title) === norm(of))
      stages = was
        ? stages.map((one) => (one === was ? { ...fields, key: was.key, slug: was.slug, icon: was.icon } : one))
        : [...stages, { ...fields, slug: null }]
    }
    setDraft({ ...draft, stages })
    setModal(null)
    if (rewritten.some((one) => one.of == null)) {
      setTab('stages')
      setOpened(null)
    }
  }

  // Значок стадии в окне переписывания — тот же, что на её карточке.
  const stageMark = (title: string) => {
    const stage = draft.stages.find((one) => norm(one.title) === norm(title))
    const kind = !stage ? 'orchestrator' : stage.kind === 'оркестратор' ? 'orchestrator' : stage.kind === 'оператор' ? 'operator' : 'agent'
    return (
      <span className={`flow-card-mark flow-mark-${kind}`} aria-hidden="true">
        <StageIcon icon={stage?.icon ?? ''} kind={kind} />
      </span>
    )
  }

  // Новая стадия на вкладке «Стадии»: во флоу её ставят уже со вкладки «Сценарии».
  const newStage = () => {
    const { added, stages } = addStage(emptyStage)
    setDraft({ ...draft, stages })
    setStageKey(added.key)
    setStageOpen(true)
  }

  const newFlow = () => {
    const created: DraftFlow = { key: nextKey++, name: freeName(draft.flows), when: '', entries: [] }
    setDraft({ ...draft, flows: [...draft.flows, created] })
    setFlowKey(created.key)
    setTab('flow')
    setOpened({ kind: 'flow' })
  }

  /** Стадия встаёт в конец флоу: своя стадия базы или новая пустая — она заводится в базе. */
  const placeStage = (target: DraftFlow, choice: { stage: number } | 'new') => {
    const entry = (stage: number): DraftEntry => ({ key: nextKey++, stage, title: '', returns: [] })
    const withEntry = (flowsOf: DraftFlow[], stage: number) =>
      flowsOf.map((f) => (f.key === target.key ? { ...f, entries: [...f.entries, entry(stage)] } : f))

    if (choice !== 'new') {
      const placed = entry(choice.stage)
      setDraft({ ...draft, flows: draft.flows.map((f) => (f.key === target.key ? { ...f, entries: [...f.entries, placed] } : f)) })
      setFocus({ key: placed.key })
    } else {
      const { added, stages } = addStage(emptyStage)
      setDraft({ stages, flows: withEntry(draft.flows, added.key) })
      // Новую стадию ещё заполнять: её правка — на вкладке «Стадии».
      setStageKey(added.key)
      setStageOpen(true)
      setTab('stages')
    }
    setModal(null)
  }

  const editable = flow !== null && !flow.error
  // Нет сценариев или стадий — пустое состояние только на своей вкладке: переключатель и другая вкладка остаются (B-222).
  const noFlows = editable && draft.flows.length === 0
  const noStages = editable && draft.stages.length === 0
  // Открыто окно поверх раздела: верх, схема и полоса под подложкой недоступны — Tab не уходит из окна.
  // Окно переписывания у непрочитанного флоу не встаёт — и верх раздела не запирает: проект можно сменить или обновить.
  const covered =
    stageOpen || modal === 'description' || (modal === 'rewrite' && editable) || opened?.kind === 'returns'
  // Со схемы правка стадии задевает все сценарии, где она стоит: окна говорят об этом, если сценарий не один.
  const scope = tab === 'flow' && currentStage ? scopeWarning(draft, currentStage.key) : null
  const backToBlock = () => origin !== null && setFocus({ key: origin })

  return (
    <>
      {/* Пока открыто окно, верх раздела и полоса под подложкой недоступны: окно запирает Tab. */}
      <div className="vc-head" inert={covered}>
        <h2>Флоу</h2>
        <div className="head-end flow-actions">
          {editable && (
            <>
              <div className="vc-tabs" role="tablist" aria-label="Части флоу">
                {(['stages', 'flow'] as const).map((one) => (
                  <button
                    key={one}
                    type="button"
                    role="tab"
                    className={`flow-tab ${tab === one ? 'is-on' : ''}`}
                    aria-selected={tab === one}
                    onClick={() => {
                      setTab(one)
                      setOpened(null)
                    }}
                  >
                    {one === 'stages' ? 'Стадии' : 'Сценарии'}
                  </button>
                ))}
              </div>
              <span className="head-sep" aria-hidden="true" />
            </>
          )}
          {load.kind === 'loading' && (
            <>
              <Sk w={166} h={32} style={{ borderRadius: 8 }} />
              <span className="head-sep" aria-hidden="true" />
              <Sk w={136} h={30} style={{ borderRadius: 6 }} />
            </>
          )}
          {flows.length > 0 && (
            <PickMenu
              label="Проект"
              value={flow?.project ?? ''}
              options={flows.map((f) => ({ id: f.base, label: f.project }))}
              selected={selected}
              // Правка идёт по флоу одной базы: пока она не записана, проект не переключается.
              disabled={dirty}
              onPick={(base) => {
                setSelected(base)
                // Выбор проекта доступен поверх окна переписывания, только если оно не встало: забыть и его.
                setModal(null)
                setOpened(null)
                setStageKey(null)
                setStageOpen(false)
                setFlowKey(null)
                setKeep(null)
              }}
            />
          )}
          <RowMenu label="Ещё действия" title="Ещё действия" buttonClassName="bases-btn head-more">
            {(close) => (
              <>
                {/* Правки агента ложатся в черновик поверх несохранённых: стадии он получает такими, как на экране.
                    Вкладка «Стадии» видна и без сценариев, поэтому пункт есть и у проекта без них (B-222). */}
                {editable && (
                  <button
                    type="button"
                    role="menuitem"
                    className="row-menu-item"
                    onClick={() => {
                      close()
                      setModal('rewrite')
                    }}
                  >
                    <RewriteIcon />
                    Переписать с {AGENT_NAME}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="row-menu-item"
                  // Обновление перечитает базу: незаписанные правки оно бы стёрло молча.
                  disabled={load.kind === 'loading' || dirty}
                  onClick={() => {
                    close()
                    refresh()
                  }}
                >
                  <RefreshIcon />
                  Обновить
                </button>
                {/* Открывать есть что, пока в базе лежит флоу или хоть одна стадия. */}
                {editable && (flow.flows.length > 0 || flow.stages.length > 0) && (
                  <button
                    type="button"
                    role="menuitem"
                    className="row-menu-item"
                    onClick={() => {
                      close()
                      void openInVsCode(flow.base)
                    }}
                  >
                    <VsCodeIcon />
                    Открыть в VS Code
                  </button>
                )}
              </>
            )}
          </RowMenu>
        </div>
      </div>

      {load.kind === 'loading' && <FlowSkeleton shown={reveal.shown} />}
      {load.kind === 'failed' && (
        <p className="message warning-text" role="alert">
          {load.message}
        </p>
      )}
      {notice && (
        <p className={`message ${notice.kind === 'done' ? 'flow-done' : 'warning-text'}`} role="status">
          {notice.text}
        </p>
      )}
      {/* Без списка исполнителей стадии не помечаются и запись не запирается — сказать, отчего так. */}
      {performersFailed && (
        <p className="message warning-text" role="status">
          Список исполнителей не прочитан: имена стадий панель не проверяет, пока раздел не откроют заново.
        </p>
      )}

      {load.kind === 'loaded' && flows.length === 0 && (
        <p className="empty-message">Нет отслеживаемых баз. Базы добавляются в разделе «Настройки».</p>
      )}

      {flow?.error && <p className="backlog-note warning-text">{flow.error}</p>}
      {/* Правки агента ложатся только на прочитанный флоу: с отметки в шапке окно не встаёт — сказать почему. */}
      {modal === 'rewrite' && flow?.error && (
        <p className="message warning-text" role="status">
          Окно «Переписать с {AGENT_NAME}» не открыть, пока флоу проекта не прочитан: правки было бы не на что положить.
        </p>
      )}

      {load.kind === 'loaded' && (
        <div className={withReveal('flow-body', reveal)} onAnimationEnd={reveal.onAnimationEnd}>
          {noFlows && tab === 'flow' && (
            <div className="flow-empty">
              <span className="flow-empty-mark" aria-hidden="true">
                <FlowIcon />
              </span>
              <h3>В этом проекте нет сценариев</h3>
              <p>Сценарий — цепочка стадий, по которой агент ведёт задачу. Пока его нет, задачу в этом проекте не начать.</p>
              <button type="button" className="bases-btn bases-btn-primary" onClick={newFlow}>
                <PlusIcon />
                Создать первый сценарий
              </button>
            </div>
          )}

          {noStages && tab === 'stages' && (
            <div className="flow-empty">
              <span className="flow-empty-mark" aria-hidden="true">
                <FlowIcon />
              </span>
              <h3>В этом проекте нет стадий</h3>
              <p>Стадия — шаг работы над задачей: кто его делает и что должно получиться. Сценарии собираются из стадий.</p>
              <button type="button" className="bases-btn bases-btn-primary" onClick={newStage}>
                <PlusIcon />
                Создать первую стадию
              </button>
            </div>
          )}

          {editable && !noStages && tab === 'stages' && (
            <StagesTab
              draft={draft}
              current={currentStage}
              known={known}
              open={stageOpen}
              covered={modal === 'description'}
              onPerformers={onPerformers}
              onSelect={(key) => {
                setStageKey(key)
                setStageOpen(true)
              }}
              onClose={() => setStageOpen(false)}
              onNew={newStage}
              onChange={(patch) => currentStage && updateStage(currentStage.key, patch)}
              onEditDescription={() => setModal('description')}
              onDelete={() => {
                if (!currentStage) return
                setDraft({ ...draft, stages: draft.stages.filter((stage) => stage.key !== currentStage.key) })
                setStageKey(null)
                setStageOpen(false)
              }}
            />
          )}

          {editable && tab === 'flow' && currentFlow && (
            <FlowTab
              draft={draft}
              flow={currentFlow}
              opened={opened}
              known={known}
              covered={covered}
              focus={focus}
              onFocus={setFocus}
              onPick={(key) => {
                setFlowKey(key)
                setOpened(null)
              }}
              onNew={newFlow}
              onOpen={setOpened}
              onChange={(change) => updateFlow(currentFlow.key, change)}
              // Правка стадии и её описания со схемы — окнами поверх сценария, вкладка не меняется (B-202).
              onEditStage={(entry, key) => {
                setOrigin(entry)
                setStageKey(key)
                setStageOpen(true)
              }}
              onEditDescription={(entry, key) => {
                setOrigin(entry)
                setStageKey(key)
                setModal('description')
              }}
              onAdd={() => setModal('add')}
              onDelete={() => {
                setDraft({ ...draft, flows: draft.flows.filter((f) => f.key !== currentFlow.key) })
                setFlowKey(null)
                setOpened(null)
              }}
            />
          )}
        </div>
      )}

      {editable && tab === 'flow' && stageOpen && currentStage && (
        <StageModal
          stage={currentStage}
          draft={draft}
          known={known}
          covered={modal === 'description'}
          warning={scope}
          onPerformers={onPerformers}
          onClose={() => setStageOpen(false)}
          onReturnFocus={backToBlock}
          onChange={(patch) => updateStage(currentStage.key, patch)}
          onEditDescription={() => setModal('description')}
          // Стадия на схеме стоит во флоу, и «Удалить стадию» в окне погашена: удалять здесь нечего.
          onDelete={() => undefined}
        />
      )}

      {modal === 'description' && currentStage && (
        <DescriptionEditor
          title={currentStage.title}
          description={currentStage.description}
          warning={scope}
          onClose={() => {
            setModal(null)
            // Описание, открытое из окна правки, возвращает фокус окну; открытое из меню — блоку на схеме.
            if (tab === 'flow' && !stageOpen) backToBlock()
          }}
          onDone={(description) => updateStage(currentStage.key, { description })}
        />
      )}

      {modal === 'rewrite' && flow && editable && (
        <FlowRewriteModal
          base={flow.base}
          project={flow.project}
          stages={draft.stages.map(toStage)}
          mark={stageMark}
          scope={(title) => {
            const stage = draft.stages.find((one) => norm(one.title) === norm(title))
            return stage ? scopeWarning(draft, stage.key) : null
          }}
          onApply={applyRewritten}
          onClose={() => setModal(null)}
        />
      )}

      {modal === 'add' && currentFlow && (
        <AddStage
          flow={currentFlow}
          stages={draft.stages.filter((stage) => !currentFlow.entries.some((entry) => entry.stage === stage.key))}
          onCancel={() => setModal(null)}
          onPick={(choice) => placeStage(currentFlow, choice)}
        />
      )}

      {/* Полоса сохранения стоит внизу раздела и видна при правках — вариант оператора, — а ещё когда флоу
          в базе уже сломан: иначе не видно, почему его не сохранить. */}
      {editable && (dirty || problem) && (
        <div className="save-bar" inert={covered}>
          <div className="save-bar-state">
            {dirty && <span className="flow-dirty">есть несохранённые правки</span>}
            {problem && <span className="flow-blocked">Не сохранить: {problem}</span>}
          </div>
          {dirty && (
            <button
              type="button"
              className="bases-btn"
              disabled={saving}
              onClick={() => {
                setNotice(null)
                forget()
              }}
            >
              Отменить правки
            </button>
          )}
          <button
            type="button"
            className="bases-btn bases-btn-primary"
            disabled={saving || !dirty || problem !== null}
            onClick={() => (flow.activeTasks > 0 ? setConfirming(true) : void save(flow, draft))}
          >
            {saving ? 'Сохранение…' : 'Сохранить'}
          </button>
        </div>
      )}

      {confirming && flow && (
        <ConfirmSave flow={flow} onCancel={() => setConfirming(false)} onConfirm={() => void save(flow, draft)} />
      )}
    </>
  )
}

type RejectedBody = { problem?: string; flow?: string | null; stage?: string | null; detail?: string | null }

function saveError(status: number, body: RejectedBody | null) {
  if (status === 409)
    return 'Флоу не сохранён: флоу изменился в базе, пока вы его правили. Отмените правки и обновите флоу.'
  // Страховка: при том же отпечатке такие строки уже пришли с флоу, и «Сохранить» заперта раньше, чем дойдёт до API.
  if (status === 400 && body?.problem === 'unread')
    return `Флоу не сохранён: в файлах флоу есть строка, которую панель не сохранит, — ${body.detail ?? ''}`.trim()
  if (status === 400 && body?.problem) {
    const where = [body.flow ? `флоу «${body.flow}»` : '', body.stage ? `стадия «${body.stage}»` : '']
      .filter(Boolean)
      .join(', ')
    return `Флоу не сохранён: ${where ? `${where} — ` : ''}${invalidLabels[body.problem] ?? 'не в форме кита'}`
  }
  if (status === 502 && body?.problem === 'not-written')
    return `Флоу не сохранён: файл флоу не записался, файлы возвращены как были.${body.detail ? ` ${body.detail}` : ''}`
  if (status === 502 && body?.problem === 'not-restored')
    return `Флоу не сохранён, и не все файлы удалось вернуть — проверьте flow/ базы.${body.detail ? ` ${body.detail}` : ''}`
  if (status === 502 && body?.problem === 'not-committed')
    return `Флоу не сохранён: коммит в базу не прошёл, файлы оставлены как были.${body.detail ? ` ${body.detail}` : ''}`
  if (status === 404) return 'Флоу не сохранён: база не найдена'
  return 'Флоу не сохранён'
}

/** Исполнитель на блоке: то же имя, каким его зовёт стадия и каким назван его файл в базе. */
const executorOf = (stage: DraftStage) =>
  stage.kind === 'субагент' ? `субагент ${stage.agent.trim()}`.trim() : stage.kind

const executorKind = (stage: DraftStage) =>
  stage.kind === 'оркестратор' ? 'orchestrator' : stage.kind === 'оператор' ? 'operator' : 'agent'

/**
 * Выбор из списка кнопкой: проект в шапке раздела и флоу в углу холста. В раскрытом списке —
 * только названия, у выбранного — галочка.
 */
function PickMenu({
  label,
  value,
  options,
  selected,
  disabled = false,
  onPick,
}: {
  label: string
  value: string
  options: { id: string; label: string }[]
  selected: string | null
  disabled?: boolean
  onPick: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  return (
    <div className="flow-pick" ref={box} onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}>
      <button
        type="button"
        className="flow-pick-btn"
        aria-label={`${label}: ${value}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        {value}
        {open ? <ChevronUpIcon /> : <ChevronDownIcon />}
      </button>
      {open && (
        <ul className="flow-pick-menu" role="listbox" aria-label={label}>
          {options.map((option) => (
            <li
              key={option.id}
              role="option"
              aria-selected={option.id === selected}
              tabIndex={0}
              onClick={() => {
                onPick(option.id)
                setOpen(false)
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                onPick(option.id)
                setOpen(false)
              }}
            >
              {option.label}
              {option.id === selected && (
                <span className="flow-pick-check">
                  <TickIcon />
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Флоу, пока он читается в первый раз: выбор сценария и цепочка стадий полосами (макет B-201). */
function FlowSkeleton({ shown }: { shown: boolean }) {
  const arrow = <Sk w={2} h={32} className="sk-block" style={{ margin: '0 auto', borderRadius: 1 }} />
  const node = (title: number, executor: number) => (
    <>
      <div className="flow-node sk-frame">
        <Sk w={40} h={40} style={{ borderRadius: 11 }} />
        <Sk w={title} h={12} />
        <Sk w={executor} h={8} />
      </div>
      {arrow}
    </>
  )
  return (
    <Skeleton label="Загрузка флоу" shown={shown} className="flow-canvas">
      <div className="flow-canvas-pick">
        <Sk w={128} h={30} style={{ borderRadius: 6 }} />
      </div>
      <div className="flow-scroll">
        <div className="flow-chain">
          <div className="flow-start">
            <Sk w={64} h={64} className="sk-round" />
            <Sk w={70} h={11} />
          </div>
          {arrow}
          {node(96, 72)}
          {node(74, 64)}
          {node(110, 56)}
        </div>
      </div>
    </Skeleton>
  )
}

/** Вкладка «Стадии»: все стадии базы карточками и правка выбранной окном — сразу для всех флоу, где она стоит. */
function StagesTab({
  draft,
  current,
  known,
  open,
  covered,
  onPerformers,
  onSelect,
  onClose,
  onNew,
  onChange,
  onEditDescription,
  onDelete,
}: {
  draft: Draft
  current: DraftStage | null
  known: string[] | null
  open: boolean
  covered: boolean
  onPerformers?: () => void
  onSelect: (key: number) => void
  onClose: () => void
  onNew: () => void
  onChange: (patch: Partial<DraftStage>) => void
  onEditDescription: () => void
  onDelete: () => void
}) {
  const grid = useRef<HTMLUListElement>(null)
  const add = useRef<HTMLButtonElement>(null)

  return (
    <div className="flow-stages">
      {/* Стадии сеткой карточек, как исполнители; новая — пунктирной карточкой последней (B-192). */}
      {/* Пока открыто окно правки, карточки под ним недоступны: Tab не уходит под подложку. */}
      <ul className="flow-stage-grid" aria-label="Стадии базы" ref={grid} inert={open}>
        {stagesInOrder(draft).map((stage) => (
          <li key={stage.key}>
            <button
              type="button"
              data-stage={stage.key}
              className={`flow-stage-card ${open && stage.key === current?.key ? 'is-on' : ''} ${
                stageErrors(stage, draft.stages, known).length > 0 ? 'invalid' : ''
              }`}
              onClick={() => onSelect(stage.key)}
            >
              <span className="flow-stage-card-top">
                <span className={`flow-card-mark flow-mark-${executorKind(stage)}`} aria-hidden="true">
                  <StageIcon icon={stage.icon} kind={executorKind(stage)} />
                </span>
                <span className="flow-stage-item-title">{stageName(stage)}</span>
              </span>
              <span className="flow-stage-card-foot">
                <span className="flow-stage-badge">
                  {/* Имя субагента — моноширинным, как имя исполнителя в его карточке. */}
                  {stage.kind === 'субагент' && stage.agent.trim() ? (
                    <>
                      субагент <span className="mono">{stage.agent.trim()}</span>
                    </>
                  ) : (
                    executorOf(stage) || 'субагент'
                  )}
                </span>
              </span>
            </button>
          </li>
        ))}
        <li>
          <button type="button" className="flow-stage-card flow-stage-card-add" ref={add} onClick={onNew}>
            <PlusIcon />
            Новая стадия
          </button>
        </li>
      </ul>

      {current && open && (
        <StageModal
          stage={current}
          draft={draft}
          known={known}
          covered={covered}
          onPerformers={onPerformers}
          onClose={onClose}
          onReturnFocus={(key) =>
            // Удалённой стадии карточки нет — фокус встаёт на «Новую стадию».
            (grid.current?.querySelector<HTMLElement>(`[data-stage="${key}"]`) ?? add.current)?.focus()
          }
          onChange={onChange}
          onEditDescription={onEditDescription}
          onDelete={onDelete}
        />
      )}
    </div>
  )
}

/**
 * Окно правки стадии — рамкой окна исполнителя: подписи слева, поля справа, внизу «Готово» (B-192).
 * Правки окно не пишет: они копятся, и записывает их полоса сохранения внизу раздела.
 */
function StageModal({
  stage,
  draft,
  known,
  covered,
  warning = null,
  onPerformers,
  onClose,
  onReturnFocus,
  onChange,
  onEditDescription,
  onDelete,
}: {
  stage: DraftStage
  draft: Draft
  known: string[] | null
  covered: boolean
  warning?: string | null
  onPerformers?: () => void
  onClose: () => void
  onReturnFocus: (key: number) => void
  onChange: (patch: Partial<DraftStage>) => void
  onEditDescription: () => void
  onDelete: () => void
}) {
  // Стадию, которая стоит хоть в одном флоу, не удалить: сначала её убирают из флоу — ответ оператора.
  const used = draft.flows.some((f) => f.entries.some((entry) => entry.stage === stage.key))
  const errors = stageErrors(stage, draft.stages, known)
  const title = useRef<HTMLInputElement>(null)
  const describe = useRef<HTMLButtonElement>(null)
  // Фокус возвращается туда, откуда правили стадию: к её карточке или, если окно открыли из меню на схеме,
  // к её блоку; окна добавления на закрытии уже нет (B-192, B-202).
  // Ключ стадии за время жизни окна не меняется, а возврат ищет карточку по ссылкам на сетку — хватает
  // того, что было на открытии.
  useEffect(() => {
    title.current?.focus()
    return () => onReturnFocus(stage.key)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Окно описания закрылось — фокус обратно на кнопку, которой его открыли, как в окне исполнителя.
  const wasCovered = useRef(covered)
  useEffect(() => {
    if (wasCovered.current && !covered) describe.current?.focus()
    wasCovered.current = covered
  }, [covered])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && !covered && onClose()}>
      <section
        className="modal-wizard flow-stage-modal"
        role="dialog"
        aria-modal={!covered}
        aria-label={`Стадия «${stageName(stage)}»`}
        // Фокус держится в окне и при щелчке мимо полей: иначе он уходит со страницы, и Escape некому поймать.
        tabIndex={-1}
        // Escape закрывает окно, если его не забрал кто-то внутри, — список значков закрывает сначала себя.
        // Окно описания стоит отдельно, и его Escape сюда не доходит.
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) onClose()
        }}
        // Пока поверх открыто описание, правка под ним недоступна: Tab и программа чтения — только в описании.
        inert={covered}
      >
        <div className="ask-head">
          <div className="ask-title">
            <span className={`flow-card-mark flow-mark-${executorKind(stage)}`} aria-hidden="true">
              <StageIcon icon={stage.icon} kind={executorKind(stage)} />
            </span>
            <h2 className="flow-stage-modal-title">{stageName(stage)}</h2>
            <span className="pf-project">{executorOf(stage) || 'субагент'}</span>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          {warning && <p className="flow-scope-warning">{warning}</p>}
        </div>

        <div className="ask-body">
          <div className="flow-stage-rows">
            <div className="flow-field">
              <span>Значок</span>
              <IconPicker stage={stage} onPick={(icon) => onChange({ icon })} />
            </div>

            <label className="flow-field">
              <span>Название</span>
              <input
                ref={title}
                className="flow-input flow-stage-name"
                aria-label="Название стадии"
                placeholder="Название стадии"
                aria-invalid={!stage.title.trim()}
                value={stage.title}
                onChange={(event) => onChange({ title: event.target.value })}
              />
            </label>

            <label className="flow-field">
              <span>Исполнитель</span>
              <select
                className="flow-input"
                aria-label="Исполнитель стадии"
                value={stage.kind}
                onChange={(event) => {
                  const kind = event.target.value as DraftStage['kind']
                  // Помощники стираются на глазах: в файле у такой стадии их не бывает, и молча они бы пропали при записи.
                  onChange({ kind, helpers: kind === 'оркестратор' ? stage.helpers : [] })
                }}
              >
                {kinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>

            {stage.kind === 'субагент' && (
              <PerformerField stage={stage} known={known} onChange={onChange} onPerformers={onPerformers} />
            )}

            {/* Помощников зовёт только оркестратор: у прочих стадий поля нет — форма кита. */}
            {stage.kind === 'оркестратор' && <HelpersField stage={stage} known={known} onChange={onChange} />}
          </div>

          <div className="flow-stage-sep">Работа</div>

          <div className="flow-stage-rows">
            <label className="flow-field">
              <span>Выход</span>
              <textarea
                className="flow-input"
                aria-label="Выход стадии"
                placeholder="что предъявить: коммит, строка в памяти, вывод прогона"
                aria-invalid={!stage.output.trim()}
                rows={3}
                value={stage.output}
                onChange={(event) => onChange({ output: event.target.value })}
              />
            </label>

            <label className="flow-field">
              <span>Пропуск</span>
              <input
                className="flow-input"
                aria-label="Пропуск стадии"
                placeholder="нет — стадия проходится всегда"
                value={stage.skip}
                onChange={(event) => onChange({ skip: event.target.value })}
              />
            </label>

            <div className="flow-field">
              <span>Описание</span>
              {/* Кнопка показывает лишь наличие описания: без него та же надпись, но пунктиром. */}
              <button
                ref={describe}
                type="button"
                className={`btn flow-description-btn ${stage.description ? '' : 'flow-description-empty'}`}
                title={stage.description ? 'Описание есть — править' : 'Описания нет — добавить'}
                onClick={onEditDescription}
              >
                <FileTextIcon />
                Редактировать описание
              </button>
            </div>
          </div>

          {errors.length > 0 && <p className="flow-step-error">Стадию не сохранить: {errors.join(', ')}.</p>}
        </div>

        <div className="modal-footer flow-stage-foot">
          <button type="button" className="btn btn-danger" disabled={used} onClick={onDelete}>
            <TrashIcon />
            Удалить стадию
          </button>
          <button type="button" className="btn btn-primary flow-stage-done" onClick={onClose}>
            Готово
          </button>
        </div>
      </section>
    </div>
  )
}

/** Вкладка «Сценарии»: выбранный флоу схемой — узел старта, стадии блоками и возвраты дугами. */
function FlowTab({
  draft,
  flow,
  opened,
  known,
  covered,
  focus,
  onFocus,
  onPick,
  onNew,
  onOpen,
  onChange,
  onEditStage,
  onEditDescription,
  onAdd,
  onDelete,
}: {
  draft: Draft
  flow: DraftFlow
  opened: Opened
  known: string[] | null
  covered: boolean
  focus: Focus
  onFocus: (focus: Focus) => void
  onPick: (key: number) => void
  onNew: () => void
  onOpen: (opened: Opened) => void
  onChange: (change: (flow: DraftFlow) => DraftFlow) => void
  onEditStage: (entry: number, stage: number) => void
  onEditDescription: (entry: number, stage: number) => void
  onAdd: () => void
  onDelete: () => void
}) {
  // Меню блока по правому щелчку: key пункта и точка, у которой оно встаёт (B-202).
  const [menu, setMenu] = useState<{ key: number; at: Point } | null>(null)
  const chain = useRef<HTMLDivElement>(null)
  const stageOf = (entry: DraftEntry) => draft.stages.find((stage) => stage.key === entry.stage) ?? null
  // Блок под мышью и блок под курсором клавиатуры: их возвраты на схеме подсвечены (B-214).
  const [hovered, setHovered] = useState<number | null>(null)
  const [focused, setFocused] = useState<number | null>(null)
  const openedIndex = opened?.kind === 'returns' ? flow.entries.findIndex((entry) => entry.key === opened.key) : -1
  const menuIndex = menu ? flow.entries.findIndex((entry) => entry.key === menu.key) : -1
  // Возвраты подсвечены у стадии с открытым окном возвратов, открытым меню, под мышью и под курсором клавиатуры.
  const lit = flow.entries.flatMap((entry, index) =>
    index === openedIndex || index === menuIndex || entry.key === hovered || entry.key === focused ? [index] : [],
  )

  // Фокус встаёт на блок, когда закрылось окно, открытое из его меню: схема к этому времени уже не под подложкой.
  // Поставленный фокус забывается: иначе вкладка, открытая заново, снова дёрнула бы его и прокрутку к старому блоку.
  useEffect(() => {
    if (!focus) return
    const block = focus.key === null ? null : chain.current?.querySelector<HTMLElement>(`[data-entry="${focus.key}"]`)
    ;(block ?? chain.current?.querySelector<HTMLElement>('.flow-node-add'))?.focus()
    onFocus(null)
  }, [focus, onFocus])

  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= flow.entries.length) return
    onChange((f) => {
      const entries = [...f.entries]
      const [entry] = entries.splice(from, 1)
      entries.splice(to, 0, entry)
      return { ...f, entries }
    })
  }

  const setEntry = (key: number, patch: Partial<DraftEntry>) =>
    onChange((f) => ({ ...f, entries: f.entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)) }))

  // Блока убранной стадии нет: фокус переходит на соседний, а у последней — на «Добавить стадию».
  const remove = (index: number) => {
    const key = flow.entries[index].key
    const next = flow.entries[index + 1] ?? flow.entries[index - 1] ?? null
    onChange((f) => ({ ...f, entries: f.entries.filter((entry) => entry.key !== key) }))
    onFocus({ key: next?.key ?? null })
  }

  return (
    <>
      <section className="flow-canvas" aria-label={`Сценарий «${flowName(flow)}»`} inert={covered}>
        <div className="flow-canvas-pick">
          <PickMenu
            label="Сценарий"
            value={flowName(flow)}
            options={draft.flows.map((f) => ({ id: String(f.key), label: flowName(f) }))}
            selected={String(flow.key)}
            onPick={(id) => onPick(Number(id))}
          />
          <button type="button" className="bases-btn bases-btn-small" onClick={onNew}>
            <PlusIcon />
            Новый сценарий
          </button>
        </div>

        <div className="flow-scroll">
          <div className="flow-chain" ref={chain}>
            <ReturnArcs flow={flow} lit={lit} />
            <button
              type="button"
              className={`flow-start ${opened?.kind === 'flow' ? 'opened' : ''} ${
                flowErrors(flow, draft.flows).length > 0 ? 'invalid' : ''
              }`}
              aria-label={`Сценарий «${flowName(flow)}»: название и «когда»`}
              aria-current={opened?.kind === 'flow'}
              onClick={() => onOpen({ kind: 'flow' })}
            >
              <span className="flow-start-dot" aria-hidden="true">
                <FlowIcon />
              </span>
              <span className="flow-start-name">{flowName(flow)}</span>
            </button>
            <FlowArrow />
            {flow.entries.map((entry, index) => {
              const stage = stageOf(entry)
              return (
                <StageNode
                  key={entry.key}
                  entry={entry.key}
                  stage={stage}
                  title={entryTitle(draft, entry)}
                  returns={entry.returns.map((back) => draft.stages.find((s) => s.key === back.target)?.title.trim() ?? '')}
                  missing={stage !== null && missingPerformer(stage, known)}
                  invalid={
                    entryErrors(flow, index).length > 0 ||
                    (stage !== null && stageErrors(stage, draft.stages, known).length > 0)
                  }
                  number={index + 1}
                  index={index}
                  last={index === flow.entries.length - 1}
                  menu={menu?.key === entry.key}
                  onMenu={(at) => {
                    onOpen(null)
                    setMenu({ key: entry.key, at })
                  }}
                  onMove={move}
                  onHover={(on) => setHovered((key) => (on ? entry.key : key === entry.key ? null : key))}
                  onFocused={(on) => setFocused((key) => (on ? entry.key : key === entry.key ? null : key))}
                />
              )
            })}
            {flow.entries.length > 0 && <FlowArrow />}
            <button type="button" className="flow-node flow-node-add" onClick={onAdd}>
              <PlusIcon />
              <span className="flow-node-title">Добавить стадию</span>
            </button>
          </div>
        </div>

        {opened?.kind === 'flow' && (
          <FlowDrawer
            flow={flow}
            errors={flowErrors(flow, draft.flows)}
            onChange={(patch) => onChange((f) => ({ ...f, ...patch }))}
            onClose={() => onOpen(null)}
            onDelete={onDelete}
          />
        )}
      </section>

      {menu && menuIndex >= 0 && (
        <EntryMenu
          draft={draft}
          flow={flow}
          index={menuIndex}
          at={menu.at}
          onClose={(back) => {
            setMenu(null)
            if (back) onFocus({ key: menu.key })
          }}
          onReturns={() => {
            setMenu(null)
            onOpen({ kind: 'returns', key: menu.key })
          }}
          onEditStage={(stage) => {
            setMenu(null)
            onEditStage(menu.key, stage)
          }}
          onEditDescription={(stage) => {
            setMenu(null)
            onEditDescription(menu.key, stage)
          }}
          onRemove={() => {
            setMenu(null)
            remove(menuIndex)
          }}
        />
      )}

      {openedIndex >= 0 && (
        <ReturnsModal
          draft={draft}
          flow={flow}
          index={openedIndex}
          onChange={(patch) => setEntry(flow.entries[openedIndex].key, patch)}
          onClose={() => {
            onOpen(null)
            onFocus({ key: flow.entries[openedIndex].key })
          }}
        />
      )}
    </>
  )
}

/**
 * Дуги возвратов рисуются по местам блоков, а не по замеру DOM: высоты узла старта и блока и промежуток
 * между ними заданы в Flow.css и здесь повторены числами — меняются они вместе.
 */
const START_HEIGHT = 96
const NODE_HEIGHT = 148
const NODE_GAP = 32
const ARC_LANE = 26
const ARC_WIDTH = 150
const ARC_ROUND = 12
const CHAIN_PAD = 16

type ReturnArc = { from: number; to: number; condition: string; lane: number }

/**
 * Возвраты флоу дугами: у каждой своя дорожка, чтобы соседние круги не сливались в одну линию.
 * Возврат, которому некуда вести, не рисуется — он уже назван ошибкой стадии.
 */
function returnArcs(flow: DraftFlow): ReturnArc[] {
  const arcs: ReturnArc[] = []
  flow.entries.forEach((entry, from) => {
    for (const back of entry.returns) {
      const to = flow.entries.findIndex((other) => back.target !== null && other.stage === back.target)
      if (to < 0 || to >= from) continue
      let lane = 0
      while (arcs.some((arc) => arc.lane === lane && arc.to <= from && to <= arc.from)) lane++
      arcs.push({ from, to, condition: back.condition, lane })
    }
  })
  return arcs
}

const arcCenter = (index: number) => index * (NODE_HEIGHT + NODE_GAP) + NODE_HEIGHT / 2

/**
 * Круги работы слева от ленты: свои дуги подсвеченных стадий — `lit`, по индексам — выделены и подписаны условием,
 * ведущие в них остаются приглушёнными. Подсвеченные рисуются последними: поверх приглушённых их концы не закрыты.
 */
function ReturnArcs({ flow, lit }: { flow: DraftFlow; lit: number[] }) {
  const open = (arc: ReturnArc) => lit.includes(arc.from)
  const arcs = returnArcs(flow).sort((a, b) => Number(open(a)) - Number(open(b)))
  if (arcs.length === 0) return null

  const height = flow.entries.length * (NODE_HEIGHT + NODE_GAP)

  return (
    // Первым в ленте стоит узел старта: дуги начинаются под ним.
    <div className="flow-lines" style={{ top: CHAIN_PAD + START_HEIGHT + NODE_GAP }} aria-hidden="true">
      <svg className="flow-arcs" style={{ width: ARC_WIDTH, height }} viewBox={`0 0 ${ARC_WIDTH} ${height}`}>
        {arcs.map((arc) => {
          const lane = ARC_WIDTH - (arc.lane + 1) * ARC_LANE
          const y1 = arcCenter(arc.from)
          const y2 = arcCenter(arc.to)
          const lighted = open(arc)
          return (
            <g key={`${arc.from}-${arc.to}-${arc.lane}`} className={`flow-arc ${lighted ? 'flow-arc-open' : ''}`}>
              <path
                d={`M ${ARC_WIDTH} ${y1} H ${lane + ARC_ROUND} Q ${lane} ${y1} ${lane} ${y1 - ARC_ROUND} V ${
                  y2 + ARC_ROUND
                } Q ${lane} ${y2} ${lane + ARC_ROUND} ${y2} H ${ARC_WIDTH - 10}`}
              />
              <path d={`M ${ARC_WIDTH - 16} ${y2 - 5} L ${ARC_WIDTH - 6} ${y2} L ${ARC_WIDTH - 16} ${y2 + 5}`} />
              {lighted && arc.condition.trim() && (
                <text className="flow-arc-label" x={lane - 8} y={(y1 + y2) / 2} textAnchor="end">
                  {arc.condition.trim()}
                </text>
              )}
            </g>
          )
        })}
      </svg>
    </div>
  )
}

/**
 * Блок стадии на схеме: без номера — по решению оператора, — со значком, названием и исполнителем.
 * Щелчок по нему ничего не открывает, блок только перетаскивается; правка — меню у курсора только по правому
 * щелчку, с клавиатуры — Shift+F10 или клавишей меню: так решил оператор на приёмке B-202.
 */
function StageNode({
  entry,
  stage,
  title,
  returns,
  missing,
  invalid,
  number,
  index,
  last,
  menu,
  onMenu,
  onMove,
  onHover,
  onFocused,
}: {
  entry: number
  stage: DraftStage | null
  title: string
  returns: string[]
  missing: boolean
  invalid: boolean
  number: number
  index: number
  last: boolean
  menu: boolean
  onMenu: (at: Point) => void
  onMove: (from: number, to: number) => void
  onHover: (on: boolean) => void
  onFocused: (on: boolean) => void
}) {
  const [dragging, setDragging] = useState(false)
  const [over, setOver] = useState(false)
  const kind = stage ? executorKind(stage) : 'agent'

  // С клавиатуры меню встаёт у середины блока: курсора нет, а блок виден.
  const fromKeys = (block: HTMLElement) => {
    const rect = block.getBoundingClientRect()
    onMenu({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 })
  }

  return (
    <>
      {number > 1 && <FlowArrow />}
      <div className="flow-node-row">
        <button
          type="button"
          data-entry={entry}
          className={`flow-node ${menu ? 'menu-open' : ''} ${dragging ? 'dragging' : ''} ${over ? 'drop-target' : ''} ${
            invalid ? 'invalid' : ''
          }`}
          // Возврат нарисован дугой, а не текстом: программе чтения экрана он называется здесь.
          aria-label={`Стадия ${number}: ${title}${returns
            .filter(Boolean)
            .map((target) => `, возврат к стадии ${target}`)
            .join('')}`}
          aria-haspopup="menu"
          aria-expanded={menu}
          draggable
          onMouseEnter={() => onHover(true)}
          onMouseLeave={() => onHover(false)}
          onFocus={() => onFocused(true)}
          onBlur={() => onFocused(false)}
          onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
            event.preventDefault()
            // Клавиша меню и Shift+F10 уже открыли меню по нажатию; браузер следом шлёт contextmenu — его пропускаем.
            if (!menu) onMenu({ x: event.clientX, y: event.clientY })
          }}
          onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
            if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
              event.preventDefault()
              fromKeys(event.currentTarget)
            }
          }}
          onDragStart={(event: DragEvent) => {
            event.dataTransfer.effectAllowed = 'move'
            event.dataTransfer.setData('text/plain', String(index))
            setDragging(true)
          }}
          onDragEnd={() => {
            setDragging(false)
            setOver(false)
          }}
          onDragOver={(event: DragEvent) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault()
            setOver(false)
            const from = Number(event.dataTransfer.getData('text/plain'))
            if (Number.isInteger(from)) onMove(from, index)
          }}
        >
          <span className="flow-grip" aria-hidden="true">
            <GripIcon />
          </span>
          {stage?.skip.trim() && (
            <span className="flow-node-skip" title="есть условие пропуска" aria-hidden="true">
              <SkipIcon />
            </span>
          )}
          {/* Исполнителя нет в базе: с таким именем флоу не сохранится, пока его не заменили. */}
          {missing && stage && (
            <span className="flow-node-missing" aria-label={`Исполнителя ${stage.agent.trim()} нет в базе`}>
              <MissingIcon />
            </span>
          )}
          <span className={`flow-node-mark flow-mark-${kind}`} aria-hidden="true">
            {stage ? <StageIcon icon={stage.icon} kind={kind} /> : <MissingIcon />}
          </span>
          <span className="flow-node-title">{title}</span>
          <span className="flow-node-executor">{stage ? executorOf(stage) || 'субагент' : 'стадии нет в базе'}</span>
        </button>
        {/* Клавиатурой стадия двигается кнопками: перетаскивание ей недоступно. */}
        <span className="flow-node-keys">
          <IconButton label={`Стадия ${number} выше`} disabled={number === 1} onClick={() => onMove(index, index - 1)}>
            <ChevronUpIcon />
          </IconButton>
          <IconButton label={`Стадия ${number} ниже`} disabled={last} onClick={() => onMove(index, index + 1)}>
            <ChevronDownIcon />
          </IconButton>
        </span>
      </div>
    </>
  )
}

type Point = { x: number; y: number }

/** Стадии, к которым пункт может вернуться: стоящие в этом флоу раньше него. */
const earlierStages = (draft: Draft, flow: DraftFlow, index: number) =>
  flow.entries
    .slice(0, index)
    .map((other) => draft.stages.find((s) => s.key === other.stage))
    .filter((s): s is DraftStage => s !== undefined)

/**
 * Меню блока стадии — всё, что правится у неё со схемы: возвраты в этом сценарии, сама стадия, её описание
 * и уход из сценария за чертой (B-202). Пункт, которому некуда вести, приглушён без подписи, как в меню строки.
 */
function EntryMenu({
  draft,
  flow,
  index,
  at,
  onClose,
  onReturns,
  onEditStage,
  onEditDescription,
  onRemove,
}: {
  draft: Draft
  flow: DraftFlow
  index: number
  at: Point
  onClose: (back: boolean) => void
  onReturns: () => void
  onEditStage: (stage: number) => void
  onEditDescription: (stage: number) => void
  onRemove: () => void
}) {
  const entry = flow.entries[index]
  const stage = draft.stages.find((s) => s.key === entry.stage) ?? null
  const title = entryTitle(draft, entry)
  // Возврат из файла виден и у первой стадии: его надо видеть, чтобы убрать.
  const returnable = earlierStages(draft, flow, index).length > 0 || entry.returns.length > 0

  return (
    <ContextMenu label={`Стадия «${title}»`} at={at} onClose={onClose}>
      <button type="button" role="menuitem" className="row-menu-item" disabled={!returnable} onClick={onReturns}>
        <ReturnIcon />
        Возвраты
      </button>
      <button
        type="button"
        role="menuitem"
        className="row-menu-item"
        disabled={!stage}
        onClick={() => stage && onEditStage(stage.key)}
      >
        <PencilIcon />
        Править стадию «{title}»
      </button>
      <button
        type="button"
        role="menuitem"
        className="row-menu-item"
        disabled={!stage}
        onClick={() => stage && onEditDescription(stage.key)}
      >
        <FileTextIcon />
        Редактировать описание
      </button>
      <div className="row-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="row-menu-item" onClick={onRemove}>
        <MinusIcon />
        Убрать из сценария
      </button>
    </ContextMenu>
  )
}

/**
 * Меню у точки на экране — в оформлении меню строки. Открывшись, отдаёт фокус первому пункту; стрелки ходят
 * по пунктам, Escape и Tab закрывают его с возвратом фокуса, щелчок мимо, прокрутка и смена размера окна — без.
 * Стоит поверх страницы, а не внутри схемы: иначе его обрезает прокрутка холста.
 */
function ContextMenu({
  label,
  at,
  onClose,
  children,
}: {
  label: string
  at: Point
  onClose: (back: boolean) => void
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState(at)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  const items = () => [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])]

  // Меню не вылезает за край окна: у правого и нижнего края встаёт от точки влево и вверх.
  useLayoutEffect(() => {
    const rect = box.current?.getBoundingClientRect()
    if (rect)
      setPlace({
        x: Math.max(8, Math.min(at.x, window.innerWidth - rect.width - 8)),
        y: Math.max(8, Math.min(at.y, window.innerHeight - rect.height - 8)),
      })
    items()[0]?.focus({ preventScroll: true })
  }, [at.x, at.y])

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) close.current(false)
    }
    // Прокрутку, которая случилась до меню, браузер присылает событием в следующем кадре — раньше колбэков
    // кадра: фокус, вернувшийся на блок, подкручивает схему к нему, и без этого меню, открытое сразу
    // после, закрылось бы само. Закрывает только прокрутка после первого кадра меню.
    let ready = false
    const frame = requestAnimationFrame(() => (ready = true))
    const away = () => ready && close.current(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', away)
    window.addEventListener('scroll', away, true)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', away)
      window.removeEventListener('scroll', away, true)
    }
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = items()
    const now = list.indexOf(document.activeElement as HTMLElement)
    const go = (index: number) => list[(index + list.length) % list.length]?.focus()
    if (event.key === 'ArrowDown') go(now + 1)
    else if (event.key === 'ArrowUp') go(now < 0 ? -1 : now - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(-1)
    else if (event.key === 'Escape' || event.key === 'Tab') onClose(true)
    else return
    event.preventDefault()
    event.stopPropagation()
  }

  return createPortal(
    <div
      ref={box}
      className="row-menu-popup flow-context-menu"
      role="menu"
      aria-label={label}
      style={{ left: place.x, top: place.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(event) => event.preventDefault()}
    >
      {children}
    </div>,
    document.body,
  )
}

/**
 * Окно возвратов стадии в этом сценарии — то, что у неё своё в нём; прежде жило в сайдбаре стадии (B-202).
 * Правки окно не пишет: они копятся в полосу сохранения, как у окна правки стадии.
 */
function ReturnsModal({
  draft,
  flow,
  index,
  onChange,
  onClose,
}: {
  draft: Draft
  flow: DraftFlow
  index: number
  onChange: (patch: Partial<DraftEntry>) => void
  onClose: () => void
}) {
  const entry = flow.entries[index]
  const stage = draft.stages.find((s) => s.key === entry.stage) ?? null
  const title = entryTitle(draft, entry)
  const kind = stage ? executorKind(stage) : 'agent'
  const errors = entryErrors(flow, index)
  const box = useRef<HTMLElement>(null)
  const done = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    ;(box.current?.querySelector<HTMLElement>('.flow-input, .flow-add-dashed') ?? done.current)?.focus()
  }, [])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section
        ref={box}
        className="modal-wizard flow-stage-modal flow-returns-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Возвраты стадии «${title}»`}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) onClose()
        }}
      >
        <div className="ask-head">
          <div className="ask-title">
            <span className={`flow-card-mark flow-mark-${kind}`} aria-hidden="true">
              {stage ? <StageIcon icon={stage.icon} kind={kind} /> : <MissingIcon />}
            </span>
            <h2 className="flow-stage-modal-title">Возвраты стадии «{title}»</h2>
            <span className="pf-project">сценарий «{flowName(flow)}»</span>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="ask-body">
          <ReturnsField
            returns={entry.returns}
            earlier={earlierStages(draft, flow, index)}
            onChange={(returns) => onChange({ returns })}
          />
          {errors.length > 0 && <p className="flow-step-error">Флоу не сохранить: {errors.join(', ')}.</p>}
        </div>

        <div className="modal-footer flow-stage-foot">
          <button type="button" ref={done} className="btn btn-primary flow-stage-done" onClick={onClose}>
            Готово
          </button>
        </div>
      </section>
    </div>
  )
}

const countWords: Record<number, string> = {
  3: 'трёх',
  4: 'четырёх',
  5: 'пяти',
  6: 'шести',
  7: 'семи',
  8: 'восьми',
  9: 'девяти',
  10: 'десяти',
}

/**
 * Правка стадии одна на все флоу, где она стоит: открытая со схемы, она задевает и другие сценарии, и окно
 * называет их — замечание оператора к критерию B-202. У стадии одного сценария задевать некого, строки нет.
 */
function scopeWarning(draft: Draft, stage: number): string | null {
  const names = draft.flows.filter((f) => f.entries.some((entry) => entry.stage === stage)).map((f) => `«${flowName(f)}»`)
  if (names.length < 2) return null
  const all = names.length === 2 ? 'в обоих' : `во всех ${countWords[names.length] ?? names.length}`
  return `Стадия стоит в сценариях ${names.slice(0, -1).join(', ')} и ${names.at(-1)} — правка изменит её ${all}.`
}

/** Сайдбар сценария (флоу) — по щелчку на узле старта: название, «когда» и удаление. На вкладке флоу зовётся сценарием (B-192). */
function FlowDrawer({
  flow,
  errors,
  onChange,
  onClose,
  onDelete,
}: {
  flow: DraftFlow
  errors: string[]
  onChange: (patch: Partial<DraftFlow>) => void
  onClose: () => void
  onDelete: () => void
}) {
  return (
    <aside
      className="flow-drawer"
      aria-label={`Сценарий «${flowName(flow)}»`}
      onKeyDown={(event) => event.key === 'Escape' && onClose()}
    >
      <div className="flow-drawer-head">
        <span className="flow-node-mark flow-mark-flow" aria-hidden="true">
          <FlowIcon />
        </span>
        <div className="flow-drawer-name">
          <h3>{flowName(flow)}</h3>
          <span className="flow-drawer-kind">сценарий</span>
        </div>
        <button type="button" className="btn btn-icon" aria-label="Закрыть сайдбар" title="Закрыть сайдбар" onClick={onClose}>
          <CloseIcon />
        </button>
      </div>

      <div className="flow-drawer-body">
        <label className="flow-field">
          <span>Название сценария</span>
          <input
            className="flow-input"
            aria-label="Название сценария"
            aria-invalid={!flow.name.trim()}
            value={flow.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </label>
        <label className="flow-field">
          <span>Когда</span>
          <textarea
            className="flow-input"
            aria-label="Когда брать сценарий"
            placeholder="какие задачи вести этим сценарием"
            rows={4}
            value={flow.when}
            onChange={(event) => onChange({ when: event.target.value })}
          />
        </label>
        {errors.length > 0 && <p className="flow-step-error">Флоу не сохранить: {errors.join(', ')}.</p>}
      </div>

      <div className="flow-drawer-foot">
        <button type="button" className="btn btn-danger flow-drawer-delete" onClick={onDelete}>
          <TrashIcon />
          Удалить сценарий
        </button>
      </div>
    </aside>
  )
}

/**
 * Имя субагента: выбор из заведённых в базе проекта. Того, кого в базе нет, агент не позовёт,
 * поэтому вписать имя руками панель не даёт — и с таким именем флоу не сохраняется.
 */
function PerformerField({
  stage,
  known,
  onChange,
  onPerformers,
}: {
  stage: DraftStage
  known: string[] | null
  onChange: (patch: Partial<DraftStage>) => void
  onPerformers?: () => void
}) {
  const agent = stage.agent.trim()
  const missing = missingPerformer(stage, known)
  // Список не прочитан — выбирать не из чего, но имя из файла показать надо: иначе поле пустое,
  // а на схеме исполнитель есть.
  const unread = known === null && agent.length > 0

  return (
    <div className="flow-field">
      <span>Имя субагента</span>
      <select
        className="flow-input mono"
        aria-label="Имя субагента"
        aria-invalid={!agent || missing}
        value={missing ? MISSING_AGENT : agent}
        onChange={(event) => {
          // Пункт ненайденного исполнителя — не выбор: он только показывает, что стоит в файле.
          if (event.target.value === MISSING_AGENT) return
          onChange({ agent: event.target.value })
        }}
      >
        {agent === '' && <option value="">выберите исполнителя</option>}
        {unread && <option value={agent}>{agent}</option>}
        {missing && <option value={MISSING_AGENT}>{agent} — в базе нет</option>}
        {(known ?? []).map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      {missing && <MissingNote agent={agent} onPerformers={onPerformers} />}
    </div>
  )
}

/**
 * Пункт ненайденного исполнителя: своё значение, а не имя из файла. С именем он спорил бы за выбор
 * с одноимённым заведённым — тем самым, которым стадию и чинят.
 */
const MISSING_AGENT = '__missing__'

/**
 * Имя, которого нет в базе проекта: под ним агент исполнителя не найдёт, поэтому флоу с такой стадией
 * не сохраняется. Имена вписывают не руками — выбирают из заведённых, а недостающего заводят рядом.
 */
function MissingNote({ agent, onPerformers }: { agent: string; onPerformers?: () => void }) {
  return (
    <p className="flow-missing" role="status">
      Исполнителя <span className="mono">{agent}</span> нет в базе проекта. Выберите исполнителя
      из заведённых.
      {onPerformers && (
        <button type="button" className="flow-link" onClick={onPerformers}>
          Завести исполнителя
        </button>
      )}
    </p>
  )
}

function FlowArrow() {
  return (
    <span className="flow-arrow" aria-hidden="true">
      <svg viewBox="0 0 12 32" fill="none">
        <path d="M6 0 V23" stroke="currentColor" strokeWidth="1.5" />
        <path d="M6 31 L2.5 23 h7 z" fill="currentColor" stroke="none" />
      </svg>
    </span>
  )
}

/**
 * Помощники стадии: исполнители проекта, которых оркестратор зовёт внутри своей стадии. Выбираются из
 * заведённых — как исполнитель стадии; оставшегося в файле, кого в базе нет, чип показывает янтарём.
 */
function HelpersField({
  stage,
  known,
  onChange,
}: {
  stage: DraftStage
  known: string[] | null
  onChange: (patch: Partial<DraftStage>) => void
}) {
  const taken = stage.helpers.map((name) => name.trim())
  const free = (known ?? []).filter((name) => !taken.includes(name))
  const missing = (name: string) => known !== null && !known.includes(name.trim())

  return (
    <div className="flow-field">
      <span>Помощники</span>
      {stage.helpers.length > 0 && (
        <div className="flow-chips">
          {stage.helpers.map((name) => (
            <span
              key={name}
              className={`flow-chip mono ${missing(name) ? 'flow-chip-missing' : ''}`}
              title={missing(name) ? `Исполнителя ${name.trim()} нет в базе` : undefined}
            >
              {name.trim()}
              <button
                type="button"
                className="flow-chip-remove"
                aria-label={`Убрать помощника ${name.trim()}`}
                onClick={() => onChange({ helpers: stage.helpers.filter((helper) => helper !== name) })}
              >
                <CloseIcon />
              </button>
            </span>
          ))}
        </div>
      )}
      {free.length > 0 && (
        <select
          className="flow-input mono"
          aria-label="Добавить помощника"
          value=""
          onChange={(event) => event.target.value && onChange({ helpers: [...stage.helpers, event.target.value] })}
        >
          <option value="">добавить исполнителя…</option>
          {free.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      )}
    </div>
  )
}

/**
 * Возвраты стадии в этом флоу: условие и стадия, к которой работа идёт заново. Цель выбирается из стадий,
 * стоящих раньше: вперёд возврата не бывает, и набирать название руками оператору незачем.
 */
function ReturnsField({
  returns,
  earlier,
  onChange,
}: {
  returns: DraftReturn[]
  earlier: DraftStage[]
  onChange: (returns: DraftReturn[]) => void
}) {
  const set = (index: number, patch: Partial<DraftReturn>) =>
    onChange(returns.map((back, i) => (i === index ? { ...back, ...patch } : back)))

  // Вернуться не к чему — раньше в сценарии нет стадий базы: пустого блока «Возвраты» нет — замечание оператора на приёмке B-192.
  // Возврат из файла всё же покажется: его надо видеть, чтобы убрать.
  if (earlier.length === 0 && returns.length === 0) return null

  return (
    <div className="flow-field">
      <span>Возвраты</span>
      {returns.map((back, index) => {
        const valid = earlier.some((stage) => stage.key === back.target)
        return (
          <div className="flow-return" key={index}>
            <div className="flow-return-row">
              <input
                className="flow-input"
                aria-label={`Условие возврата ${index + 1}`}
                placeholder="условие"
                aria-invalid={!back.condition.trim()}
                value={back.condition}
                onChange={(event) => set(index, { condition: event.target.value })}
              />
              <button
                type="button"
                className="btn btn-icon"
                aria-label={`Убрать возврат ${index + 1}`}
                title={`Убрать возврат ${index + 1}`}
                onClick={() => onChange(returns.filter((_, i) => i !== index))}
              >
                <CloseIcon />
              </button>
            </div>
            <div className="flow-return-row">
              <span className="flow-return-mark" aria-hidden="true">
                <ReturnIcon />
              </span>
              <select
                className="flow-input"
                aria-label={`Стадия возврата ${index + 1}`}
                aria-invalid={!valid}
                value={valid ? String(back.target) : ''}
                onChange={(event) => set(index, { target: event.target.value ? Number(event.target.value) : null })}
              >
                <option value="">стадия…</option>
                {earlier.map((stage) => (
                  <option key={stage.key} value={stage.key}>
                    {stageName(stage)}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )
      })}
      {earlier.length > 0 && (
        <button
          type="button"
          className="flow-add-dashed"
          onClick={() => onChange([...returns, { condition: '', target: null }])}
        >
          <PlusIcon />
          Добавить возврат
        </button>
      )}
    </div>
  )
}

/**
 * Описание стадии правится текстом в окне, а не полем — решение оператора, — по образцу задания исполнителя
 * (B-202): разметка показана оформленной, «Редактировать» открывает поле с исходным текстом. «Готово» кладёт
 * правку в черновик и возвращает к просмотру, «Отменить» — без правки; в базу описание ложится полосой
 * сохранения. Пустое описание открывается сразу в правке.
 */
function DescriptionEditor({
  title,
  description,
  warning,
  onClose,
  onDone,
}: {
  title: string
  description: string | null
  warning: string | null
  onClose: () => void
  onDone: (description: string | null) => void
}) {
  const empty = !description?.trim()
  const [editing, setEditing] = useState(empty)
  const [text, setText] = useState(description ?? '')
  // Открытое окно забирает фокус: иначе он остался бы на кнопке под подложкой.
  const close = useRef<HTMLButtonElement>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  useEffect(() => (editing ? field.current?.focus() : close.current?.focus()), [editing])

  function edit() {
    setText(description ?? '')
    setEditing(true)
  }

  function cancel() {
    // Пустое описание открывали, чтобы написать: без правки смотреть в нём нечего.
    if (empty) onClose()
    else {
      setText(description ?? '')
      setEditing(false)
    }
  }

  function done() {
    const next = text.replace(/\r\n/g, '\n')
    onDone(next.trim() ? next : null)
    if (next.trim()) setEditing(false)
    else onClose()
  }

  return (
    <div
      className="modal-overlay pf-task-overlay"
      // В правке промах мимо окна не закрывает его: набранное описание пропало бы без вопроса.
      onMouseDown={(event) => event.target === event.currentTarget && !editing && onClose()}
    >
      <div
        className="modal-wizard pf-task flow-description"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-description-title"
        tabIndex={-1}
        // Escape закрывает верхнее окно и в правке — без правки, как до B-202: так решено для всех окон раздела.
        onKeyDown={(event) => event.key === 'Escape' && onClose()}
      >
        <div className="ask-head">
          <div className="ask-title">
            <FileTextIcon />
            <h2 id="flow-description-title">Описание стадии «{title.trim() || 'без названия'}»</h2>
            <button type="button" className="btn btn-icon" aria-label="Закрыть описание" onClick={onClose}>
              <CloseIcon />
            </button>
          </div>
          {warning && <p className="flow-scope-warning">{warning}</p>}
        </div>
        <div className="ask-body">
          {editing ? (
            <textarea
              ref={field}
              className="custom-textarea pf-task-edit"
              aria-label="Описание стадии"
              spellCheck={false}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <Markdown className="pf-task-view" text={description ?? ''} />
          )}
        </div>
        <div className="modal-footer ask-footer">
          <div className="footer-right">
            {editing ? (
              <>
                <button type="button" className="btn" onClick={cancel}>
                  Отменить
                </button>
                <button type="button" className="btn btn-primary" onClick={done}>
                  Готово
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn" onClick={edit}>
                  <PencilIcon />
                  Редактировать
                </button>
                <button type="button" ref={close} className="btn" onClick={onClose}>
                  Закрыть
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** Значки на выбор; те же имена знает API, и чужого значка он не запомнит. */
const stageIcons: { id: string; label: string; icon: ReactNode }[] = [
  { id: 'target', label: 'цель', icon: <TargetIcon /> },
  { id: 'branch', label: 'ветка', icon: <BranchIcon /> },
  { id: 'code', label: 'код', icon: <CodeIcon /> },
  { id: 'check', label: 'проверка', icon: <CheckIcon /> },
  { id: 'base', label: 'база', icon: <DatabaseIcon /> },
]

function StageIcon({ icon, kind }: { icon: string; kind: string }) {
  const chosen = stageIcons.find((one) => one.id === icon)
  if (chosen) return chosen.icon
  return kind === 'operator' ? <OperatorIcon /> : kind === 'agent' ? <AgentIcon /> : <OrchestratorIcon />
}

/** Список значков: в нём сами значки, а не их названия — решение оператора. */
function IconPicker({ stage, onPick }: { stage: DraftStage; onPick: (icon: string) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onMouseDown = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    return () => document.removeEventListener('mousedown', onMouseDown)
  }, [open])

  const pick = (icon: string) => {
    onPick(icon)
    setOpen(false)
  }

  return (
    <div
      className="flow-icons"
      ref={box}
      onKeyDown={(event) => {
        // Escape закрывает сперва список, и дальше, к окну стадии, он не идёт.
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
      }}
    >
      <button
        type="button"
        className="flow-icon-toggle"
        aria-label="Значок стадии"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className={`flow-node-mark flow-mark-${executorKind(stage)}`} aria-hidden="true">
          <StageIcon icon={stage.icon} kind={executorKind(stage)} />
        </span>
        <ChevronDownIcon />
      </button>
      {open && (
        <div className="flow-icon-menu" role="group" aria-label="Значки стадии">
          <button
            type="button"
            className="flow-icon-btn"
            aria-label="Значок по исполнителю"
            title="по исполнителю"
            aria-pressed={!stage.icon}
            onClick={() => pick('')}
          >
            <StageIcon icon="" kind={executorKind(stage)} />
          </button>
          {stageIcons.map((one) => (
            <button
              key={one.id}
              type="button"
              className="flow-icon-btn"
              aria-label={`Значок «${one.label}»`}
              title={one.label}
              aria-pressed={stage.icon === one.id}
              onClick={() => pick(one.id)}
            >
              {one.icon}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * Стадия во флоу выбирается своим окном: новая или своя стадия базы, которой во флоу ещё нет.
 * Рамка — окна правки стадии и возвратов, стадии — списком строк в виде карточек вкладки «Стадии» (B-209).
 */
function AddStage({
  flow,
  stages,
  onPick,
  onCancel,
}: {
  flow: DraftFlow
  stages: DraftStage[]
  onPick: (choice: { stage: number } | 'new') => void
  onCancel: () => void
}) {
  const first = useRef<HTMLButtonElement>(null)
  // Фокус — в окне, иначе Escape его не закрывает: он ловится на самом окне.
  useEffect(() => first.current?.focus(), [])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <section
        className="modal-wizard flow-stage-modal flow-add-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Добавить стадию в сценарий «${flowName(flow)}»`}
        tabIndex={-1}
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <div className="ask-head">
          <div className="ask-title">
            <span className="flow-card-mark flow-mark-flow" aria-hidden="true">
              <PlusIcon />
            </span>
            <h2 className="flow-stage-modal-title">Добавить стадию</h2>
            <span className="pf-project">сценарий «{flowName(flow)}»</span>
            <button type="button" className="btn btn-icon" aria-label="Закрыть" onClick={onCancel}>
              <CloseIcon />
            </button>
          </div>
        </div>

        <div className="ask-body flow-add-body">
          <ul className="flow-add-list">
            <li>
              <button
                type="button"
                ref={first}
                className="flow-stage-card flow-stage-card-add"
                onClick={() => onPick('new')}
              >
                <PlusIcon />
                Новая стадия
              </button>
            </li>
          </ul>
          {stages.length > 0 && (
            <div role="group" aria-label="Стадии базы" className="flow-add-group">
              <div className="flow-add-label">Стадии базы</div>
              <ul className="flow-add-list">
                {stages.map((stage) => (
                  <li key={stage.key}>
                    <AddStageRow
                      title={stageName(stage)}
                      icon={stage.icon}
                      executor={toStage(stage).executor}
                      onClick={() => onPick({ stage: stage.key })}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div className="modal-footer flow-stage-foot">
          <button type="button" className="btn flow-stage-done" onClick={onCancel}>
            Отмена
          </button>
        </div>
      </section>
    </div>
  )
}

/** Строка окна добавления: значок цвета исполнителя, название и справа исполнитель, как на карточке стадии. */
function AddStageRow({
  title,
  icon,
  executor,
  onClick,
}: {
  title: string
  icon: string
  executor: string
  onClick: () => void
}) {
  const kind = executor === 'оркестратор' ? 'orchestrator' : executor === 'оператор' ? 'operator' : 'agent'
  return (
    <button type="button" className="flow-stage-card" onClick={onClick}>
      <span className={`flow-card-mark flow-mark-${kind}`} aria-hidden="true">
        <StageIcon icon={icon} kind={kind} />
      </span>
      <span className="flow-stage-item-title">{title}</span>
      <span className="flow-stage-card-foot">
        <span className="flow-stage-badge">
          {kind === 'agent' && executor ? (
            <>
              субагент <span className="mono">{executor}</span>
            </>
          ) : (
            executor || 'субагент'
          )}
        </span>
      </span>
    </button>
  )
}

function ConfirmSave({ flow, onCancel, onConfirm }: { flow: BaseFlow; onCancel: () => void; onConfirm: () => void }) {
  const confirm = useRef<HTMLButtonElement>(null)
  useEffect(() => confirm.current?.focus(), [])

  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onCancel()}>
      <div
        className="flow-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="flow-confirm-title"
        onKeyDown={(event) => event.key === 'Escape' && onCancel()}
      >
        <h3 id="flow-confirm-title">Сохранить флоу {flow.project}?</h3>
        <p className="text-sec">
          Флоу и стадии в базе будут переписаны и закоммичены одним коммитом. Следующая задача на проекте пойдёт уже
          по новому флоу.
        </p>
        <p className="flow-confirm-warning">
          На проекте {plural(flow.activeTasks, 'задача', 'задачи', 'задач')} в работе. Они дойдут по старым стадиям —
          новый флоу их не меняет.
        </p>
        <div className="flow-confirm-actions">
          <button type="button" className="bases-btn" onClick={onCancel}>
            Отмена
          </button>
          <button type="button" className="bases-btn bases-btn-primary" ref={confirm} onClick={onConfirm}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

function IconButton({
  label,
  disabled = false,
  pressed,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  pressed?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      className="flow-icon-btn"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  )
}

function GripIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="9" cy="6" r="1" />
      <circle cx="15" cy="6" r="1" />
      <circle cx="9" cy="12" r="1" />
      <circle cx="15" cy="12" r="1" />
      <circle cx="9" cy="18" r="1" />
      <circle cx="15" cy="18" r="1" />
    </svg>
  )
}

function ChevronUpIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="18 15 12 9 6 15" />
    </svg>
  )
}

function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  )
}

function MissingIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3 21 19 H3 z" />
      <path d="M12 9v4" />
      <path d="M12 16.5h.01" />
    </svg>
  )
}

function SkipIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" />
    </svg>
  )
}

/** Значок возврата — стрелка круга: он же стоит у дуги возврата на схеме. */
function ReturnIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9h11a4 4 0 0 1 0 8H9" />
      <polyline points="8 5 4 9 8 13" />
    </svg>
  )
}

function FileTextIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="14" y2="17" />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

function OrchestratorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4" y="8" width="16" height="12" rx="2" />
      <path d="M12 8V5" />
      <circle cx="12" cy="3.6" r="1.2" />
      <path d="M9 13h.01" />
      <path d="M15 13h.01" />
      <path d="M9 17h6" />
    </svg>
  )
}

function OperatorIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <polyline points="17 11 19 13 23 9" />
    </svg>
  )
}

function AgentIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z" />
      <path d="M18 16l.8 2.2L21 19l-2.2.8L18 22l-.8-2.2L15 19l2.2-.8z" />
    </svg>
  )
}

function TargetIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" />
    </svg>
  )
}

function BranchIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  )
}

function CodeIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9 11l3 3L22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  )
}

function DatabaseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3" />
      <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5" />
    </svg>
  )
}

export function FlowIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <line x1="6" y1="7" x2="6" y2="17" />
      <path d="M6 12h10" />
    </svg>
  )
}

function TickIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

/** Карандаш у пунктов правки: «Править стадию» в меню блока и «Редактировать» в окне описания. */
function PencilIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import PerformerModal, { type DraftEvent, type DraftFields } from './PerformerModal'
import { controlledStream, runningRequest, stubPanel, type PanelStub } from './agentPanelTesting'
import type { BasePerformers, Performer } from './Performers'

afterEach(() => vi.unstubAllGlobals())

const reviewer: Performer = {
  name: 'reviewer',
  description: 'Читает дифф ветки задачи.',
  model: 'opus',
  tools: 'Read, Glob, Grep',
  prompt: 'Ты читаешь дифф ветки целиком.',
  path: 'D:\\Projects\\app-knowledge\\agents\\reviewer.md',
}

const bases: BasePerformers[] = [
  {
    base: 'D:\\Projects\\app-knowledge',
    project: 'Agents Kit Web',
    directory: 'D:\\Projects\\app-knowledge\\agents',
    performers: [reviewer],
    error: null,
  },
]

const runner: DraftFields = {
  name: 'e2e-runner',
  description: 'Гоняет e2e.',
  model: 'sonnet',
  tools: null,
  prompt: 'Ты гоняешь e2e.',
}

function open(editing: Performer | null = null, onSaved = vi.fn(), panelBases = bases) {
  render(
    <PerformerModal bases={panelBases} initial={panelBases[0].base} editing={editing} onClose={vi.fn()} onSaved={onSaved} />,
  )
  return onSaved
}

/** Тело запроса, которым панель записала исполнителя. */
function saved(fetchMock: ReturnType<typeof vi.fn>) {
  const call = fetchMock.mock.calls.find(([url]) => url === '/api/performers')!
  return JSON.parse(String((call[1] as RequestInit).body))
}

/** Запись исполнителя отвечает заданным ответом; остальное — стенд панели с просьбой к агенту. */
function stubSave(response: () => Response) {
  const stream = controlledStream<DraftEvent>()
  const others: PanelStub['others'] = (url) => (url === '/api/performers' ? response() : null)
  const panel = stubPanel('performer', stream, { project: 'Agents Kit Web', others })
  return { stream, panel, fetchMock: fetch as unknown as ReturnType<typeof vi.fn> }
}

/** Новый исполнитель после ответа Чудо-Юдо: основу окну дал агент. */
async function drafted(stream: ReturnType<typeof controlledStream<DraftEvent>>, fields: DraftFields = runner) {
  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Гоняет e2e' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))
  await screen.findByRole('status')
  stream.send({ type: 'drafted', text: '---', fields })
  stream.close()
  await screen.findByText('Основу написал Чудо-Юдо')
  // Ответ становится основой эффектом, отдельным тиком после строки о нём: поле имени ждётся, а не берётся сразу.
  await screen.findByLabelText('Имя')
}

test('у нового имя, описание и задание видны сразу, а сохранить можно, когда есть имя и задание', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open()

  expect(screen.getByRole('heading', { name: 'Новый исполнитель' })).toBeInTheDocument()
  expect(screen.getByLabelText('Имя')).toHaveValue('')
  expect(screen.getByLabelText('Описание')).toHaveValue('')
  expect(screen.getByRole('button', { name: 'Написать задание' })).toBeInTheDocument()
  // Пока поля пусты, окно подсказывает просьбы примерами.
  expect(screen.getByText('Например')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'release-notes' } })
  expect(screen.queryByText('Например')).not.toBeInTheDocument()
  // Имя без задания — ещё не исполнитель.
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('нового можно завести целиком руками, без просьбы к Чудо-Юдо', async () => {
  const { fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  const onSaved = open()

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'release-notes' } })
  fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Собирает заметки к версии.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Написать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  fireEvent.change(within(task).getByRole('textbox', { name: 'Задание' }), { target: { value: 'Ты собираешь заметки.' } })
  fireEvent.click(within(task).getByRole('button', { name: 'Готово' }))
  fireEvent.click(within(task).getByRole('button', { name: 'Закрыть' }))

  const save = screen.getByRole('button', { name: 'Сохранить' })
  expect(save).toBeEnabled()
  fireEvent.click(save)

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('release-notes'))
  expect(saved(fetchMock)).toMatchObject({
    name: 'release-notes',
    description: 'Собирает заметки к версии.',
    prompt: 'Ты собираешь заметки.',
    editing: null,
  })
  // Просьбы к агенту не было.
  expect(fetchMock.mock.calls.some(([url]) => url === '/api/performers/draft')).toBe(false)
})

test('окно закрывается крестиком, отдельной «Отмены» нет', () => {
  stubSave(() => Response.json({ path: 'x' }))
  const onClose = vi.fn()
  render(<PerformerModal bases={bases} initial={bases[0].base} editing={null} onClose={onClose} onSaved={vi.fn()} />)

  expect(screen.queryByRole('button', { name: 'Отмена' })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Закрыть' }))
  expect(onClose).toHaveBeenCalled()
})

test('у нового проект выбирается выпадающим списком в шапке', () => {
  stubSave(() => Response.json({ path: 'x' }))
  const two = [...bases, { ...bases[0], base: 'D:\\Projects\\nota-knowledge', project: 'Nota', performers: [] }]
  open(null, vi.fn(), two)

  const select = screen.getByLabelText('Проект')
  expect(select.tagName).toBe('SELECT')
  fireEvent.change(select, { target: { value: 'D:\\Projects\\nota-knowledge' } })
  expect(select).toHaveValue('D:\\Projects\\nota-knowledge')
})

test('правка называет исполнителя в заголовке, и имя в окне не правится', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  const title = screen.getByRole('heading', { name: 'reviewer' })
  expect(title).toBeInTheDocument()
  expect(screen.getByText('Agents Kit Web')).toBeInTheDocument()
  expect(screen.queryByLabelText('Имя')).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Проект')).not.toBeInTheDocument()
})

test('описание правится полем прямо в окне, а сохраняется одной строкой', async () => {
  const { fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  const description = screen.getByLabelText('Описание')
  expect(description.tagName).toBe('TEXTAREA')
  expect(description).toHaveValue('Читает дифф ветки задачи.')
  expect(description).toHaveAttribute('rows', '4')

  // Enter новой строки не начинает: в файле описание — одна строка шапки.
  const enter = fireEvent.keyDown(description, { key: 'Enter' })
  expect(enter).toBe(false)
  // Вставленный текст с переводами строк сводится к одной строке.
  fireEvent.change(description, { target: { value: 'Читает дифф.\r\n  Возвращает вердикт.\n' } })
  expect(description).toHaveValue('Читает дифф. Возвращает вердикт. ')
  // Прочие переводы строк, что понимает разбор файла, сводятся так же.
  fireEvent.change(description, {
    target: { value: 'Читает\u2028дифф.\u0085Возвращает\fвердикт.\u2029' },
  })
  expect(description).toHaveValue('Читает дифф. Возвращает вердикт. ')
  fireEvent.change(description, { target: { value: 'Читает дифф. Возвращает вердикт.' } })
  expect(description).toHaveValue('Читает дифф. Возвращает вердикт.')

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(saved(fetchMock).description).toBe('Читает дифф. Возвращает вердикт.'))
})

test('отказ API описанию назван своей строкой, а не ошибкой имени', async () => {
  stubSave(() => Response.json({ problem: 'invalid-description' }, { status: 400 }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('Описание не годится')
})

test('«Только чтение» — переключатель: включён — набор закреплён, выключен — поле своих инструментов', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  const toggle = screen.getByRole('button', { name: 'Только чтение' })
  expect(toggle).toHaveAttribute('aria-pressed', 'true')
  expect(screen.queryByLabelText('Инструменты')).not.toBeInTheDocument()
  expect(screen.getByText('Read, Glob, Grep')).toBeInTheDocument()

  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('')

  fireEvent.change(screen.getByLabelText('Инструменты'), { target: { value: 'Read, Bash' } })
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Bash')
})

test('переключатель помнит свой список и не включается от набранного текста', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open({ ...reviewer, tools: 'Read, Bash' })

  const toggle = screen.getByRole('button', { name: 'Только чтение' })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Bash')

  // Включить и выключить — свой список возвращается, а не стирается во «все инструменты».
  fireEvent.click(toggle)
  fireEvent.click(toggle)
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Bash')

  // Набранный руками набор чтения переключатель сам не включает: поле под курсором не пропадает.
  fireEvent.change(screen.getByLabelText('Инструменты'), { target: { value: 'Read, Glob, Grep' } })
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(screen.getByLabelText('Инструменты')).toHaveValue('Read, Glob, Grep')
})

test('правка модели и инструментов записывает прежние описание и задание', async () => {
  const { fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  const onSaved = open(reviewer)

  fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'haiku' } })
  fireEvent.click(screen.getByRole('button', { name: 'Только чтение' }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(saved(fetchMock)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    name: 'reviewer',
    description: 'Читает дифф ветки задачи.',
    model: 'haiku',
    tools: null,
    prompt: 'Ты читаешь дифф ветки целиком.',
    editing: 'reviewer',
  })
})

test('разметка задания показана оформленной', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open({ ...reviewer, prompt: '## Что делаешь\n\n- читаешь **дифф**\n- сверяешь с `decisions`' })

  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))

  const task = screen.getByRole('dialog', { name: /Задание/ })
  expect(within(task).getByRole('heading', { name: 'Что делаешь' })).toBeInTheDocument()
  expect(within(task).getAllByRole('listitem')).toHaveLength(2)
  expect(within(task).getByText('дифф').tagName).toBe('STRONG')
  expect(within(task).getByText('decisions').tagName).toBe('CODE')
})

test('«Редактировать» открывает поле, «Готово» возвращает к просмотру с правкой, и она уходит в файл', async () => {
  const { fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))

  const field = within(task).getByRole('textbox', { name: 'Задание' })
  expect(field).toHaveValue('Ты читаешь дифф ветки целиком.')
  expect(field).toHaveFocus()
  fireEvent.change(field, { target: { value: 'Ты читаешь **только** дифф.' } })
  fireEvent.click(within(task).getByRole('button', { name: 'Готово' }))

  expect(within(task).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(task).getByText('только').tagName).toBe('STRONG')

  fireEvent.click(within(task).getByRole('button', { name: 'Закрыть' }))
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))
  await waitFor(() => expect(saved(fetchMock).prompt).toBe('Ты читаешь **только** дифф.'))
})

test('«Отменить» возвращает к просмотру без правки', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))
  fireEvent.change(within(task).getByRole('textbox', { name: 'Задание' }), { target: { value: 'Другое.' } })
  fireEvent.click(within(task).getByRole('button', { name: 'Отменить' }))

  expect(within(task).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(task).getByText('Ты читаешь дифф ветки целиком.')).toBeInTheDocument()
  // Открытая заново правка начинается с того, что в задании, а не с отменённого.
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))
  expect(within(task).getByRole('textbox', { name: 'Задание' })).toHaveValue('Ты читаешь дифф ветки целиком.')
})

test('в правке задания ни клик мимо окна, ни Escape его не закрывают, а в просмотре клик закрывает', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))
  fireEvent.change(within(task).getByRole('textbox', { name: 'Задание' }), { target: { value: 'Набрано руками.' } })

  const overlay = task.parentElement!
  fireEvent.mouseDown(overlay)
  // Окно осталось в документе, и набранное в нём цело.
  expect(screen.getByRole('dialog', { name: /Задание/ })).toBe(task)
  expect(within(task).getByRole('textbox', { name: 'Задание' })).toHaveValue('Набрано руками.')
  // Escape в правке тоже не закрывает окно.
  fireEvent.keyDown(window, { key: 'Escape' })
  expect(screen.getByRole('dialog', { name: /Задание/ })).toBe(task)
  expect(within(task).getByRole('textbox', { name: 'Задание' })).toHaveValue('Набрано руками.')

  fireEvent.click(within(task).getByRole('button', { name: 'Готово' }))
  fireEvent.mouseDown(overlay)
  expect(screen.queryByRole('dialog', { name: /Задание/ })).not.toBeInTheDocument()
})

test('пустое задание открывается кнопкой «Написать задание» сразу в правке', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open({ ...reviewer, prompt: '' })

  fireEvent.click(screen.getByRole('button', { name: 'Написать задание' }))

  const task = screen.getByRole('dialog', { name: /Задание/ })
  expect(within(task).getByRole('textbox', { name: 'Задание' })).toHaveFocus()
  fireEvent.change(within(task).getByRole('textbox', { name: 'Задание' }), { target: { value: 'Ты гоняешь проверки.' } })
  fireEvent.click(within(task).getByRole('button', { name: 'Готово' }))
  fireEvent.click(within(task).getByRole('button', { name: 'Закрыть' }))

  expect(screen.getByRole('button', { name: 'Показать задание' })).toBeInTheDocument()
})

test('у заведённого с пустым заданием модель и инструменты всё равно сохраняются', async () => {
  const { fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  const onSaved = open({ ...reviewer, description: null, prompt: '' })

  // Файл завели в базе руками, без тела: поле описания пусто, а сохранение не заперто.
  expect(screen.getByLabelText('Описание')).toHaveValue('')
  expect(screen.queryByRole('button', { name: 'Показать задание' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Написать задание' })).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'sonnet' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(saved(fetchMock)).toMatchObject({ model: 'sonnet', prompt: '', description: null })
})

test('задание открывается кнопкой своим окном, оформленным markdown', () => {
  stubSave(() => Response.json({ path: 'x' }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))

  const task = screen.getByRole('dialog', { name: /Задание/ })
  expect(within(task).getByText('Ты читаешь дифф ветки целиком.')).toBeInTheDocument()
  // В просмотре поля нет: правку открывает одна кнопка «Редактировать».
  expect(within(task).queryByRole('textbox')).not.toBeInTheDocument()
  expect(within(task).getByRole('button', { name: 'Редактировать' })).toBeInTheDocument()

  // Окно задания сверху: фокус в нём, а окно исполнителя под ним недоступно.
  expect(within(task).getByRole('button', { name: 'Закрыть' })).toHaveFocus()
  expect(screen.getByRole('dialog', { name: 'reviewer', hidden: true })).toHaveAttribute('inert')

  fireEvent.click(within(task).getByRole('button', { name: 'Закрыть' }))
  expect(screen.queryByRole('dialog', { name: /Задание/ })).not.toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'reviewer' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Показать задание' })).toHaveFocus()
})

test('просьба к Чудо-Юдо идёт из окна, а его ответ становится основой', async () => {
  const { stream, panel } = stubSave(() => Response.json({ path: 'x' }))
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Читает дифф ветки и возвращает вердикт' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  await waitFor(() => expect(panel.posts).toHaveLength(1))
  expect(panel.posts[0]).toEqual({
    url: '/api/performers/draft',
    body: {
      base: 'D:\\Projects\\app-knowledge',
      wish: 'Читает дифф ветки и возвращает вердикт',
      current: null,
    },
  })

  stream.send({ type: 'step', text: 'читает scenarios.md' })
  expect(await screen.findByText('читает scenarios.md')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('заводит исполнителя')

  stream.send({
    type: 'drafted',
    text: '---',
    fields: {
      name: 'reviewer-2',
      description: 'Читает дифф ветки задачи.',
      model: 'opus',
      tools: 'Read, Glob, Grep',
      prompt: 'Ты читаешь дифф ветки целиком.',
    },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Имя')).toHaveValue('reviewer-2'))
  expect(screen.getByLabelText('Описание')).toHaveTextContent('Читает дифф ветки задачи.')
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
  expect(screen.getByRole('button', { name: 'Только чтение' })).toHaveAttribute('aria-pressed', 'true')
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeEnabled()
  // Файл ещё не записан: его пишет «Сохранить».
  expect(panel.posts.map((post) => post.url)).toEqual(['/api/performers/draft'])
})

test('имя нового, предложенное агентом, можно поправить до записи', async () => {
  const { stream, fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  const onSaved = open()
  await drafted(stream)

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'e2e' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('e2e'))
  expect(saved(fetchMock)).toEqual({
    base: 'D:\\Projects\\app-knowledge',
    name: 'e2e',
    description: 'Гоняет e2e.',
    model: 'sonnet',
    tools: null,
    prompt: 'Ты гоняешь e2e.',
    editing: null,
  })
})

test('модель и инструменты, выбранные до ответа, ответ агента не перетирает', async () => {
  const { stream } = stubSave(() => Response.json({ path: 'x' }))
  open()

  fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'haiku' } })
  fireEvent.click(screen.getByRole('button', { name: 'Только чтение' }))
  await drafted(stream, { ...runner, model: 'opus', tools: 'Read, Bash' })

  expect(screen.getByLabelText('Модель')).toHaveValue('haiku')
  expect(screen.getByRole('button', { name: 'Только чтение' })).toHaveAttribute('aria-pressed', 'true')
})

test('окно задания нового со стёртым именем озаглавлено без пустого места', async () => {
  const { stream } = stubSave(() => Response.json({ path: 'x' }))
  open()
  await drafted(stream)

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))

  expect(screen.getByRole('dialog', { name: 'Задание исполнителя' })).toBeInTheDocument()
})

test('имя, занятое у проекта, окно бережёт и не даёт сохранить', async () => {
  const { stream } = stubSave(() => Response.json({ path: 'x' }))
  open()
  await drafted(stream)

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'reviewer' } })

  // Набор исполнителей свой у базы проекта: молча переписать заведённого в ней нельзя.
  expect(screen.getByText(/Исполнитель с таким именем у этого проекта уже есть/)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('«Вернуть как было» возвращает то, что стояло до ответа агента', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Пусть ещё сверяет с критериями' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))

  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'reviewer', description: 'Новое описание.', model: null, tools: null, prompt: 'Новое задание.' },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveValue('Новое описание.'))

  fireEvent.click(screen.getByRole('button', { name: 'вернуть как было' }))

  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveValue('Читает дифф ветки задачи.'))
  expect(screen.getByLabelText('Модель')).toHaveValue('opus')
})

test('ответ агента заменяет поправленные руками описание и задание, а «вернуть как было» возвращает правку', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText('Описание'), { target: { value: 'Поправлено руками.' } })
  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))
  fireEvent.change(within(task).getByRole('textbox', { name: 'Задание' }), { target: { value: 'Задание руками.' } })
  fireEvent.click(within(task).getByRole('button', { name: 'Готово' }))
  fireEvent.click(within(task).getByRole('button', { name: 'Закрыть' }))

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Перепиши короче' } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))
  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'reviewer', description: 'Описание агента.', model: null, tools: null, prompt: 'Задание агента.' },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveValue('Описание агента.'))
  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  expect(within(screen.getByRole('dialog', { name: /Задание/ })).getByText('Задание агента.')).toBeInTheDocument()
  fireEvent.click(within(screen.getByRole('dialog', { name: /Задание/ })).getByRole('button', { name: 'Закрыть' }))

  fireEvent.click(screen.getByRole('button', { name: 'вернуть как было' }))

  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveValue('Поправлено руками.'))
  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  expect(within(screen.getByRole('dialog', { name: /Задание/ })).getByText('Задание руками.')).toBeInTheDocument()
})

test('ответ агента при открытом задании попадает и в правку, а не только в просмотр', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Перепиши короче' } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))
  await screen.findByRole('status')
  // Пока агент работает, оператор открыл задание: окно висит, когда приходит ответ.
  fireEvent.click(screen.getByRole('button', { name: 'Показать задание' }))
  const task = screen.getByRole('dialog', { name: /Задание/ })
  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'reviewer', description: 'Описание агента.', model: null, tools: null, prompt: 'Задание агента.' },
  })
  stream.close()

  expect(await within(task).findByText('Задание агента.')).toBeInTheDocument()
  fireEvent.click(within(task).getByRole('button', { name: 'Редактировать' }))
  expect(within(task).getByRole('textbox', { name: 'Задание' })).toHaveValue('Задание агента.')
})

test('правка не меняет имя, даже если агент вернул другое', async () => {
  const { stream, fetchMock } = stubSave(() => Response.json({ path: 'x' }))
  const onSaved = open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Пусть ещё сверяет' } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))
  await screen.findByRole('status')
  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'diff-judge', description: 'Судит дифф.', model: 'opus', tools: null, prompt: 'Новое задание.' },
  })
  stream.close()
  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveTextContent('Судит дифф.'))

  expect(screen.getByRole('heading', { name: 'reviewer' })).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  // Другое имя бэкенд счёл бы переименованием: записал бы новый файл и удалил reviewer.
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(saved(fetchMock)).toMatchObject({ name: 'reviewer', editing: 'reviewer', prompt: 'Новое задание.' })
})

test('окно правки не подхватывает просьбу о новом исполнителе', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream, {
    running: runningRequest('performer', 'Ревьюер ветки', bases[0].base, 'Agents Kit Web'),
  })
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
  open(reviewer)
  stream.send({ type: 'drafted', text: '---', fields: runner })
  stream.close()

  // Окно спросило о просьбах, но ответ про другого исполнителя в окно reviewer не лёг и просьбу не забрал.
  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/agent/requests'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.getByLabelText('Описание')).toHaveTextContent('Читает дифф ветки задачи.')
  expect(screen.queryByText('Основу написал Чудо-Юдо')).not.toBeInTheDocument()
  expect(panel.deletes).toEqual([])
  // Разом идёт одна просьба этого вида: окно предупреждает, что его просьба остановит чужую.
  expect(screen.getByText(/сейчас занят про нового исполнителя Agents Kit Web: новая просьба отсюда остановит его/)).toBeInTheDocument()
})

test('открытое заново окно правки подхватывает свою просьбу и её итог', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream, {
    running: runningRequest('performer', 'Пусть ещё сверяет', bases[0].base, 'Agents Kit Web', 0, 'reviewer'),
  })
  open(reviewer)

  expect(await screen.findByText('Пусть ещё сверяет')).toBeInTheDocument()
  stream.send({
    type: 'drafted',
    text: '---',
    fields: { name: 'reviewer', description: 'Сверяет с критериями.', model: 'opus', tools: null, prompt: 'Новое.' },
  })
  stream.close()

  await waitFor(() => expect(screen.getByLabelText('Описание')).toHaveTextContent('Сверяет с критериями.'))
  expect(screen.getByRole('heading', { name: 'reviewer' })).toBeInTheDocument()
})

test('окно нового не подхватывает просьбу о правке заведённого', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream, {
    running: runningRequest('performer', 'Пусть ещё сверяет', bases[0].base, 'Agents Kit Web', 0, 'reviewer'),
  })
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
  open()

  await waitFor(() => expect(fetchMock.mock.calls.map(([url]) => url)).toContain('/api/agent/requests'))
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(screen.queryByText('Пусть ещё сверяет')).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByText(/сейчас занят про исполнителя reviewer Agents Kit Web/)).toBeInTheDocument()

  // Своя просьба чужую останавливает: предупреждать больше не о чем.
  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Ревьюер ветки' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))
  await waitFor(() => expect(screen.queryByText(/сейчас занят про исполнителя/)).not.toBeInTheDocument())
})

test('нынешние поля уходят агенту, когда исполнителя правят', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream)
  open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), {
    target: { value: 'Пусть не чинит найденное сам' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))

  await waitFor(() => expect(panel.posts).toHaveLength(1))
  expect(panel.posts[0].body.current).toEqual({
    name: 'reviewer',
    description: 'Читает дифф ветки задачи.',
    model: 'opus',
    tools: 'Read, Glob, Grep',
    prompt: 'Ты читаешь дифф ветки целиком.',
  })
})

test('Чудо-Юдо недоступен — причина одной строкой, у нового сохранить нечего', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream)
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Ревьюер ветки' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  stream.send({ type: 'error', text: 'кончился лимит подписки', output: 'Готово!' })
  stream.close()

  const line = await screen.findByRole('alert')
  expect(line).toHaveTextContent('Чудо-Юдо не ответил: кончился лимит подписки')
  // Вывод агента читается подсказкой, а не второй строкой.
  expect(line).toHaveAttribute('title', 'Готово!')
  expect(screen.queryByText('Готово!')).not.toBeInTheDocument()
  expect(screen.getByLabelText(/Просьба к Чудо-Юдо/)).toHaveValue('Ревьюер ветки')
  expect(screen.getByRole('button', { name: 'Попросить снова' })).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Сохранить' })).toBeDisabled()
})

test('без Чудо-Юдо модель и инструменты правятся и сохраняются, основа остаётся прежней', async () => {
  const stream = controlledStream<DraftEvent>()
  const others: PanelStub['others'] = (url) => (url === '/api/performers' ? Response.json({ path: 'x' }) : null)
  stubPanel('performer', stream, { others })
  const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>
  const onSaved = open(reviewer)

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Пусть ещё сверяет' } })
  fireEvent.click(screen.getByRole('button', { name: 'Переписать с помощью Чудо-Юдо' }))
  stream.send({ type: 'error', text: 'кончился лимит подписки' })
  stream.close()
  await screen.findByRole('alert')

  fireEvent.change(screen.getByLabelText('Модель'), { target: { value: 'sonnet' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('reviewer'))
  expect(saved(fetchMock)).toMatchObject({
    model: 'sonnet',
    description: 'Читает дифф ветки задачи.',
    prompt: 'Ты читаешь дифф ветки целиком.',
  })
})

test('негодное имя объясняется словами, а набранное остаётся', async () => {
  const { stream } = stubSave(() => Response.json({ problem: 'invalid-name' }, { status: 400 }))
  open()
  await drafted(stream)

  fireEvent.change(screen.getByLabelText('Имя'), { target: { value: 'Ревью Диффа' } })
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText(/строчная латиница/)).toBeInTheDocument()
  expect(screen.getByLabelText('Имя')).toHaveValue('Ревью Диффа')
})

test('занятое имя, о котором сказал API, объяснено словами', async () => {
  stubSave(() => Response.json({ problem: 'name-taken' }, { status: 409 }))
  open(reviewer)

  // Имя заняли, пока окно было открыто: список раздела о нём ещё не знает, а API уже знает.
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByRole('alert')).toHaveTextContent('уже есть')
})

test('имя, занятое файлом самого проекта, названо вместе с копией', async () => {
  stubSave(() => Response.json({ problem: 'name-in-project', detail: 'D:\\Projects\\app' }, { status: 409 }))
  open(reviewer)

  // Такой файл ведёт команда проекта, кит его не трогает — исполнитель в эту копию не приедет
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('уже есть в копии D:\\Projects\\app')
  expect(alert).toHaveTextContent('Выберите другое имя')
})

test('отказ базы принять коммит показан её словами', async () => {
  stubSave(() => Response.json({ problem: 'not-committed', detail: 'сверка: база не приняла' }, { status: 409 }))
  const onSaved = open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  // Что сказала база, оператор читает дословно, а окно остаётся открытым
  const alert = await screen.findByRole('alert')
  expect(alert).toHaveTextContent('База не приняла исполнителя')
  expect(alert).toHaveTextContent('сверка: база не приняла')
  expect(onSaved).not.toHaveBeenCalled()
})

test('незнакомый отказ API назван своим именем, а не чужой причиной', async () => {
  stubSave(() => Response.json({ problem: 'что-то-новое' }, { status: 409 }))
  open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  // Иначе новый отказ API показывался бы прежним текстом, и причина была бы неверной
  expect(await screen.findByRole('alert')).toHaveTextContent('панель не поняла отказ «что-то-новое»')
})

test('без связи с API окно говорит об этом и не закрывается', async () => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('failed to fetch')))
  const onSaved = open(reviewer)

  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }))

  expect(await screen.findByText(/нет связи с API/)).toBeInTheDocument()
  expect(onSaved).not.toHaveBeenCalled()
})

test('«Отменить» убирает просьбу из панели', async () => {
  const stream = controlledStream<DraftEvent>()
  const panel = stubPanel('performer', stream)
  open()

  fireEvent.change(screen.getByLabelText(/Просьба к Чудо-Юдо/), { target: { value: 'Ревьюер ветки' } })
  fireEvent.click(screen.getByRole('button', { name: 'Завести с помощью Чудо-Юдо' }))

  fireEvent.click(await screen.findByRole('button', { name: 'отменить' }))

  await waitFor(() => expect(panel.deletes).toEqual(['/api/agent/performer']))
})

test('идущая просьба подхватывается открытым заново окном', async () => {
  const stream = controlledStream<DraftEvent>()
  stubPanel('performer', stream, {
    running: runningRequest('performer', 'Ревьюер ветки', 'D:\\Projects\\app-knowledge', 'Agents Kit Web'),
  })
  open()

  expect(await screen.findByText('Ревьюер ветки')).toBeInTheDocument()
  stream.send({ type: 'step', text: 'читает scenarios.md' })
  expect(await screen.findByText('читает scenarios.md')).toBeInTheDocument()
})

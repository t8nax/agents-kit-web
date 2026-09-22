import { fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import AgentBar from './AgentBar'
import type { AgentRequestSummary } from './agentRequest'

afterEach(() => {
  vi.unstubAllGlobals()
})

const asking: AgentRequestSummary = {
  kind: 'ask',
  id: 'r1',
  base: 'D:\\Projects\\app-knowledge',
  project: 'Agents Kit Web',
  text: 'Что решено про опрос?',
  elapsedMs: 72000,
  state: 'running',
}

const rewriting: AgentRequestSummary = {
  kind: 'flow',
  id: 'r2',
  base: 'D:\\Projects\\nota-knowledge',
  project: 'Nota',
  text: 'Добавь ревью перед мержем',
  elapsedMs: 5000,
  state: 'done',
}

function stubRequests(requests: AgentRequestSummary[]) {
  const fetchMock = vi.fn(() => Promise.resolve(Response.json(requests)))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('пока просьб нет, шапка молчит', async () => {
  const fetchMock = stubRequests([])
  render(<AgentBar onOpen={() => {}} />)

  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/agent/requests'))
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

test('идущая просьба названа в шапке вместе со временем и открывает своё окно', async () => {
  stubRequests([asking])
  const opened: AgentRequestSummary[] = []
  render(<AgentBar onOpen={(request) => opened.push(request)} />)

  const chip = await screen.findByRole('button', { name: /Чудо-Юдо читает базу Agents Kit Web/ })
  expect(within(chip).getByLabelText('Просьба идёт')).toHaveTextContent('1:12')

  fireEvent.click(chip)

  expect(opened).toEqual([asking])
})

test('дождавшийся итог показан своими словами', async () => {
  stubRequests([rewriting])
  render(<AgentBar onOpen={() => {}} />)

  expect(await screen.findByRole('button', { name: /Чудо-Юдо переписал стадии Nota/ })).toBeInTheDocument()
})

test('несколько просьб разворачиваются списком, строка открывает свою', async () => {
  stubRequests([asking, rewriting])
  const opened: AgentRequestSummary[] = []
  render(<AgentBar onOpen={(request) => opened.push(request)} />)

  fireEvent.click(await screen.findByRole('button', { name: /Чудо-Юдо занят/ }))

  const list = await screen.findByRole('list', { name: 'Просьбы' })
  expect(within(list).getByText('Чудо-Юдо читает базу Agents Kit Web')).toBeInTheDocument()
  expect(within(list).getByText('Добавь ревью перед мержем')).toBeInTheDocument()
  expect(within(list).getByText('готов')).toBeInTheDocument()

  fireEvent.click(within(list).getByText('Чудо-Юдо переписал стадии Nota'))

  expect(opened).toEqual([rewriting])
  expect(screen.queryByRole('list', { name: 'Просьбы' })).not.toBeInTheDocument()
})

test('просьба об исполнителе названа в шапке своими словами', async () => {
  stubRequests([
    {
      kind: 'performer',
      id: 'r3',
      base: 'D:\\Projects\\app-knowledge',
      project: 'Agents Kit Web',
      text: 'Читает дифф ветки и возвращает вердикт',
      elapsedMs: 4000,
      state: 'running',
    },
  ])
  render(<AgentBar onOpen={() => {}} />)

  expect(
    await screen.findByRole('button', { name: /Чудо-Юдо заводит исполнителя Agents Kit Web/ }),
  ).toBeInTheDocument()
})

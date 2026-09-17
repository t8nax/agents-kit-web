import { expect, test } from 'vitest'
import { splitTask } from './taskTitle'

test('отделяет номер записи бэклога от заголовка', () => {
  expect(splitTask('B-24 Номер задачи и её заголовок — отдельные колонки таблицы')).toEqual({
    number: 'B-24',
    title: 'Номер задачи и её заголовок — отдельные колонки таблицы',
  })
})

test('задача не из бэклога остаётся заголовком целиком', () => {
  expect(splitTask('Хук подачи бьёт кириллицу')).toEqual({ number: null, title: 'Хук подачи бьёт кириллицу' })
})

test('номер без заголовка или слово, похожее на номер, номером не считаются', () => {
  expect(splitTask('B-24')).toEqual({ number: null, title: 'B-24' })
  expect(splitTask('B-24x Заголовок')).toEqual({ number: null, title: 'B-24x Заголовок' })
  expect(splitTask('Про B-24 и B-11')).toEqual({ number: null, title: 'Про B-24 и B-11' })
})

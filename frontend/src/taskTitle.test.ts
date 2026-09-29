import { expect, test } from 'vitest'
import { normalizeNumber, numberLetters, splitTask, splitTrackerTask } from './taskTitle'

test('отделяет номер записи бэклога от заголовка', () => {
  expect(splitTask('B-24 Номер задачи и её заголовок — отдельные колонки таблицы', 'B')).toEqual({
    number: 'B-24',
    title: 'Номер задачи и её заголовок — отдельные колонки таблицы',
  })
})

test('отделяет номер с буквами другого проекта', () => {
  expect(splitTask('ORD-12 Выгрузка заказов за период', 'ORD')).toEqual({ number: 'ORD-12', title: 'Выгрузка заказов за период' })
  expect(splitTask('A1-3 Буквы с цифрой', 'A1')).toEqual({ number: 'A1-3', title: 'Буквы с цифрой' })
})

test('номер кириллицей или строчными — тот же номер', () => {
  expect(splitTask('В-7 Набран руками', 'B')).toEqual({ number: 'B-7', title: 'Набран руками' })
  expect(splitTask('ord-12 Строчными', 'ORD')).toEqual({ number: 'ORD-12', title: 'Строчными' })
})

test('слово с чужими буквами номером не считается', () => {
  expect(splitTask('UTF-8 в именах файлов ломает выгрузку', 'ORD')).toEqual({
    number: null,
    title: 'UTF-8 в именах файлов ломает выгрузку',
  })
  expect(splitTask('B-7 Чужими буквами', 'ORD')).toEqual({ number: null, title: 'B-7 Чужими буквами' })
})

test('без букв проекта номер не отделяется', () => {
  expect(splitTask('B-24 Заголовок', null)).toEqual({ number: null, title: 'B-24 Заголовок' })
  expect(splitTask('B-24 Заголовок', undefined)).toEqual({ number: null, title: 'B-24 Заголовок' })
})

test('задача не из бэклога остаётся заголовком целиком', () => {
  expect(splitTask('Хук подачи бьёт кириллицу', 'B')).toEqual({ number: null, title: 'Хук подачи бьёт кириллицу' })
})

test('номер без заголовка или слово, похожее на номер, номером не считаются', () => {
  expect(splitTask('B-24', 'B')).toEqual({ number: null, title: 'B-24' })
  expect(splitTask('B-24x Заголовок', 'B')).toEqual({ number: null, title: 'B-24x Заголовок' })
  expect(splitTask('Про B-24 и B-11', 'B')).toEqual({ number: null, title: 'Про B-24 и B-11' })
})

test('отделяет номер задачи трекера проекта вместе с именем трекера', () => {
  expect(splitTrackerTask('GitHub #37 Оплата падает', 'GitHub')).toEqual({ number: 'GitHub #37', title: 'Оплата падает' })
  expect(splitTrackerTask('Jira PAY-7 Выгрузка отчётов', 'Jira')).toEqual({ number: 'Jira PAY-7', title: 'Выгрузка отчётов' })
  expect(splitTrackerTask('youtrack abc-12 Строчными', 'YouTrack')).toEqual({ number: 'YouTrack ABC-12', title: 'Строчными' })
  expect(splitTrackerTask('github#37 Без пробела', 'GitHub')).toEqual({ number: 'GitHub #37', title: 'Без пробела' })
  expect(splitTrackerTask('Трекер.Свой X-1 Своё имя', 'Трекер.Свой')).toEqual({ number: 'Трекер.Свой X-1', title: 'Своё имя' })
})

test('номер чужого трекера или без трекера проекта не отделяется', () => {
  expect(splitTrackerTask('GitHub #37 Оплата падает', 'Jira')).toEqual({ number: null, title: 'GitHub #37 Оплата падает' })
  expect(splitTrackerTask('GitHub #37 Оплата падает', null)).toEqual({ number: null, title: 'GitHub #37 Оплата падает' })
  expect(splitTrackerTask('GitHub #37 Оплата падает', undefined)).toEqual({ number: null, title: 'GitHub #37 Оплата падает' })
  expect(splitTrackerTask('GitHub #37', 'GitHub')).toEqual({ number: null, title: 'GitHub #37' })
  expect(splitTrackerTask('GitHubber #37 Не то имя', 'GitHub')).toEqual({ number: null, title: 'GitHubber #37 Не то имя' })
  expect(splitTrackerTask('B-24 Запись бэклога', 'GitHub')).toEqual({ number: null, title: 'B-24 Запись бэклога' })
})

test('номер по правилу кита', () => {
  expect(normalizeNumber(' тех-4 ')).toBe('TEX-4')
  expect(normalizeNumber('1B-2')).toBeNull()
  expect(normalizeNumber('ABCDEFGHIJK-2')).toBeNull()
  expect(normalizeNumber('Заказ-2')).toBeNull()
  expect(numberLetters('ord-12')).toBe('ORD')
  expect(numberLetters('Про')).toBeNull()
})

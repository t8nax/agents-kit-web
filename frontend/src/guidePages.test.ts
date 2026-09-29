import { expect, test } from 'vitest'
import { guideFiles, guidePages, guideText, pageLink } from './guidePages'

// Критерии 2 и 3 B-306: оглавление и файлы руководства сходятся, а ссылки между страницами не битые.

test('у каждой страницы оглавления есть файл с заголовком, и каждый файл руководства стоит в оглавлении', () => {
  const listed = guidePages.map((page) => page.file)
  expect(new Set(listed).size).toBe(listed.length)
  for (const file of listed) expect(guideText(file), file).toMatch(/^# \S/m)
  expect([...guideFiles()].sort()).toEqual([...listed].sort())
})

test('каждая ссылка страницы ведёт на существующую страницу руководства или на внешний адрес', () => {
  const broken: string[] = []
  let checked = 0
  for (const file of guideFiles()) {
    for (const [, href] of guideText(file)!.matchAll(/\]\(([^)\s]+)\)/g)) {
      checked++
      if (/^https?:\/\//.test(href)) continue
      const target = pageLink(href)
      if (!target || guideText(target) === undefined) broken.push(`${file} → ${href}`)
    }
  }
  // Разбор ссылок не должен молча ничего не находить: страницы ссылаются друг на друга десятки раз
  expect(checked).toBeGreaterThan(20)
  expect(broken).toEqual([])
})

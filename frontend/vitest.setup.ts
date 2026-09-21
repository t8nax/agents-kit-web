import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach, vi } from 'vitest'

// Под нагрузкой полного прогона ожиданиям не хватало секунды по умолчанию — чаще всего первому
// тесту файла, который несёт подготовку всего файла, — и прогон краснел без поломки (B-164).
// Запас один на findBy и waitFor библиотеки и на vi.waitFor: у vi.waitFor своя секунда, общей
// настройки у vitest нет, а заменить его нечем — он опрашивает и там, где setInterval подделан.
const WAIT_TIMEOUT = 5000
configure({ asyncUtilTimeout: WAIT_TIMEOUT })
const waitFor = vi.waitFor
vi.waitFor = (callback, options) =>
  waitFor(callback, typeof options === 'number' ? options : { timeout: WAIT_TIMEOUT, ...options })

afterEach(() => {
  cleanup()
})

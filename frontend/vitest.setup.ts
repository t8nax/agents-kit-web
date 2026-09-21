import '@testing-library/jest-dom/vitest'
import { cleanup, configure } from '@testing-library/react'
import { afterEach } from 'vitest'

// Первый тест файла несёт подготовку всего файла, и под нагрузкой полного прогона секунды
// по умолчанию на findBy и waitFor ему не хватало: прогон краснел без поломки (B-164).
configure({ asyncUtilTimeout: 5000 })

afterEach(() => {
  cleanup()
})

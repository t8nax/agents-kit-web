import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react()],
  server: {
    // Переопределяются из env e2e-прогоном, который поднимает свою панель на свободных портах.
    port: Number(process.env.WEB_PORT ?? 5173),
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${process.env.API_PORT ?? 5078}`,
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Хуки идут в порядке объявления, а не задом наперёд: иначе afterEach файла теста снимает
    // заглушку fetch раньше, чем cleanup размонтирует окна, и их запросы уходят в настоящую сеть.
    sequence: { hooks: 'list' },
    // С запасом над ожиданием findBy и waitFor (vitest.setup.ts): тест из нескольких ожиданий
    // под нагрузкой полного прогона не упирается в пять секунд по умолчанию (B-164).
    testTimeout: 20000,
  },
})

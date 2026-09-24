import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { availableParallelism, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig, devices } from '@playwright/test'

// Каждый прогон поднимает свои API и dev-сервер на свободных портах и не берёт уже
// запущенные: на привычных портах может работать панель соседней рабочей копии.
// Порты кладутся в env, чтобы воркеры Playwright, заново читающие конфиг, взяли те же.

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, 'localhost', () => {
      const address = server.address()
      server.close(() =>
        typeof address === 'object' && address ? resolve(address.port) : reject(new Error('no port')),
      )
    })
  })
}

process.env.E2E_API_PORT ??= String(await freePort())
process.env.E2E_WEB_PORT ??= String(await freePort())
const apiPort = process.env.E2E_API_PORT
const webPort = process.env.E2E_WEB_PORT

// Свой каталог сборки: запущенный dev-API держит exe в bin, и сборка туда упала бы.
const artifacts = join(
  tmpdir(),
  'agents-kit-web-e2e',
  createHash('sha256').update(import.meta.dirname).digest('hex').slice(0, 12),
)

export default defineConfig({
  testDir: './e2e',
  // Не больше четырёх браузеров разом: по умолчанию Playwright берёт половину ядер, и на машине
  // с двадцатью ядрами десять браузеров забирали 17 ГБ из 32 — всё прочее на машине вставало,
  // а прогон шёл дольше, чем с четырьмя (B-245). Где половина ядер меньше, остаётся она.
  workers: Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  use: {
    baseURL: `http://localhost:${webPort}`,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: `dotnet run --project ../backend/src/AgentsKitWeb.Api --launch-profile http --artifacts-path "${artifacts}" -- --urls http://localhost:${apiPort}`,
      url: `http://localhost:${apiPort}/api/ping`,
      reuseExistingServer: false,
      timeout: 180_000,
    },
    {
      command: 'npm run dev',
      url: `http://localhost:${webPort}`,
      reuseExistingServer: false,
      env: { WEB_PORT: webPort, API_PORT: apiPort },
    },
  ],
})

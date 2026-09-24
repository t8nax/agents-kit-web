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
  // На GitHub машина занята только прогоном, и браузеры берут все её ядра (B-248).
  workers: process.env.CI
    ? availableParallelism()
    : Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
  // Слияние в dev ждёт зелёного прогона на GitHub: забытый test.only сделал бы его зелёным на части проверок.
  forbidOnly: !!process.env.CI,
  // На GitHub упавшую проверку не перегнать у себя: её след и снимок страницы уходят в артефакт
  // прогона, а в журнале — строка на каждую проверку, а не точки.
  reporter: process.env.CI ? 'list' : undefined,
  use: {
    baseURL: `http://localhost:${webPort}`,
    trace: process.env.CI ? 'retain-on-failure' : undefined,
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

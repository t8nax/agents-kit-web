# agents-kit-web

Веб-панель оператора над базами знаний agents-kit.

## Структура

- `backend/` — .NET 10 minimal API (`AgentsKitWeb.slnx`): `src/AgentsKitWeb.Api`, тесты в `tests/AgentsKitWeb.Api.Tests`.
- `frontend/` — React + TypeScript на Vite. Фронт ходит на относительный `/api`, dev-сервер Vite проксирует его на API.
- `design/` — временный набросок, не спецификация.

## Запуск

```sh
# API на http://localhost:5078
dotnet run --project backend/src/AgentsKitWeb.Api --launch-profile http

# фронт на http://localhost:5173
cd frontend
npm install
npm run dev
```

## Поставленная панель

Для постоянной работы панель публикуется из `origin/master` и работает на http://localhost:5080 — отдельно от dev-запуска.

```powershell
pwsh -NoProfile -File scripts/publish.ps1
```

Скрипт собирает master во временном git worktree (рабочая копия и её ветка не трогаются), кладёт собранный фронт в `wwwroot` и публикует API в `%LOCALAPPDATA%\agents-kit-web\app`. Затем останавливает запущенную панель, подменяет каталог, регистрирует или обновляет задачу Планировщика заданий `agents-kit-web panel` (при входе текущего пользователя, без прав администратора) и запускает панель. Панель читает тот же `bases.json` из `%APPDATA%\agents-kit-web`, что и dev-API. Обновить панель — запустить скрипт снова; параметры `-Ref`, `-Target`, `-Port` меняют ref, каталог и порт.

Поставленная панель собрана из master и правок ветки задачи не содержит: приёмку смотрят на dev-панели.

## Проверки

```sh
# бэкенд
cd backend
dotnet test

# фронтенд
cd frontend
npm run lint
npm test
npm run build

# e2e: каждый прогон поднимает свои API и dev-сервер на свободных портах, запущенные не берёт
npx playwright install chromium   # один раз
npm run test:e2e
```

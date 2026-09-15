# agent-kit-web

Веб-панель оператора над базами знаний agents-kit.

## Структура

- `backend/` — .NET 10 minimal API (`AgentKitWeb.slnx`): `src/AgentKitWeb.Api`, тесты в `tests/AgentKitWeb.Api.Tests`.
- `frontend/` — React + TypeScript на Vite. Фронт ходит на относительный `/api`, dev-сервер Vite проксирует его на API.
- `design/` — временный набросок, не спецификация.

## Запуск

```sh
# API на http://localhost:5078
dotnet run --project backend/src/AgentKitWeb.Api --launch-profile http

# фронт на http://localhost:5173
cd frontend
npm install
npm run dev
```

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

# e2e: сам поднимает API и dev-сервер, если они не запущены
npx playwright install chromium   # один раз
npm run test:e2e
```

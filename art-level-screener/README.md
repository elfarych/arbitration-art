# art-level-screener

Бэкенд расчёта горизонтальных уровней Binance USDⓈ-M Futures для арбитража.
Три независимых Node.js/TypeScript-сервиса, связанные через Redis. Источник
данных для раздела «скринер уровней» во фронтенде `quasar/arbitration-art-q`.

## Сервисы

| Сервис | Роль |
|--------|------|
| [`services/binance-futures-connector`](services/binance-futures-connector/README.md) | Свечи Binance Futures (REST snapshot + 1m WS, агрегация ТФ) → Redis |
| [`services/levels-processor`](services/levels-processor/README.md) | Раз в ~10с считает горизонтальные уровни из свечей → Redis |
| [`services/levels-api`](services/levels-api/README.md) | Fastify HTTP API поверх рассчитанных уровней (+ Swagger) |

## Запуск

Нужен доступный Redis (по умолчанию `redis://127.0.0.1:6379`). Запускать в
порядке потока данных: коннектор → процессор → api. Для каждого сервиса:

```bash
cd services/<service>
cp .env.example .env      # при необходимости поправить
npm install
npm run dev               # или: npm run build && npm start
```

Контракт наружу — HTTP API сервиса `levels-api` (см.
[API.md](services/levels-api/API.md), Swagger на `/docs`). Биржевые API-ключи
**не требуются** — используются только публичные данные Binance.

## Документация

- Архитектура, потоки данных, схема Redis, риски — [DOCS.md](DOCS.md).
- Интеграция и правила репозитория — [`AGENTS.md`](../AGENTS.md) (раздел
  art-level-screener).

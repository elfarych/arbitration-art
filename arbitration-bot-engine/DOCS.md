# Arbitration Bot Engine — внутренняя документация

Документ описывает фактическое состояние сервиса `arbitration-bot-engine`: назначение, архитектуру, HTTP API, торговый цикл, exchange-адаптеры, интеграцию с Django и технические риски. Это рабочая документация для быстрого восстановления контекста перед изменениями.

## 1. Краткое резюме

`arbitration-bot-engine` — отдельный TypeScript/Node.js процесс, который принимает команды от Django backend и исполняет runtime-логику арбитражных ботов.

Главные обязанности engine:

- Поднять Fastify HTTP API на порту `3001`.
- Получать от Django команды `start`, `sync`, `stop`, `force-close` только при валидном `X-Service-Token`.
- Создавать native REST-клиенты бирж для account/order операций.
- Создавать native WebSocket-клиенты для live orderbook данных и публиковать их в общий `OrderBookStore`.
- Рассчитывать VWAP, spread, PnL, drawdown и timeout exits.
- Открывать/закрывать сделки в real mode через биржевые REST API.
- В emulator mode не трогать биржи, а писать сделки в Django как эмуляционные.
- Синхронизировать trade state в Django через `/api/bots/real-trades/` и `/api/bots/trades/` с service token.
- Восстанавливать открытые сделки из Django при старте бота только в scope конкретного `bot_id`.

Engine не использует `ccxt`/`ccxt.pro`. Все REST и WebSocket-вызовы делаются нативно. Это снижает hot-path latency и убирает один из крупнейших источников непредсказуемых зависимостей.

## 1.1. Состояние production-readiness

Ключевые safety-механизмы и hot-path оптимизации:

- `src/main.ts` проверяет `X-Service-Token` на всех control-plane endpoints через `crypto.timingSafeEqual` (constant-time сравнение, чтобы байтовое содержимое токена не утекало через timing side-channel), выполняет structural validation тела запроса (`bot_id`, `config`, `keys`) и регистрирует `SIGINT`/`SIGTERM` для graceful shutdown через `engine.stopAll()`, а также `unhandledRejection` / `uncaughtException` для прозрачной диагностики.
- `src/services/api.ts` отправляет service token в Django через native fetch и предоставляет `updateTrade` / `updateEmulationTrade` для PATCH-обновлений комиссии и PnL после background backfill.
- `src/config.ts` экспортирует `serviceToken`, `tradeAmountUsdt`, `useTestnet` и `port`. `tradeAmountUsdt` используется как fallback notional, когда `BotConfig.coin_amount` пуст.
- REST exchange clients принимают credentials через constructor. `Engine.extractKeys` строго проверяет тип (`string`) и эмпти-state через `.trim().length > 0`, бросая ошибку до создания клиента, если ключ отсутствует, пустой или whitespace-only. Это гарантирует, что клиент без рабочих credentials никогда не попадает на order path.
- WebSocket market-data клиенты создаются без credentials — orderbook public, и хранить там ключи не нужно.
- `Engine.startBot` использует `Set<starting>` + `Map<traders>` для защиты от race при двух параллельных `start` для одного `bot_id`. Slot освобождается в `finally`.
- `Engine.startBot` запускает `setIsolatedMargin`, `setLeverage` и (если адаптер реализует) `prefetchAccountSettings` параллельно внутри каждой ноги, и параллельно по двум ногам. `prefetchAccountSettings` прогревает account-level флаги, влияющие на структуру ордера (например, Binance Hedge Mode `positionSide`), так что первая сделка строится правильно без extra round-trip на hot path.
- `MarketInfoService.initialize` использует `IExchangeClient.fetchTicker(symbol)` — один лёгкий REST-вызов на биржу за пару, без `fetchTickers()`.

Hot-path latency:

- `BotTrader` event-driven: подписан на `OrderBookStore.onUpdate` и реагирует на каждый snapshot. Никаких polling-циклов и `await exchange.watchOrderBook` — между событием обновления стакана и `Promise.all` параллельного submit двух market-orders только spread-math и size-rounding.
- `createMarketOrder` всех бирж (Binance, Bybit, MEXC, Gate) возвращает управление сразу после подтверждения fill-а (orderId + avgPrice + filledQty), без блокирующего fetch комиссии. Один быстрый retry 100–150ms покрывает редкий случай, когда биржа ещё не вернула `avgPrice`.
- Фактическая комиссия и точный PnL приходят в Django через background-задачу `fetchOrderCommission` + `api.updateTrade(...)` PATCH. На время backfill в Django лежит оценка по taker-rate (Binance 0.05%, Bybit 0.055%, MEXC 0.02%, Gate 0.05%).
- В `executeClose` `fetchPositions` обеих бирж и сами close-ордера выполняются параллельно через `Promise.all` / `Promise.allSettled`.
- В `executeOpen` и `executeClose` при ошибке хотя бы одной ноги вызывается `handleOpenCleanup` / `verifyAndCloseResidual`, который параллельно проверяет позиции на обеих биржах и закрывает residue через reduceOnly.
- Verbose JSON-payload логи на hot path понижены до `DEBUG`.

Safety:

- Если запись trade в Django падает после успешного открытия позиций на бирже в real mode, `executeOpen` сразу выполняет `rollbackOpenLegs` + `handleOpenCleanup`, чтобы не оставить orphan-позицию, про которую engine забудет.
- Если хотя бы одна нога close-ордера отклонена, `executeClose` вызывает `verifyAndCloseResidual` для повторной попытки reduceOnly close по фактическому размеру позиции; в случае невозможности закрыть пишет CRITICAL-лог.
- Закрывающий PATCH в Django ретраится через `persistCloseWithRetry` (3 попытки с linear backoff 0/500/1500 ms). Это покрывает короткие network-флапы и рестарт Django-воркера. Если после всех попыток write не прошёл, engine пишет `🚨 CRITICAL` с trade ID и оператору нужна ручная сверка (позиция уже закрыта на бирже, но trade в Django остаётся `open`). Без ретраев такая рассинхронизация уже наблюдалась при типичных пиках нагрузки.
- `BotTrader.restoreOpenTrades` при обнаружении нескольких open-записей на одной паре пишет ERROR с перечнем ID, восстанавливает последнюю по `opened_at` и оставляет старые как «требуют ручной сверки» — продолжать торговать со случайно выбранной записью в дублях нельзя без риска mis-tracking-а позиции.
- `BotTrader.stop` ждёт до 30 секунд завершения in-flight операции и затем закрывает оба native WS соединения, очищая snapshots из `OrderBookStore`, чтобы циклы start/stop не лили коннекшены/память.
- `BotTrader.forceClose` ждёт до 10 секунд завершения текущей операции и только потом форсит close, чтобы команда не игнорировалась `busy`-флагом.
- Native market WS клиенты переподключаются с экспоненциальным backoff (`1s → 30s`), при reconnect локальные delta-буферы (Bybit) очищаются, чтобы свежий snapshot пришёл без stale-данных.

Close-reason mapping (engine → Django):

- `profit`, `timeout`, `shutdown` остаются как есть.
- `liquidation` → `error` (потеря по margin).
- `force_close` → `manual` (manual user override). Status в этом случае — `force_closed` для real-trade, `closed` для emulation (см. ограничение EmulationTrade.Status ниже).

## 2. Технологический стек

Фактические зависимости из `package.json`:

- Node.js ESM project (`"type": "module"`).
- TypeScript 5.4.
- Fastify 4 + `@fastify/cors`.
- `ws` 8.x (native WebSocket client).
- `dotenv`.

Скрипты:

```json
{
  "dev": "tsx watch src/main.ts",
  "build": "tsc",
  "start": "node dist/main.js"
}
```

TypeScript settings:

- Target: `ES2022`.
- Module: `NodeNext`.
- Module resolution: `NodeNext`.
- Strict mode: `true`.
- Output: `dist`.
- Include: `src/**/*`.

Package manager в проекте: `pnpm`. Проверенная версия: `9.0.6`.

## 3. Структура проекта

```text
arbitration-bot-engine/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── DOCS.md
└── src/
    ├── main.ts
    ├── config.ts
    ├── types/index.ts
    ├── classes/
    │   ├── Engine.ts
    │   └── BotTrader.ts
    ├── market-data/
    │   └── orderbook-store.ts
    ├── services/
    │   ├── api.ts
    │   └── market-info.ts
    ├── exchanges/
    │   ├── exchange-client.ts          # IExchangeClient interface
    │   ├── exchange-tester.ts          # test-connection / test-trade
    │   ├── market-ws.ts                # MarketWsClient interface + Position/Ticker types
    │   ├── symbols.ts                  # unified ↔ exchange symbol conversion
    │   ├── binance-client.ts           # native REST
    │   ├── binance-market-ws.ts        # native depth20@100ms WS
    │   ├── bybit-client.ts             # native REST (HMAC v5 + time-offset)
    │   ├── bybit-market-ws.ts          # native orderbook.50 snapshot+delta WS
    │   ├── mexc-client.ts              # native REST (contract v1)
    │   ├── mexc-market-ws.ts           # native push.depth.full WS
    │   ├── gate-client.ts              # native REST (HMAC v4)
    │   └── gate-market-ws.ts           # native futures.order_book WS
    └── utils/
        ├── http.ts                     # requestJson, buildQuery, sleep, HttpError
        ├── logger.ts
        └── math.ts
```

Основные слои:

- `main.ts` — Fastify control plane.
- `Engine.ts` — manager всех живых `BotTrader`.
- `BotTrader.ts` — торговый цикл одного bot config.
- `market-data/orderbook-store.ts` — in-memory snapshots от native market WS, EventEmitter под подписку.
- `exchanges/*-client.ts` — native REST adapters; реализуют `IExchangeClient` + factory `createMarketWs`.
- `exchanges/*-market-ws.ts` — native public-WS клиенты, пишут в `OrderBookStore`.
- `services/api.ts` — Django API client (native fetch).
- `services/market-info.ts` — кеш unified market constraints.
- `utils/http.ts` — общий fetch-helper для всех REST клиентов.
- `utils/math.ts` — spread/PnL/drawdown/VWAP расчёты.
- `types/index.ts` — общие TypeScript interfaces.

## 4. Runtime architecture

```text
Django BotConfig CRUD
        |
        | HTTP POST /engine/bot/{action}
        v
Fastify main.ts
        |
        v
Engine
        |
        | creates
        v
BotTrader per bot_id
        |
        | uses
        +--> Native market WS client per exchange (writes to OrderBookStore)
        +--> Native REST exchange clients for orders/positions/account setup
        +--> OrderBookStore.onUpdate subscription (event-driven spread check)
        +--> MarketInfoService for sizing constraints
        +--> Django API client for trade persistence
```

Runtime state:

- Django хранит persistent state: users, bot configs, trades.
- Engine хранит in-memory state: active `BotTrader` instances, active trade pointer, cooldown, OrderBookStore snapshots, WS connections.
- При рестарте engine память теряется.
- После рестарта engine сам подтягивает активные конфиги: `main.ts` после `fastify.listen` запускает `engine.bootstrapFromDjango(config.engineServiceUrl)`, который дёргает `GET /api/bots/engine-bootstrap/?service_url=<self>` и параллельно вызывает `startBot` для каждого вернувшегося конфига. Открытые сделки восстанавливает уже существующий `trader.restoreOpenTrades` внутри `startBot`. Bootstrap идёт фоном — HTTP listener engine отвечает сразу, чтобы Django мог в это же время слать lifecycle-команды (`startBot` идемпотентен и обрабатывает гонку через `traders` map + `starting` set).
- Если bootstrap не дозвонился до Django, делаются до 5 попыток с задержкой 3 секунды; после исчерпания ретраев engine остаётся живым, но без traders, и ждёт ручного `start` от Django.

Важно: engine не имеет distributed locking. Если два engine-процесса одновременно получат один и тот же `bot_id`, они могут запустить два независимых trader loop.

## 5. Конфигурация

Файл: `src/config.ts`.

Текущий экспорт:

```ts
export const config = {
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    useTestnet: process.env.USE_TESTNET === 'true',
    port: parseInt(process.env.PORT || '3001', 10),
    tradeAmountUsdt: Number(process.env.TRADE_AMOUNT_USDT || '50'),
    engineServiceUrl: (
        process.env.ENGINE_SERVICE_URL
        || `http://127.0.0.1:${parseInt(process.env.PORT || '3001', 10)}`
    ).replace(/\/$/, ''),
    serviceToken: requireEnv('SERVICE_SHARED_TOKEN'),
};
```

Переменные окружения:

| Переменная | Default | Назначение |
|---|---|---|
| `DJANGO_API_URL` | `http://127.0.0.1:8000/api` | Base URL Django API без trailing slash. |
| `USE_TESTNET` | `false` | Переключение биржевых клиентов на sandbox/testnet, где поддерживается. |
| `PORT` | `3001` | HTTP port Fastify engine. |
| `TRADE_AMOUNT_USDT` | `50` | Fallback notional, когда `BotConfig.coin_amount` пуст. |
| `ENGINE_SERVICE_URL` | `http://127.0.0.1:${PORT}` | URL, которым engine идентифицирует себя при bootstrap-запросе к Django (`GET /api/bots/engine-bootstrap/?service_url=...`). Должен совпадать с `BotConfig.service_url` целевых ботов, иначе Django вернёт пустой список и engine стартует «холодным». В single-host dev-сетапе можно не задавать; для multi-engine deployment-ов задавать явно. |
| `SERVICE_SHARED_TOKEN` | — (required) | Shared service token между Django и engine. |
| `LOG_LEVEL` | `INFO` | DEBUG/INFO/WARN/ERROR — обрабатывается logger-ом. |
| `ORDERBOOK_MAX_AGE_MS` | `15000` | Максимальный возраст snapshot-а в `OrderBookStore`, при котором non-emergency сигналы ещё валидны. Старше — `BotTrader.getPrices` возвращает `null`, entry/profit skip. Emergency exits guard-у не подчиняются. |
| `ORDERBOOK_MAX_SKEW_MS` | `20000` | Максимальная разница между `localTimestamp` primary и secondary snapshot-ов в одном решении. Бортит spread-сигналы, когда одна нога отстаёт от другой. `0` — выключить только этот чек, оставив max-age. |

`SERVICE_SHARED_TOKEN` — обязательная переменная. Engine упадёт на старте при её отсутствии. Значение должно совпадать с `SERVICE_SHARED_TOKEN` в `arbitration-art-django/.env`.

Testnet support:
- Binance: futures testnet (`testnet.binancefuture.com` + `stream.binancefuture.com`).
- Bybit: testnet (`api-testnet.bybit.com` + `stream-testnet.bybit.com`).
- Gate: testnet (`fx-api-testnet.gateio.ws` + `fx-ws-testnet.gateio.ws`).
- MEXC: testnet not exposed публично; `USE_TESTNET=true` оставляет production endpoint.

## 6. Fastify HTTP API

Файл: `src/main.ts`.

Engine поднимает Fastify:

```ts
Fastify({ logger: false })
fastify.register(cors, { origin: '*' })
fastify.listen({ port: config.port, host: '0.0.0.0' })
```

Назначение Fastify API: control plane для Django, не публичный browser API. Все control endpoints за `X-Service-Token` через `addHook('preHandler', ...)`. CORS open by default — процесс должен жить за firewall/localhost.

### 6.1. `POST /engine/bot/start`

Payload от Django:

```json
{
  "bot_id": 123,
  "config": {
    "id": 123,
    "primary_exchange": "binance_futures",
    "secondary_exchange": "bybit_futures",
    "entry_spread": "0.5000",
    "exit_spread": "0.1000",
    "coin": "BTC/USDT:USDT",
    "coin_amount": "0.01000000",
    "order_type": "auto",
    "trade_mode": "emulator",
    "max_trades": 10,
    "primary_leverage": 1,
    "secondary_leverage": 1,
    "trade_on_primary_exchange": true,
    "trade_on_secondary_exchange": true,
    "max_trade_duration_seconds": 3600,
    "max_leg_drawdown_percent": 80,
    "is_active": true
  },
  "keys": {
    "binance_api_key": "...",
    "binance_secret": "...",
    "bybit_api_key": "...",
    "bybit_secret": "...",
    "gate_api_key": "...",
    "gate_secret": "...",
    "mexc_api_key": "...",
    "mexc_secret": "..."
  }
}
```

Behavior:

- Calls `engine.startBot(bot_id, config, keys)`.
- On success returns `{ "success": true }`.
- On error returns HTTP 500 `{ "success": false, "error": "..." }`.

### 6.2. `POST /engine/bot/sync`

Payload:

```json
{ "bot_id": 123, "config": {} }
```

Behavior:

- Calls `engine.syncBot(bot_id, config)`.
- Updates in-memory config of existing `BotTrader`.
- Does not start a missing trader.

### 6.3. `POST /engine/bot/stop`

Payload:

```json
{ "bot_id": 123 }
```

Behavior:

- Calls `engine.stopBot(bot_id)`.
- If trader exists, calls `trader.stop(true)`. `closePositions=true` означает active trade закрывается reason `shutdown`.
- Removes trader from `Engine.traders`.

### 6.4. `POST /engine/bot/pause`

Payload (same shape as `/engine/bot/sync` — Django reuses `build_bot_runtime_payload`):

```json
{ "bot_id": 123, "config": { ..., "is_active": false }, "keys": { ... } }
```

Behavior:

- Calls `engine.pauseBot(bot_id, config)`.
- Trader stays registered (`Engine.traders` map untouched), WS streams stay subscribed, timeout/exit-spread/drawdown checks keep firing.
- `trader.syncConfig(config)` updates `bot.is_active = false`. The existing guard in `BotTrader.checkSpreads` (`if (!this.bot.is_active) return`) blocks new opens; if there is an active trade, `checkExit`/`checkTimeouts` continue and will close it on profit / timeout / max-leg drawdown.
- Pause никогда не закрывает позиции. Чтобы закрыть активную сделку немедленно — `/engine/bot/force-close`. Чтобы полностью убрать бота из engine (удаление) — `/engine/bot/stop`.
- Pause неизвестного бота логируется как warning, не 500.

Resume is plain `/engine/bot/start` — `Engine.startBot` обнаруживает уже-зарегистрированного трейдера и роутит вызов через `syncBot(config)`, флипая `is_active` обратно в `true` без пересоздания WS и `restoreOpenTrades`.

Known limitation: `bootstrapFromDjango` фильтрует ботов по `is_active=True`. Если engine рестартует, пока бот стоит на паузе с активной сделкой, этот бот не восстановится автоматически — оператор должен снять паузу (`is_active: true`), и engine через START поднимет трейдер заново и подцепит open trade через `restoreOpenTrades`.

### 6.5. `POST /engine/bot/force-close`

Payload:

```json
{ "bot_id": 123 }
```

Behavior:

- Calls `engine.forceClose(bot_id)`.
- If trader has active trade, attempts close using emergency prices.
- Trader remains registered after force-close.

### 6.6. `POST /engine/exchange/test-connection`

Файл: `src/exchanges/exchange-tester.ts` (`testConnection`).

Payload:

```json
{ "exchange": "binance|bybit|gate|mexc", "api_key": "<api key>", "secret": "<secret>" }
```

Behavior:

- Создаёт короткоживущий native REST-клиент (`BinanceClient` / `BybitClient` / `GateClient` / `MexcClient`) и не регистрирует его ни в `Engine.traders`, ни в `Engine.starting`.
- Выполняет `loadMarkets()`, затем `fetchPositions(['SOL/USDT:USDT'])` для проверки auth и futures read-permissions.
- Возвращает `{ ok, exchange, checks: [{name, ok, detail}], error }`. HTTP 200 при любых exchange-ошибках, чтобы Django мог отдать пользователю причину без дополнительной интерпретации.

### 6.7. `POST /engine/exchange/test-trade`

Файл: `src/exchanges/exchange-tester.ts` (`testTrade`).

Payload идентичен `test-connection`.

Behavior:

- Берёт фиксированные параметры: `SOL/USDT:USDT`, notional = $15, leverage = 10 (effective margin ≈ $1.5).
- Если адаптер реализует `prefetchAccountSettings`, вызывает его перед margin/leverage setup (для Binance — определение Hedge/One-Way режима), чтобы открывающий ордер сразу собирался с правильным `positionSide`.
- Последовательно вызывает `setIsolatedMargin`, `setLeverage`, `fetchTicker`, считает количество как `notional / lastPrice` и округляет через `getMarketInfo().stepSize`.
- В ответ кладёт оба поля: `notional_usd` (общий размер сделки, $15) и `margin_usd` (требуемая маржа = notional / leverage, $1.50) — фронт показывает обе цифры.
- Открывает `createMarketOrder(symbol, 'buy', qty)` и сразу закрывает `createMarketOrder(symbol, 'sell', qty, { reduceOnly: true })`.
- Замеряет latency каждой ноги через `Date.now()` непосредственно вокруг вызова `createMarketOrder`.
- При ошибке close-ноги выставляет `error` с указанием, что позиция, скорее всего, осталась открытой.

Risk note:

- Endpoint выполняет реальную сделку с реальных средств пользователя на live-бирже (testnet включается только глобальным `USE_TESTNET=true`). Django оборачивает вызов confirmation-диалогом во фронтенде и не повторяет запрос при сетевой ошибке.

## 7. `Engine`

Файл: `src/classes/Engine.ts`.

`Engine` owns:

```ts
private traders: Map<number, BotTrader>
private starting: Set<number>
private orderBookStore: OrderBookStore
```

`traders` keyed by Django `BotConfig.id`; `starting` хранит id ботов с ещё не завершённой инициализацией. Один общий `orderBookStore` обслуживает все BotTrader-ы.

### 7.1. Exchange client creation

`createRestClient(name, keys)`:

| Name | Adapter |
|---|---|
| `binance_futures` | `BinanceClient` (native) |
| `bybit_futures` | `BybitClient` (native) |
| `mexc_futures` | `MexcClient` (native) |
| `gate_futures` | `GateClient` (native) |

Каждый `IExchangeClient` экспонирует `createMarketWs(store)` — фабрику нативного market-WS клиента, который пушит snapshot-ы в `OrderBookStore`.

### 7.2. Key extraction

`extractKeys(exchangeName, keys)`:

- Binance — `keys.binance_api_key`, `keys.binance_secret`.
- Bybit — `keys.bybit_api_key`, `keys.bybit_secret`.
- Gate — `keys.gate_api_key`, `keys.gate_secret`.
- MEXC — `keys.mexc_api_key`, `keys.mexc_secret`.

Любое отсутствие ключей или невалидный `keys`-объект → `throw new Error(...)` ДО создания клиента.

### 7.3. `startBot(botId, config, keys)`

Flow:

1. Если `traders.has(botId)` ИЛИ `starting.has(botId)` → duplicate start (Django повтор или race); вызывает `syncBot(botId, config)` и return.
2. `starting.add(botId)` — резервирует slot.
3. Создаёт primary и secondary REST clients.
4. Параллельный `Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()])`.
5. Создаёт `MarketInfoService` и initialize для `[config.coin]`.
6. Если `trade_mode === 'real'`: на каждой ноге параллельно через `Promise.allSettled([setIsolatedMargin, setLeverage, prefetchAccountSettings?])` (последний — опционально, только если адаптер его реализует); обе ноги параллельно через `Promise.all`; rejected задачи логируются как WARN.
7. Через factory создаёт `primaryMarketWs` и `secondaryMarketWs` (native WS), пишущие в `orderBookStore`.
8. Создаёт `BotTrader` с обоими REST клиентами, обоими WS клиентами, общим store и market-info.
9. Получает открытые сделки из Django (`api.getOpenTrades` / `api.getOpenEmulationTrades`); ошибка fetch не блокирует старт.
10. `trader.restoreOpenTrades(openTrades)`.
11. `traders.set(botId, trader)`.
12. `await trader.start()` — подписывает trader на `OrderBookStore.onUpdate` и параллельно открывает оба WS соединения.
13. `finally`: `starting.delete(botId)` независимо от исхода. Если start упал после `traders.set`, запись удаляется в `catch`.

Важно:

- WS соединения открываются как часть `trader.start()`. После resolve обещание `start()` не висит — message dispatch продолжается асинхронно в обработчиках сокета.
- Если bootstrap падает с ошибкой, частично созданные WS-клиенты не остаются висеть: при следующем `start` engine создаст новые экземпляры.

### 7.4. `syncBot(botId, config)`

Behavior:

- Logs JSON config.
- If trader exists, calls `trader.syncConfig(config)`.
- If missing, only logs warning.

### 7.5. `stopBot(botId)` / `forceClose(botId)` / `stopAll()`

Без изменений по сравнению с предыдущим контрактом: `stopBot` ждёт `trader.stop(true)` и удаляет из map; `forceClose` оставляет trader зарегистрированным; `stopAll` параллельно стопит все боты.

### 7.6. `bootstrapFromDjango(serviceUrl)`

Восстановление in-memory состояния после рестарта engine.

Flow:

1. `api.getActiveBotPayloads(serviceUrl)` → `GET /api/bots/engine-bootstrap/?service_url=<self>` с `X-Service-Token`. Django возвращает `{ "bots": [{ bot_id, owner_id, config, keys }, ...] }`, отфильтрованные по `is_active=True` и `service_url=<self>`.
2. На сетевую/auth-ошибку логируется ERROR и метод выходит. Ретраи делает caller (`main.ts`, 5 попыток × 3 секунды).
3. Если список пустой — INFO с напоминанием проверить `ENGINE_SERVICE_URL` ↔ `BotConfig.service_url`.
4. `Promise.allSettled(payloads.map(p => startBot(p.bot_id, p.config, p.keys)))` — боты восстанавливаются параллельно, падение одного не блокирует остальные. Каждый `startBot` сам тянет `getOpenTrades` / `getOpenEmulationTrades` и зовёт `BotTrader.restoreOpenTrades`.
5. INFO с агрегатами `started=N, failed=M`. Падения каждого бота логируются по `bot_id`.

Вызывается из `main.ts` один раз после `fastify.listen`. HTTP listener поднимается раньше bootstrap-а, чтобы Django мог в это же время слать `start`/`sync` (idempotency через `traders` map + `starting` set).

## 8. `BotTrader`

Файл: `src/classes/BotTrader.ts`.

`BotTrader` manages one bot/coin pair and at most one active trade. Event-driven: подписан на `OrderBookStore.onUpdate` и вызывает `checkSpreads()` при каждом релевантном обновлении.

Constructor dependencies:

- `bot` — Django BotConfig payload.
- `primaryClient` / `secondaryClient` — native REST `IExchangeClient`.
- `primaryMarketWs` / `secondaryMarketWs` — native `MarketWsClient`, созданные через `client.createMarketWs(store)`.
- `orderBookStore` — shared `OrderBookStore`.
- `marketInfo` — initialised `MarketInfoService`.

### 8.1. Runtime state

`PairState`:

| Field | Meaning |
|---|---|
| `activeTrade` | Current Django trade record or `null`. |
| `openedAtMs` | Local timestamp for timeout checks. |
| `busy` | Re-entrancy lock for open/close operations. |
| `cooldownUntil` | Timestamp until next entry attempt is blocked after failure. |
| `tradesOpenedCount` | All-time count of trades the bot has opened. Hydrated in `start()` via `api.getTotalTradesCount(botId, isReal)` (no status filter — includes `open + closed + force_closed`). Incremented after every successful Django write in `executeOpen`. Persists across engine restart through Django; resets only on bot deletion + recreation. |

Constants:

- `COOLDOWN_MS = 30_000` — пауза между неудачной попыткой open и следующей.
- `TIMEOUT_CHECK_INTERVAL_MS = 2_000` — частота проверки `max_trade_duration_seconds`. 2s выбраны как нижняя граница, при которой минимально допустимое значение `max_trade_duration_seconds=10` (форсится Django serializer) даёт детект таймаута с дрейфом ≤2s; больше резолюции тут не нужно, меньше — CPU-носер ни за что.
- `STOP_BUSY_WAIT_MS = 30_000` — макс. время ожидания в `stop()`.
- `FORCE_CLOSE_BUSY_WAIT_MS = 10_000` — макс. время ожидания в `forceClose`.
- `MAX_TRADES_LOG_THROTTLE_MS = 60_000` — троттлинг лога «budget reached»; без него каждый orderbook tick после исчерпания `max_trades` спамил бы один и тот же info-лог.
- `ESTIMATED_TAKER_RATE` — оценки taker fee per exchange (binance 0.05%, bybit 0.055%, mexc 0.02%, gate 0.05%) для записи estimated commission до того, как background backfill подставит точное значение.

#### `max_trades` enforcement

`checkSpreads` перед каждым потенциальным open проверяет `state.tradesOpenedCount >= bot.max_trades` (если `max_trades > 0`). Если budget исчерпан — open не делается, лог «🛑 max_trades budget reached» (throttled). Активный trade при этом продолжает обслуживаться (exit / timeout / drawdown / force-close), только новые входы блокируются. Чтобы «сбросить» лимит — удалить и пересоздать бот (или поднять `max_trades` через PATCH; in-memory счётчик не меняется, но сравнение `count < new_max_trades` снова станет true).

### 8.2. Lifecycle methods

`syncConfig(newConfig)`:

- Replaces `this.bot`. Существующий open trade продолжает мониториться с новыми порогами.

`restoreOpenTrades(openTrades)`:

- Finds first trade where `t.coin === this.bot.coin && t.status === 'open'`.
- Sets `activeTrade` + `openedAtMs` из `trade.opened_at`.

Risk: если в БД оказались две open-записи на одной паре (регрессия или manual admin), engine восстанавливает только первую.

`start()`:

- Подписывается на `OrderBookStore.onUpdate` — фильтрация по `symbol === bot.coin` и `exchange ∈ {primaryKey, secondaryKey}`.
- Параллельно вызывает `primaryMarketWs.connect([coin])` и `secondaryMarketWs.connect([coin])`.
- Стартует timeout timer.

`stop(closePositions=false)`:

- Снимает подписку OrderBookStore, останавливает timer.
- Ждёт до `STOP_BUSY_WAIT_MS` (30s) пока in-flight `executeOpen`/`executeClose` корректно закончится.
- Если `closePositions && activeTrade`, закрывает позиции с reason `shutdown` через emergency prices.
- Параллельно закрывает оба native WS соединения и очищает свои snapshots из `OrderBookStore`.

`forceClose()`:

- Если нет active trade — return.
- Ждёт до `FORCE_CLOSE_BUSY_WAIT_MS` (10s) завершения текущей операции.
- Берёт active trade amount, emergency prices, вызывает `executeClose('force_close', prices)`.

### 8.3. Market data flow

Каждый native market-WS клиент:

1. Открывает socket на public endpoint биржи (Binance combined stream, Bybit `v5/public/linear`, MEXC `contract.mexc.com/edge`, Gate `fx-ws.gateio.ws/v4/ws/usdt`).
2. Подписывается на orderbook по unified symbol (через локальную конверсию в exchange-specific формат).
3. Парсит входящие сообщения (snapshot/delta — для Bybit с локальной merge-картой; для Binance/MEXC/Gate full-snapshot pushes).
4. Пушит `OrderBookSnapshot { exchange, symbol, bids, asks, exchangeTimestamp, localTimestamp, sequence }` в `OrderBookStore.set()`.
5. На transport-сбой делает экспоненциальный reconnect (1s → 30s); при reconnect Bybit обнуляет local books, чтобы свежий snapshot пришёл без stale-данных.
6. Шлёт ping (Bybit/MEXC/Gate) на собственных интервалах, чтобы биржа не закрывала idle socket.

### 8.4. Price extraction and VWAP

`getPrices(symbol, targetCoinsFallback?, isEmergency=false)`:

1. Reads primary and secondary snapshots through `orderBookStore.get(exchangeKey, symbol)`.
2. Требует оба book-а иметь bids и asks.
3. Determines `targetCoins`: close — фактический trade amount; entry — `marketInfo.getInfo(symbol)?.tradeAmount`.
4. Calculates VWAP для всех четырёх сторон (`calculateVWAP(side, targetCoins, isEmergency)`).
5. Если любой VWAP `NaN`, возвращает `null`.
6. Иначе возвращает `OrderbookPrices { primaryBid, primaryAsk, secondaryBid, secondaryAsk }`.

Non-emergency VWAP возвращает `NaN`, если недостаточно глубины; emergency использует доступную глубину.

### 8.5. Entry checks

`checkSpreads()` устроен так же как раньше; только источник стакана — `OrderBookStore`, а не `(ws as any).orderbooks`.

Guards:

- Если `busy`, return.
- Если market info отсутствует, return.

При `activeTrade` — `checkExit` с strict/emergency prices.

Без active trade:

1. Если `bot.is_active=false` — return.
2. Если `Date.now() < state.cooldownUntil` — return.
3. Reads current primary best bid из `orderBookStore`.
4. Determines raw amount: `bot.coin_amount` или `engineConfig.tradeAmountUsdt / currentPrice`.
5. Round down to `info.stepSize`. Reject если ниже `minQty` или `minNotional`.
6. Get strict VWAP prices. Если `null` — return.
7. Compare spread to `bot.entry_spread`. Для `order_type ∈ {buy, auto}` проверяет buy direction; для `{sell, auto}` — sell. Лениво — направление считается только если в скоупе `order_type`.

Entry direction semantics:

- `buy` — buy/long primary, sell/short secondary.
- `sell` — sell/short primary, buy/long secondary.

### 8.6. Opening a trade

`executeOpen(orderType, prices, spread, targetCoins)`:

1. Sets `busy=true`.
2. Determines sides; `isReal = bot.trade_mode === 'real'`; `runPrimary/runSecondary` — биржа-side toggles.
3. Обе ноги — параллельно через `Promise.allSettled([createMarketOrder, createMarketOrder])`.
4. Если хотя бы одна нога `rejected`: reverse reduceOnly для fulfilled fillQty, далее в real mode `handleOpenCleanup()` для residue, cooldown, return.
5. Иначе берутся fill prices, либо orderbook VWAP для skipped/emulator-ноги. Real spread пересчитывается по фактическим ценам.
6. Build payload (см. ниже).
7. `api.openTrade` / `api.openEmulationTrade` пишет trade в Django. Если падает в real mode — `rollbackOpenLegs` + `handleOpenCleanup`, чтобы не остаться с orphan-позицией.
8. При успехе сохраняется `activeTrade` и `openedAtMs`.
9. Background: `backfillOpenCommission` — параллельно тянет точные комиссии с обеих бирж и PATCH-ит Django.

Real mode payload включает: `bot`, `coin`, `primary/secondary_exchange` (`<exchangeKey>_futures`), `order_type`, `status`, `amount`, `leverage`, `primary/secondary_open_price`, `primary/secondary_open_order_id`, `open_spread`, `open_commission` (estimated).

Emulator payload без exchange names/order IDs/commission.

### 8.7. Open cleanup

`handleOpenCleanup()` — safety net после partial open failure или DB rollback:

- Параллельно через `Promise.all` тянет `client.fetchPositions([symbol])` на обеих биржах.
- Для каждой позиции с `size >= minQty`: long → reduceOnly sell; short → reduceOnly buy.
- Все close-ордера параллельно через `Promise.allSettled`.
- Любые ошибки close логируются как ERROR.

### 8.8. Exit checks

`checkExit(strictPrices, emergencyPrices)`:

1. Reads active trade open prices + order type.
2. `drawdownLimit = bot.max_leg_drawdown_percent || 80.0`.
3. Если `emergencyPrices`: `checkLegDrawdown` → если >= drawdownLimit → close reason `liquidation`.
4. Если `strictPrices`: `calculateTruePnL` → если >= `bot.exit_spread` → close reason `profit`.

Exit priority: liquidation guard → profit target. Timeout exits — отдельный timer (`checkTimeouts`).

### 8.9. Closing a trade

`executeClose(reason, prices)`:

1. Busy guard.
2. Determines close sides (mirror of open).
3. В real mode:
   - параллельно `fetchPositions([symbol])` на обеих биржах через `IExchangeClient.fetchPositions`;
   - для каждой ноги: если позиция найдена — берёт её фактический размер; иначе fallback к recorded amount (reduceOnly блокирует двойное закрытие);
   - параллельно `Promise.allSettled` reduceOnly market close обоих ног (если `size >= minQty`);
   - при любой rejected ноге → `verifyAndCloseResidual` (повторный fetch + reduceOnly close, CRITICAL-лог при невозможности);
   - если `avgPrice` skipped/rejected leg = 0 → fallback к текущей VWAP или open-price.
4. В emulator mode: цены из orderbook / open price.
5. Считает estimated `close_commission` (taker-rate × notional), `total_commission`, `profitUsdt/profitPercentage` через `calculateRealPnL`, `close_spread`, `close_status`.
6. Build close payload (см. mapping ниже).
7. `api.closeTrade` / `api.closeEmulationTrade` — PATCH. При ошибке write — лог ERROR (exchange уже actioned).
8. Сбрасывает `activeTrade` и `openedAtMs`.
9. Background `backfillCloseCommission` — точные комиссии + пересчитанный PnL → PATCH в Django.

Close status / reason mapping:

```ts
const closeStatus = isReal && !(reason === 'profit' || reason === 'shutdown')
    ? 'force_closed'
    : 'closed';
payload.close_reason =
    reason === 'liquidation' ? 'error' :
    reason === 'force_close' ? 'manual' :
    reason;
```

Django `Trade.CloseReason` choices: `profit`, `timeout`, `manual`, `shutdown`, `error`.

`EmulationTrade.Status` определён только как `open` / `closed` — для эмулятора любая причина закрытия (включая `force_close`, `timeout`, `liquidation`) маппится в `closed`. В эмуляторе нет ордеров и partial fills, поэтому различие `closed` vs `force_closed` смысла не несёт; причина закрытия остаётся в engine-логах. Real-режим использует полную пару `closed`/`force_closed` и пишет конкретную причину в `Trade.close_reason`.

### 8.10. Timeout checks

`checkTimeouts()`:

- Каждые 2 секунды (`TIMEOUT_CHECK_INTERVAL_MS`).
- Если нет active trade или busy — return.
- `maxDurationSeconds = bot.max_trade_duration_seconds || 3600`.
- Если elapsed >= maxDuration → emergency prices → `executeClose('timeout', prices)`.

### 8.11. Inactive bot behavior

Если `bot.is_active=false`:

- Existing active trade продолжает мониториться и может закрыться.
- Новые сделки не открываются.

## 9. Math utilities

Файл: `src/utils/math.ts`. Без изменений по контракту:

- `calculateOpenSpread(prices, orderType)` — buy/sell variants.
- `calculateTruePnL(openPrices, currentPrices, orderType)` — signal-evaluation PnL с estimated fee 0.20%.
- `calculateRealPnL(...)` — окончательный PnL по fill prices и фактической комиссии.
- `d(value, decimals=8)` — rounding для Django DecimalFields.
- `checkLegDrawdown(...)` — leveraged drawdown per leg.
- `calculateVWAP(side, targetCoins, isEmergency)` — strict/emergency глубина.

## 10. MarketInfoService

Файл: `src/services/market-info.ts`.

Кэш unified constraints для tradeable symbols.

`initialize(primaryClient, secondaryClient, commonSymbols)`:

1. Для каждой пары параллельно вызывает `client.fetchTicker(symbol)` на обеих биржах (native REST).
2. Для каждого symbol берёт `client.getMarketInfo(symbol)` на обеих биржах.
3. Choose strictest constraints: max `stepSize`, max `minQty`, max `minNotional`.
4. Сравнивает primary/secondary last prices: при deviation > 40% → homonym → skip.
5. Рассчитывает fallback `tradeAmount = config.tradeAmountUsdt / currentPrice`, округлённый по `stepSize`, validates против `minQty`/`minNotional`.
6. Кэширует `UnifiedMarketInfo`.

`getInfo(symbol)` — синхронный доступ к кэшу.

## 11. Django API client

Файл: `src/services/api.ts`.

Native fetch через `utils/http.ts`:

- `baseUrl = config.djangoApiUrl` (без trailing slash).
- Все запросы шлют `X-Service-Token` header.
- Timeout 15s.

Endpoints:

- `POST /bots/real-trades/` → `openTrade`
- `PATCH /bots/real-trades/{id}/` → `closeTrade` / `updateTrade`
- `GET /bots/real-trades/?status=open&bot_id={id}` → `getOpenTrades`
- `POST /bots/trades/` → `openEmulationTrade`
- `PATCH /bots/trades/{id}/` → `closeEmulationTrade` / `updateEmulationTrade`
- `GET /bots/trades/?status=open&bot_id={id}` → `getOpenEmulationTrades`

DRF endpoints в Django используют `AllowAny` для service-to-service write, но требуют валидный `X-Service-Token`.

## 12. Exchange client interface

Файл: `src/exchanges/exchange-client.ts`.

```ts
interface IExchangeClient {
  readonly name: string;
  readonly exchangeKey: string;            // 'binance' | 'bybit' | 'mexc' | 'gate'
  loadMarkets(): Promise<void>;
  setLeverage(symbol, leverage): Promise<void>;
  setIsolatedMargin(symbol): Promise<void>;
  prefetchAccountSettings?(): Promise<void>; // optional warm-up for account-level flags
  createMarketOrder(symbol, side, amount, params?): Promise<OrderResult>;
  fetchOrderCommission(symbol, orderId): Promise<number>;
  getMarketInfo(symbol): SymbolMarketInfo | null;
  getUsdtSymbols(): string[];
  fetchPositions(symbols): Promise<ExchangePosition[]>;
  fetchTicker(symbol): Promise<ExchangeTicker>;
  createMarketWs(store): MarketWsClient;
}
```

`ExchangePosition` (нормализованный shape для всех бирж):

```ts
{ symbol: string; side: 'long'|'short'; size: number; entryPrice: number; }
```

`MarketWsClient`:

```ts
interface MarketWsClient {
  readonly exchange: string;
  connect(symbols: string[]): Promise<void>;
  close(): Promise<void>;
  isOpen(): boolean;
}
```

Все взаимодействия с биржами проходят через эти два интерфейса. `ccxt`/`ccxt.pro` не используется.

## 13. BinanceClient

Файл: `src/exchanges/binance-client.ts`. Native REST для Binance USDT-M Futures.

Base URL:
- Testnet: `https://testnet.binancefuture.com`
- Production: `https://fapi.binance.com`

Symbol conversion: `BTC/USDT:USDT` ↔ `BTCUSDT`.

Endpoints:

- `loadMarkets` — `GET /fapi/v1/exchangeInfo`, фильтр `PERPETUAL` + `quoteAsset=USDT`.
- `setLeverage` — `POST /fapi/v1/leverage` (treats "No need to change" as success).
- `setIsolatedMargin` — `POST /fapi/v1/marginType` (treats already-isolated as success).
- `prefetchAccountSettings` — `GET /fapi/v1/positionSide/dual` один раз, кэширует Hedge/One-Way флаг на жизнь клиента и логирует выбранный режим. `Engine.startBot` запускает его параллельно с `setIsolatedMargin` + `setLeverage` для каждой ноги, а `exchange-tester.testTrade` — перед открытием. Цель — гарантировать, что первый ордер строится с правильным `positionSide` без extra round-trip на hot path.
- `createMarketOrder` — `POST /fapi/v1/order` с `newOrderRespType=RESULT`; быстрый retry `/fapi/v1/order` через 100ms при `avgPrice=0` / non-terminal status. Использует кэш из `prefetchAccountSettings`; если кэш пуст (probe ещё не выполнился или упал), отрабатывает lazy probe в этом же вызове. В **Hedge Mode** проставляет `positionSide=LONG/SHORT` (derived из `side` и `reduceOnly`: open long → `buy` без reduceOnly → `LONG`; close long → `sell` + reduceOnly → `LONG`; и зеркально для short) и **не** отправляет `reduceOnly` (Binance вернёт `-1106`). В **One-Way Mode** — обычный `reduceOnly=true` без `positionSide`. Если probe упал, клиент логирует warn и работает как One-Way (Binance-дефолт), а на следующем ордере пробует probe снова.
- `fetchOrderCommission` — `GET /fapi/v1/userTrades` с retry-backoff [200, 400, 800, 1500] ms; BNB-fee аппроксимация `notional × 0.00045`.
- `fetchPositions` — `GET /fapi/v2/positionRisk` per symbol; нормализует `positionAmt` в `{symbol, side, size, entryPrice}`.
- `fetchTicker` — `GET /fapi/v1/ticker/24hr?symbol=...` → `{ last, quoteVolume }`.
- `createMarketWs` — `new BinanceMarketWs(store, useTestnet)`.

Signing: `timestamp + recvWindow + HMAC-SHA256(query, secret)`; API key в `X-MBX-APIKEY`.

### 13.1. BinanceMarketWs

Файл: `src/exchanges/binance-market-ws.ts`. Native depth20@100ms combined stream.

URL: `wss://fstream.binance.com/stream?streams=<symbol>@depth20@100ms/<...>`. Pushes top-20 snapshots каждые 100ms. Парсит, нормализует, кладёт в `OrderBookStore`. Reconnect с экспоненциальным backoff (1s→30s).

## 14. BybitClient

Файл: `src/exchanges/bybit-client.ts`. Native REST для Bybit V5 linear futures.

Base URL:
- Testnet: `https://api-testnet.bybit.com`
- Production: `https://api.bybit.com`

Symbol conversion: `BTC/USDT:USDT` ↔ `BTCUSDT`.

Endpoints:

- `loadMarkets` — `GET /v5/market/instruments-info?category=linear&settleCoin=USDT` с пагинацией.
- `setLeverage` — `POST /v5/position/set-leverage` (idempotent через `isAlreadyConfigured` predicate: retCode 110043/110025).
- `setIsolatedMargin` — `POST /v5/position/switch-isolated`; UTA-аккаунты возвращают benign-коды 110026/110027/110028/3400045 + "unified account/not modified/isolated" — все игнорируются.
- `prefetchAccountSettings(symbol)` — `GET /v5/position/list?category=linear&symbol=...` один раз per-symbol, кеш в `Map<symbol, 'hedge' | 'one-way'>`. Hedge определяется по наличию записей с `positionIdx` 1 или 2; иначе One-Way. Cache живёт на жизнь клиента; failed probe не кэшируется (retry на следующем вызове). `Engine.startBot` зовёт параллельно с margin/leverage, `exchange-tester.testTrade` — перед открытием.
- `createMarketOrder` — `POST /v5/order/create` (category=linear); fast retry 150ms на `fetchOrderRaw` для получения `avgPrice`/`cumExecQty`. Использует кэш `prefetchAccountSettings` (lazy probe если кэш пуст). В **Hedge Mode** проставляет `positionIdx=1/2` (derived из `side` + `reduceOnly`: open long → `buy` без reduceOnly → 1; close long → `sell` + reduceOnly → 1; и зеркально для short). В **One-Way Mode** — `positionIdx=0`. `reduceOnly` поддерживается в обоих режимах.
- `fetchOrderCommission` — `fetchOrderRaw` с retry-backoff [200, 400, 800, 1500] ms; `cumExecFee` уже в USDT.
- `fetchPositions` — `GET /v5/position/list?category=linear&settleCoin=USDT` с пагинацией.
- `fetchTicker` — `GET /v5/market/tickers?category=linear&symbol=...`.
- `createMarketWs` — `new BybitMarketWs(store, useTestnet)`.

Signing: HMAC-SHA256 над `timestamp + apiKey + recvWindow + (query или body)`. `recvWindow=15000` ms. Time-offset кэшируется на 60s через `GET /v5/market/time`; при `timestamp/recv_window` error → refresh + один retry.

### 14.1. BybitMarketWs

Файл: `src/exchanges/bybit-market-ws.ts`. Native `v5/public/linear` с `orderbook.50.<SYMBOL>`. Получает `snapshot` затем `delta`; локальная Map<price, qty> сливает дельты и push-ит top-50 в `OrderBookStore` при каждом тике. Ping каждые 20s. Reconnect экспоненциально, при reconnect local books очищаются.

## 15. MexcClient

Файл: `src/exchanges/mexc-client.ts`. Native REST для MEXC contract API.

Base URL: `https://contract.mexc.com` (no public testnet).

Symbol conversion: `BTC/USDT:USDT` ↔ `BTC_USDT`.

Endpoints:

- `loadMarkets` — `GET /api/v1/contract/detail`, фильтр `state===0` + USDT settle.
- `setLeverage` — `POST /api/v1/private/position/change_leverage` (positionType 1 + 2 для long/short legs, `openType=1` для isolated).
- `setIsolatedMargin` — no-op: margin mode задаётся вместе с `setLeverage` через `openType=1`.
- `prefetchAccountSettings(symbol)` — `GET /api/v1/private/position/position_mode` один раз. Логирует `Account position mode: Hedge | One-Way`. Диагностический — side encoding (1=open long, 2=close short, 3=open short, 4=close long) в обоих режимах одинаков per MEXC docs; warning в one-way режиме упрощает диагностику любых неожиданных rejection-ов. `symbol` игнорируется (account-level флаг).
- `createMarketOrder` — `POST /api/v1/private/order/submit`. Side encoding: 1=open long, 2=close short, 3=open short, 4=close long. Quantity в контрактах через `contractSize`. Fast retry 150ms на `GET /api/v1/private/order/get/{id}`.
- `fetchOrderCommission` — `GET /api/v1/private/order/deal_details/{orderId}` с retry-backoff [200, 400, 800, 1500] ms; считает только USDT/USDC fees (промо-период с MX-fee возвращает 0).
- `fetchPositions` — `GET /api/v1/private/position/open_positions`. Filter по symbol set, `holdVol` × `contractSize` → base coin size.
- `fetchTicker` — `GET /api/v1/contract/ticker?symbol=...` → `{ last, quoteVolume }`.
- `createMarketWs` — `new MexcMarketWs(store)`.

Signing: HMAC-SHA256 над `apiKey + timestamp + (sorted query или JSON body)`. Headers: `ApiKey`, `Request-Time`, `Signature`.

### 15.1. MexcMarketWs

Файл: `src/exchanges/mexc-market-ws.ts`. URL `wss://contract.mexc.com/edge`. Подписка `sub.depth.full` с `limit=20` — full snapshot push (no merge logic). Ping каждые 15s. Reconnect экспоненциально.

## 16. GateClient

Файл: `src/exchanges/gate-client.ts`. Native REST для Gate USDT futures.

Base URL:
- Testnet: `https://fx-api-testnet.gateio.ws/api/v4`
- Production: `https://api.gateio.ws/api/v4`

Symbol conversion: `BTC/USDT:USDT` ↔ `BTC_USDT`.

Endpoints:

- `loadMarkets` — `GET /futures/usdt/contracts` (skip `in_delisting`).
- `setLeverage` — `POST /futures/usdt/positions/{contract}/leverage` с `leverage=N` и `cross_leverage_limit=0` (mandatory чтобы остаться в isolated mode).
- `setIsolatedMargin` — `POST /futures/usdt/positions/{contract}/margin` с `size=0` (документированный no-op; Gate by default isolated).
- `prefetchAccountSettings(symbol)` — `GET /futures/usdt/accounts` один раз, читает `in_dual_mode`. Cache живёт на жизнь клиента; failed probe не кэшируется (retry на следующем вызове). `symbol` игнорируется — Gate dual mode задаётся per-settle (USDT), не per-symbol. `Engine.startBot` зовёт параллельно с margin/leverage, `exchange-tester.testTrade` — перед открытием.
- `createMarketOrder` — `POST /futures/usdt/orders` с `tif=ioc` и `price="0"`. Size в контрактах через `quanto_multiplier`. Использует кэш `prefetchAccountSettings` (lazy probe если кэш пуст). В **Single (One-Way) Mode** — `size > 0` для buy, `size < 0` для sell + опциональный `reduce_only`. В **Dual (Hedge) Mode** опен использует ту же signed-size форму, а close (reduce_only) отправляется как `size=0` + `auto_size=close_long` (при sell) или `close_short` (при buy) + `reduce_only=true` — это документированный Gate close-path для dual mode; signed size при close в dual mode открыл бы противоположную позицию вместо reduce. Fast retry 150ms на `GET /futures/usdt/orders/{id}` для `fill_price`.
- `fetchOrderCommission` — `GET /futures/usdt/my_trades?contract=&order=` с retry-backoff [200, 400, 800, 1500] ms; сумма `|fee|`.
- `fetchPositions` — `GET /futures/usdt/positions/{contract}` per symbol; size × multiplier → base coin.
- `fetchTicker` — `GET /futures/usdt/tickers?contract=...` → `{ last, quoteVolume }`.
- `createMarketWs` — `new GateMarketWs(store, useTestnet)`.

Signing: HMAC-SHA512 над `METHOD\n/api/v4/path\nQUERY\nSHA512(BODY)\nTIMESTAMP`. Headers: `KEY`, `Timestamp`, `SIGN`.

### 16.1. GateMarketWs

Файл: `src/exchanges/gate-market-ws.ts`. URL `wss://fx-ws.gateio.ws/v4/ws/usdt`. Подписка `futures.order_book` с payload `[contract, "20", "100ms"]` — full top-20 snapshot push каждые 100ms. Ping `futures.ping` каждые 20s. Reconnect экспоненциально.

## 17. Types

Файл: `src/types/index.ts`. Существенные типы:

- `OrderbookPrices` — normalized price object (primary/secondary bid/ask).
- `SymbolMarketInfo` — exchange-specific lot/precision/min-notional.
- `UnifiedMarketInfo` — conservative merged constraints + precomputed `tradeAmount`.
- `OrderResult` — normalized order result returned by `createMarketOrder`.
- `TradeOpenPayload` / `TradeClosePayload` — Django trade API payloads.
- `TradeRecord` — Django response shape.

Дополнительно `src/exchanges/market-ws.ts`:
- `MarketWsClient` — интерфейс native WS клиента.
- `ExchangePosition` — нормализованная позиция.
- `ExchangeTicker` — `{ last, quoteVolume }`.

## 18. Logger

Файл: `src/utils/logger.ts`. Без изменений: levels `DEBUG`/`INFO`/`WARN`/`ERROR`, env `LOG_LEVEL` (default `INFO`), формат `<iso> [LEVEL] [Tag] message`.

Tags: `MAIN`, `API`, `Engine`, `Bot-{id}[{coin}]`, exchange client names (`BinanceClient`, `BybitClient`, `MexcClient`, `GateClient`), `BinanceMarketWs`, `BybitMarketWs`, `MexcMarketWs`, `GateMarketWs`, `MarketInfo`, `Math`.

## 19. Integration with Django backend

Django sends engine lifecycle commands from `apps.bots.api.views.sync_with_engine`.

Django engine URL: `http://127.0.0.1:3001/engine/bot`.

| Django event | Engine endpoint |
|---|---|
| BotConfig create (`is_active=True`) | `POST /engine/bot/start` |
| BotConfig update (config changes) | `POST /engine/bot/sync` |
| BotConfig update (`is_active: True → False`) | `POST /engine/bot/pause` |
| BotConfig update (`is_active: False → True`) | `POST /engine/bot/start` (идемпотентный resume) |
| BotConfig delete | `POST /engine/bot/stop` |
| Bot force close action | `POST /engine/bot/force-close` |

Engine calls back to Django:

| Engine action | Django endpoint |
|---|---|
| Open real trade | `POST /api/bots/real-trades/` |
| Close real trade | `PATCH /api/bots/real-trades/{id}/` |
| Update real trade | `PATCH /api/bots/real-trades/{id}/` |
| List open real trades | `GET /api/bots/real-trades/?status=open&bot_id=...` |
| Open emulation trade | `POST /api/bots/trades/` |
| Close emulation trade | `PATCH /api/bots/trades/{id}/` |
| Update emulation trade | `PATCH /api/bots/trades/{id}/` |
| List open emulation trades | `GET /api/bots/trades/?status=open&bot_id=...` |

Auth модель: Django → engine через `X-Service-Token` header (preHandler). Engine → Django через тот же `X-Service-Token`.

## 20. Supported exchanges and naming

Engine expected names в `BotConfig`:

- `binance_futures`
- `bybit_futures`
- `mexc_futures`
- `gate_futures`

Django choices observed in backend могут отличаться (`binance_spot`, отсутствие `gate_futures` или `mexc_futures`). При запуске бота с неподдерживаемым именем engine бросает `Unknown REST exchange` → start fails fast вместо тихого fallback.

## 21. Real vs emulator mode

### Emulator mode

Condition: `bot.trade_mode !== 'real'`.

- No real exchange orders.
- Market data из native WS клиентов.
- Open/close prices — orderbook VWAP.
- Trades пишутся в Django `EmulationTrade`.

### Real mode

Condition: `bot.trade_mode === 'real'`.

- `setIsolatedMargin` + `setLeverage` per leg.
- Market orders на обеих ногах параллельно.
- Atomic compensation на partial failure.
- Close через reduceOnly market orders.
- Trades пишутся в Django `Trade`.

Risk:
- True atomicity across exchanges невозможна.
- Compensation orders могут падать → `verifyAndCloseResidual` + CRITICAL-лог.
- Fill prices, commissions и position fetches eventually consistent.

## 22. Current build status

Command:

```bash
pnpm build
```

Current result: succeeds with no TypeScript errors after removing `ccxt`/`axios` and switching to native clients.

## 23. Commands

From project root:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-bot-engine

pnpm install
pnpm build
pnpm dev    # tsx watch src/main.ts
pnpm start  # node dist/main.js
```

Expected server URL: `http://127.0.0.1:3001`.

### 23.1. Production-сборка (Docker / Dokploy)

Production-образ строится из самого каталога `arbitration-bot-engine/`. Артефакты:

- `Dockerfile` — multi-stage:
  - Stage 1 (`builder`) на `node:22-slim`, ставит **все** зависимости через `pnpm install --frozen-lockfile`, компилирует TypeScript (`pnpm run build` → `tsc` → `./dist`).
  - Stage 2 (`runtime`) на `node:22-slim`, ставит **только** `--prod` зависимости (нет `tsc`/`tsx`/`@types/*` в финальном слое), копирует `dist/` из builder. PID 1 — `tini` для корректного SIGTERM от Dokploy/Docker → Fastify успевает закрыть HTTP-сервер. Запуск от non-root `node` user.
- `.dockerignore` — режет `node_modules/`, `dist/`, `.env*` (кроме `.env.example`), `.git/`, `DOCS.md`. Это критично, чтобы локальный `.env` со `SERVICE_SHARED_TOKEN` не попадал в образ.

Build context для Dokploy:

- В Dokploy указать **Build Path** = корень репозитория, **Dockerfile Path** = `arbitration-bot-engine/Dockerfile`, **Build Context** = `arbitration-bot-engine/`. Альтернатива — подключать в Dokploy только подкаталог как отдельный source.
- Контейнер слушает порт `3001` (control plane). Пробрасывать через Traefik/прокси Dokploy.

Обязательные env vars в Dokploy:

- `SERVICE_SHARED_TOKEN` — обязан **посимвольно** совпадать со значением в Django (`arbitration-art-django` env). Любое расхождение → engine отбрасывает lifecycle-запросы от Django с 401, Django отбрасывает write-запросы от engine.
- `DJANGO_API_URL` — публичный URL Django API без trailing slash (например `https://api.example.com/api`). Engine использует его для записи trades, fetch активных ботов на bootstrap.
- `ENGINE_SERVICE_URL` — URL, под которым engine виден из Django. Должен **посимвольно** совпадать с `BotConfig.service_url` в БД, иначе `engine-bootstrap` вернёт пустой список и engine стартанёт «холодным» (без восстановленных ботов).
- `PORT` — внутренний порт контейнера (дефолт `3001`). Меняем только если в инфре нужен другой.

Опциональные (есть дефолты в `config.ts`):

- `USE_TESTNET` — `true` для Binance/Bybit/Gate sandbox. Для production реальных денег держать `false`. MEXC contract sandbox не поддерживает — флаг no-op.
- `TRADE_AMOUNT_USDT` — fallback notional, если у `BotConfig` нет `coin_amount`.
- `LOG_LEVEL` — `DEBUG|INFO|WARN|ERROR`. На hot path debug-логи дают заметный overhead, на prod держать `INFO`/`WARN`.
- `ORDERBOOK_MAX_AGE_MS` (дефолт 15000), `ORDERBOOK_MAX_SKEW_MS` (дефолт 20000 — зафиксированный лимит) — guards для cross-leg snapshot freshness.

Риски и подводные камни при деплое:

- **Latency.** Engine — hot path: сетевые hop-ы между engine и биржей напрямую влияют на slippage. Размещать engine **географически близко** к биржевым endpoint-ам, не за лишними VPN/прокси. Канал engine ↔ Django (REST) — холодный, его можно держать дальше.
- **Биржевые ключи в plaintext.** Engine получает API keys в lifecycle payload от Django по HTTP. Если Django и engine на разных хостах, использовать private network или TLS-терминацию на прокси между ними. См. также §25.1.
- **`.env` в образ не кладём.** Все env vars приходят через Dokploy env injection; `.dockerignore` страхует от случайного попадания локального `.env` с реальным токеном.
- **Multi-instance.** Engine не имеет distributed lock (см. §25.2). Запускать **один** контейнер engine на один Django, либо изолировать каждую инстанцию engine своим набором `BotConfig.service_url`. Dokploy replica scaling > 1 для engine — небезопасно.
- **Graceful shutdown.** `tini` доставляет SIGTERM в Node; Fastify сам по себе не закрывает live-WS к биржам — при rolling deploy открытые позиции остаются на бирже, engine при перезапуске восстановит их через Django bootstrap. Не делать deploy в момент активной торговли без необходимости.

Локальный smoke build (опционально):

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-bot-engine
docker build -t arbitration-bot-engine:local .
```

Control endpoints:

```text
POST http://127.0.0.1:3001/engine/bot/start
POST http://127.0.0.1:3001/engine/bot/sync
POST http://127.0.0.1:3001/engine/bot/stop
POST http://127.0.0.1:3001/engine/bot/force-close
POST http://127.0.0.1:3001/engine/exchange/test-connection
POST http://127.0.0.1:3001/engine/exchange/test-trade
GET  http://127.0.0.1:3001/health
```

## 24. Recommended smoke tests after fixes

After build блокеров:

```bash
pnpm build
```

Start Django and engine:

```bash
# terminal 1, Django project
venv/bin/python manage.py runserver

# terminal 2, engine project
pnpm dev
```

Manual endpoint health check (sync against non-existent bot):

```bash
curl -X POST http://127.0.0.1:3001/engine/bot/sync \
  -H 'Content-Type: application/json' \
  -H "X-Service-Token: $SERVICE_SHARED_TOKEN" \
  -d '{"bot_id":999,"config":{"id":999,"coin":"BTC/USDT:USDT","is_active":false}}'
```

Expected:

- HTTP 200 `{ "success": true }`.
- Engine logs warning `Bot 999 not found in this engine instance during sync.`

Для real start smoke test — testnet credentials only.

Behavioral tests, которые имеет смысл добавить:

- `calculateOpenSpread` buy/sell formulas.
- `calculateRealPnL` buy/sell formulas.
- `calculateVWAP` full depth vs insufficient depth vs emergency behavior.
- `checkLegDrawdown`.
- `api.getOpenTrades` paginated response parsing.
- `Engine.syncBot` missing/running bot behavior.
- `BotTrader` inactive bot skips entry but still checks exit.
- `force_close` close reason mapping.
- Native WS клиентов: snapshot/delta merge на Bybit, parsing payloads на Binance/MEXC/Gate.

## 25. Risks and known limitations

### 25.1. Control-plane network isolation

`X-Service-Token` валидирует все control-plane запросы. CORS остаётся `origin: '*'`, поэтому процесс должен быть изолирован на localhost / private network / firewall.

### 25.2. Multi-process duplication risk

Только in-process защита от двойного запуска (`traders` Map + `starting` Set). Два engine-процесса на один Django могут открыть две позиции параллельно. Возможные защиты: DB lease / heartbeat per bot, Redis lock, single queue consumer, engine instance id в Django.

### 25.3. Recovery edge-cases

Recovery открытых сделок (`Engine.startBot` → `api.getOpenTrades(botId)` → `BotTrader.restoreOpenTrades`) фильтрует по `bot_id` на стороне Django и затем по `coin` в памяти. После крэша engine `bootstrapFromDjango` сам зовёт `startBot` для каждого `is_active=True` бота, чьё `service_url` совпадает с `ENGINE_SERVICE_URL`. Остаются известные edge-case:

- Дубли open-записей на одном `(bot_id, coin)`: `restoreOpenTrades` берёт самую свежую по `opened_at` и логирует ERROR с ID дубликатов, остальные оставляет «требуют ручной сверки».
- Удалённый `BotConfig`: `Trade.bot` обнуляется (on_delete=SET_NULL), и фильтр `bot_id=X` такие сделки уже не вернёт.
- `is_active=False` бот с открытыми сделками в БД: bootstrap намеренно его не поднимает, чтобы не возобновлять торговлю на боте, который оператор поставил на паузу. Открытая позиция на бирже остаётся без engine-мониторинга — её нужно закрыть через `force-close` (после `is_active=True`) либо вручную на бирже.
- Закрывающий PATCH в Django, не доехавший до фиксации (`Trade.status='open'` при фактически закрытой позиции на бирже): после bootstrap `restoreOpenTrades` подцепит запись как «активную»; следующий timeout/force-close попробует reduceOnly close — биржа вернёт ошибку «no position», engine залогирует `🚨 CRITICAL` и потребуется ручная сверка PnL и сторнирования.
- Несовпадение `ENGINE_SERVICE_URL` engine-а и `BotConfig.service_url`: bootstrap получит пустой список и engine стартует холодным (Django видит ботов как `running`, но фактически они не работают). Лог `Bootstrap: no active bots returned for service_url=...` — диагностический сигнал.

### 25.4. Spot/futures naming mismatch

Django и engine могут расходиться в choices для `binance_spot` и `gate_futures`/`mexc_futures`. Запуск бота с неподдерживаемым именем → `Unknown REST exchange` сразу при start.

### 25.5. MEXC native peculiarities

- MEXC contract API не имеет публичного testnet — `USE_TESTNET=true` не меняет endpoint.
- Margin mode задаётся вместе с leverage (`openType=1`). Отдельный `setIsolatedMargin` — no-op.
- MEXC commission в промо-периоды может возвращаться в `MX` (или 0). Native client считает только `USDT`/`USDC` fees.

### 25.6. Bybit UTA quirks

Bybit Unified Trading Accounts не поддерживают per-symbol switch-isolated. Native client отлавливает retCode 110026/110027/110028/3400045 и текстовые признаки "unified/isolated/not modified" как benign no-op, чтобы UTA-ключи не блокировали bot start.

### 25.7. No automated tests

Test framework отсутствует. Перед изменениями математики (`utils/math.ts`), state-машины `BotTrader` (`executeOpen`/`executeClose`/`verifyAndCloseResidual`) и WS-парсинга нужно сначала покрыть тестами.

### 25.8. Secrets in logs/payloads

Engine принимает exchange keys от Django. `Engine.syncBot` логирует только config (без keys), `Engine.startBot` логирует `bot_id` + `coin`. Hot-path payload логи понижены до `DEBUG`. Перед добавлением новых логов проверять, что `keys` не попадают в строку.

### 25.9. Estimated commission window

После real-close в Django ненадолго оседает estimated `close_commission` / `profit_usdt`. Точное значение PATCH-ится background задачей `backfillCloseCommission` обычно за 0.5–3 секунды. UI должен учитывать, что values могут уточняться.

### 25.10. Native WS resilience

Native market WS клиенты делают экспоненциальный reconnect (1s→30s) и шлют ping per биржевому регламенту. На случай длинного network-флапа или зависшего сокета `BotTrader.getPrices` проверяет свежесть snapshot-ов через `ORDERBOOK_MAX_AGE_MS` (per leg) и `ORDERBOOK_MAX_SKEW_MS` (cross-leg): non-emergency сигналы (entry, profit-taking) скипаются, пока WS не догонит. Emergency exits (timeout/liquidation/force-close/shutdown) намеренно проходят сквозь guard — закрыть на чуть устаревшей цене безопаснее, чем оставить позицию открытой. Stale-warning логи rate-limited до одного раза в 5 секунд, чтобы не флудить journal при затяжной деградации стрима. Операторам всё равно следует мониторить теги `WS closed; reconnecting`, `socket error` и `⏱️ stale orderbook` / `⏱️ orderbook skew`.

### 25.11. BNB commission approximation на Binance

`fetchOrderCommission` для Binance конвертирует BNB-комиссии в USDT через `notional × 0.00045`. Это приближение, не точная конверсия по текущей BNB/USDT цене. Для high-volume BNB-fee пользователей возможны расхождения в единицы процентов; точная конверсия потребует отдельного REST-запроса за BNB price.

## 26. Production checklist

1. Развернуть engine за firewall / на localhost, с `X-Service-Token` от Django.
2. Убедиться, что `BotConfig.Exchange` choices и `Engine.createRestClient` совпадают (binance/bybit/mexc/gate futures).
3. Убедиться, что `UserExchangeKeys` поля совпадают с `Engine.extractKeys` mapping для всех бирж, где разрешён real trading (`{exchange}_api_key` / `{exchange}_secret`).
4. Перед real mode стартом: проверить `coin_amount` и `primary_leverage` на BotConfig; `MarketInfoService` должен вернуть `tradeable=true` для пары.
5. Мониторинг: следить за warn/error логами с тегами `🚨 CRITICAL`, `🚨 DB write failed`, `🚨 LIQUIDATION TRIGGERED`, `🟡 Residual`, `Could not fetch commission`, `WS closed; reconnecting` — это сигналы для оператора.
6. SIGINT/SIGTERM запускает graceful shutdown с force-exit timeout 30s — оркестратор (systemd/k8s) должен ставить timeout не меньше 35–40s.

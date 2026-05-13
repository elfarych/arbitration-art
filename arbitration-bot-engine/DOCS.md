# Arbitration Bot Engine - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние проекта `arbitration-bot-engine`: назначение сервиса, архитектуру, HTTP API, торговый цикл, exchange-адаптеры, интеграцию с Django и технические риски. Это рабочая документация для быстрого восстановления контекста перед изменениями.

## 1. Краткое резюме

`arbitration-bot-engine` - отдельный TypeScript/Node.js процесс, который принимает команды от Django backend и исполняет runtime-логику арбитражных ботов.

Главные обязанности engine:

- Поднять Fastify HTTP API на порту `3001`.
- Получать от Django команды `start`, `sync`, `stop`, `force-close` только при валидном `X-Service-Token`.
- Создавать REST-клиенты бирж для account/order операций.
- Создавать WebSocket-клиенты `ccxt.pro` для live orderbook данных.
- Рассчитывать VWAP, spread, PnL, drawdown и timeout exits.
- Открывать/закрывать сделки в real mode через exchange REST API.
- В emulator mode не трогать биржи, а писать сделки в Django как эмуляционные.
- Синхронизировать trade state в Django через `/api/bots/real-trades/` и `/api/bots/trades/` с service token.
- Восстанавливать открытые сделки из Django при старте бота только в scope конкретного `bot_id`.

Текущий проект небольшой, но он работает в высокорисковой зоне: real trading, API keys, market orders, cross-exchange exposure, partial fills, liquidation/timeout exits.

## 1.1. Состояние production-readiness

Актуальное состояние ключевых safety-механизмов и hot-path оптимизаций:

- `src/main.ts` проверяет `X-Service-Token` на всех control-plane endpoints, выполняет structural validation тела запроса (`bot_id`, `config`, `keys`) и регистрирует `SIGINT`/`SIGTERM` для graceful shutdown через `engine.stopAll()`, а также `unhandledRejection` / `uncaughtException` для прозрачной диагностики.
- `src/services/api.ts` отправляет service token в Django, фильтрует recovery по `bot_id` и предоставляет `updateTrade` / `updateEmulationTrade` для PATCH-обновлений комиссии и PnL после background backfill.
- `src/config.ts` экспортирует `serviceToken`, `tradeAmountUsdt`, `useTestnet` и `port`. `tradeAmountUsdt` используется как fallback notional, когда `BotConfig.coin_amount` пуст.
- REST exchange clients принимают credentials через constructor. `Engine.extractKeys` бросает ошибку, если ключи отсутствуют или биржа не распознана, чтобы клиент с пустыми ключами никогда не попадал на order path.
- WebSocket клиенты (ccxt.pro) создаются без API-ключей — orderbook public, и хранить там credentials не нужно.
- `Engine.startBot` использует `Set<starting>` + `Map<traders>` для защиты от race при двух параллельных `start` для одного `bot_id`. Slot освобождается в `finally`.
- `Engine.startBot` запускает `setIsolatedMargin` и `setLeverage` параллельно внутри каждой ноги, и параллельно по двум ногам.
- `MarketInfoService.initialize` для single-symbol запуска бота вызывает `fetchTicker(symbol)` вместо `fetchTickers()`, чтобы startup не тащил тысячи тикеров.

Hot-path latency:

- `createMarketOrder` всех бирж (Binance, Bybit, MEXC, Gate) возвращает управление сразу после подтверждения fill-а (orderId + avgPrice + filledQty), без блокирующего fetch комиссии. Один быстрый retry 100–150ms покрывает редкий случай, когда биржа ещё не вернула `avgPrice`.
- Фактическая комиссия и точный PnL приходят в Django через background-задачу `fetchOrderCommission` + `api.updateTrade(...)` PATCH. На время backfill в Django лежит оценка по taker-rate (Binance 0.05%, Bybit 0.055%, MEXC 0.02%, Gate 0.05%).
- В `executeClose` `fetchPositions` обеих бирж и сами close-ордера выполняются параллельно через `Promise.all` / `Promise.allSettled`.
- В `executeOpen` и `executeClose` при ошибке хотя бы одной ноги вызывается `handleOpenCleanup` / `verifyAndCloseResidual`, который параллельно проверяет позиции на обеих биржах и закрывает residue через reduceOnly.
- Verbose JSON-payload логи на hot path понижены до `DEBUG`.

Safety:

- Если запись trade в Django падает после успешного открытия позиций на бирже в real mode, `executeOpen` сразу выполняет `rollbackOpenLegs` + `handleOpenCleanup`, чтобы не оставить orphan-позицию, про которую engine забудет.
- Если хотя бы одна нога close-ордера отклонена, `executeClose` вызывает `verifyAndCloseResidual` для повторной попытки reduceOnly close по фактическому размеру позиции; в случае невозможности закрыть пишет CRITICAL-лог.
- `BotTrader.stop` ждёт до 30 секунд завершения in-flight операции и затем закрывает оба ccxt.pro WS-соединения, чтобы циклы start/stop не лили коннекшены/память.
- `BotTrader.forceClose` ждёт до 10 секунд завершения текущей операции и только потом форсит close, чтобы команда не игнорировалась `busy`-флагом.

Close-reason mapping (engine → Django):

- `profit`, `timeout`, `shutdown` остаются как есть.
- `liquidation` → `error` (потеря по margin).
- `force_close` → `manual` (manual user override). Status в этом случае — `force_closed`.

## 2. Технологический стек

Фактические зависимости из `package.json`:

- Node.js ESM project (`"type": "module"`).
- TypeScript 5.4.
- `tsx` через lockfile/среду для dev watch script.
- Fastify 4.
- `@fastify/cors`.
- Axios.
- `ccxt`.
- `dotenv`.
- `ts-node` в dev dependencies.

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
    ├── types/
    │   └── index.ts
    ├── classes/
    │   ├── Engine.ts
    │   └── BotTrader.ts
    ├── services/
    │   ├── api.ts
    │   └── market-info.ts
    ├── exchanges/
    │   ├── exchange-client.ts
    │   ├── binance-client.ts
    │   ├── bybit-client.ts
    │   ├── mexc-client.ts
    │   └── gate-client.ts
    └── utils/
        ├── logger.ts
        └── math.ts
```

Основные слои:

- `main.ts` - Fastify control plane.
- `Engine.ts` - manager всех живых `BotTrader`.
- `BotTrader.ts` - торговый цикл одного bot config.
- `exchanges/*` - REST adapters для бирж.
- `services/api.ts` - Django API client.
- `services/market-info.ts` - кеш unified market constraints.
- `utils/math.ts` - spread/PnL/drawdown/VWAP расчеты.
- `types/index.ts` - общие TypeScript interfaces.

## 4. Runtime architecture

Высокоуровневый поток:

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
        +--> ccxt.pro websocket clients for orderbooks
        +--> REST exchange clients for orders/account setup
        +--> MarketInfoService for sizing constraints
        +--> Django API client for trade persistence
```

Runtime state:

- Django хранит persistent state: users, bot configs, trades.
- Engine хранит in-memory state: active `BotTrader` instances, active trade pointer, cooldown, websocket loops.
- При рестарте engine память теряется.
- Восстановление происходит только после нового `start` от Django: `Engine.startBot()` читает open trades из Django и вызывает `trader.restoreOpenTrades()`.

Важно: engine не имеет distributed locking. Если два engine-процесса одновременно получат один и тот же `bot_id`, они могут запустить два независимых trader loop.

## 5. Конфигурация

Файл: `src/config.ts`.

Текущий экспорт:

```ts
export const config = {
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    useTestnet: process.env.USE_TESTNET === 'true',
    port: parseInt(process.env.PORT || '3001', 10),
};
```

Переменные окружения:

| Переменная | Default | Назначение |
|---|---|---|
| `DJANGO_API_URL` | `http://127.0.0.1:8000/api` | Base URL Django API без trailing slash. |
| `USE_TESTNET` | `false` | Переключение биржевых клиентов на sandbox/testnet, если клиент это поддерживает. |
| `PORT` | `3001` | HTTP port Fastify engine. |
| `LOG_LEVEL` | `INFO` | Используется logger-ом, хотя находится не в `config.ts`. |

Критический разрыв контракта:

Код в exchange clients и `MarketInfoService` ожидает дополнительные поля:

```ts
config.binance.apiKey
config.binance.secret
config.bybit.apiKey
config.bybit.secret
config.mexc.apiKey
config.mexc.secret
config.gate.apiKey
config.gate.secret
config.tradeAmountUsdt
```

Но `config.ts` их не экспортирует. Из-за этого `pnpm build` сейчас падает.

Второй разрыв: `Engine.createRestClient()` передает credentials в конструкторы:

```ts
new BinanceClient(creds.apiKey, creds.secret)
```

Но текущие constructors `BinanceClient`, `BybitClient`, `MexcClient`, `GateClient` аргументы не принимают.

Проектная развилка:

- Либо REST-клиенты должны принимать user-specific credentials из Django payload.
- Либо они должны читать global env credentials из `config`.

С учетом Django уже передает `keys` в engine payload, более логичная архитектура - per-user credentials через constructor.

## 6. Fastify HTTP API

Файл: `src/main.ts`.

Engine поднимает Fastify:

```ts
Fastify({ logger: false })
fastify.register(cors, { origin: '*' })
fastify.listen({ port: config.port, host: '0.0.0.0' })
```

Назначение Fastify API: control plane для Django, не публичный browser API.

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
    "max_trade_duration_minutes": 60,
    "max_leg_drawdown_percent": 80,
    "is_active": true
  },
  "keys": {
    "binance_api_key": "...",
    "binance_secret": "...",
    "bybit_api_key": "...",
    "bybit_secret": "...",
    "gate_api_key": "...",
    "gate_secret": "..."
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
{
  "bot_id": 123,
  "config": {}
}
```

Behavior:

- Calls `engine.syncBot(bot_id, config)`.
- Updates in-memory config of existing `BotTrader`.
- Does not start a missing trader.
- Missing trader only logs warning in `Engine`.

### 6.3. `POST /engine/bot/stop`

Payload:

```json
{
  "bot_id": 123
}
```

Behavior:

- Calls `engine.stopBot(bot_id)`.
- If trader exists, calls `trader.stop(true)`.
- `closePositions=true` means active trade should be closed with reason `shutdown`.
- Removes trader from `Engine.traders`.

### 6.4. `POST /engine/bot/force-close`

Payload:

```json
{
  "bot_id": 123
}
```

Behavior:

- Calls `engine.forceClose(bot_id)`.
- If trader has active trade, attempts close using emergency prices.
- Trader remains registered after force-close.

Security note:

- Все control-plane endpoints проверяют `X-Service-Token` через `addHook('preHandler', ...)`. CORS остаётся открытым по умолчанию, поэтому процесс должен быть изолирован на localhost / private network / firewall.

### 6.5. `POST /engine/exchange/test-connection`

Файл: `src/exchanges/exchange-tester.ts` (`testConnection`).

Payload:

```json
{
  "exchange": "binance|bybit|gate|mexc",
  "api_key": "<api key>",
  "secret": "<secret>"
}
```

Behavior:

- Создаёт короткоживущий REST-клиент (`BinanceClient` / `BybitClient` / `GateClient` / `MexcClient`) и не регистрирует его ни в `Engine.traders`, ни в `Engine.starting`.
- Выполняет `loadMarkets()`, затем `ccxtInstance.fetchPositions(['SOL/USDT:USDT'])` для проверки auth и futures read-permissions.
- Возвращает структуру вида `{ ok, exchange, checks: [{name, ok, detail}], error }`. HTTP 200 при любых exchange-ошибках, чтобы Django мог отдать пользователю причину без дополнительной интерпретации.

### 6.6. `POST /engine/exchange/test-trade`

Файл: `src/exchanges/exchange-tester.ts` (`testTrade`).

Payload идентичен `test-connection` (`exchange`, `api_key`, `secret`).

Behavior:

- Берёт фиксированные параметры: `SOL/USDT:USDT`, margin = $15, leverage = 10.
- Последовательно вызывает `setIsolatedMargin`, `setLeverage`, `ccxtInstance.fetchTicker`, считает количество как `(margin * leverage) / lastPrice` и округляет через `getMarketInfo().stepSize`.
- Открывает `createMarketOrder(symbol, 'buy', qty)` и сразу закрывает `createMarketOrder(symbol, 'sell', qty, { reduceOnly: true })`.
- Замеряет latency каждой ноги через `Date.now()` непосредственно вокруг вызова `createMarketOrder` и возвращает `open_latency_ms` и `close_latency_ms` — это чистая длительность HTTP-сделки на бирже без overhead Fastify/Django.
- При ошибке close-ноги выставляет `error` с указанием, что позиция, скорее всего, осталась открытой; пользователь должен закрыть её вручную.
- HTTP 200 при любых exchange-ошибках; HTTP 400 — только при отсутствии полей или неподдерживаемой бирже.

Risk note:

- Endpoint выполняет реальную сделку с реальных средств пользователя на live-бирже (testnet включается только глобальным `USE_TESTNET=true`). Django оборачивает вызов confirmation-диалогом во фронтенде и не повторяет запрос при сетевой ошибке, потому что повтор может привести к второй сделке.

## 7. `Engine`

Файл: `src/classes/Engine.ts`.

`Engine` owns:

```ts
private traders: Map<number, BotTrader>
private starting: Set<number>
```

`traders` keyed by Django `BotConfig.id`; `starting` хранит id ботов с ещё не завершённой инициализацией. Оба контейнера проверяются на старте, чтобы одновременные `start`-запросы для одного `bot_id` не создавали два BotTrader-а параллельно.

### 7.1. Exchange client creation

`createRestClient(name, keys)`:

Maps exchange name from Django config to REST adapter:

| Name | Adapter |
|---|---|
| `binance_futures` | `BinanceClient` |
| `bybit_futures` | `BybitClient` |
| `mexc_futures` | `MexcClient` |
| `gate_futures` | `GateClient` |

Important mismatch:

- Django `BotConfig.Exchange` currently has `BINANCE_SPOT` and `MEXC_FUTURES`, but no `gate_futures`.
- Django `UserExchangeKeys` has Gate keys but no MEXC keys.
- Engine supports `gate_futures`, but Django choices shown in backend docs currently include `mexc_futures` instead.

`createWsClient(name)`:

Создаёт ccxt.pro клиенты БЕЗ credentials — orderbook public, авторизация ни на одной из бирж не нужна, и держать ключи в публичных WS-сокетах — лишняя поверхность для утечек.

| Name | ccxt.pro client |
|---|---|
| `binance_futures` | `pro.binanceusdm()` |
| `bybit_futures` | `pro.bybit({ options: { defaultType: 'swap' } })` |
| `mexc_futures` | `pro.mexc({ options: { defaultType: 'swap' } })` |
| `gate_futures` | `pro.gate({ options: { defaultType: 'swap' } })` |

Spot support:

- Django имеет choice `binance_spot`.
- Engine не обрабатывает `binance_spot` в REST/WS switch.
- Запуск бота c `binance_spot` бросит `Unknown REST exchange` до открытия любых позиций.

### 7.2. Key extraction

`extractKeys(exchangeName, keys)`:

- Binance — `keys.binance_api_key`, `keys.binance_secret`.
- Bybit — `keys.bybit_api_key`, `keys.bybit_secret`.
- Gate — `keys.gate_api_key`, `keys.gate_secret`.
- MEXC — `keys.mexc_api_key`, `keys.mexc_secret`.

Любое отсутствие ключей, отсутствие mapping для биржи или невалидный `keys`-объект приводит к `throw new Error(...)` ДО создания клиента. Этот hard fail умышленно: без него engine мог бы попасть на order path с пустыми credentials и упасть на 401 биржи уже после сигнала, что хуже всего для real-money сценария.

### 7.3. `startBot(botId, config, keys)`

Flow:

1. Если `traders.has(botId)` ИЛИ `starting.has(botId)` — это duplicate start (Django повтор или race); вызывает `syncBot(botId, config)` и return.
2. `starting.add(botId)` — резервирует slot до создания BotTrader, чтобы параллельный второй start корректно ушёл в sync branch.
3. Создаёт primary и secondary REST clients (credentials валидируются `extractKeys`).
4. Параллельный `Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()])`.
5. Создаёт `MarketInfoService` и initialize для `[config.coin]` (single-symbol путь через `fetchTicker`).
6. Если `trade_mode === 'real'`:
   - на каждой ноге, для которой `trade_on_X_exchange = true`, параллельно через `Promise.allSettled([setIsolatedMargin, setLeverage])`;
   - сами две ноги выполняются параллельно через `Promise.all`;
   - rejected задачи логируются как WARN, но startBot не прерывают (большинство бирж считают повторный вызов идемпотентным).
7. Создаёт primary и secondary ccxt.pro WS clients без credentials.
8. `Promise.all([primaryWs.loadMarkets(), secondaryWs.loadMarkets()])`.
9. Создаёт `BotTrader`.
10. Получает открытые сделки из Django (`api.getOpenTrades` / `api.getOpenEmulationTrades`); ошибка fetch не блокирует старт.
11. `trader.restoreOpenTrades(openTrades)`.
12. `traders.set(botId, trader)`.
13. Запускает watch-loops в background через `trader.start().catch(logger.error)`.
14. `finally`: `starting.delete(botId)` независимо от исхода.

Важно:

- `startBot()` не await-ит long-lived trader loop.
- `MarketInfoService.initialize()` result не проверяется в Engine; если кэш пуст, бот стартует, но сигналов не будет — это поведение оставлено намеренно, чтобы операция `start` оставалась идемпотентной для случая, когда биржа временно недоступна.
- Open trade recovery тянет open trades по `bot_id`, затем `BotTrader.restoreOpenTrades` дополнительно фильтрует по coin.

### 7.4. `syncBot(botId, config)`

Behavior:

- Logs JSON config.
- If trader exists, calls `trader.syncConfig(config)`.
- If missing, only logs warning.

This means a Django update cannot start a bot that was never loaded in this engine process.

### 7.5. `stopBot(botId)`

Behavior:

- If trader exists:
  - `await trader.stop(true)`;
  - delete from map.
- If trader missing, no error.

`true` means close active positions/trade with shutdown reason before removal.

### 7.6. `forceClose(botId)`

Behavior:

- If trader exists, calls `trader.forceClose()`.
- If trader missing, no error.

## 8. `BotTrader`

Файл: `src/classes/BotTrader.ts`.

`BotTrader` manages one bot/coin pair and at most one active trade.

Constructor dependencies:

- `bot` - Django BotConfig payload.
- `primaryWs` - ccxt.pro exchange for primary orderbook.
- `secondaryWs` - ccxt.pro exchange for secondary orderbook.
- `primaryClient` - REST adapter implementing `IExchangeClient`.
- `secondaryClient` - REST adapter implementing `IExchangeClient`.
- `marketInfo` - initialized `MarketInfoService`.

### 8.1. Runtime state

`PairState`:

| Field | Meaning |
|---|---|
| `activeTrade` | Current Django trade record or `null`. |
| `openedAtMs` | Local timestamp for timeout checks. |
| `busy` | Re-entrancy lock for open/close operations. |
| `cooldownUntil` | Timestamp until next entry attempt is blocked after failure. |

Constants:

- `COOLDOWN_MS = 30_000` — пауза между неудачной попыткой open и следующей.
- `TIMEOUT_CHECK_INTERVAL_MS = 10_000` — частота проверки `max_trade_duration_minutes`.
- `STOP_BUSY_WAIT_MS = 30_000` — макс. время ожидания в `stop()` чтобы in-flight операция корректно завершилась.
- `FORCE_CLOSE_BUSY_WAIT_MS = 10_000` — макс. время ожидания в `forceClose` перед попыткой закрыть.
- `ESTIMATED_TAKER_RATE` — оценки taker fee per exchange (binance 0.05%, bybit 0.055%, mexc 0.02%, gate 0.05%) для записи estimated commission до того, как background backfill подставит точное значение.

### 8.2. Lifecycle methods

`syncConfig(newConfig)`:

- Replaces `this.bot`.
- Existing open trade remains active.
- New thresholds/activity flags affect future checks.

`restoreOpenTrades(openTrades)`:

- Finds first trade where `t.coin === this.bot.coin && t.status === 'open'`.
- Sets `activeTrade`.
- Sets `openedAtMs` from `trade.opened_at`.

Risk: does not filter by `bot` id, and real `Trade` has no bot relation. If multiple bots trade the same coin, recovery can attach the wrong open trade.

`start()`:

- Starts timeout timer.
- Runs two infinite websocket watch loops с `Promise.all`.

`stop(closePositions=false)`:

- Sets `isRunning=false`.
- Clears timeout timer.
- Ждёт до `STOP_BUSY_WAIT_MS` (30s) пока in-flight `executeOpen`/`executeClose` корректно закончится — abort посередине open/close может оставить orphan-позицию.
- Если `closePositions && activeTrade`, закрывает позиции с reason `shutdown` через emergency prices.
- Параллельно закрывает оба ccxt.pro WS соединения (`safeWsClose`), чтобы повторные start/stop циклы не лили коннекшены и память.

`forceClose()`:

- Если нет active trade — return.
- Ждёт до `FORCE_CLOSE_BUSY_WAIT_MS` (10s) завершения текущей операции, иначе busy-guard в `executeClose` отбросит forceClose и команда оператора потеряется.
- Берёт active trade amount, emergency prices, вызывает `executeClose('force_close', prices)`.

### 8.3. WebSocket watch loop

`watchLoop(exchange, symbol, exName)`:

- Repeatedly calls `exchange.watchOrderBook(symbol, limit=50)`.
- After each successful update, calls `checkSpreads()`.
- On error:
  - increments `consecutiveErrors`;
  - logs error;
  - waits `min(2000 * consecutiveErrors, 30000)` ms.

The actual orderbook is read from `exchange.orderbooks[symbol]` later in `getPrices()`.

### 8.4. Price extraction and VWAP

`getPrices(symbol, targetCoinsFallback?, isEmergency=false)`:

1. Reads primary and secondary orderbooks from ccxt.pro internal cache.
2. Requires both books to have bids and asks.
3. Determines `targetCoins`:
   - close: explicit fallback from active trade amount;
   - entry: `marketInfo.getInfo(symbol)?.tradeAmount`.
4. Calculates VWAP for:
   - primary bid;
   - primary ask;
   - secondary bid;
   - secondary ask.
5. If any VWAP is `NaN`, returns `null`.
6. Otherwise returns normalized `OrderbookPrices`.

Important behavior:

- Non-emergency VWAP returns `NaN` if there is not enough depth for full target size.
- Emergency VWAP uses available depth if full depth is unavailable.

### 8.5. Entry checks

`checkSpreads()` does both entry and exit routing.

Common guards:

- If `busy`, return.
- If market info missing, return.

If `activeTrade` exists:

- Use active trade amount.
- Compute strict prices and emergency prices.
- Call `checkExit(strictPrices, emergencyPrices)`.
- Return.

If no active trade:

1. Если `bot.is_active=false` — return (inactive bot не открывает новые сделки).
2. Если `Date.now() < state.cooldownUntil` — return.
3. Read current primary best bid.
4. Determine raw amount:
   - `this.bot.coin_amount`, или
   - fallback `engineConfig.tradeAmountUsdt / currentPrice`.
5. Round down to `info.stepSize`.
6. Reject если ниже `minQty` или `minNotional`.
7. Get strict VWAP prices.
8. Compare spread to `bot.entry_spread`:
   - если `order_type` `buy` или `auto` и `currentBuySpread >= entry_spread` → `executeOpen('buy', ...)`;
   - иначе если `order_type` `sell` или `auto` и `currentSellSpread >= entry_spread` → `executeOpen('sell', ...)`.

Каждое spread-направление вычисляется лениво — только если `order_type` действительно его проверяет, чтобы не делать лишней работы на каждом WS-тике.

Entry direction semantics:

- `buy`:
  - buy/long primary;
  - sell/short secondary.
- `sell`:
  - sell/short primary;
  - buy/long secondary.

### 8.6. Opening a trade

`executeOpen(orderType, prices, spread, targetCoins)` устроен так, чтобы латентность от сигнала до подачи ордеров была минимальной, а любые сбои гарантированно не оставляли orphan-позиции.

1. Sets `busy=true`.
2. Determines primary/secondary sides и `isReal = bot.trade_mode === 'real'`.
3. `runPrimary = isReal && trade_on_primary_exchange`, `runSecondary = isReal && trade_on_secondary_exchange`.
4. Обе ноги запускаются параллельно через `Promise.allSettled([createMarketOrder, createMarketOrder])`. `createMarketOrder` каждой биржи возвращает управление сразу после получения fill-а с одним быстрым retry на случай отсутствия `avgPrice` (комиссия в этот момент не запрашивается).
5. Если хотя бы одна нога `rejected`:
   - логируется причина по обеим ногам;
   - для fulfilled real-ноги параллельно отправляется reverse reduceOnly market order на её `filledQty`;
   - в real mode далее `handleOpenCleanup()` сверяет реальные позиции на обеих биржах и закрывает residue;
   - выставляется cooldown, return.
6. Иначе берутся fill prices, либо orderbook VWAP для skipped/emulator-ноги.
7. Реальный open spread пересчитывается по фактическим ценам fill-а.
8. Строится payload. Для real mode добавляются exchange names, order IDs и **estimated open commission** (taker-rate × notional суммарно по обеим ногам). Точное значение PATCH-ом обновляется чуть позже.
9. `api.openTrade` / `api.openEmulationTrade` пишет trade в Django.
10. **Safety**: если write в Django падает в real mode после успешного открытия позиций, `rollbackOpenLegs` параллельно отправляет reverse reduceOnly на обе ноги, затем `handleOpenCleanup` сверяет фактическое состояние, чтобы не остаться с позицией, про которую engine забудет.
11. При успехе в state сохраняется `activeTrade` и `openedAtMs`.
12. Background: `backfillOpenCommission(tradeRecord.id, ...)` параллельно вызывает `fetchOrderCommission` на обеих биржах и PATCH-ит Django точным `open_commission`. Fire-and-forget, ошибки логируются как WARN.
13. `finally`: `busy=false`.

Real mode payload включает: bot, coin, primary/secondary exchange, order_type, status, amount, leverage, primary/secondary_open_price, primary/secondary_open_order_id, open_spread, open_commission (estimated).

Emulator payload включает: bot, coin, order_type, status, amount, leverage, primary/secondary_open_price, open_spread. Поле `leverage` присутствует, но `EmulationTradeSerializer` Django его не объявляет; это известное расхождение, не блокирующее сохранение, поскольку DRF default-конфигурация игнорирует unknown fields в большинстве POST handlers, но требует проверки при изменении serializer-а.

### 8.7. Open cleanup

`handleOpenCleanup()` — safety net после partial open failure или DB rollback:

- Параллельно через `Promise.all` тянет `fetchPositions([symbol])` на обеих биржах (если соответствующий `trade_on_X_exchange = true`).
- Для каждой найденной позиции с `size >= minQty`:
  - `long` → reduceOnly sell;
  - `short` → reduceOnly buy.
- Все close-ордера запускаются параллельно через `Promise.allSettled`.
- Любые ошибки close логируются как ERROR, но cleanup не падает.

### 8.8. Exit checks

`checkExit(strictPrices, emergencyPrices)`:

1. Reads active trade open prices.
2. Reads order type.
3. Reads drawdown limit from `bot.max_leg_drawdown_percent || 80.0`.
4. If emergency prices exist:
   - compute max leveraged leg drawdown;
   - if drawdown >= limit, close with reason `liquidation`.
5. If strict prices exist:
   - compute `calculateTruePnL`;
   - if PnL >= `bot.exit_spread`, close with reason `profit`.

Exit priority:

1. liquidation/drawdown guard;
2. profit target.

Timeout exits are checked separately by timer.

### 8.9. Closing a trade

`executeClose(reason, prices)`:

1. Если `busy=true`, return.
2. `busy=true`.
3. Определяет close sides:
   - buy entry → primary sell, secondary buy;
   - sell entry → primary buy, secondary sell.
4. Парсит open prices и amount из active trade.
5. В real mode:
   - параллельно через `Promise.all` запрашивает `fetchPositions([symbol])` на обеих биржах;
   - для каждой ноги: если позиция найдена — берёт её фактический размер; иначе fallback к recorded `amount` (reduceOnly блокирует двойное закрытие, если позиции уже нет);
   - параллельно через `Promise.allSettled` отправляет reduceOnly market close на обе ноги (если `size >= minQty`);
   - если хотя бы одна нога `rejected`, вызывает `verifyAndCloseResidual`, который проверяет позиции и делает ещё один проход reduceOnly close; при невозможности закрыть пишет CRITICAL-лог;
   - если `avgPrice` close-ноги нулевой (skipped/rejected leg), для отчётности используется текущая VWAP-цена из orderbook либо open price как последний fallback.
6. В emulator mode: цены берутся из текущего orderbook / open price.
7. Считает estimated `close_commission` (taker-rate × notional обеих ног), `total_commission = open + close`, `profitUsdt` / `profitPercentage` через `calculateRealPnL`, `close_spread`, `close_status`.
8. Строит close payload (см. mapping ниже).
9. `api.closeTrade` / `api.closeEmulationTrade` отправляет PATCH в Django. Если write падает, лог ERROR — exchange позиции уже закрыты, state очищается чтобы trader не залип.
10. Сбрасывает `activeTrade` и `openedAtMs`.
11. Background: `backfillCloseCommission` параллельно тянет точные комиссии через `fetchOrderCommission`, пересчитывает `profit_usdt` / `profit_percentage` и PATCH-ит Django финальными значениями. Fire-and-forget.
12. `finally`: `busy=false`.

Close status:

```ts
const closeStatus = (reason === 'profit' || reason === 'shutdown') ? 'closed' : 'force_closed';
```

Close reason mapping (engine → Django Trade.CloseReason):

```ts
payload.close_reason =
    reason === 'liquidation' ? 'error' :       // loss-driven exit
    reason === 'force_close' ? 'manual' :      // user-initiated force-close
    reason;                                    // profit / timeout / shutdown
```

`Trade.CloseReason` choices в Django: `profit`, `timeout`, `manual`, `shutdown`, `error`. Поле `close_status` при liquidation / force_close равно `force_closed`, так что non-organic close виден в UI отдельно от reason.

### 8.10. Timeout checks

`checkTimeouts()`:

- Runs every 10 seconds.
- If no active trade or busy, returns.
- Reads `max_trade_duration_minutes || 60`.
- If elapsed >= max duration:
  - logs timeout;
  - gets emergency prices;
  - closes with reason `timeout`.

### 8.11. Inactive bot behavior

If `bot.is_active=false`:

- Existing active trade continues to be monitored and can close.
- New entries are skipped.

This matches the Django-side comment: deactivated bot should stop opening new trades but let current orders finish.

## 9. Math utilities

Файл: `src/utils/math.ts`.

### 9.1. `calculateOpenSpread(prices, orderType)`

For `sell`:

```text
(primaryBid - secondaryAsk) / secondaryAsk * 100
```

Interpretation:

- short/sell primary at bid;
- long/buy secondary at ask;
- positive spread means primary is expensive relative to secondary.

For `buy`:

```text
(secondaryBid - primaryAsk) / primaryAsk * 100
```

Interpretation:

- long/buy primary at ask;
- short/sell secondary at bid;
- positive spread means secondary is expensive relative to primary.

If denominator missing, returns `-Infinity`.

### 9.2. `calculateTruePnL(openPrices, currentPrices, orderType)`

Used for exit signal evaluation, not final accounting.

It estimates:

- open edge;
- current reversal edge;
- estimated fees of `0.20%` of entry price.

Returns percent.

Final real trade accounting uses `calculateRealPnL`.

### 9.3. `calculateRealPnL(...)`

Calculates actual profit in USDT and percent:

- For sell:
  - primary short PnL = `(openPrimary - closePrimary) * amount`;
  - secondary long PnL = `(closeSecondary - openSecondary) * amount`.
- For buy:
  - primary long PnL = `(closePrimary - openPrimary) * amount`;
  - secondary short PnL = `(openSecondary - closeSecondary) * amount`.
- Subtracts total commission.
- Percent uses capital = `amount * min(openPrimary, openSecondary)`.

### 9.4. `d(value, decimals=8)`

Rounds/trims number before sending JSON to Django DecimalFields.

### 9.5. `checkLegDrawdown(...)`

Computes leveraged drawdown per leg:

- For each leg, compute raw PnL percent.
- Multiply by leverage.
- Only negative PnL counts.
- Return max drawdown of the two legs.

Used for liquidation-risk exit.

### 9.6. `calculateVWAP(orderbookSide, targetCoins, isEmergency=false)`

Calculates volume-weighted average price for a target base-coin amount.

Behavior:

- If no orderbook levels, returns `NaN`.
- If target <= 0, returns first level price.
- Consumes levels until target size is filled.
- If not enough depth:
  - non-emergency: return `NaN`;
  - emergency: use available depth and log warning.

This is central to slippage-aware entry/exit checks.

## 10. MarketInfoService

Файл: `src/services/market-info.ts`.

Purpose:

- Load and cache constraints for symbols tradable on both exchanges.
- Merge constraints conservatively.
- Calculate fixed `tradeAmount`.
- Filter suspicious ticker collisions.

Cache:

```ts
private cache: Map<string, UnifiedMarketInfo>
```

`initialize(primaryClient, secondaryClient, commonSymbols)` flow:

1. Fetch tickers from both clients.
2. Store current last prices per symbol.
3. For each symbol:
   - read primary market info;
   - read secondary market info;
   - skip if missing on either exchange;
   - choose max `stepSize`;
   - choose max `minQty`;
   - choose max `minNotional`;
   - compare primary/secondary price deviation;
   - skip if deviation > 40%;
   - calculate `tradeAmount = config.tradeAmountUsdt / currentPrice`;
   - round down to step size;
   - reject if below min quantity or min notional;
   - store unified info.
4. Return list of tradeable symbols.

Critical current issue:

- `config.tradeAmountUsdt` does not exist in `config.ts`.
- Also `BotTrader` later uses `bot.coin_amount` for entry sizing, so the relationship between global `tradeAmountUsdt` and per-bot `coin_amount` needs clarification.

Potential simplification:

- If Django always sends `coin_amount`, `MarketInfoService` should not calculate tradeAmount from global USDT amount.
- It should cache only constraints, and BotTrader should validate `bot.coin_amount` against those constraints.

## 11. Django API client

Файл: `src/services/api.ts`.

Axios client:

```ts
baseURL: config.djangoApiUrl
Content-Type: application/json
timeout: 15000
```

No auth headers are sent.

This relies on Django endpoints:

- `/api/bots/real-trades/`
- `/api/bots/trades/`

In current Django backend, these endpoints use `AllowAny`, so engine can write without JWT.

### 11.1. Real trade methods

`openTrade(payload)`:

- `POST /bots/real-trades/`
- logs created Django trade ID.
- returns `TradeRecord`.

`closeTrade(id, payload)`:

- `PATCH /bots/real-trades/{id}/`
- logs profit.
- returns `TradeRecord`.

`getOpenTrades()`:

- `GET /bots/real-trades/?status=open`
- supports both paginated and raw-array response.
- on error logs and returns `[]`.

### 11.2. Emulation trade methods

`openEmulationTrade(payload)`:

- `POST /bots/trades/`

`closeEmulationTrade(id, payload)`:

- `PATCH /bots/trades/{id}/`

`getOpenEmulationTrades()`:

- `GET /bots/trades/?status=open`
- supports paginated/raw array.
- on error logs and returns `[]`.

Mismatch to verify:

- TypeScript `TradeOpenPayload` is shaped for real `Trade`.
- Emulator payloads reuse `any`.
- Django `EmulationTradeSerializer` does not include all real-trade fields.

## 12. Exchange client interface

Файл: `src/exchanges/exchange-client.ts`.

All REST clients implement:

```ts
interface IExchangeClient {
  readonly name: string;
  readonly ccxtInstance: any;
  loadMarkets(): Promise<void>;
  setLeverage(symbol, leverage): Promise<void>;
  setIsolatedMargin(symbol): Promise<void>;
  createMarketOrder(symbol, side, amount, params?): Promise<OrderResult>;
  getMarketInfo(symbol): SymbolMarketInfo | null;
  getUsdtSymbols(): string[];
}
```

The interface intentionally covers REST/account behavior, not WebSocket streaming. WebSockets are created separately through `ccxt.pro`.

## 13. BinanceClient

Файл: `src/exchanges/binance-client.ts`.

Type: direct signed REST adapter for Binance USDT-M Futures.

Base URL:

- Testnet: `https://testnet.binancefuture.com`
- Production: `https://fapi.binance.com`

Symbol conversion:

- ccxt: `BTC/USDT:USDT`
- Binance REST: `BTCUSDT`

Key operations:

- `loadMarkets()`:
  - calls `/fapi/v1/exchangeInfo`;
  - caches perpetual USDT symbols.
- `setLeverage()`:
  - `POST /fapi/v1/leverage`;
  - treats "No need to change" as success.
- `setIsolatedMargin()`:
  - `POST /fapi/v1/marginType`;
  - treats already-isolated response as success.
- `createMarketOrder()`:
  - `POST /fapi/v1/order` с `newOrderRespType=RESULT`, чтобы Binance вернул `avgPrice`/`executedQty` синхронно;
  - тип `MARKET`, поддерживает `reduceOnly`;
  - один быстрый retry `/fapi/v1/order` через 100ms, если `avgPrice=0` или статус не terminal;
  - комиссия в этом вызове НЕ запрашивается, чтобы не блокировать hot path; используется `fetchOrderCommission`.
- `fetchOrderCommission(symbol, orderId)`:
  - тянет `/fapi/v1/userTrades` с retry-backoff [200, 400, 800, 1500] ms;
  - агрегирует `commission` в USDT-эквивалент; для `BNB`-комиссий применяется приближённый расчёт `notional × 0.00045`, потому что точная конверсия требовала бы отдельного REST-запроса за BNB-курсом.
- `getMarketInfo()`:
  - parses filters `PRICE_FILTER`, `LOT_SIZE`, `MIN_NOTIONAL`.
- `getUsdtSymbols()`:
  - returns ccxt-format futures symbols.

Signing:

- Adds `timestamp` and `recvWindow`.
- Builds query string.
- HMAC-SHA256 with Binance secret.
- Sends API key in `X-MBX-APIKEY`.

Constructor принимает `(apiKey, secret)` напрямую — engine читает user-keys из payload Django и пробрасывает их в client. WebSocket Binance USDT-M создаётся отдельно через `pro.binanceusdm()` без credentials (orderbook public).

## 14. BybitClient

Файл: `src/exchanges/bybit-client.ts`.

Type: ccxt-based Bybit USDT perpetual adapter.

Constructor:

- `new ccxt.bybit({ apiKey, secret, enableRateLimit, sandbox?, options: { defaultType: 'swap' } })`

Operations:

- `loadMarkets()` via ccxt.
- `setLeverage()` via `exchange.setLeverage`. "leverage not modified" / `110043` трактуется как idempotent success.
- `setIsolatedMargin()` via `exchange.setMarginMode('isolated')`. UTA-аккаунты могут не поддерживать per-symbol margin mode; такие отказы (`110026`, `110027`, `110028`, `3400045`, тексты с "isolated", "unified", "not modified") трактуются как benign и не прерывают старт.
- `createMarketOrder()` via `exchange.createMarketOrder`. После create — один быстрый retry `fetchOrder` через 150ms, если `average` не пришёл. Комиссия в этот момент НЕ извлекается.
- `fetchOrderCommission(symbol, orderId)` тянет `fetchOrder` с backoff [200, 400, 800, 1500] ms и нормализует `fees` / `fee` в USDT-эквивалент через `extractCommission`.
- `getMarketInfo()` converts ccxt precision to step size.
- `getUsdtSymbols()` filters symbols ending with `:USDT`.
- `extractCommission()` normalizes fees to approximate USDT.

Constructor принимает `(apiKey, secret)` для REST-операций. WebSocket Bybit создаётся отдельно через `pro.bybit({ options: { defaultType: 'swap' } })` без credentials.

## 15. MexcClient

Файл: `src/exchanges/mexc-client.ts`.

Type: ccxt-based MEXC futures adapter.

Constructor:

- `new ccxt.mexc({ apiKey, secret, enableRateLimit, sandbox?, options: { defaultType: 'swap' } })`

Operations:

- `loadMarkets()` via ccxt.
- `setLeverage()` warning-only on failure.
- `setIsolatedMargin()`:
  - tries `setMarginMode('isolated')`;
  - if fails, attempts implicit direct API fallback `contractPrivatePostApiV1MarginIsolated`.
- `createMarketOrder()`:
  - вызывает `exchange.createMarketOrder`;
  - один быстрый retry `fetchOrder` через 150ms, если `average` не вернулся;
  - комиссия НЕ запрашивается на hot path.
- `fetchOrderCommission(symbol, orderId)` тянет `fetchOrder` с retry-backoff [200, 400, 800, 1500] ms; нормализует комиссии через `extractCommission`, который считает только USDT/USDC fees (MEXC может промо-периодом давать 0% taker, тогда возвращается 0).
- `getMarketInfo()` handles tick-size precision mode.
- `getUsdtSymbols()` filters `:USDT`.
- `extractCommission()` counts USDT/USDC fees and ignores unknown assets.

Известные особенности:

- MEXC contract API ненадёжно поддерживает unified `reduceOnly` через ccxt. Поэтому engine на cleanup/close сначала запрашивает фактические позиции через `fetchPositions` и отправляет explicit opposite-side ордер; флаг `reduceOnly` оставлен в params как доп. защита exchange-уровня.
- Django `UserExchangeKeys` должна содержать поля `mexc_api_key` / `mexc_secret` (`Engine.extractKeys` ожидает именно их). Если их нет — `extractKeys` бросает ошибку до создания клиента.

## 16. GateClient

Файл: `src/exchanges/gate-client.ts`.

Type: direct signed REST adapter for Gate USDT futures.

Base URL:

- Testnet: `https://fx-api-testnet.gateio.ws/api/v4`
- Production: `https://api.gateio.ws/api/v4`

Symbol conversion:

- ccxt: `BTC/USDT:USDT`
- Gate: `BTC_USDT`

Operations:

- `loadMarkets()`:
  - `GET /futures/usdt/contracts`;
  - caches contract metadata.
- `setLeverage()`:
  - `POST /futures/usdt/positions/{contract}/leverage` с `leverage=N` и `cross_leverage_limit=0`. Передавать оба ненулевых значения нельзя: Gate либо отклонит запрос, либо молча переключит позицию в cross.
- `setIsolatedMargin()`:
  - attempts margin endpoint;
  - treats unsupported/already-isolated cases as non-fatal debug.
- `createMarketOrder()`:
  - converts base amount to contract size via `quanto_multiplier`;
  - positive size for buy, negative for sell;
  - submits IOC order with `price: "0"`;
  - supports `reduce_only`;
  - один быстрый retry GET `/futures/usdt/orders/{id}` через 150ms, если `fill_price=0`;
  - комиссия НЕ запрашивается на hot path;
  - converts filled contract count back to base amount.
- `fetchOrderCommission(symbol, orderId)` тянет `/futures/usdt/my_trades` с backoff [200, 400, 800, 1500] ms и суммирует `|fee|`.
- `getMarketInfo()`:
  - converts contract constraints to base coin constraints.
- `getUsdtSymbols()`:
  - returns direct USDT contracts in ccxt format.

Signing:

- SHA512 hash of payload.
- Signature string:

```text
METHOD
/api/v4/path
query
hashedPayload
timestamp
```

- HMAC-SHA512 with Gate secret.

Constructor принимает `(apiKey, secret)`. WebSocket Gate создаётся отдельно через `pro.gate({ options: { defaultType: 'swap' } })` без credentials. Если Django BotConfig.exchange choices не содержат `gate_futures`, использование Gate возможно только через ручное расширение enum.

## 17. Types

Файл: `src/types/index.ts`.

### 17.1. `OrderbookPrices`

Normalized price object:

```ts
{
  primaryBid,
  primaryAsk,
  secondaryBid,
  secondaryAsk
}
```

Prices are VWAP values for intended amount, not necessarily top-of-book.

### 17.2. `SymbolMarketInfo`

Exchange-specific constraints:

- `symbol`;
- `minQty`;
- `stepSize`;
- `minNotional`;
- `pricePrecision`;
- `quantityPrecision`.

### 17.3. `UnifiedMarketInfo`

Conservative merged constraints:

- max step size;
- max min quantity;
- max min notional;
- precomputed `tradeAmount`;
- `tradeable`.

### 17.4. `OrderResult`

Normalized exchange order result:

- `orderId`;
- `avgPrice`;
- `filledQty`;
- `commission`;
- `commissionAsset`;
- `status`;
- `raw`.

### 17.5. `TradeOpenPayload`

Typed for real Django `Trade` open payload.

Contains:

- coin;
- exchanges;
- order type;
- status;
- amount;
- leverage;
- open prices;
- order IDs;
- open spread;
- open commission.

### 17.6. `TradeClosePayload`

Typed for real Django `Trade` close payload.

Important mismatch:

- Type includes `liquidation`.
- BotTrader can use `force_close`.
- Django choices do not include either as close_reason.
- BotTrader maps `liquidation -> error`, but not `force_close -> manual`.

### 17.7. `TradeRecord`

Django response shape for active trade recovery.

Important:

- Django DecimalFields arrive as strings.
- BotTrader parses them before calculations.

## 18. Logger

Файл: `src/utils/logger.ts`.

Log levels:

- `DEBUG`
- `INFO`
- `WARN`
- `ERROR`

Priority:

```ts
DEBUG: 0
INFO: 1
WARN: 2
ERROR: 3
```

`LOG_LEVEL` env controls minimum log level; default `INFO`.

Format:

```text
2026-04-22T...Z [INFO]  [Tag] message
```

Tags:

- `MAIN`
- `API`
- `Engine`
- `Bot-{id}[{coin}]`
- exchange client names
- `MarketInfo`
- `Math`

Risk:

- Invalid `LOG_LEVEL` is not validated.
- If `LOG_LEVEL` is invalid, priority lookup can behave unexpectedly.

## 19. Integration with Django backend

Django sends engine lifecycle commands from `apps.bots.api.views.sync_with_engine`.

Django engine URL:

```text
http://127.0.0.1:3001/engine/bot
```

Mapping:

| Django event | Engine endpoint |
|---|---|
| BotConfig create | `POST /engine/bot/start` |
| BotConfig update | `POST /engine/bot/sync` |
| BotConfig delete | `POST /engine/bot/stop` |
| Bot force close action | `POST /engine/bot/force-close` |

Engine calls back to Django:

| Engine action | Django endpoint |
|---|---|
| Open real trade | `POST /api/bots/real-trades/` |
| Close real trade | `PATCH /api/bots/real-trades/{id}/` |
| List open real trades | `GET /api/bots/real-trades/?status=open` |
| Open emulation trade | `POST /api/bots/trades/` |
| Close emulation trade | `PATCH /api/bots/trades/{id}/` |
| List open emulation trades | `GET /api/bots/trades/?status=open` |

Current auth model:

- Django -> engine: no engine auth.
- Engine -> Django: no Django auth.
- This relies on network isolation and Django `AllowAny` endpoints.

## 20. Supported exchanges and naming

Engine expected names:

- `binance_futures`
- `bybit_futures`
- `mexc_futures`
- `gate_futures`

Django choices observed in backend:

- `binance_futures`
- `binance_spot`
- `bybit_futures`
- `mexc_futures`

Mismatch:

- Django allows `binance_spot`, engine does not.
- Engine allows `gate_futures`, Django does not.
- Django stores Gate credentials, but no MEXC credentials.
- Engine extracts MEXC credentials, but Django does not store them.

This should be reconciled before production usage.

## 21. Real vs emulator mode

### Emulator mode

Condition:

```ts
bot.trade_mode !== 'real'
```

Behavior:

- No real exchange orders.
- Market data still comes from WS clients.
- Open/close prices come from orderbook VWAP.
- Trades are written to Django `EmulationTrade`.

Potential issue:

- Engine still creates REST clients and WS clients using credentials even for emulator mode.
- If credentials/config are missing and constructors require them, emulator mode can fail before trading.

### Real mode

Condition:

```ts
bot.trade_mode === 'real'
```

Behavior:

- Sets isolated margin and leverage.
- Opens market orders on enabled legs.
- Attempts atomic compensation if one leg fails.
- Closes with reduce-only orders.
- Writes real `Trade` records in Django.

Risk:

- True atomicity across exchanges is impossible.
- Compensation orders can fail.
- Fill prices, commissions and position fetches are eventually consistent and require polling.

## 22. Current build status

Command:

```bash
pnpm build
```

Current result: fails with TypeScript errors.

Observed errors:

```text
src/classes/Engine.ts(...): Expected 0 arguments, but got 2.
src/exchanges/binance-client.ts(...): Property 'binance' does not exist on type config.
src/exchanges/bybit-client.ts(...): Property 'bybit' does not exist on type config.
src/exchanges/gate-client.ts(...): Property 'gate' does not exist on type config.
src/exchanges/mexc-client.ts(...): Property 'mexc' does not exist on type config.
src/services/market-info.ts(...): Property 'tradeAmountUsdt' does not exist on type config.
```

Root causes:

1. `Engine` passes credentials into exchange constructors.
2. Constructors accept no args.
3. Exchange clients read credentials from `config`.
4. `config` does not define exchange credentials.
5. `MarketInfoService` reads `config.tradeAmountUsdt`.
6. `config` does not define `tradeAmountUsdt`.

Recommended fix direction:

- Make exchange clients accept credentials through constructors:

```ts
constructor(apiKey = '', secret = '') { ... }
```

- Use those instance credentials in signing/client setup.
- Remove global exchange credentials from `config` unless there is a deliberate single-account mode.
- Remove or replace `tradeAmountUsdt` with per-bot `coin_amount`.

## 23. Commands

From project root:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-bot-engine
```

Install dependencies:

```bash
pnpm install
```

Run TypeScript build:

```bash
pnpm build
```

Run dev server:

```bash
pnpm dev
```

Run compiled server:

```bash
pnpm start
```

Expected server URL:

```text
http://127.0.0.1:3001
```

Control endpoints:

```text
POST http://127.0.0.1:3001/engine/bot/start
POST http://127.0.0.1:3001/engine/bot/sync
POST http://127.0.0.1:3001/engine/bot/stop
POST http://127.0.0.1:3001/engine/bot/force-close
```

## 24. Recommended smoke tests after fixes

After build blockers are fixed:

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

Manual endpoint health check:

```bash
curl -X POST http://127.0.0.1:3001/engine/bot/sync \
  -H 'Content-Type: application/json' \
  -d '{"bot_id":999,"config":{"id":999,"coin":"BTC/USDT:USDT","is_active":false}}'
```

Expected:

- HTTP 200 `{ "success": true }`.
- Engine logs warning that bot was not found.

For real start smoke test, use testnet credentials only.

Minimum behavioral tests to add:

- `calculateOpenSpread` buy/sell formulas.
- `calculateRealPnL` buy/sell formulas.
- `calculateVWAP` full depth vs insufficient depth vs emergency behavior.
- `checkLegDrawdown`.
- `api.getOpenTrades` paginated response parsing.
- `Engine.syncBot` missing/running bot behavior.
- `BotTrader` inactive bot skips entry but still checks exit.
- `force_close` close reason mapping.

## 25. Risks and known limitations

### 25.1. Control-plane network isolation

`X-Service-Token` валидирует все control-plane запросы. CORS остаётся `origin: '*'`, поэтому процесс должен быть изолирован на localhost / private network / firewall. Дополнительные защитные меры: mTLS между Django и engine, HMAC-подпись запросов.

### 25.2. Multi-process duplication risk

Только in-process защита от двойного запуска (`traders` Map + `starting` Set). Если запущено два engine-процесса на один Django, оба могут получить `start` и открыть позиции параллельно. Возможные защиты: DB lease / heartbeat per bot, Redis lock, single queue consumer, engine instance id в Django.

### 25.3. Recovery edge-cases

Recovery открытых сделок (`Engine.startBot` → `api.getOpenTrades(botId)` → `BotTrader.restoreOpenTrades`) фильтрует по `bot_id` на стороне Django (`TradeViewSet.get_queryset`) и затем по `coin` в памяти. Реальный `Trade` имеет `bot = ForeignKey(BotConfig, on_delete=SET_NULL, null=True)`, поэтому в нормальном сценарии recovery корректно ограничивается этим ботом. Остаются два узких edge-case:

- **Дубли open-записей на одном `(bot_id, coin)`**: `restoreOpenTrades` берёт первый matching `Trade` через `.find(...)`. Если в БД оказались две open-записи (последствия регрессии, ручной вставки через admin, неконсистентного закрытия), engine восстановит только первую. Вторая останется `status=open` в Django, и позиция под ней на бирже может оказаться без мониторинга.
- **Удалённый `BotConfig`**: при `on_delete=SET_NULL` `Trade.bot` обнуляется, и фильтр `bot_id=X` такие сделки уже не вернёт. Удаление бота через admin не закрывает позиции на бирже — оператор должен закрыть их вручную или восстановить `bot_id` перед `start`.

### 25.4. Spot/futures naming mismatch

Django и engine могут расходиться в choices для `binance_spot` и `gate_futures`. Запуск бота с неподдерживаемым именем ведёт к `Unknown REST exchange` сразу при start, что лучше, чем тихий fallback.

### 25.5. Emulator payload may include unknown fields

Engine отправляет один shape payload (включая `leverage`) и для real, и для emulation. DRF может валидировать unknown fields в зависимости от serializer. Желательно проверить `EmulationTradeSerializer` при изменении полей.

### 25.6. No automated tests

В проекте отсутствует test framework и тесты. Перед изменениями математики (`utils/math.ts`) и state-машины `BotTrader` (`executeOpen` / `executeClose` / `verifyAndCloseResidual`) нужно сначала покрыть тестами.

### 25.7. Secrets in logs/payloads

Engine принимает exchange keys от Django. `Engine.syncBot` логирует только config (без keys), `Engine.startBot` логирует bot_id + coin. Hot-path логи payload-ов понижены до `DEBUG`. Перед добавлением новых логов проверять, что `keys` не попадают в строку.

### 25.8. Estimated commission window

После real-close в Django ненадолго оседает estimated `close_commission` / `profit_usdt`. Точное значение PATCH-ится background задачей `backfillCloseCommission` обычно за 0.5–3 секунды. Если backfill не успешен, в записи остаётся estimate; UI должен учитывать, что values могут уточняться.

### 25.9. ccxt.pro internal API access

`BotTrader.getPrices` читает `(ws as any).orderbooks[symbol]` — внутреннее поле ccxt.pro. Это самый дешёвый способ получить актуальный orderbook без подписки на event-эмиттер, но он может сломаться при апгрейде ccxt. При апгрейде обязательно проверить, что поле сохраняется.

### 25.10. BNB commission approximation на Binance

`fetchOrderCommission` для Binance конвертирует BNB-комиссии в USDT через `notional × 0.00045`. Это приближение, не точная конверсия по текущей BNB/USDT цене. Для пользователей с большим объёмом BNB-fees отчёт может расходиться с реальным значением на единицы процентов; полностью точная конверсия требует отдельного REST-запроса за BNB price.

## 26. Production checklist

1. Развернуть engine за firewall / на localhost, с `X-Service-Token` от Django.
2. Убедиться, что `BotConfig.Exchange` choices и `Engine.createRestClient` совпадают (binance/bybit/mexc/gate futures).
3. Убедиться, что `UserExchangeKeys` поля совпадают с `Engine.extractKeys` mapping для всех бирж, где разрешён real trading.
4. Перед real mode стартом: проверить `coin_amount` и `primary_leverage` на BotConfig; `MarketInfoService` должен вернуть `tradeable=true` для пары.
5. Мониторинг: следить за warn/error логами с тегами `🚨 CRITICAL`, `🚨 DB write failed`, `🚨 LIQUIDATION TRIGGERED`, `🟡 Residual`, `Could not fetch commission` — это сигналы для оператора.
6. SIGINT/SIGTERM запускает graceful shutdown с force-exit timeout 30s — оркестратор (systemd/k8s) должен ставить timeout не меньше 35–40s.

## 27. Files updated with code comments

English explanatory comments were added across:

- `src/config.ts`
- `src/main.ts`
- `src/types/index.ts`
- `src/classes/Engine.ts`
- `src/classes/BotTrader.ts`
- `src/services/api.ts`
- `src/services/market-info.ts`
- `src/exchanges/exchange-client.ts`
- `src/exchanges/binance-client.ts`
- `src/exchanges/bybit-client.ts`
- `src/exchanges/mexc-client.ts`
- `src/exchanges/gate-client.ts`
- `src/utils/logger.ts`
- `src/utils/math.ts`

Comments focus on:

- ownership boundaries;
- lifecycle side effects;
- exchange-specific quirks;
- recovery behavior;
- risk-control logic;
- Django API assumptions;
- current contract gaps.

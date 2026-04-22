# Arbitration Bot Engine - внутренняя документация

Дата анализа: 2026-04-22.

Документ описывает фактическое состояние проекта `arbitration-bot-engine`: назначение сервиса, архитектуру, HTTP API, торговый цикл, exchange-адаптеры, интеграцию с Django, команды запуска, текущие блокеры сборки и технические риски. Это рабочая документация для быстрого восстановления контекста перед изменениями.

## 1. Краткое резюме

`arbitration-bot-engine` - отдельный TypeScript/Node.js процесс, который принимает команды от Django backend и исполняет runtime-логику арбитражных ботов.

Главные обязанности engine:

- Поднять Fastify HTTP API на порту `3001`.
- Получать от Django команды `start`, `sync`, `stop`, `force-close`.
- Создавать REST-клиенты бирж для account/order операций.
- Создавать WebSocket-клиенты `ccxt.pro` для live orderbook данных.
- Рассчитывать VWAP, spread, PnL, drawdown и timeout exits.
- Открывать/закрывать сделки в real mode через exchange REST API.
- В emulator mode не трогать биржи, а писать сделки в Django как эмуляционные.
- Синхронизировать trade state в Django через `/api/bots/real-trades/` и `/api/bots/trades/`.
- Восстанавливать открытые сделки из Django при старте бота.

Текущий проект небольшой, но он работает в высокорисковой зоне: real trading, API keys, market orders, cross-exchange exposure, partial fills, liquidation/timeout exits.

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
- Engine хранит in-memory state: active `BotTrader` instances, baselines, active trade pointer, cooldown, websocket loops.
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

- No auth/mTLS/service token.
- CORS is open.
- This is only acceptable if endpoint is isolated on localhost/private network/firewall.

## 7. `Engine`

Файл: `src/classes/Engine.ts`.

`Engine` owns:

```ts
private traders: Map<number, BotTrader>
```

Key: Django `BotConfig.id`.

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

`createWsClient(name, keys)`:

Creates ccxt.pro clients:

| Name | ccxt.pro client |
|---|---|
| `binance_futures` | `pro.binanceusdm` |
| `bybit_futures` | `pro.bybit({ defaultType: 'swap' })` |
| `mexc_futures` | `pro.mexc({ defaultType: 'swap' })` |
| `gate_futures` | `pro.gate({ defaultType: 'swap' })` |

Spot support:

- Django has `binance_spot`.
- Engine does not handle `binance_spot` in REST or WS switch.
- Starting a bot with `binance_spot` will throw `Unknown REST exchange`.

### 7.2. Key extraction

`extractKeys(exchangeName, keys)`:

- Binance names use `keys.binance_api_key`, `keys.binance_secret`.
- Bybit names use `keys.bybit_api_key`, `keys.bybit_secret`.
- Gate names use `keys.gate_api_key`, `keys.gate_secret`.
- MEXC names use `keys.mexc_api_key`, `keys.mexc_secret` or empty strings.

Current Django `UserExchangeKeys` does not provide `mexc_api_key`/`mexc_secret`, so MEXC real trading would receive empty credentials unless Django model/API is extended.

### 7.3. `startBot(botId, config, keys)`

Flow:

1. If trader already exists:
   - log warning;
   - call `syncBot(botId, config)`;
   - return.
2. Create primary and secondary REST clients.
3. `loadMarkets()` on both REST clients.
4. Create `MarketInfoService`.
5. Initialize market info for `[config.coin]`.
6. If `trade_mode === 'real'`:
   - set isolated margin;
   - set leverage;
   - use `Promise.allSettled` to avoid one setup failure rejecting the whole setup.
7. Create primary and secondary ccxt.pro WS clients.
8. `loadMarkets()` on both WS clients.
9. Create `BotTrader`.
10. Fetch open trades from Django:
    - real mode: `api.getOpenTrades()`;
    - emulator mode: `api.getOpenEmulationTrades()`.
11. `trader.restoreOpenTrades(openTrades)`.
12. Store trader in `traders`.
13. Start trader loops in background:

```ts
trader.start().catch(...)
```

Important:

- `startBot()` does not await the long-lived trader loop.
- `MarketInfoService.initialize()` result is not checked; if no tradeable symbol is cached, bot may start but never trade.
- Open trade recovery fetches all open trades, then `BotTrader` filters by coin only, not by bot id.

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
| `baselineBuy` | EMA baseline for buy spread. Currently tracked but not used in entry decision. |
| `baselineSell` | EMA baseline for sell spread. Currently tracked but not used in entry decision. |
| `activeTrade` | Current Django trade record or `null`. |
| `openedAtMs` | Local timestamp for timeout checks. |
| `busy` | Re-entrancy lock for open/close operations. |
| `cooldownUntil` | Timestamp until next entry attempt is blocked after failure. |

Constants:

- `COOLDOWN_MS = 30_000`.
- `TIMEOUT_CHECK_INTERVAL_MS = 10_000`.

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
- Runs two infinite websocket watch loops with `Promise.all`.

`stop(closePositions=false)`:

- Sets `isRunning=false`.
- Clears timeout timer.
- If `closePositions && activeTrade`, closes all positions with reason `shutdown`.

`forceClose()`:

- If no active trade, returns.
- Uses active trade amount.
- Gets emergency prices.
- Calls `executeClose('force_close', prices)`.

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

1. Read current primary best bid.
2. Determine raw amount:
   - `this.bot.coin_amount`, or
   - fallback `50 / currentPrice`.
3. Round down to `info.stepSize`.
4. Reject if below `minQty` or `minNotional`.
5. If `bot.is_active` is false, return.
6. Get strict VWAP prices.
7. Reject if cooldown active.
8. Calculate:
   - `currentBuySpread = calculateOpenSpread(prices, 'buy')`
   - `currentSellSpread = calculateOpenSpread(prices, 'sell')`
9. Update EMA baselines.
10. Compare spread to `bot.entry_spread`.
11. If `order_type` is `buy` or `auto` and buy spread passes, open buy trade.
12. Else if `order_type` is `sell` or `auto` and sell spread passes, open sell trade.

Entry direction semantics:

- `buy`:
  - buy/long primary;
  - sell/short secondary.
- `sell`:
  - sell/short primary;
  - buy/long secondary.

### 8.6. Opening a trade

`executeOpen(orderType, prices, spread, targetCoins)`:

1. Sets `busy=true`.
2. Determines primary and secondary sides.
3. Checks `isReal = bot.trade_mode === 'real'`.
4. Determines whether to execute each leg:
   - `runPrimary = isReal && trade_on_primary_exchange`;
   - `runSecondary = isReal && trade_on_secondary_exchange`.
5. Runs both legs concurrently with `Promise.allSettled`.
6. If any leg rejected:
   - log atomic execution failure;
   - for any fulfilled real leg, submit opposite reduce-only order;
   - run `handleOpenCleanup()` in real mode;
   - set cooldown;
   - return.
7. Use fill prices if available, else orderbook VWAP prices.
8. Sum commissions.
9. Recalculate actual open spread from fill prices.
10. Build payload.
11. If real mode, add exchange names, order IDs and commission.
12. Send to Django:
   - real: `api.openTrade(payload)`;
   - emulator: `api.openEmulationTrade(payload)`.
13. Store `activeTrade`.
14. Store `openedAtMs`.
15. Finally set `busy=false`.

Real mode payload includes:

- coin;
- primary/secondary exchange;
- order_type;
- amount;
- leverage;
- open prices;
- order IDs;
- open spread;
- open commission.

Emulator payload includes:

- `bot`;
- coin;
- order type;
- status;
- amount;
- leverage field is present in code payload, but Django EmulationTrade serializer does not include `leverage`;
- open prices;
- open spread.

DRF ModelSerializer generally ignores unknown fields only if not in serializer? Actually DRF raises validation errors for unknown input fields in typical serializers. This should be checked manually: current emulator payload includes `leverage`, while `EmulationTradeSerializer` fields do not list `leverage`.

### 8.7. Open cleanup

`handleOpenCleanup(primarySide, secondarySide)`:

- Fetches current positions on enabled exchanges.
- For each position matching symbol with size >= minQty:
  - if position long, sell reduce-only;
  - if position short, buy reduce-only.

This is a safety net after partial open failure.

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

1. If busy, return.
2. Set busy.
3. Determine close sides:
   - buy entry closes with primary sell and secondary buy;
   - sell entry closes with primary buy and secondary sell.
4. Parse open prices and amount from active Django trade.
5. If real mode:
   - fetch current positions on enabled exchanges;
   - use actual position sizes;
   - if size >= minQty, submit reduce-only market orders;
   - otherwise use current prices/open prices for reporting.
6. If emulator:
   - use current prices/open prices.
7. Calculate:
   - total commission;
   - real PnL;
   - close spread;
   - close status.
8. Build close payload.
9. If real mode:
   - set `close_reason`;
   - order IDs;
   - close commission;
   - profit USDT.
10. Send to Django:
   - real: `api.closeTrade(trade.id, payload)`;
   - emulator: `api.closeEmulationTrade(trade.id, payload)`.
11. Clear active trade.
12. Clear openedAtMs.
13. Finally set busy=false.

Close status:

```ts
const closeStatus = (reason === 'profit' || reason === 'shutdown') ? 'closed' : 'force_closed';
```

Close reason mapping:

```ts
payload.close_reason = reason === 'liquidation' ? 'error' : reason;
```

Important mismatch:

- `reason` can be `force_close`.
- Django `Trade.CloseReason` choices are `profit`, `timeout`, `manual`, `shutdown`, `error`.
- `force_close` is not a Django close_reason.
- Current code can send `close_reason: "force_close"` for real trades, which Django should reject.
- Better mapping: `force_close -> manual`.

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
  - `POST /fapi/v1/order`;
  - uses `MARKET`;
  - supports `reduceOnly`;
  - polls `/fapi/v1/order` if avg price missing;
  - extracts commission via `/fapi/v1/userTrades`.
- `getMarketInfo()`:
  - parses filters `PRICE_FILTER`, `LOT_SIZE`, `MIN_NOTIONAL`.
- `getUsdtSymbols()`:
  - returns ccxt-format futures symbols.

Signing:

- Adds `timestamp` and `recvWindow`.
- Builds query string.
- HMAC-SHA256 with Binance secret.
- Sends API key in `X-MBX-APIKEY`.

Important current issue:

- Constructor reads `config.binance.apiKey`/`secret`, but `config.ts` does not define them.
- `Engine` attempts to pass credentials into constructor, but constructor accepts no args.

## 14. BybitClient

Файл: `src/exchanges/bybit-client.ts`.

Type: ccxt-based Bybit USDT perpetual adapter.

Constructor:

- `new ccxt.bybit({ apiKey, secret, enableRateLimit, sandbox?, options: { defaultType: 'swap' } })`

Operations:

- `loadMarkets()` via ccxt.
- `setLeverage()` via `exchange.setLeverage`.
- `setIsolatedMargin()` via `exchange.setMarginMode('isolated')`.
- `createMarketOrder()` via `exchange.createMarketOrder`.
- Polls `fetchOrder()` up to 5 times if average/status missing.
- `getMarketInfo()` converts ccxt precision to step size.
- `getUsdtSymbols()` filters symbols ending with `:USDT`.
- `extractCommission()` normalizes fees to approximate USDT.

Important current issue:

- Reads `config.bybit.apiKey`/`secret`, but config does not define them.
- Constructor accepts no per-bot credentials.

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
  - creates market order;
  - polls `fetchOrder()` up to 5 times for average/status.
- `getMarketInfo()` handles tick-size precision mode.
- `getUsdtSymbols()` filters `:USDT`.
- `extractCommission()` counts USDT/USDC fees and ignores unknown assets.

Important current issues:

- Reads `config.mexc.apiKey`/`secret`, but config does not define them.
- Django `UserExchangeKeys` currently has no MEXC fields.

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
  - `POST /futures/usdt/positions/{contract}/leverage`.
- `setIsolatedMargin()`:
  - attempts margin endpoint;
  - treats unsupported/already-isolated cases as non-fatal debug.
- `createMarketOrder()`:
  - converts base amount to contract size via `quanto_multiplier`;
  - positive size for buy, negative for sell;
  - submits IOC order with `price: "0"`;
  - supports `reduce_only`;
  - polls final order details;
  - fetches trades for commission;
  - converts filled contract count back to base amount.
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

Important current issue:

- Reads `config.gate.apiKey`/`secret`, but config does not define them.
- Engine supports `gate_futures`, but Django BotConfig choices currently do not include `gate_futures`.

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

## 25. Critical risks and technical debt

### 25.1. Build is currently broken

The project cannot compile until config/constructor contracts are fixed.

### 25.2. Credentials contract is ambiguous

Django sends per-user keys, but exchange clients use global config keys. Real trading must clearly use per-user credentials.

### 25.3. No authentication on control plane

Anyone who can reach `:3001` can start/stop/force-close bots.

Mitigations:

- bind to localhost only if no container network requires `0.0.0.0`;
- firewall/private network;
- service token header;
- HMAC signed requests;
- mTLS between Django and engine.

### 25.4. No authentication from engine to Django

Engine writes trades to Django `AllowAny` endpoints. If Django API is exposed, external clients can tamper with trades.

### 25.5. Multi-process duplication risk

No lock prevents two engine processes from running the same bot.

Potential fixes:

- DB lease/heartbeat per bot;
- Redis lock;
- single queue consumer;
- engine instance id stored in Django.

### 25.6. Real trade close reason mismatch

`force_close` can be sent as Django `close_reason`, but Django does not allow it. Map to `manual`.

### 25.7. Recovery can attach wrong trade

`restoreOpenTrades` matches by coin/status, not by bot id. Real `Trade` has no bot relation. Multiple bots on same coin can conflict.

### 25.8. Spot/futures naming mismatch

Django and engine choices differ for `binance_spot` and `gate_futures`.

### 25.9. Emulator payload may include unknown fields

BotTrader builds one payload shape and sends it to emulation endpoint. Verify DRF validation for extra fields like `leverage`.

### 25.10. Error handling favors continuity over correctness

Some setup failures are warnings, and sync errors between Django/engine are not persisted. For trading, explicit degraded state is safer.

### 25.11. No automated tests

No test framework or test files are present. Math and state transitions should be covered before real trading changes.

### 25.12. Secrets in logs/payloads

Django sends exchange keys to engine. Avoid logging payloads that include `keys`. Current `Engine.syncBot` logs config only, not keys, which is good.

## 26. Suggested stabilization plan

1. Fix TypeScript build by resolving config/constructor contract.
2. Decide exchange support matrix and align Django choices with engine.
3. Add service authentication for Django -> engine and engine -> Django.
4. Map `force_close -> manual` for Django close_reason.
5. Add bot/owner relation to real trades or another safe recovery key.
6. Add tests for math utilities.
7. Add tests around BotTrader state transitions with mocked clients.
8. Replace global `tradeAmountUsdt` with `bot.coin_amount` if per-bot sizing is product truth.
9. Add structured logs and redact secrets by design.
10. Add lock/lease mechanism if more than one engine process can run.

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


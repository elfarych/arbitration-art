# Arbitration Trader - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние проекта `arbitration-trader`: архитектуру, конфигурацию, торговый цикл, интеграцию с Django, exchange-клиенты, команды запуска, деплой, проверки и текущие риски. Документация на русском; комментарии в коде добавлены на английском языке.

## 1. Краткое резюме

`arbitration-trader` - standalone TypeScript/Node.js процесс для реальной арбитражной торговли между двумя выбранными futures/derivatives биржами.

Сервис поднимает HTTP control plane, принимает lifecycle-команды `POST /engine/trader/{start|sync|stop}` от Django, отдает diagnostic routes для exchange health, active coins, live PnL и system load, держит в одном процессе только один активный `TraderRuntimeConfig` и получает биржевые ключи/торговые параметры в payload.

Сервис:

- читает из `.env` только инфраструктурные переменные (`DJANGO_API_URL`, `PORT`, `SERVICE_SHARED_TOKEN`);
- получает runtime-конфиг и ключи пользователя из Django;
- загружает markets;
- находит пересечение USDT perpetual symbols;
- фильтрует самые ликвидные пары;
- проверяет market constraints;
- выставляет isolated margin и leverage;
- создает общие WebSocket clients;
- делит пары на chunks;
- запускает несколько `Trader` instances;
- открывает и закрывает реальные сделки;
- пишет trade records в Django.

Основные сценарии:

- Непрерывный сканинг многих пар на двух биржах.
- Открытие cross-exchange arbitrage сделки при расширении spread относительно EMA baseline.
- Закрытие по profit threshold, timeout, shutdown или liquidation/drawdown guard.
- Восстановление открытых сделок из Django после рестарта.
- Восстановление только тех открытых сделок, которые относятся к текущему `runtime_config_id`.

Это real-trading сервис. Ошибки конфигурации, ключей, времени сервера, закрытия позиций или синхронизации с Django могут приводить к реальным финансовым потерям.

## 2. Технологический стек

Фактический стек:

- Node.js / ESM-style imports compiled by TypeScript.
- TypeScript 6.0.x.
- `tsx` for direct TypeScript runtime in `pnpm start`.
- `ccxt` for exchange integrations.
- `axios` for direct REST and Django API calls.
- `dotenv` for `.env`.
- `ws` dependency.
- `pnpm` package manager.

`package.json`:

```json
{
  "name": "arbitration-trader",
  "description": "Real arbitrage trading bot for Binance/Bybit Futures",
  "scripts": {
    "start": "tsx src/main.ts",
    "build": "tsc"
  }
}
```

TypeScript config:

- `target: es2022`
- `module: Node16`
- `moduleResolution: node16`
- `rootDir: ./src`
- `outDir: ./dist`
- `strict: true`
- `skipLibCheck: true`

## 3. Структура проекта

```text
arbitration-trader/
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── .env.example
├── DEPLOY_LINUX.md
├── DOCS.md
├── test_binance.ts
├── test_gate.ts
├── binance_api_docs.html
├── binance_api_docs_files/
├── Gate API _ Gate API v4.html
├── Gate API _ Gate API v4_files/
└── src/
    ├── main.ts
    ├── config.ts
    ├── classes/
    │   ├── RuntimeManager.ts
    │   └── Trader.ts
    ├── exchanges/
    │   ├── exchange-client.ts
    │   ├── binance-client.ts
    │   ├── bybit-client.ts
    │   ├── mexc-client.ts
    │   └── gate-client.ts
    ├── services/
    │   ├── api.ts
    │   └── market-info.ts
    ├── types/
    │   └── index.ts
    └── utils/
        ├── logger.ts
        └── math.ts
```

Сгенерированные/локальные директории после проверки:

- `node_modules/` - установленные зависимости.
- `dist/` - результат `pnpm build`.

Они не отображаются в `git status`, вероятно, игнорируются.

## 4. Архитектура

Высокоуровневый поток:

```text
Django
  |
  | POST /engine/trader/{start|sync|stop}
  v
main.ts control plane
  |
  v
RuntimeManager
  |
  +--> active runtime payload in config.ts
  +--> REST exchange clients
  +--> market discovery/filtering
  +--> MarketInfoService
  +--> leverage/margin setup
  +--> shared ccxt.pro WebSocket clients
  +--> TradeCounter
  +--> Trader chunks
              |
              +--> watch orderbooks
              +--> calculate spreads / VWAP / PnL
              +--> place market orders
              +--> cleanup partial failures
              +--> persist trades to Django via service token
```

Ключевые особенности:

- Один процесс управляет всеми symbols.
- Primary/secondary exchanges выбираются глобально через `.env`.
- Все chunks используют одни и те же REST clients и WebSocket clients.
- `TradeCounter` общий для всех chunks и ограничивает число одновременных открытых сделок.
- Django используется как persistence layer для real trades, но не управляет lifecycle этого trader-процесса.

## 5. Конфигурация

Файл: `src/config.ts`.

`.env` загружается через:

```ts
dotenv.config();
```

Обязательные переменные:

- `BINANCE_API_KEY`
- `BINANCE_SECRET`
- `BYBIT_API_KEY`
- `BYBIT_SECRET`

Они читаются через `requireEnv()`, поэтому процесс упадет на старте, если их нет.

Опциональные credentials:

- `GATE_API_KEY`
- `GATE_SECRET`
- `MEXC_API_KEY`
- `MEXC_SECRET`

Если они не заданы, используются пустые строки.

### 5.1. Таблица переменных

| Переменная | Default | Назначение |
|---|---:|---|
| `DJANGO_API_URL` | `http://127.0.0.1:8000/api` | Base URL Django API. |
| `BINANCE_API_KEY` | required | Binance Futures key. |
| `BINANCE_SECRET` | required | Binance Futures secret. |
| `BYBIT_API_KEY` | required | Bybit key. |
| `BYBIT_SECRET` | required | Bybit secret. |
| `GATE_API_KEY` | empty | Gate key. |
| `GATE_SECRET` | empty | Gate secret. |
| `MEXC_API_KEY` | empty | MEXC key. |
| `MEXC_SECRET` | empty | MEXC secret. |
| `PRIMARY_EXCHANGE` | `binance` | Primary route exchange. |
| `SECONDARY_EXCHANGE` | `bybit` | Secondary route exchange. |
| `USE_TESTNET` | `false` | Testnet/sandbox mode where supported. |
| `TRADE_AMOUNT_USDT` | `50` | Position notional before leverage. |
| `LEVERAGE` | `10` | Leverage on both exchanges. |
| `MAX_CONCURRENT_TRADES` | `3` | Global concurrent open trade limit. |
| `TOP_LIQUID_PAIRS_COUNT` | `100` | Max number of liquid pairs to scan. |
| `MAX_TRADE_DURATION_MINUTES` | `60` | Timeout before force close. |
| `MAX_LEG_DRAWDOWN_PERCENT` | `80` | Per-leg leveraged drawdown limit. |
| `OPEN_THRESHOLD` | `2.0` | Spread expansion over EMA baseline to open. |
| `CLOSE_THRESHOLD` | `1.5` | True PnL threshold to close. |
| `ORDERBOOK_LIMIT` | `50` | Orderbook depth subscription limit. |
| `CHUNK_SIZE` | `10` | Symbols per `Trader` instance. |
| `LOG_LEVEL` | `INFO` | Logger minimum level. |

Supported route names in `main.ts`:

- `binance`
- `bybit`
- `mexc`
- `gate`

Important:

- `PRIMARY_EXCHANGE` and `SECONDARY_EXCHANGE` must be different.
- Even if you select `gate` or `mexc`, current `config.ts` still requires Binance and Bybit credentials because they are mandatory via `requireEnv()`.
- `DEPLOY_LINUX.md` currently shows `BINANCE_SECRET_KEY` / `BYBIT_SECRET_KEY`, but actual code expects `BINANCE_SECRET` / `BYBIT_SECRET`. Use the variable names from `.env.example` and `config.ts`.

## 6. Entry Point: `main.ts`

`main.ts` contains the full process bootstrap.

### 6.1. Startup banner

Logs:

- real trading mode;
- testnet status;
- trade amount;
- leverage;
- max concurrent trades;
- max trade duration;
- open/close thresholds.

### 6.2. REST exchange clients

`createClient(name)` returns:

| Config name | Client |
|---|---|
| `binance` | `BinanceClient` |
| `bybit` | `BybitClient` |
| `mexc` | `MexcClient` |
| `gate` | `GateClient` |

If unknown exchange name is configured, process logs error and exits.

REST clients are used for:

- markets metadata;
- tickers;
- positions;
- leverage/margin setup;
- real market orders.

### 6.3. Latency measurement

Flow:

1. Warmup `fetchTime()` on both exchanges.
2. Measure a second `fetchTime()` using existing keep-alive/TLS session.
3. Log approximate API latency.

This is informational only. It does not affect trading decisions.

### 6.4. Market loading

Calls:

```ts
primaryClient.loadMarkets()
secondaryClient.loadMarkets()
```

Market metadata is later used by:

- `getUsdtSymbols()`;
- `MarketInfoService`;
- `Trader` amount validation;
- exchange-specific order conversion.

### 6.5. Common symbol discovery

The trader:

1. Gets primary USDT symbols.
2. Gets secondary USDT symbols.
3. Keeps only intersection.

Symbols are in ccxt futures format:

```text
BTC/USDT:USDT
```

### 6.6. Liquidity filtering

The trader fetches primary exchange tickers and filters:

- require 24h quote volume >= `2_000_000`;
- sort by quote volume descending;
- keep first `TOP_LIQUID_PAIRS_COUNT`.

Reason:

- illiquid symbols can show fake/unexecutable spreads;
- lower depth increases slippage and partial-fill risk.

If ticker fetch fails, bot proceeds with all common symbols.

### 6.7. Market info validation

Creates `MarketInfoService` and calls:

```ts
marketInfo.initialize(primaryClient, secondaryClient, commonSymbols)
```

This:

- fetches prices;
- detects ticker homonyms;
- merges min quantities and step sizes;
- computes trade amount from `TRADE_AMOUNT_USDT`;
- excludes symbols that cannot meet minimums.

If no symbols remain, process exits.

### 6.8. Leverage and isolated margin setup

For each tradeable symbol:

- set isolated margin on primary and secondary;
- set leverage on primary and secondary.

The setup is batched:

- `batchSize = 5`;
- delay `1200ms` between batches.

Reason: prevent Bybit HTTP 429 / "Too many visits".

If setup fails for a symbol, that symbol is excluded from final tradable list.

If no symbols remain after setup, process exits.

Additional guarantees:

- startup aborts if open-trade recovery from Django fails;
- Gate/MEXC setup warnings are not treated as successful setup;
- a symbol is allowed into scanning only after both exchanges confirmed the requested margin/leverage state.

### 6.9. WebSocket clients

`createWsClient(name)` returns ccxt.pro exchange instance:

- `pro.binanceusdm`
- `pro.bybit({ defaultType: 'swap' })`
- `pro.mexc({ defaultType: 'swap' })`
- `pro.gate({ defaultType: 'swap' })`

These are shared by all `Trader` chunks.

Important:

- WS clients are created without API credentials.
- They are used for public orderbook streaming.

### 6.10. TradeCounter

Creates one shared:

```ts
const tradeCounter = new TradeCounter();
```

It enforces `MAX_CONCURRENT_TRADES` across all chunks.

### 6.11. Chunking

Final tradeable symbols are split into chunks of `CHUNK_SIZE`.

Each chunk becomes one `Trader`:

```ts
new Trader(
  id,
  chunk,
  wsPrimary,
  wsSecondary,
  primaryClient,
  secondaryClient,
  marketInfo,
  tradeCounter
)
```

### 6.12. Recovery from Django

Before starting traders:

```ts
const openTrades = await api.getOpenTrades();
```

Then each open trade is assigned to the `Trader` whose `symbols` include `trade.coin`.

If no matching trader chunk exists, trade is ignored with warning.

If `getOpenTrades()` fails, runtime startup is aborted. The trader does not continue with an empty in-memory state while exchange exposure may still exist.

### 6.13. Shutdown

Handlers:

- `SIGINT`
- `SIGTERM`
- `uncaughtException`
- `unhandledRejection`

Graceful shutdown:

1. Prevent repeated shutdown from running twice.
2. Call `t.stop(true)` for every trader.
3. Close websocket connections.
4. Exit process.

`stop(true)` means active positions should be closed before exit.

## 7. `TradeCounter`

Файл: `src/classes/Trader.ts`.

`TradeCounter` is shared across all `Trader` instances.

Fields:

- `count`

Methods:

- `current`
- `canOpen()`
- `reserve()`
- `release()`
- `forceReserve()`

Purpose:

- Prevent more than `config.maxConcurrentTrades` active trades globally.
- Avoid async races by reserving a slot immediately before opening.
- Count restored open trades after restart.

Important:

- It is process-local only.
- If two trader processes run against the same account, they do not share this counter.

## 8. `Trader`

Файл: `src/classes/Trader.ts`.

`Trader` owns a subset of symbols. It does not own exchange clients; they are shared and injected from `main.ts`.

Constructor dependencies:

- trader id;
- symbols chunk;
- primary WebSocket exchange;
- secondary WebSocket exchange;
- primary REST client;
- secondary REST client;
- `MarketInfoService`;
- shared `TradeCounter`.

### 8.1. PairState

Each symbol has:

| Field | Meaning |
|---|---|
| `baselineBuy` | EMA baseline for buy spread. |
| `baselineSell` | EMA baseline for sell spread. |
| `activeTrade` | Current Django trade record. |
| `openedAtMs` | Open timestamp for timeout checks. |
| `busy` | Mutex preventing duplicate open/close. |
| `cooldownUntil` | Re-entry block after failure. |

Constants:

- `COOLDOWN_MS = 30000`.
- `TIMEOUT_CHECK_INTERVAL_MS = 10000`.

### 8.2. `restoreOpenTrades(openTrades)`

For every trade:

- find matching symbol state;
- if no active trade there:
  - set `activeTrade`;
  - set `openedAtMs` from Django `opened_at`;
  - call `tradeCounter.forceReserve()`.

This lets the bot continue monitoring exits after restart.

Risk:

- Recovery matches by symbol, not by exchange route/account/process id.
- If multiple standalone trader processes or exchange routes share Django, recovery can attach a trade to the wrong runtime.

### 8.3. `start()`

Starts:

- timeout watchdog interval;
- two watch loops per symbol:
  - primary orderbook;
  - secondary orderbook.

`start()` awaits `Promise.all(loops)`, so normally it never resolves until stopped.

### 8.4. `stop(closePositions=false)`

Behavior:

- `isRunning=false`;
- clear timeout timer;
- if `closePositions=true`, call `closeAllPositions('shutdown')`;
- log stopped.

Used by graceful shutdown.

### 8.5. `watchLoop(exchange, symbol, exName)`

Loop:

1. `exchange.watchOrderBook(symbol, config.orderbookLimit)`.
2. Reset consecutive errors.
3. `checkSpreads(symbol)`.
4. On error:
   - increment error count;
   - log;
   - wait `min(2000 * consecutiveErrors, 30000)`.

Each symbol has two loops, so `checkSpreads` can be called from primary and secondary updates. `state.busy` prevents duplicate opens/closes.

### 8.6. `getPrices(symbol, targetCoinsFallback?, isEmergency=false)`

Reads:

- `primaryWs.orderbooks[symbol]`;
- `secondaryWs.orderbooks[symbol]`.

Requires:

- primary bids/asks;
- secondary bids/asks.

Determines target size:

- close: explicit target from active trade amount;
- entry: `marketInfo.getInfo(symbol)?.tradeAmount`;
- fallback 0 means VWAP returns top-of-book.

Calculates VWAP for:

- primary bid;
- primary ask;
- secondary bid;
- secondary ask.

If any is `NaN`, returns `null`.

Strict vs emergency:

- strict prices require enough visible depth for full target amount;
- emergency prices may use available depth.

### 8.7. Entry logic: `checkSpreads(symbol)`

High-level:

- If busy, return.
- If market info missing, return.
- If active trade exists, route to exit logic.
- If idle, calculate entry size and spreads.

Idle flow:

1. Read current primary best bid.
2. Convert `TRADE_AMOUNT_USDT` into base coin amount.
3. Round down to unified step size.
4. Reject if below min quantity or min notional.
5. Get strict VWAP prices.
6. Calculate buy and sell open spreads.
7. Update EMA baselines:

```text
baseline = baseline * (1 - 0.002) + currentSpread * 0.002
```

8. Check `TradeCounter.canOpen()`.
9. Check cooldown.
10. Open buy if:

```text
currentBuySpread >= baselineBuy + OPEN_THRESHOLD
```

11. Open sell if:

```text
currentSellSpread >= baselineSell + OPEN_THRESHOLD
```

Direction semantics:

`buy`:

- buy primary;
- sell secondary.

`sell`:

- sell primary;
- buy secondary.

### 8.8. Opening trade: `executeOpen(...)`

Flow:

1. Set `state.busy=true`.
2. Reserve global trade slot.
3. Determine order sides.
4. Place both market orders concurrently via `Promise.allSettled`.
5. If any leg rejects:
   - log atomic failure;
   - close any fulfilled leg with reduce-only opposite order;
   - wait 1 second;
   - run `handleOpenCleanup`;
   - release trade slot;
   - set cooldown;
   - return.
6. Use exchange fill prices or fallback VWAP prices.
7. Sum commissions.
8. Recalculate real open spread from fill prices.
9. Create Django `Trade` via `api.openTrade`.
10. Store `state.activeTrade`.
11. Store `openedAtMs`.
12. Slot remains reserved until close.
13. On catch:
   - log;
   - cleanup positions;
   - release slot;
   - reset baselines;
   - set cooldown.
14. Finally clear busy flag.

Important:

- There is no true atomic open across exchanges.
- The code compensates by flattening any successfully opened leg.
- `reduceOnly` is used for rollback where supported.

### 8.9. Cleanup: `handleOpenCleanup(symbol, orderType)`

Safety cleanup after failed open or Django persistence failure.

Flow:

- fetch positions on primary;
- close matching symbol position if size >= minQty;
- fetch positions on secondary;
- close matching symbol position if size >= minQty.

It does not rely on local promise results, because an API call can time out after the exchange accepted/fillled the order.

### 8.10. Exit logic: `checkExit(...)`

Inputs:

- strict prices;
- emergency prices.

Order:

1. Liquidation/drawdown protection:
   - use emergency prices;
   - compute max leveraged leg drawdown;
   - if >= `MAX_LEG_DRAWDOWN_PERCENT`, close with reason `liquidation`.
2. Profit check:
   - use strict prices;
   - compute `calculateTruePnL`;
   - if >= `CLOSE_THRESHOLD`, close with reason `profit`.

### 8.11. Closing trade: `executeClose(...)`

Flow:

1. If busy, return.
2. Set busy.
3. Determine close sides.
4. Fetch current positions on both exchanges.
5. Determine actual sizes.
6. Close only legs that still have positions.
7. Use reduce-only market orders.
8. Fallback to current book/open price if no close order is needed or price is missing.
9. Calculate:
   - close commission;
   - total commission;
   - real PnL;
   - close spread;
   - status.
10. Update Django with retries:
   - up to 10 attempts;
   - 5s delay between attempts.
11. If Django still does not accept the close payload:
   - keep `activeTrade` in local state;
   - keep the trade slot reserved;
   - store the exact close payload in pending sync state;
   - retry Django close sync until it succeeds.
12. Only after successful close persistence:
   - clear active trade and opened timestamp;
   - release trade slot;
   - reset or update baselines.
13. On exchange close error, do not clear local state; next tick will retry.

Close status:

- `profit` -> `closed`
- everything else -> `force_closed`

Close reason mapping:

- `liquidation` -> `error`
- `profit`, `timeout`, `shutdown`, `error` are sent as-is.

This aligns with current Django choices from backend:

- `profit`
- `timeout`
- `manual`
- `shutdown`
- `error`

### 8.12. Timeout watchdog

`checkTimeouts()` runs every 10 seconds.

For each active trade:

- if elapsed >= `config.maxTradeDurationMs`;
- get emergency prices;
- close with reason `timeout`.

### 8.13. Graceful shutdown close

`closeAllPositions(reason)`:

- finds all states with active trades;
- retries pending Django close sync first if positions are already flat;
- closes each using emergency prices;
- logs errors but continues.

Used by `stop(true)`.

### 8.14. Runtime crash handling

If any `Trader` loop rejects unexpectedly:

- runtime crash is logged;
- `RuntimeManager` marks the runtime as inactive;
- graceful stop is triggered automatically;
- `/health` no longer reports the crashed runtime as active.

## 9. Math utilities

Файл: `src/utils/math.ts`.

### 9.1. `calculateOpenSpread`

For `sell`:

```text
(primaryBid - secondaryAsk) / secondaryAsk * 100
```

Meaning:

- sell/short primary;
- buy/long secondary.

For `buy`:

```text
(secondaryBid - primaryAsk) / primaryAsk * 100
```

Meaning:

- buy/long primary;
- sell/short secondary.

### 9.2. `calculateTruePnL`

Signal-level PnL estimate for exit checks.

It estimates:

- open edge;
- reversal edge;
- static fee estimate `0.20%`.

It is not final accounting. Final accounting uses actual fill prices and commissions.

### 9.3. `calculateRealPnL`

Final PnL calculation from:

- open prices;
- close prices;
- amount;
- order direction;
- total commission.

Returns:

- `profitUsdt`;
- `profitPercentage`.

### 9.4. `d`

Rounds/trims numeric values before sending to Django DecimalFields.

### 9.5. `checkLegDrawdown`

Calculates leveraged drawdown per leg and returns the maximum drawdown.

Used for liquidation protection.

### 9.6. `calculateVWAP`

Calculates volume-weighted average price for a target base-coin amount.

Behavior:

- no book -> `NaN`;
- target <= 0 -> first level price;
- enough depth -> full VWAP;
- insufficient depth:
  - strict mode -> `NaN`;
  - emergency mode -> VWAP of available depth.

## 10. MarketInfoService

Файл: `src/services/market-info.ts`.

Purpose:

- cache unified market constraints;
- compute trade amount;
- detect suspicious ticker collisions;
- filter symbols that cannot satisfy minimum exchange requirements.

Flow:

1. Fetch primary/secondary tickers.
2. For each common symbol:
   - get primary market info;
   - get secondary market info;
   - skip if missing;
   - set `stepSize = max(primary.stepSize, secondary.stepSize)`;
   - set `minQty = max(primary.minQty, secondary.minQty)`;
   - set `minNotional = max(primary.minNotional, secondary.minNotional)`;
   - compare prices;
   - skip if deviation > 40%;
   - compute `TRADE_AMOUNT_USDT / currentPrice`;
   - round down to step size;
   - reject if below min constraints;
   - cache `UnifiedMarketInfo`.

The 40% deviation check is a homonym/ticker collision guard. It protects against different assets with the same ticker on different exchanges.

## 11. Django API integration

Файл: `src/services/api.ts`.

Axios client:

```ts
baseURL: config.djangoApiUrl
timeout: 15000
Content-Type: application/json
```

Endpoints:

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/bots/real-trades/` | Create open real trade. |
| `PATCH` | `/bots/real-trades/{id}/` | Close/update real trade. |
| `GET` | `/bots/real-trades/?status=open` | Recover open trades. |

No JWT/service token is sent.

This relies on Django real-trades endpoint being open to this process. If Django API is publicly reachable, this is unsafe.

## 12. Exchange interface

Файл: `src/exchanges/exchange-client.ts`.

Every exchange client implements:

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

This keeps `Trader` exchange-agnostic.

## 13. BinanceClient

Файл: `src/exchanges/binance-client.ts`.

Type: direct signed REST client for Binance USDT-M Futures.

Base URLs:

- testnet: `https://testnet.binancefuture.com`
- production: `https://fapi.binance.com`

Symbol conversion:

- ccxt `BTC/USDT:USDT`
- Binance REST `BTCUSDT`

Key behavior:

- direct HMAC-SHA256 signing;
- `fetchTime`, `fetchTickers`, `fetchPositions` ccxt-like surface;
- load perpetual USDT markets from `/fapi/v1/exchangeInfo`;
- set leverage and margin type;
- create market orders;
- poll order if average price is missing;
- extract commission from `/fapi/v1/userTrades`;
- approximate BNB commission as USDT using notional * 0.045%.

## 14. BybitClient

Файл: `src/exchanges/bybit-client.ts`.

Type: ccxt-based adapter.

Key behavior:

- `defaultType: 'swap'`;
- optional sandbox;
- load markets through ccxt;
- set leverage and isolated margin;
- create market orders;
- poll `fetchOrder()` up to 5 times for final average/status;
- normalize fees to approximate USDT.

## 15. MexcClient

Файл: `src/exchanges/mexc-client.ts`.

Type: ccxt-based futures adapter.

Key behavior:

- `defaultType: 'swap'`;
- leverage setup failures are warnings;
- isolated margin has fallback implicit API attempt;
- market order polling for missing average/status;
- only USDT/USDC fees are counted.

Important:

- `MEXC_API_KEY`/`MEXC_SECRET` are optional in config.
- If route uses `mexc` without credentials, real order operations will fail.

## 16. GateClient

Файл: `src/exchanges/gate-client.ts`.

Type: direct signed Gate Futures REST client.

Base URLs:

- testnet: `https://fx-api-testnet.gateio.ws/api/v4`
- production: `https://api.gateio.ws/api/v4`

Symbol conversion:

- ccxt `BTC/USDT:USDT`
- Gate `BTC_USDT`

Key behavior:

- direct Gate v4 HMAC-SHA512 signing;
- fetch tickers;
- fetch positions;
- load contracts;
- set leverage;
- best-effort isolated margin;
- convert base coin amount to Gate contract count via `quanto_multiplier`;
- use positive size for buy, negative for sell;
- submit IOC market-style orders with `price: "0"`;
- poll final order details;
- extract commission from `my_trades`;
- convert filled contracts back to base quantity.

Important:

- `GATE_API_KEY`/`GATE_SECRET` are optional in config.
- If route uses `gate` without credentials, real order operations will fail.

## 17. Test scripts

### 17.1. `test_binance.ts`

Manual smoke test:

- create `BinanceClient`;
- load markets;
- print first 5 USDT symbols;
- print BTC market info.

Run:

```bash
pnpm exec tsx test_binance.ts
```

Requires `.env` with Binance credentials because `config.ts` requires them.

### 17.2. `test_gate.ts`

Manual smoke test:

- create `GateClient`;
- load markets;
- print first 5 USDT symbols;
- print BTC market info.

Run:

```bash
pnpm exec tsx test_gate.ts
```

## 18. Deployment notes

Файл `DEPLOY_LINUX.md` already contains a Russian deployment guide.

Key points from it:

- Use Linux VPS.
- Keep system time synchronized.
- Install Chrony.
- Use Node.js 20 LTS.
- Install `pnpm`, `typescript`, `tsx`.
- Use PM2 for process supervision.
- Build with `pnpm run build`.
- Run `dist/main.js` under PM2.

Critical deploy warning:

- Exchange APIs reject signed requests if server time drifts.
- Time sync must be monitored.

Config mismatch to fix:

`DEPLOY_LINUX.md` shows:

```env
BINANCE_SECRET_KEY=...
BYBIT_SECRET_KEY=...
```

But actual code expects:

```env
BINANCE_SECRET=...
BYBIT_SECRET=...
```

Update deploy docs before relying on them.

## 19. Commands

From project root:

```bash
cd /Users/eldar/dev/Projects/arbitration-art/arbitration-trader
```

Install dependencies:

```bash
pnpm install
```

Build:

```bash
pnpm build
```

Run trader directly:

```bash
pnpm start
```

Run manual tests:

```bash
pnpm exec tsx test_binance.ts
pnpm exec tsx test_gate.ts
```

Production pattern:

```bash
pnpm build
pm2 start dist/main.js --name "arbitration-trader"
```

## 20. Verification performed

Performed on 2026-04-23:

```bash
pnpm install
pnpm build
rg "[А-Яа-яЁё]" src test_binance.ts test_gate.ts .env.example
```

Results:

- Dependencies installed successfully.
- `pnpm build` completed successfully.
- No Cyrillic text remains in `src`, `test_binance.ts`, `test_gate.ts`, `.env.example`.

Note:

- `pnpm install` created local `node_modules/`.
- `pnpm build` created local `dist/`.
- These do not appear as git changes in current status.

## 21. Current git-touched files

Code/config files updated with English comments:

- `.env.example`
- `src/config.ts`
- `src/main.ts`
- `src/classes/Trader.ts`
- `src/services/api.ts`
- `src/services/market-info.ts`
- `src/types/index.ts`
- `src/utils/logger.ts`
- `src/utils/math.ts`
- `src/exchanges/exchange-client.ts`
- `src/exchanges/binance-client.ts`
- `src/exchanges/bybit-client.ts`
- `src/exchanges/mexc-client.ts`
- `src/exchanges/gate-client.ts`
- `test_binance.ts`
- `test_gate.ts`

Documentation added:

- `DOCS.md`

## 22. Important risks and technical debt

### 22.1. Real trading by default

`USE_TESTNET=false` by default in `.env.example`.

This is dangerous for development. Consider making testnet default or adding an explicit confirmation flag for production.

### 22.2. Mandatory Binance/Bybit credentials

Even if route is `gate/mexc`, `config.ts` requires Binance and Bybit credentials. This limits exchange routing flexibility.

Recommended:

- require credentials only for selected exchanges;
- validate selected exchanges before reading their required secrets.

### 22.3. No process-level distributed lock

Two running trader processes can open trades on the same account and bypass the local `TradeCounter`.

Mitigation:

- DB lock;
- Redis lock;
- single PM2 instance;
- exchange-account-level operating discipline.

### 22.4. Django API unauthenticated

Trader does not send auth to Django. Current Django endpoint must stay private or use service auth.

### 22.5. Recovery matching by symbol only

Recovered trades are distributed by `trade.coin`. If multiple strategies/accounts/routes use the same symbol, recovery can be wrong.

Better:

- add strategy id;
- add exchange route;
- add process/account id;
- add bot relation in Django real Trade.

### 22.6. No automated test suite

There are manual smoke scripts only. Math and state transitions should have tests.

Recommended minimum:

- `calculateOpenSpread`;
- `calculateTruePnL`;
- `calculateRealPnL`;
- `calculateVWAP`;
- `checkLegDrawdown`;
- `TradeCounter`;
- `Trader.executeOpen` with mocked clients;
- partial open rollback;
- close retry loop;
- recovery behavior.

### 22.7. Exchange-specific reduceOnly support

The strategy assumes `reduceOnly` works consistently through all clients. Confirm behavior for MEXC/Gate and ccxt parameter naming.

### 22.8. Market-order slippage

VWAP reduces false signals but cannot guarantee final fill. The code recalculates spread from actual fills, but entry decision can still be stale under fast markets.

### 22.9. Fee approximations

BNB fee conversion is approximate. Non-USDT fees on some exchanges are ignored or approximated.

### 22.10. PM2 deploy docs variable mismatch

Fix `DEPLOY_LINUX.md` secret variable names before production deployment.

## 23. Suggested stabilization plan

1. Change `.env.example` default to `USE_TESTNET=true` or require explicit production confirmation.
2. Make credentials required only for selected exchanges.
3. Fix `DEPLOY_LINUX.md` variable names.
4. Add service authentication to Django real-trades API.
5. Add strategy/account/process identifiers to Django trades for safe recovery.
6. Add automated tests for math utilities.
7. Add mocked exchange tests for open/rollback/close flows.
8. Add structured logging and secret redaction policy.
9. Add persistent counters for WS errors, close retries and cleanup events.
10. Add lock/lease if more than one process can run.

## 24. Workflow summary

This section consolidates the operational flow that was previously kept in `WORKFLOW.md`.

### 24.1. Service purpose

`arbitration-trader` is a standalone real-trading process that:

- accepts lifecycle commands from Django over HTTP;
- keeps only one active runtime in a process;
- receives exchange keys and trading parameters from Django payloads;
- connects to two futures exchanges;
- scans a shared set of liquid USDT perpetual symbols;
- opens two opposite market legs when spread expands beyond baseline;
- closes by profit, timeout, shutdown, or drawdown/liquidation guard;
- persists real trades into Django through service-token-authenticated requests.

### 24.2. What comes from `.env`

The service reads only infrastructure variables from `.env`:

- `DJANGO_API_URL`
- `SERVICE_SHARED_TOKEN`
- `PORT`

Trading configuration and user exchange keys arrive from Django runtime payloads sent to:

- `POST /engine/trader/start`
- `POST /engine/trader/sync`

### 24.3. Control plane

The HTTP server exposes:

- `GET /health`
- `POST /engine/trader/start`
- `POST /engine/trader/sync`
- `POST /engine/trader/stop`
- `POST /engine/trader/runtime/exchange-health`
- `GET /engine/trader/runtime/active-coins`
- `GET /engine/trader/runtime/open-trades-pnl`
- `GET /engine/trader/runtime/system-load`

All endpoints except `/health` require `X-Service-Token`.

Command behavior:

1. `start`
   - stop current runtime if one is active;
   - start a new runtime from payload.
2. `sync`
   - perform a controlled restart with a fresh payload.
3. `stop`
   - stop the active runtime;
   - if `runtime_config_id` is provided, it must match the active runtime.

Diagnostic behavior:

1. `POST /engine/trader/runtime/exchange-health`
   - receives a full Django runtime payload with exchange keys;
   - creates short-lived REST clients for primary/secondary exchanges without mutating the currently active runtime;
   - runs authenticated private API checks and returns per-exchange availability/error.
2. `GET /engine/trader/runtime/active-coins`
   - reads in-memory trader state for the requested `runtime_config_id`;
   - returns `active_coins`, `trade_count` and `is_requested_runtime_active`.
3. `GET /engine/trader/runtime/open-trades-pnl`
   - reads in-memory open trades;
   - calculates live mark-to-market values from the current orderbook snapshot;
   - returns both signal-style `current_pnl_percent` and estimated USDT / percentage PnL using recorded open commission.
4. `GET /engine/trader/runtime/system-load`
   - samples system-wide CPU utilization over a short interval;
   - returns total/used/free RAM in bytes and percent usage for the host running the trader process.

### 24.4. Runtime bootstrap sequence

`RuntimeManager.startRuntime()` performs the following steps:

1. Store runtime payload in `config.ts`.
2. Create primary and secondary REST clients.
3. Validate that exchanges differ.
4. Measure approximate latency.
5. Load markets on both exchanges.
6. Build the intersection of USDT futures symbols.
7. Filter by primary-exchange liquidity.
8. Initialize `MarketInfoService`.
9. Merge and validate market constraints.
10. Configure isolated margin and leverage on both exchanges.
11. Create shared WebSocket clients.
12. Split symbols into chunks.
13. Fetch open Django trades for the current `runtime_config_id`.
14. Create `Trader` instances for chunks.
15. Restore open trades into matching traders.
16. Start all `Trader` workers.

If recovery of open trades from Django fails at step 13, runtime startup is aborted.

### 24.5. Symbol selection logic

The runtime trades only symbols that pass all of the following:

1. Present on both exchanges as USDT perpetual/futures symbols.
2. Have primary-exchange `quoteVolume >= 2_000_000`.
3. Fit within `top_liquid_pairs_count`.
4. Pass `MarketInfoService` validation:
   - merged `stepSize`
   - merged `minQty`
   - merged `minNotional`
5. Are not filtered by homonym detection:
   - if cross-exchange price deviation exceeds 40%, symbol is skipped.
6. Successfully confirm isolated margin and leverage setup on both exchanges.

Warnings from exchange setup are not treated as successful configuration.

### 24.6. Trader runtime state

Each `Trader` owns a chunk of symbols and keeps per-symbol mutable state:

- `baselineBuy`
- `baselineSell`
- `activeTrade`
- `openedAtMs`
- `busy`
- `cooldownUntil`
- `pendingCloseSync`

Two watch loops run per symbol, one per exchange WebSocket feed. `busy` acts as a local mutex to prevent duplicate open/close handling from concurrent book updates.

### 24.7. Price and size calculation

The strategy uses VWAP instead of top-of-book:

1. Read both orderbooks from ccxt.pro in-memory cache.
2. Determine target size:
   - entry uses current configured trade size;
   - close uses exact stored Django trade amount.
3. Build four prices:
   - `primaryBid`
   - `primaryAsk`
   - `secondaryBid`
   - `secondaryAsk`

If depth is insufficient:

- entry and profit-close are skipped;
- emergency exits can use approximate VWAP over available visible depth.

Entry amount is:

1. derived from `trade_amount_usdt`;
2. converted using current primary best bid;
3. rounded down by unified `stepSize`;
4. validated against merged `minQty` and `minNotional`.

### 24.8. Entry workflow

When a symbol has no active trade:

1. Compute `currentBuySpread` and `currentSellSpread`.
2. Update separate EMA baselines for buy and sell directions.
3. Check global `TradeCounter`.
4. Enforce per-symbol cooldown.
5. Open when:
   - `currentBuySpread >= baselineBuy + openThreshold`, or
   - `currentSellSpread >= baselineSell + openThreshold`.

Direction semantics:

- `buy`
  - long primary
  - short secondary
- `sell`
  - short primary
  - long secondary

`executeOpen()`:

1. Locks the symbol with `busy`.
2. Reserves a trade slot atomically.
3. Sends both market orders concurrently.
4. On partial failure:
   - attempt reverse reduce-only rollback;
   - run full position cleanup;
   - release slot;
   - apply cooldown.
5. On success:
   - use actual fill prices or VWAP fallback;
   - sum fees;
   - recompute real open spread;
   - create Django trade;
   - store `activeTrade` and `openedAtMs`.

### 24.9. Recovery behavior

At startup, open trades are loaded from Django for the current runtime only and distributed by `trade.coin` to the matching `Trader`.

`restoreOpenTrades()`:

- restores local `activeTrade`;
- restores `openedAtMs`;
- increments shared `TradeCounter`.

This ensures:

- restored exposure still counts against concurrency;
- timeout and drawdown guards continue after restart;
- runtime does not open new trades over restored positions.

### 24.10. Exit workflow

When a symbol has `activeTrade`, no new entry is evaluated. Exit checks run in this order:

1. Drawdown/liquidation guard using emergency prices.
2. Profit close using strict prices and `calculateTruePnL`.
3. Timeout close via watchdog every 10 seconds.

`executeClose()`:

1. Lock symbol with `busy`.
2. Determine close side per exchange.
3. Fetch real positions from both exchanges.
4. Close only legs that are still open.
5. Use reduce-only market orders.
6. Use fallback prices if a leg is already flat or execution price is missing.
7. Compute:
   - close commission
   - total commission
   - real PnL
   - close spread
   - final status
8. Persist close into Django with retry loop.

If exchange close succeeded but Django close sync still failed after retries:

- keep `activeTrade` locally;
- keep the trade slot reserved;
- store close payload in `pendingCloseSync`;
- retry Django close sync until it succeeds.

Only after successful close persistence:

- clear `activeTrade`;
- clear `openedAtMs`;
- clear `pendingCloseSync`;
- release `TradeCounter` slot;
- reset or refresh baselines.

Close status mapping:

- `profit` -> `closed`
- all other close triggers -> `force_closed`

Close reason mapping to Django:

- `liquidation` -> `error`
- `profit`, `timeout`, `shutdown`, `error` are sent unchanged

### 24.11. Shutdown and crash handling

On `SIGINT`, `SIGTERM`, or runtime stop:

1. `RuntimeManager` clears active runtime handle.
2. Each `Trader` runs `stop(true)`.
3. Active trades are closed with emergency pricing.
4. If only Django close sync is pending, it is retried first.
5. Shared WebSocket clients are closed.

If a `Trader` worker rejects unexpectedly:

- the crash is logged;
- runtime is marked inactive;
- controlled stop is triggered automatically;
- `/health` no longer reports the crashed runtime as active.

### 24.12. Key operational nuances

1. Only one runtime can be active in a process.
2. Market constraints are preloaded at bootstrap and not recomputed during trading.
3. WebSocket clients are shared across all trader chunks.
4. Entry/profit checks require full visible depth; emergency exits prioritize flattening over exact pricing.
5. Cleanup after failed opens relies on real `fetchPositions`, not only local assumptions.
6. Close persistence in Django is treated as required state synchronization, not best-effort logging.
7. Dust positions below `minQty` may be ignored by close logic.
8. `profitPercentage` is calculated against notional capital, not isolated margin after leverage.

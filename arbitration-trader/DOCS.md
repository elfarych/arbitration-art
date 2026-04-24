# Arbitration Trader - внутренняя документация

Дата анализа: 2026-04-23.

Документ описывает фактическое состояние проекта `arbitration-trader`: архитектуру, конфигурацию, торговый цикл, интеграцию с Django, exchange-клиенты, команды запуска, деплой, проверки и текущие риски. Документация на русском; комментарии в коде добавлены на английском языке.

## 1. Краткое резюме

`arbitration-trader` - standalone TypeScript/Node.js процесс для реальной арбитражной торговли между двумя выбранными futures/derivatives биржами.

Сервис поднимает HTTP control plane, принимает lifecycle-команды `POST /engine/trader/{start|sync|stop}` от Django, отдает diagnostic routes для exchange health, active coins, live PnL и system load, держит в одном процессе только один активный `TraderRuntimeConfig` и получает биржевые ключи/торговые параметры в payload.

Сервис:

- читает из `.env` инфраструктурные/операционные переменные, process guards, execution journal path и production safety caps;
- получает runtime-конфиг и ключи пользователя из Django;
- загружает markets;
- находит пересечение USDT perpetual symbols;
- фильтрует самые ликвидные пары;
- проверяет market constraints;
- сверяет все открытые futures-позиции выбранных аккаунтов с Django open trades перед запуском scanner;
- ведет локальный JSONL execution journal для open/cleanup/close intents и блокирует старт при незавершенных intents;
- держит host-local process lock на runtime;
- выставляет isolated margin и leverage;
- создает общие orderbook providers;
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
- `fastify` for HTTP control plane.
- `axios` for native Binance/Bybit/MEXC/Gate REST, orderbook snapshot bootstrap and Django API calls.
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
    "build": "tsc",
    "test": "tsx --test tests/*.test.ts"
  },
  "dependencies": {
    "fastify": "^4.26.2"
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
    │   ├── TradeCounter.ts
    │   ├── trade-state.ts
    │   ├── RuntimeManager.ts
    │   └── Trader.ts
    ├── control-plane/
    │   ├── server.ts
    │   └── shutdown.ts
    ├── exchanges/
    │   ├── exchange-client.ts
    │   ├── symbols.ts
    │   ├── binance-client.ts
    │   ├── bybit-client.ts
    │   ├── mexc-client.ts
    │   ├── gate-client.ts
    │   └── ws/
    │       ├── orderbook-store.ts
    │       ├── binance-orderbook-provider.ts
    │       ├── bybit-orderbook-provider.ts
    │       ├── gate-orderbook-provider.ts
    │       ├── mexc-orderbook-provider.ts
    │       └── orderbook-provider-factory.ts
    ├── services/
    │   ├── account-reconciliation.ts
    │   ├── api.ts
    │   ├── close-sync-service.ts
    │   ├── diagnostics.ts
    │   ├── execution-journal.ts
    │   ├── market-info.ts
    │   ├── position-recovery.ts
    │   ├── runtime-process-lock.ts
    │   ├── runtime-payload-validation.ts
    │   ├── shadow-recorder.ts
    │   └── signal-engine.ts
    ├── types/
    │   └── index.ts
    └── utils/
        ├── logger.ts
        └── math.ts
└── tests/
    ├── account-reconciliation.test.ts
    ├── binance-orderbook-provider.test.ts
    ├── math.test.ts
    ├── orderbook-store.test.ts
    ├── risk-lock.test.ts
    ├── runtime-payload-validation.test.ts
    ├── signal-engine.test.ts
    └── trade-counter.test.ts
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
Fastify control plane
  |
  v
RuntimeManager
  |
  +--> active runtime payload in config.ts
  +--> REST exchange clients
  +--> market discovery/filtering
  +--> MarketInfoService
  +--> leverage/margin setup
  +--> shared orderbook providers
  +--> TradeCounter
  +--> RuntimeRiskLock
  +--> SignalEngine / CloseSyncService / PositionRecovery helpers
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
- Primary/secondary exchanges выбираются через runtime payload от Django.
- Все chunks используют одни и те же REST clients и orderbook providers.
- `main.ts` только связывает `RuntimeManager`, Fastify control plane и process shutdown handlers.
- `TradeCounter` общий для всех chunks и ограничивает число одновременных открытых сделок.
- Django используется как persistence layer для real trades, но не управляет lifecycle этого trader-процесса.

## 5. Конфигурация

Файл: `src/config.ts`.

`.env` загружается через:

```ts
dotenv.config();
```

Обязательная переменная окружения:

- `SERVICE_SHARED_TOKEN`

Из `.env` также читаются инфраструктурные переменные:

- `DJANGO_API_URL`
- `PORT`
- `SHADOW_SIGNAL_LOG_PATH`
- `EXECUTION_JOURNAL_PATH`
- `TRADER_PROCESS_LOCK_PATH`
- `PUBLIC_HEALTH_DETAILS`
- `FAIL_ON_UNRESOLVED_EXECUTION_JOURNAL`
- `POSITION_SIZE_TOLERANCE_PERCENT`
- `ALLOW_PRODUCTION_TRADING`
- `TRADER_ENVIRONMENT`
- `PRODUCTION_TRADING_ENVIRONMENT`
- `PRODUCTION_ACCOUNT_FINGERPRINTS`
- `MAX_PRODUCTION_TRADE_AMOUNT_USDT`
- `MAX_PRODUCTION_CONCURRENT_TRADES`
- `MAX_PRODUCTION_LEVERAGE`

Биржевые ключи и торговые параметры приходят в runtime payload от Django. `runtime-payload-validation.ts` проверяет payload до `setActiveRuntime(payload)`: id, owner, допустимые exchange names, положительные числовые лимиты, `primary_exchange != secondary_exchange` и наличие ключей для выбранных бирж.

### 5.1. Таблица переменных

| Переменная | Default | Назначение |
|---|---:|---|
| `DJANGO_API_URL` | `http://127.0.0.1:8000/api` | Base URL Django API. |
| `SERVICE_SHARED_TOKEN` | required | Shared token for Django -> trader control plane and Django trade API calls. |
| `PORT` | `3002` | HTTP control plane port. |
| `SHADOW_SIGNAL_LOG_PATH` | `logs/shadow-signals.jsonl` | JSONL file for shadow-mode entry signals. |
| `EXECUTION_JOURNAL_PATH` | `logs/execution-journal.jsonl` | Durable local JSONL journal for open/cleanup/close execution intents and results. |
| `TRADER_PROCESS_LOCK_PATH` | `locks/trader-runtime.lock` | Host-local lock file held while a runtime is active. |
| `PUBLIC_HEALTH_DETAILS` | `false` | If `false`, unauthenticated `/health` returns only a public-safe `status=ok`; detailed health requires `X-Service-Token`. |
| `FAIL_ON_UNRESOLVED_EXECUTION_JOURNAL` | `true` | Startup fails when the execution journal contains unresolved intents for the runtime. |
| `POSITION_SIZE_TOLERANCE_PERCENT` | `0.1` | Allowed expected-vs-actual position size drift before reconciliation locks the runtime. |
| `ALLOW_PRODUCTION_TRADING` | `false` | Process-level guard for payloads with `use_testnet=false`; production runtime also requires environment, account allowlist and caps below. |
| `TRADER_ENVIRONMENT` | `development` | Current process environment id. Production payloads require it to match `PRODUCTION_TRADING_ENVIRONMENT`. |
| `PRODUCTION_TRADING_ENVIRONMENT` | `production` | Required environment id for production payloads. |
| `PRODUCTION_ACCOUNT_FINGERPRINTS` | empty | Comma-separated SHA-256 prefixes of selected exchange API keys for allowed live account routes. Empty value rejects production payloads. |
| `MAX_PRODUCTION_TRADE_AMOUNT_USDT` | empty | Required live cap for `trade_amount_usdt`. Empty value rejects production payloads. |
| `MAX_PRODUCTION_CONCURRENT_TRADES` | empty | Required live cap for `max_concurrent_trades`. Empty value rejects production payloads. |
| `MAX_PRODUCTION_LEVERAGE` | empty | Required live cap for `leverage`. Empty value rejects production payloads. |

Runtime payload fields in `config`:

| Field | Назначение |
|---|---|
| `primary_exchange`, `secondary_exchange` | Exchange route. |
| `use_testnet` | Testnet/sandbox mode where supported. |
| `trade_amount_usdt` | Position notional before leverage. |
| `leverage` | Leverage on both exchanges. |
| `max_concurrent_trades` | Global concurrent open trade limit. |
| `top_liquid_pairs_count` | Max number of liquid pairs to scan. |
| `max_trade_duration_minutes` | Timeout before force close. |
| `max_leg_drawdown_percent` | Per-leg leveraged drawdown limit. |
| `open_threshold` | Spread expansion over EMA baseline to open. |
| `close_threshold` | True PnL threshold to close. |
| `orderbook_limit` | Orderbook depth subscription limit. |
| `chunk_size` | Symbols per `Trader` instance. |
| `min_open_net_edge_percent` | Minimum hard economic entry edge after buffers. Default `0`. |
| `entry_fee_buffer_percent` | Entry/exit fee buffer for entry signal. Default `0.20`. |
| `entry_slippage_buffer_percent` | Slippage buffer for entry signal. Default `0.05`. |
| `funding_buffer_percent` | Extra funding risk buffer. Default `0`. |
| `latency_buffer_percent` | Latency/staleness buffer. Default `0.02`. |
| `shadow_mode` | If `true`, entry signals are recorded without placing orders. Default `false`. |

Supported route names:

- `binance`
- `bybit`
- `mexc`
- `gate`

Important:

- `primary_exchange` and `secondary_exchange` must be different.
- Credentials are required only for exchanges selected in the runtime payload.
- Binance/Bybit/Gate/MEXC credentials are not stored in `.env`.

## 6. Entry Point: `main.ts`

`main.ts` contains only process wiring:

- create `RuntimeManager`;
- register process shutdown handlers from `control-plane/shutdown.ts`;
- create and start Fastify control plane from `control-plane/server.ts`.

HTTP routing, token checks, payload parsing and error mapping live in `src/control-plane/server.ts`. Runtime command payload validation lives in `src/services/runtime-payload-validation.ts`.

### 6.1. Control plane

Fastify routes:

- `GET /health`
- `POST /engine/trader/start`
- `POST /engine/trader/sync`
- `POST /engine/trader/stop`
- `POST /engine/trader/runtime/exchange-health`
- `GET /engine/trader/runtime/active-coins`
- `GET /engine/trader/runtime/open-trades-pnl`
- `GET /engine/trader/runtime/system-load`

All routes except `/health` require `X-Service-Token`.

Unauthenticated `GET /health` returns only public-safe `{ success: true, status: "ok" }` while `PUBLIC_HEALTH_DETAILS=false`. Detailed health with `active_runtime_config_id`, `runtime_state`, `risk_locked`, `risk_incidents` and `open_exposure` is returned when the request has a valid `X-Service-Token` or `PUBLIC_HEALTH_DETAILS=true`. `runtime_state` is one of `idle`, `running`, `risk_locked`, `stopping_with_open_exposure`.

Invalid runtime payloads return HTTP 400. Runtime errors return HTTP 500.

### 6.2. Startup banner

`RuntimeManager.startRuntime()` logs:

- real trading mode;
- testnet status;
- trade amount;
- leverage;
- max concurrent trades;
- max trade duration;
- open/close thresholds.

### 6.3. REST exchange clients

`createClient(name)` returns:

| Config name | Client |
|---|---|
| `binance` | `BinanceClient` |
| `bybit` | `BybitClient` |
| `mexc` | `MexcClient` |
| `gate` | `GateClient` |

Unknown exchange names are rejected during runtime payload validation and by `RuntimeManager.createClient()`.

REST clients are used for:

- markets metadata;
- tickers;
- symbol-specific positions and account-wide open position reconciliation through `fetchAllOpenPositions()`;
- leverage/margin setup;
- real market orders.

### 6.4. Latency measurement

Flow:

1. Warmup `fetchTime()` on both exchanges.
2. Measure a second `fetchTime()` using existing keep-alive/TLS session.
3. Log approximate API latency.

This is informational only. It does not affect trading decisions.

### 6.5. Market loading

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

### 6.6. Common symbol discovery

The trader:

1. Gets primary USDT symbols.
2. Gets secondary USDT symbols.
3. Keeps only intersection.

Symbols use the internal unified futures format:

```text
BTC/USDT:USDT
```

### 6.7. Liquidity filtering

The trader fetches tickers from both selected exchanges and filters:

- require `min(primaryVolume, secondaryVolume) >= 2_000_000`;
- sort by cross-exchange minimum quote volume descending;
- keep first `TOP_LIQUID_PAIRS_COUNT`.

Reason:

- illiquid symbols can show fake/unexecutable spreads;
- lower depth increases slippage and partial-fill risk.

If ticker fetch fails and there are no open Django trades to restore, runtime startup fails closed. If open trades exist, the runtime starts only for recovery symbols and blocks new entries for those symbols after they are closed.

### 6.8. Market info validation

Creates `MarketInfoService` and calls:

```ts
marketInfo.initialize(primaryClient, secondaryClient, commonSymbols)
```

This:

- fetches prices;
- detects ticker homonyms;
- stores funding rate / next funding snapshots when exchange tickers provide them;
- merges min quantities and step sizes;
- computes trade amount from `trade_amount_usdt`;
- excludes symbols that cannot meet minimums.

If no symbols remain, process exits.

### 6.9. Leverage and isolated margin setup

For each tradeable symbol:

- set isolated margin on primary and secondary;
- set leverage on primary and secondary.

Before symbol setup, runtime validates account mode through each selected REST client:

- Binance rejects hedge mode through `positionSide/dual`;
- Bybit rejects detected hedge positions where `positionIdx != 0`;
- Gate validates private API availability;
- MEXC validates that the reported position mode is recognized by the native client.

The setup is batched:

- `batchSize = 5`;
- delay `1200ms` between batches.

Reason: prevent Bybit HTTP 429 / "Too many visits".

If setup fails for a symbol, that symbol is excluded from final tradable list.

If no symbols remain after setup, process exits.

Additional guarantees:

- startup aborts if open-trade recovery from Django fails;
- startup aborts if any open Django trade cannot be included in the runtime universe;
- Gate/MEXC setup warnings are not treated as successful setup;
- a symbol is allowed into scanning only after both exchanges confirmed the requested margin/leverage state.
- confirmed leverage/margin setup is cached in-process by account fingerprint, testnet/production mode, exchange route, symbol and leverage, so repeated syncs skip already confirmed symbols only inside the same environment/account route.

### 6.10. Orderbook providers

`createOrderBookProvider(name)` returns an `OrderBookProvider`:

| Config name | Provider |
|---|---|
| `binance` | Native Binance USD-M Futures depth stream provider. |
| `bybit` | Native Bybit V5 public linear orderbook provider. |
| `mexc` | Native MEXC Contract `push.depth` provider. |
| `gate` | Native Gate USDT Futures `futures.order_book_update` provider. |

Providers are shared by all `Trader` chunks and expose only normalized orderbook snapshots through:

```ts
getOrderBook(symbol): OrderBookSnapshot | null
onUpdate(listener): () => void
```

Important:

- Providers are created without API credentials.
- They are used for public orderbook streaming.
- Binance native provider blocks trading for a symbol while the local book is unsynced or older than 10 seconds.
- Bybit native provider uses V5 `orderbook.{depth}.{symbol}` snapshots/deltas, heartbeat ping every 20 seconds, reconnect/resubscribe, and stale-book blocking.
- Gate native provider subscribes to `futures.order_book_update`, fetches REST snapshots with `with_id=true`, validates `U`/`u` continuity, converts contract sizes to base coin amounts through `quanto_multiplier`, sends `X-Gate-Size-Decimal: 1`, and blocks trading while the book is unsynced or stale.
- MEXC native provider subscribes to `sub.depth` with `compress: false`, fetches REST depth snapshots, validates contiguous `version` increments, converts contract volumes to base coin amounts through `contractSize`, and blocks trading while the book is unsynced or stale.

### 6.11. TradeCounter

Creates one shared:

```ts
const tradeCounter = new TradeCounter();
```

It enforces `max_concurrent_trades` across all chunks.

### 6.12. Chunking

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

### 6.13. Recovery from Django

Before liquidity filtering finishes, runtime loads open trades:

```ts
const openTrades = await api.getOpenTrades(config.runtimeConfigId);
```

Open trade symbols are added to the runtime universe even if they are not part of the current liquid scanning set. If a recovery symbol is not scannable, its `PairState.canOpenNewTrades` is `false`, so the runtime can monitor/close the restored exposure without opening a new trade on that symbol.

Then each open trade is assigned to the `Trader` whose `symbols` include `trade.coin`.

If no matching trader chunk exists, runtime startup fails. Open trades are not ignored.

If `getOpenTrades()` fails, runtime startup is aborted. The trader does not continue with an empty in-memory state while exchange exposure may still exist.

### 6.14. Shutdown

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

`unhandledRejection` is treated as fatal: the process starts controlled shutdown and exits with non-zero status so a supervisor can restart it.

## 7. `TradeCounter`

Файл: `src/classes/TradeCounter.ts`.

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

`Trader` owns a subset of symbols. It does not own exchange clients; they are shared and injected from `RuntimeManager`.

Constructor dependencies:

- trader id;
- symbols chunk;
- primary `OrderBookProvider`;
- secondary `OrderBookProvider`;
- primary REST client;
- secondary REST client;
- `MarketInfoService`;
- shared `TradeCounter`;
- `entryDisabledSymbols` for recovery-only symbols.

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
| `pendingCloseSync` | Exchange close payload that still must be persisted to Django. |
| `unmanagedExposure` | Failed-open cleanup state; new entries are blocked and cleanup is retried until flat. |
| `partialClose` | In-process per-leg close execution state with fill price, order id, commission and size, used when one close leg succeeds and the other fails. |
| `closeIntentId` | Execution-journal intent id reused across close retries for the same active trade. |
| `canOpenNewTrades` | Blocks new entries for recovery-only symbols. |

Constants:

- `COOLDOWN_MS = 30000`.
- `TIMEOUT_CHECK_INTERVAL_MS = 10000`.
- `UNMANAGED_CLEANUP_RETRY_MS = 10000`.
- `RECONCILIATION_INTERVAL_MS = 60000`.

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
- update listeners on primary and secondary `OrderBookProvider`.

`start()` schedules one spread check per symbol when provider updates arrive. Per-symbol scheduling prevents overlapping spread checks for the same symbol.

`start()` normally never resolves until `stop()` is called.

### 8.4. `stop(closePositions=false)`

Behavior:

- if `closePositions=true`, set `isStopping=true` so new entries are blocked;
- call `closeAllPositions('shutdown')`;
- keep timers and provider listeners alive if exposure, pending close sync, unmanaged cleanup or runtime risk lock remains;
- clear timers/listeners and resolve only when the trader is flat/reconciled, or when `closePositions=false`.

Used by graceful shutdown.

### 8.5. `scheduleCheck(symbol)`

Provider callbacks call `scheduleCheck(symbol)`.

Behavior:

- skip when trader is stopped;
- skip when a spread check is already scheduled;
- skip when a spread check is already running for the symbol;
- run `checkSpreads(symbol)` in a microtask;
- log spread-check errors without crashing the provider callback.

### 8.6. `getPrices(symbol, targetCoinsFallback?, isEmergency=false)`

Reads:

- `primaryBooks.getOrderBook(symbol)`;
- `secondaryBooks.getOrderBook(symbol)`.

Requires:

- primary bids/asks;
- secondary bids/asks.
- provider snapshot must be synced.

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
2. Convert `trade_amount_usdt` into base coin amount.
3. Round down to unified step size.
4. Reject if below min quantity or min notional.
5. Get strict VWAP prices.
6. Pass prices, market info and baselines to `SignalEngine`.
7. `SignalEngine` calculates buy/sell spreads and updates EMA baselines:

```text
baseline = baseline * (1 - 0.002) + currentSpread * 0.002
```

8. `SignalEngine` applies relative threshold:

```text
currentSpread >= baselineSpread + open_threshold
```

9. `SignalEngine` applies hard economic threshold:

```text
expected_net_edge = spread - entry_fee_buffer - entry_slippage_buffer - projected_funding_cost - funding_buffer - latency_buffer
expected_net_edge >= min_open_net_edge_percent
```

10. Check `TradeCounter.canOpen()`.
11. Check cooldown.
12. Open the selected direction if both signal and economic thresholds pass.

Funding cost uses cached funding rates from `MarketInfoService` when next funding time is inside `max_trade_duration_minutes`. Unknown funding rates contribute `0`, while `funding_buffer_percent` remains a static conservative buffer.

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
2. If `shadow_mode=true`, write the entry signal into `SHADOW_SIGNAL_LOG_PATH`, set cooldown and return without placing orders.
3. Reserve global trade slot.
4. Determine order sides.
5. Verify there is no unexpected existing position on the target symbol.
6. Place both market orders concurrently via `Promise.allSettled`.
7. If any leg rejects:
   - log atomic failure;
   - close any fulfilled leg with reduce-only opposite order;
   - wait 1 second;
   - run safe cleanup;
   - release trade slot only when cleanup is confirmed;
   - keep the slot reserved and set `unmanagedExposure` when cleanup fails;
   - set cooldown;
   - return.
8. Use exchange fill prices or fallback VWAP prices.
9. Sum commissions.
10. Recalculate real open spread from fill prices.
11. Create Django `Trade` via `api.openTrade`.
12. Store `state.activeTrade`.
13. Store `openedAtMs`.
14. Slot remains reserved until close.
15. On catch after orders may have reached exchanges:
   - log;
   - run safe cleanup;
   - release slot only when cleanup is confirmed;
   - set runtime risk lock and `unmanagedExposure` when cleanup fails;
   - reset baselines;
   - set cooldown.
16. Finally clear busy flag.

Important:

- There is no true atomic open across exchanges.
- The code compensates by flattening any successfully opened leg.
- `reduceOnly` is used for rollback where supported.
- Runtime-level risk lock blocks new entries across all trader chunks while unmanaged exposure or reconciliation incidents exist.

### 8.9. Cleanup: `handleOpenCleanup(symbol, orderType)`

Safety cleanup after failed open or Django persistence failure.

Flow:

- fetch positions on primary;
- close matching symbol position if size >= minQty;
- fetch positions on secondary;
- close matching symbol position if size >= minQty.

It does not rely on local promise results, because an API call can time out after the exchange accepted/fillled the order.

If cleanup fails, `unmanagedExposure` is stored in `PairState`, the runtime risk lock is enabled, and cleanup retries run from the normal watchdog/update flow until positions are confirmed flat.

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
4. Fetch current positions on both exchanges through `position-recovery.ts`.
5. If a leg is missing, wait briefly and recheck before treating it as confirmed flat.
6. Verify detected position side matches the expected leg side.
7. Determine actual sizes.
8. Close only legs that still have positions.
9. Use reduce-only market orders.
10. Store successful close-leg execution in `partialClose` before handling failed legs.
11. Fallback to current book/open price if no close order is needed or price is missing.
12. Calculate:
   - close commission;
   - total commission;
   - real PnL;
   - close spread;
   - status.
13. Update Django through `CloseSyncService` with retries:
   - up to 10 attempts;
   - 5s delay between attempts.
14. If Django still does not accept the close payload:
   - keep `activeTrade` in local state;
   - keep the trade slot reserved;
   - store the exact close payload in pending sync state;
   - retry Django close sync until it succeeds.
15. Only after successful close persistence:
   - clear active trade and opened timestamp;
   - clear `partialClose`;
   - release trade slot;
   - reset or update baselines.
16. On exchange close error, do not clear local state; next tick will retry and reuse stored per-leg close state.

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

- finds all states with active trades, pending close sync or unmanaged exposure;
- retries pending Django close sync first if positions are already flat;
- retries unmanaged exposure cleanup;
- closes each using emergency prices;
- throws if any exposure or pending sync remains.

Used by `stop(true)`.

### 8.14. Runtime crash handling

If any `Trader` loop rejects unexpectedly:

- runtime crash is logged;
- `RuntimeManager` marks the runtime as inactive;
- graceful stop is triggered automatically;
- `/health` reports the active runtime state and risk incidents while controlled stop or cleanup is pending.

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
   - compute `trade_amount_usdt / currentPrice`;
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
  fetchTime(): Promise<number>;
  fetchTickers(symbols?): Promise<Record<string, ExchangeTicker>>;
  fetchPositions(symbols): Promise<ExchangePosition[]>;
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

- internal `BTC/USDT:USDT`
- Binance REST `BTCUSDT`

Key behavior:

- direct HMAC-SHA256 signing;
- direct `fetchTime()` via `/fapi/v1/time`;
- direct `fetchTickers()` via `/fapi/v1/ticker/24hr`;
- direct `fetchPositions()` via `/fapi/v3/positionRisk`;
- load perpetual USDT markets from `/fapi/v1/exchangeInfo`;
- set leverage and margin type;
- create market orders;
- support optional `clientOrderId` as Binance `newClientOrderId`;
- poll order if average price is missing;
- extract commission from `/fapi/v1/userTrades`;
- approximate BNB commission as USDT using notional * 0.045%.

### 13.1. Binance native orderbook provider

Файлы:

- `src/exchanges/ws/binance-orderbook-provider.ts`
- `src/exchanges/ws/orderbook-store.ts`

Base URLs:

- REST snapshot production: `https://fapi.binance.com/fapi/v1/depth`
- REST snapshot testnet: `https://testnet.binancefuture.com/fapi/v1/depth`
- WS production: `wss://fstream.binance.com/stream?streams=...`
- WS testnet: `wss://stream.binancefuture.com/stream?streams=...`

Behavior:

1. Subscribe to `<symbol>@depth@100ms` streams.
2. Buffer diff-depth events per symbol.
3. Fetch REST depth snapshot.
4. Drop buffered events older than snapshot `lastUpdateId`.
5. Apply the first buffered event that bridges the snapshot sequence.
6. Apply later events only while Binance `pu` matches the local previous update id.
7. Mark the symbol unsynced and resync from REST snapshot on a sequence gap.
8. Return `null` from `getOrderBook(symbol)` while a symbol is unsynced.
9. Reconnect with exponential backoff and resubscribe all symbols after WS disconnect.

Depth snapshots use the nearest Binance-supported depth limit from `5, 10, 20, 50, 100, 500, 1000` based on `ORDERBOOK_LIMIT`.

## 14. BybitClient

Файл: `src/exchanges/bybit-client.ts`.

Type: direct signed REST client for Bybit V5 USDT linear perpetuals.

Base URLs:

- testnet: `https://api-testnet.bybit.com`
- production: `https://api.bybit.com`

Symbol conversion:

- internal `BTC/USDT:USDT`
- Bybit REST `BTCUSDT`

Key behavior:

- direct HMAC-SHA256 signing with `X-BAPI-*` headers;
- direct `fetchTime()` via `/v5/market/time`;
- direct `fetchTickers()` via `/v5/market/tickers?category=linear`;
- direct `fetchPositions()` via `/v5/position/list`;
- load tradable USDT linear perpetual markets from `/v5/market/instruments-info`;
- set isolated margin through `/v5/position/switch-isolated`;
- set leverage through `/v5/position/set-leverage`;
- create market orders through `/v5/order/create`;
- send `positionIdx: 0`, so the account route is expected to use one-way position mode;
- generate `orderLinkId` when the caller does not provide `clientOrderId`;
- do not blindly retry order placement after transport failures; reconcile by `orderLinkId` before surfacing the error;
- poll `/v5/order/realtime` and `/v5/order/history` for final order state;
- read `/v5/execution/list` to compute average fill price and USDT/USDC commission;
- reject non-filled or partially filled market orders so `Trader` cleanup can flatten real positions through `fetchPositions()`.

### 14.1. Bybit native orderbook provider

Файл: `src/exchanges/ws/bybit-orderbook-provider.ts`.

Base URLs:

- testnet: `wss://stream-testnet.bybit.com/v5/public/linear`
- production: `wss://stream.bybit.com/v5/public/linear`

Behavior:

1. Subscribe to `orderbook.{depth}.{symbol}` topics.
2. Normalize configured depth to Bybit-supported levels: `1`, `50`, `200`, `1000`.
3. Apply `snapshot` messages as full local book resets.
4. Apply `delta` messages as absolute level updates; amount `0` deletes the level.
5. Ignore stale/out-of-order deltas whose update id is not newer than the local book.
6. Mark all books unsynced after WebSocket disconnect and block trading until fresh data arrives.
7. Return `null` from `getOrderBook(symbol)` when the book is unsynced or older than 10 seconds.
8. Send Bybit heartbeat ping every 20 seconds.
9. Reconnect with exponential backoff and resubscribe all symbols after disconnect.

## 15. MexcClient

Файл: `src/exchanges/mexc-client.ts`.

Type: direct signed MEXC Contract REST client.

Base URL:

- production: `https://contract.mexc.com`

Symbol conversion:

- internal `BTC/USDT:USDT`
- MEXC `BTC_USDT`

Key behavior:

- direct MEXC Contract HMAC-SHA256 signing with `ApiKey`, `Request-Time` and `Signature` headers;
- fetch server time through `/api/v1/contract/ping`;
- load USDT perpetual contracts from `/api/v1/contract/detail`;
- fetch 24h tickers from `/api/v1/contract/ticker`;
- fetch open positions from `/api/v1/private/position/open_positions`;
- ошибки private positions endpoint пробрасываются вызывающему коду, чтобы close/cleanup logic не трактовала неизвестное состояние позиции MEXC как flat;
- set isolated leverage through `/api/v1/private/position/change_leverage` for long and short sides;
- treat `setIsolatedMargin()` as a MEXC-specific precondition because isolated mode is sent as `openType: 1` on leverage and order requests;
- convert base coin amount to MEXC contract `vol` through `contractSize` and `volUnit`;
- use side `1` for open long, `3` for open short, `2` for close short and `4` for close long;
- submit market orders with `type: 5`, `openType: 1` and `externalOid`;
- reconcile transport/order-submit failures by querying `/api/v1/private/order/external/{symbol}/{externalOid}` before surfacing the error;
- poll final order details and deal details;
- count only USDT/USDC fees as quote-equivalent commission;
- convert filled contracts back to base quantity;
- reject zero-fill and partial-fill market orders so `Trader` cleanup can flatten real positions through `fetchPositions()`.

Important:

- `MEXC_API_KEY`/`MEXC_SECRET` are optional in config.
- If route uses `mexc` without credentials, real order operations will fail.
- MEXC futures testnet is not configured in this project. If `use_testnet=true`, MEXC private operations and the native MEXC provider fail closed instead of touching production endpoints as a testnet substitute.
- `Trader` closes positions through normalized `ExchangePosition.amount`. MEXC `contracts` stores native contract count, while `amount` stores base coin quantity.

### 15.1. MEXC native orderbook provider

Файл: `src/exchanges/ws/mexc-orderbook-provider.ts`.

Base URL:

- production: `wss://contract.mexc.com/edge`

Behavior:

1. Load MEXC contract metadata from `/api/v1/contract/detail` and require `contractSize` for subscribed symbols.
2. Subscribe to `sub.depth` with `compress: false` for incremental depth updates.
3. Fetch REST snapshots from `/api/v1/contract/depth/{symbol}` and support the current `{ success, code, data }` response wrapper.
4. Cache WebSocket updates while the REST snapshot is fetched.
5. Apply only updates that continue the local `version` by exactly `+1`.
6. Mark a symbol unsynced and resync it when a version gap or snapshot failure is detected.
7. Convert every orderbook level from MEXC contract volume to base coin amount before exposing snapshots to `Trader`.
8. Return `null` from `getOrderBook(symbol)` while the book is unsynced or older than 10 seconds.
9. Send MEXC `ping` heartbeat every 20 seconds and reconnect/resubscribe after disconnect.

## 16. GateClient

Файл: `src/exchanges/gate-client.ts`.

Type: direct signed Gate Futures REST client.

Base URLs:

- testnet: `https://fx-api-testnet.gateio.ws/api/v4`
- production: `https://fx-api.gateio.ws/api/v4`

Symbol conversion:

- internal `BTC/USDT:USDT`
- Gate `BTC_USDT`

Key behavior:

- direct Gate v4 HMAC-SHA512 signing;
- fetch tickers;
- fetch positions;
- ошибки private position endpoint пробрасываются вызывающему коду, чтобы close/cleanup logic не трактовала неизвестное состояние позиции Gate как flat;
- load contracts;
- set isolated leverage through positive `leverage` on `POST /futures/usdt/positions/{contract}/leverage`;
- treat `setIsolatedMargin()` as a Gate-specific precondition check because Gate's isolated mode is confirmed by positive leverage;
- convert base coin amount to Gate contract count via `quanto_multiplier`;
- use positive size for buy, negative for sell;
- submit IOC market-style orders with `price: "0"`;
- send `text` custom order ids with the required `t-` prefix;
- reconcile transport/order-submit failures by searching open and finished orders by `text` before surfacing the error;
- poll final order details;
- extract commission from `my_trades`;
- convert filled contracts back to base quantity.
- reject zero-fill and partial-fill market orders so `Trader` cleanup can flatten real positions through `fetchPositions()`.

### 16.1. Gate native orderbook provider

Файл: `src/exchanges/ws/gate-orderbook-provider.ts`.

Base URLs:

- testnet: `wss://ws-testnet.gate.com/v4/ws/futures/usdt`
- production: `wss://fx-ws.gateio.ws/v4/ws/usdt`

Behavior:

1. Load Gate contract metadata from `/futures/usdt/contracts` and require `quanto_multiplier` for subscribed symbols.
2. Connect with `X-Gate-Size-Decimal: 1` so pushed contract sizes are not rounded down by the legacy integer payload mode.
3. Subscribe to `futures.order_book_update` with `[contract, "100ms", level]`, where level is normalized to `20`, `50` or `100`.
4. Cache WebSocket updates while `/futures/usdt/order_book?with_id=true` snapshot is fetched.
5. Apply only updates that bridge the snapshot id and then require contiguous `U`/`u` sequence ranges.
6. Mark a symbol unsynced and resync it when a sequence gap or snapshot failure is detected.
7. Convert every orderbook level from Gate contract count to base coin amount before exposing snapshots to `Trader`.
8. Return `null` from `getOrderBook(symbol)` while the book is unsynced or older than 10 seconds.
9. Send `futures.ping` heartbeat every 20 seconds and reconnect/resubscribe after disconnect.

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

`DEPLOY_LINUX.md` содержит актуальный Russian deployment guide.

Key points from it:

- Use Linux VPS.
- Keep system time synchronized.
- Install Chrony.
- Use Node.js 22.x.
- Install `pnpm`.
- Use PM2 for process supervision.
- Build with `pnpm run build`.
- Run `dist/main.js` under PM2.
- Keep exchange credentials out of `.env`; Django sends them in runtime payload.
- Keep `ALLOW_PRODUCTION_TRADING=false` except for explicitly prepared production processes.
- Watch `/health` fields `runtime_state`, `risk_locked`, `risk_incidents` and `open_exposure`.

Critical deploy warning:

- Exchange APIs reject signed requests if server time drifts.
- Time sync must be monitored.
- Do not run multiple PM2 instances against one exchange account because distributed account lock is not implemented.

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

Performed on 2026-04-24:

```powershell
.\node_modules\.bin\tsc.CMD
.\node_modules\.bin\tsx.CMD --test tests/*.test.ts
.\node_modules\.bin\tsc.CMD --ignoreConfig --target es2022 --module Node16 --moduleResolution node16 --esModuleInterop --strict --skipLibCheck --rootDir . --outDir dist\test-run tests\math.test.ts tests\runtime-payload-validation.test.ts tests\trade-counter.test.ts tests\signal-engine.test.ts tests\orderbook-store.test.ts
node dist\test-run\tests\math.test.js
node dist\test-run\tests\runtime-payload-validation.test.js
node dist\test-run\tests\trade-counter.test.js
node dist\test-run\tests\signal-engine.test.js
node dist\test-run\tests\orderbook-store.test.js
rg "\bccxt\b|ccxtInstance|watchOrderBook" src/exchanges/bybit-client.ts src/exchanges/ws/bybit-orderbook-provider.ts
rg "\bccxt\b|ccxtInstance|watchOrderBook" src/exchanges/gate-client.ts src/exchanges/ws/gate-orderbook-provider.ts
rg "\bccxt\b|ccxtInstance|watchOrderBook|orderbooks" src package.json pnpm-lock.yaml
node -e "<public Gate REST/WS smoke without API keys or orders>"
node -e "<public MEXC REST smoke without API keys or orders>"
node -e "<public MEXC WebSocket/provider smoke without API keys or orders>"
```

Results:

- TypeScript build completed successfully through the local `tsc` binary.
- Unit tests passed through local `tsx --test tests/*.test.ts`: 16 tests, 16 passed.
- Unit tests for math utilities, runtime payload validation, `TradeCounter`, `SignalEngine` and `OrderBookStore` passed when compiled to `dist/test-run` and executed with `node`.
- Bybit REST and Bybit WebSocket files have no `ccxt`, `ccxtInstance` or `watchOrderBook` usage.
- Gate REST and Gate WebSocket files have no `ccxt`, `ccxtInstance` or `watchOrderBook` usage.
- Runtime source, `package.json` and `pnpm-lock.yaml` have no `ccxt`, `ccxtInstance`, `watchOrderBook` or legacy lowercase `orderbooks` usage.
- Gate production public REST snapshot `GET https://fx-api.gateio.ws/api/v4/futures/usdt/order_book?contract=BTC_USDT&interval=0&limit=20&with_id=true` returned an orderbook id with 20 bids and 20 asks.
- Gate testnet public WebSocket `wss://ws-testnet.gate.com/v4/ws/futures/usdt` accepted `futures.order_book_update` subscription for `BTC_USDT` and returned updates with `U`/`u` sequences.
- Gate testnet public REST endpoints `https://fx-api-testnet.gateio.ws/api/v4/futures/usdt/contracts` and `/tickers` returned HTTP 502 from this environment.
- MEXC production public REST endpoints returned HTTP 200 for `/api/v1/contract/ping`, `/api/v1/contract/detail?symbol=BTC_USDT`, `/api/v1/contract/ticker?symbol=BTC_USDT` and `/api/v1/contract/depth/BTC_USDT?limit=20`.
- MEXC REST `detail` loaded 754 USDT perpetual symbols in this environment; `BTC/USDT:USDT` market info normalized to `minQty=0.0001`, `stepSize=0.0001`, `pricePrecision=1`, `quantityPrecision=4`.
- MEXC production public WebSocket `wss://contract.mexc.com/edge` accepted `sub.depth` for `BTC_USDT` with `compress: false` and returned contiguous `push.depth` versions.
- Compiled `MexcOrderBookProvider` returned a normalized `BTC/USDT:USDT` book with 20 bids and 20 asks; the top BTC depth was exposed in base coin amount, not native contract volume.

Note:

- Global `pnpm` is not available in the current shell; use `pnpm build` in an environment where `pnpm` is installed.
- `tsx --test tests/*.test.ts` is blocked inside the default sandbox with `spawn EPERM`; the same command passed when allowed to run outside the sandbox.
- `fastify` is declared in `package.json`; local `node_modules` in the current shell does not include a package manager to install the new dependency.
- Bybit testnet/private smoke checks were not executed in this environment.
- Gate private and order smoke checks were not executed in this environment.
- MEXC private and order smoke checks were not executed in this environment.

## 21. Key source files

Core source files:

- `.env.example`
- `src/config.ts`
- `src/main.ts`
- `src/control-plane/server.ts`
- `src/control-plane/shutdown.ts`
- `src/classes/risk-lock.ts`
- `src/classes/TradeCounter.ts`
- `src/classes/trade-state.ts`
- `src/classes/Trader.ts`
- `src/services/account-reconciliation.ts`
- `src/services/api.ts`
- `src/services/close-sync-service.ts`
- `src/services/diagnostics.ts`
- `src/services/execution-journal.ts`
- `src/services/market-info.ts`
- `src/services/position-recovery.ts`
- `src/services/runtime-process-lock.ts`
- `src/services/runtime-payload-validation.ts`
- `src/services/shadow-recorder.ts`
- `src/services/signal-engine.ts`
- `src/types/index.ts`
- `src/utils/logger.ts`
- `src/utils/math.ts`
- `src/exchanges/exchange-client.ts`
- `src/exchanges/symbols.ts`
- `src/exchanges/binance-client.ts`
- `src/exchanges/bybit-client.ts`
- `src/exchanges/mexc-client.ts`
- `src/exchanges/gate-client.ts`
- `src/exchanges/ws/orderbook-store.ts`
- `src/exchanges/ws/binance-orderbook-provider.ts`
- `src/exchanges/ws/bybit-orderbook-provider.ts`
- `src/exchanges/ws/gate-orderbook-provider.ts`
- `src/exchanges/ws/mexc-orderbook-provider.ts`
- `src/exchanges/ws/orderbook-provider-factory.ts`
- `tests/binance-orderbook-provider.test.ts`
- `tests/account-reconciliation.test.ts`
- `tests/math.test.ts`
- `tests/orderbook-store.test.ts`
- `tests/risk-lock.test.ts`
- `tests/runtime-payload-validation.test.ts`
- `tests/signal-engine.test.ts`
- `tests/trade-counter.test.ts`
- `test_binance.ts`
- `test_gate.ts`

Project documentation:

- `DOCS.md`

## 22. Important risks and technical debt

### 22.1. Runtime can enable real trading

`use_testnet` is controlled by the Django runtime payload. Production mode is possible when Django sends `use_testnet=false`.

The trader process also requires `ALLOW_PRODUCTION_TRADING=true`, matching `TRADER_ENVIRONMENT`, an allowlisted selected-account fingerprint and configured live caps before accepting a production payload. Keep these variables disabled or empty for development/testnet processes and enable them only for an explicitly prepared production runtime.

### 22.2. Runtime payload contract alignment

Trader requires credentials only for exchanges selected in the runtime payload. Django must keep sending the selected exchange keys and optional risk-buffer fields with compatible names.

Recommended:

- keep Django serializers and frontend forms aligned with `RuntimeConfigPayload`;
- reject inactive or stale runtime configs before sending lifecycle commands.

### 22.2.1. Execution journal is local

`EXECUTION_JOURNAL_PATH` records open, cleanup and close intents/results before and after exchange calls. Startup fails when the journal has unresolved intents for the runtime, which reduces silent crash windows on the same host.

This journal is not a Django/DB execution ledger. It does not provide cross-host recovery, operator UI, durable close fill persistence in Django schema, or distributed state-machine transitions. Real production still needs a database-backed execution ledger if more than one host/process can affect the account.

### 22.3. Locking scope is host-local

`TRADER_PROCESS_LOCK_PATH` prevents two trader runtimes in the same host/deployment directory from running concurrently. It is not a distributed lock. Two servers, two deployment directories, manual bots or another runtime can still open trades on the same account and bypass the local `TradeCounter`.

Mitigation:

- DB lock;
- Redis lock;
- single PM2 instance plus a single deployment directory;
- exchange-account-level operating discipline.

### 22.4. Django service-token trust boundary

Trader sends `X-Service-Token` to Django real-trades endpoints and requires the same header on its control plane. The shared token must be rotated and kept out of logs.

### 22.5. Recovery identity remains incomplete

Recovered trades are validated by runtime id, selected exchange route, unique symbol and account-wide position side/amount. Distribution to `Trader` instances still uses `trade.coin`. If multiple strategies/accounts/routes use the same symbol in the same Django real Trade table without stronger identifiers, recovery can be wrong.

Better:

- add strategy id;
- add exchange route;
- add process/account id;
- add bot relation in Django real Trade.

### 22.6. Automated test coverage remains partial

The repository includes unit tests for math utilities, runtime payload validation, `TradeCounter`, `SignalEngine` and `OrderBookStore`. Exchange execution and full `Trader` state-machine flows still need mocked integration tests.

Recommended minimum:

- `Trader.executeOpen` with mocked clients;
- partial open rollback;
- close retry loop;
- recovery behavior.

### 22.7. Exchange-specific reduceOnly support

The strategy assumes close and rollback orders cannot flip exposure. Binance, Bybit and Gate native clients send exchange-specific reduce-only fields directly. MEXC native close orders use side `2`/`4` for close-short/close-long and send `reduceOnly` only when the account reports one-way position mode, because MEXC hedge mode rejects that flag. Confirm close-side behavior with a small account-level smoke test before relying on MEXC in production.

### 22.8. Market-order slippage

VWAP reduces false signals but cannot guarantee final fill. The code recalculates spread from actual fills, but entry decision can still be stale under fast markets.

### 22.9. Fee approximations

BNB fee conversion is approximate. Non-USDT fees on some exchanges are ignored or approximated.

### 22.10. Production process guard

`ALLOW_PRODUCTION_TRADING` is process-local and is backed by environment id, account fingerprint allowlist and hard caps. If a deployment accidentally configures all live variables on a development host, Django can start a production runtime with `use_testnet=false`.

Recommended:

- keep separate `.env` files per environment;
- restrict production control plane by private network/firewall;
- verify detailed `/health` with `X-Service-Token` and runtime payload before enabling live trading.

### 22.11. Bybit endpoint region restrictions

The native Bybit client uses the standard mainnet REST and WebSocket domains:

- `https://api.bybit.com`
- `wss://stream.bybit.com/v5/public/linear`

Bybit can reject API traffic from restricted regions or require regional domains for some account registrations. If health checks return HTTP 403 or regional access errors, configure and validate the correct Bybit domain before production trading.

### 22.12. Gate testnet REST availability

Gate public testnet WebSocket responds on `wss://ws-testnet.gate.com/v4/ws/futures/usdt`, but public testnet REST endpoints on `https://fx-api-testnet.gateio.ws/api/v4` returned HTTP 502 in the current environment. Gate testnet runtime startup depends on REST contracts/tickers/orderbook snapshots, so validate Gate testnet REST availability before using Gate with `use_testnet=true`.

### 22.13. MEXC futures testnet guard

MEXC Contract production public REST and WebSocket endpoints are available from this environment, but a separate futures testnet endpoint is not configured in the project. When `use_testnet=true`, MEXC private REST operations and the MEXC orderbook provider fail closed so the runtime does not accidentally treat production MEXC as a sandbox. Validate MEXC private permissions and order behavior with an explicit low-risk account-level smoke before enabling MEXC production routes.

## 23. Suggested stabilization plan

1. Add database-backed execution ledger/state machine in Django for open/close/cleanup intents and fills.
2. Add strategy/account/process identifiers to Django trades for safer recovery.
3. Add external DB/Redis lock/lease if more than one process or host can run.
4. Add mocked exchange tests for full `Trader` open/rollback/close flows.
5. Add structured logging and secret redaction policy.
6. Add persistent counters for WS errors, stale books, close retries and cleanup events.
7. Add max daily/session loss controls.
8. Add production monitoring for shadow-mode signals, funding-adjusted edge and realized slippage.

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

The service reads only infrastructure/operational variables from `.env`:

- `DJANGO_API_URL`
- `SERVICE_SHARED_TOKEN`
- `PORT`
- `SHADOW_SIGNAL_LOG_PATH`
- `EXECUTION_JOURNAL_PATH`
- `TRADER_PROCESS_LOCK_PATH`
- `PUBLIC_HEALTH_DETAILS`
- `FAIL_ON_UNRESOLVED_EXECUTION_JOURNAL`
- `POSITION_SIZE_TOLERANCE_PERCENT`
- `ALLOW_PRODUCTION_TRADING`
- `TRADER_ENVIRONMENT`
- `PRODUCTION_TRADING_ENVIRONMENT`
- `PRODUCTION_ACCOUNT_FINGERPRINTS`
- `MAX_PRODUCTION_TRADE_AMOUNT_USDT`
- `MAX_PRODUCTION_CONCURRENT_TRADES`
- `MAX_PRODUCTION_LEVERAGE`

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
   - if `runtime_config_id` is provided, it must match the active runtime;
   - return an error while exchange exposure, pending close sync or unmanaged cleanup remains.

`GET /health` without `X-Service-Token` exposes only public-safe `{ success: true, status: "ok" }` while `PUBLIC_HEALTH_DETAILS=false`. Detailed health exposes runtime risk state through `runtime_state`, `risk_locked`, `risk_incidents` and `open_exposure` only with `X-Service-Token` or `PUBLIC_HEALTH_DETAILS=true`.

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

Fastify validates the runtime payload before `RuntimeManager.startRuntime()` stores it. `RuntimeManager.startRuntime()` performs the following steps:

1. Store runtime payload in `config.ts`.
2. Reject production payloads with `use_testnet=false` unless `ALLOW_PRODUCTION_TRADING=true`, `TRADER_ENVIRONMENT` matches `PRODUCTION_TRADING_ENVIRONMENT`, selected account fingerprint is allowlisted and live caps are configured.
3. Acquire host-local `TRADER_PROCESS_LOCK_PATH`.
4. Reject startup if `EXECUTION_JOURNAL_PATH` contains unresolved execution intents for the runtime.
5. Create primary and secondary REST clients.
6. Validate selected account modes.
7. Measure approximate latency.
8. Load markets on both exchanges.
9. Build the intersection of USDT futures symbols.
10. Fetch open Django trades for the current `runtime_config_id`.
11. Validate recovered trades: `runtime_config`, exchange route, unique symbol and valid amount.
12. Fetch all open futures positions from both selected accounts and reconcile them with Django open trades.
13. Filter scannable symbols by minimum cross-exchange quote volume.
14. Add recovery symbols to the runtime universe.
15. Initialize `MarketInfoService`.
16. Merge and validate market constraints and funding snapshots.
17. Configure isolated margin and leverage on both exchanges, using in-process confirmed setup cache.
18. Create shared orderbook providers and subscribe final tradeable symbols.
19. Split symbols into chunks.
20. Create `RuntimeRiskLock` and `Trader` instances for chunks.
21. Restore open trades into matching traders.
22. Start all `Trader` workers.

If recovery of open trades from Django fails, any open trade cannot be assigned to a trader chunk, account-wide reconciliation sees unknown/missing/mismatched positions, or execution journal has unresolved intents, runtime startup is aborted.

### 24.5. Symbol selection logic

The runtime trades only symbols that pass all of the following:

1. Present on both exchanges as USDT perpetual/futures symbols.
2. Have `min(primaryQuoteVolume, secondaryQuoteVolume) >= 2_000_000`.
3. Fit within `top_liquid_pairs_count`.
4. Pass `MarketInfoService` validation:
   - merged `stepSize`
   - merged `minQty`
   - merged `minNotional`
5. Are not filtered by homonym detection:
   - if cross-exchange price deviation exceeds 40%, symbol is skipped.
6. Successfully confirm isolated margin and leverage setup on both exchanges.

Warnings from exchange setup are not treated as successful configuration.

Open trades from Django bypass liquidity selection for recovery, but symbols that are not in the scannable liquidity set have `canOpenNewTrades=false`.

### 24.6. Trader runtime state

Each `Trader` owns a chunk of symbols and keeps per-symbol mutable state:

- `baselineBuy`
- `baselineSell`
- `activeTrade`
- `openedAtMs`
- `busy`
- `cooldownUntil`
- `pendingCloseSync`
- `unmanagedExposure`
- `partialClose`
- `closeIntentId`
- `canOpenNewTrades`

Provider update callbacks schedule spread checks per symbol. `busy` acts as a local mutex to prevent duplicate open/close handling from concurrent book updates.

### 24.7. Price and size calculation

The strategy uses VWAP instead of top-of-book:

1. Read both orderbooks from normalized `OrderBookProvider` snapshots.
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
5. Skip entry if `canOpenNewTrades=false`, runtime is stopping, or runtime risk lock is active.
6. Before sending orders, verify that the symbol has no unexpected existing positions on either exchange.
7. Open when:
   - `currentBuySpread >= baselineBuy + openThreshold`, or
   - `currentSellSpread >= baselineSell + openThreshold`.
8. Require hard economic edge:
   - subtract fee, slippage, funding and latency buffers;
   - require `expected_net_edge >= min_open_net_edge_percent`.

Direction semantics:

- `buy`
  - long primary
  - short secondary
- `sell`
  - short primary
  - long secondary

`executeOpen()`:

1. Locks the symbol with `busy`.
2. In shadow mode, writes a JSONL signal and returns without orders.
3. Reserves a trade slot atomically.
4. Appends `open_intent` and `open_orders_submitting` events to `EXECUTION_JOURNAL_PATH`.
5. Sends both market orders concurrently.
6. On partial failure:
   - attempt reverse reduce-only rollback;
   - run full position cleanup;
   - release slot only when cleanup is confirmed;
   - apply cooldown.
7. On cleanup failure:
   - log the cleanup error as critical;
   - store `unmanagedExposure`;
   - keep any reserved trade slot reserved;
   - set runtime risk lock and block new entries globally;
   - retry cleanup until flat.
8. On success:
   - use actual fill prices or VWAP fallback;
   - sum fees;
   - recompute real open spread;
   - create Django trade;
   - append `open_django_synced` to the execution journal;
   - store `activeTrade` and `openedAtMs`.

### 24.9. Recovery behavior

At startup, open trades are loaded from Django for the current runtime before scanner chunks are finalized. Recovery symbols are included in the runtime universe even when they fail liquidity selection. If a recovery symbol is not part of the scannable set, `canOpenNewTrades=false` prevents new entries after that exposure is closed.

Open trades are validated before distribution: `runtime_config` must match the requested runtime, primary/secondary exchange route must match the payload, each symbol may have only one open trade, `amount` must be positive, and `opened_at` must parse to a finite timestamp. Open trades are distributed by `trade.coin` to the matching `Trader`. Startup fails if any open trade has no matching chunk.

Before scanner startup, both exchange clients fetch all open futures positions visible to the selected API keys. The runtime compares those positions with Django open trades by symbol, side and amount using `POSITION_SIZE_TOLERANCE_PERCENT`. Unknown, missing, side-mismatched or size-mismatched positions abort startup.

`restoreOpenTrades()`:

- restores local `activeTrade`;
- restores validated `openedAtMs`;
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
2. Append `close_started` to `EXECUTION_JOURNAL_PATH`.
3. Determine close side per exchange.
4. Получить реальные позиции с обеих бирж. Если любая биржа не может подтвердить позиции, close attempt завершается ошибкой и повторяется позже вместо записи flat-состояния в Django.
5. Risk-lock the runtime if actual position size differs from Django amount beyond `POSITION_SIZE_TOLERANCE_PERCENT`.
6. Close only legs that are still open.
7. Use reduce-only market orders.
8. Preserve successful per-leg close execution, fill size and commission in `partialClose` before retrying a failed opposite leg.
9. Append per-leg `close_leg_filled` events to the execution journal.
10. Use fallback prices if a leg is already flat or execution price is missing.
11. Compute:
   - close commission
   - total commission
   - real PnL, using actual per-leg close sizes when they differ from the Django trade amount
   - close spread
   - final status
12. Persist close into Django with retry loop.

If exchange close succeeded but Django close sync still failed after retries:

- keep `activeTrade` locally;
- keep the trade slot reserved;
- store close intent id and close payload in `pendingCloseSync`;
- append `close_sync_pending` to the execution journal;
- retry Django close sync until it succeeds.

Only after successful close persistence:

- clear `activeTrade`;
- clear `openedAtMs`;
- clear `pendingCloseSync`;
- clear `partialClose`;
- clear close intent id;
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

1. Each `Trader` enters stopping mode and blocks new entries.
2. Active trades are closed with emergency pricing.
3. If only Django close sync is pending, it is retried first.
4. Unmanaged exposure cleanup is retried.
5. `RuntimeManager` clears active runtime handle and closes providers only after exposure is flat/reconciled.
6. If exposure remains, runtime stays active as `stopping_with_open_exposure` or `risk_locked`.

If a `Trader` worker rejects unexpectedly:

- the crash is logged;
- controlled stop is triggered automatically;
- `/health` reports the active runtime state and risk incidents while stop/cleanup is pending.

### 24.12. Key operational nuances

1. Only one runtime can be active in a process.
2. Market constraints are preloaded at bootstrap and not recomputed during trading.
3. Orderbook providers are shared across all trader chunks.
4. Entry/profit checks require full visible depth; emergency exits prioritize flattening over exact pricing.
5. Cleanup after failed opens relies on real `fetchPositions`, not only local assumptions.
6. Close persistence in Django is treated as required state synchronization, not best-effort logging.
7. Runtime risk lock blocks all new entries when cleanup or reconciliation detects unmanaged exposure.
8. Startup performs account-wide position reconciliation before subscribing scanners.
9. Execution journal unresolved intents block restart until operator reconciliation.
10. Host-local process lock prevents duplicate runtime in the same deployment directory, but not across hosts.
11. Dust positions below `minQty` may be ignored by close logic.
12. `profitPercentage` is calculated against notional capital, not isolated margin after leverage.

# Arbitration WS Futures Trader - внутренняя документация

`arbitration-ws-futures-trader` - standalone TypeScript/Node.js сервис для low-latency арбитражной торговли между
Binance USD-M Futures и Bybit linear Futures. Сервис использует Fastify для control plane, WebSocket market data для
локальных orderbook-ов и WebSocket trade API для отправки open/close market orders.

## 1. Назначение

Сервис сокращает критический путь от обновления orderbook до отправки двух ног сделки:

```text
market data WS
  -> OrderBookStore
  -> symbol-local spread/PnL check
  -> local state/risk guard
  -> parallel trade WebSocket submit
  -> async Django/event persistence
```

На hot path не выполняются:

- Django/DB requests;
- REST-запросы к биржам;
- позиционная сверка перед profit-close;
- синхронная запись файлов перед отправкой ордеров;
- тяжелая диагностика.

REST используется только вне hot path: market metadata, volume/ticker bootstrap, leverage/margin setup и background
reconciliation.

## 2. Структура

```text
arbitration-ws-futures-trader/
├── package.json
├── tsconfig.json
├── .env.example
├── DOCS.md
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── control-plane/server.ts
│   ├── runtime/runtime-manager.ts
│   ├── exchanges/
│   │   ├── exchange-types.ts
│   │   ├── symbols.ts
│   │   ├── binance-usdm/
│   │   └── bybit-linear/
│   ├── market-data/
│   ├── strategy/
│   ├── execution/
│   ├── persistence/
│   ├── django-sync/
│   ├── recovery/
│   └── utils/
└── tests/
```

Основные классы:

- `RuntimeManager` - lifecycle runtime, bootstrap metadata, запуск WS clients, pause/resume/stop.
- `OrderBookStore` - in-memory top/depth snapshots по exchange/symbol.
- `ExecutionEngine` - hot-path spread/PnL evaluation, state guard, параллельная отправка open/close ордеров.
- `BinanceUsdmTradeWs` - Binance USD-M WS API `order.place`.
- `BybitLinearTradeWs` - Bybit V5 Trade WS `order.create`.
- `AsyncTradeWriter` - retry-очередь создания/закрытия Django `Trade`.
- `RuntimeErrorReporter` - throttled запись `TraderRuntimeConfigError`.
- `BackgroundReconciliation` - фоновая REST-сверка открытых позиций.

## 3. Control Plane

Fastify endpoints:

| Method | Path | Auth | Назначение |
|---|---|---|---|
| `GET` | `/health` | public | Public-safe health response. |
| `GET` | `/ready` | public | `200`, если runtime `running` или `paused`, иначе `503`. |
| `POST` | `/runtime/start` | `X-Service-Token` | Старт из полного runtime payload или из `runtime_config_id`. |
| `POST` | `/runtime/stop` | `X-Service-Token` | Остановка WS clients и background задач. |
| `POST` | `/runtime/pause` | `X-Service-Token` | Пауза новых торговых решений. |
| `POST` | `/runtime/resume` | `X-Service-Token` | Возврат к market-data-triggered execution. |
| `POST` | `/runtime/test-trade` | `X-Service-Token` | Изолированная XRPUSDT open/close сделка в текущей среде с latency metrics. |
| `GET` | `/runtime/state` | `X-Service-Token` | In-memory state symbols, locks, active count. |
| `GET` | `/runtime/latency` | `X-Service-Token` | Последние latency metrics. |

Для совместимости с текущими Django proxy/lifecycle вызовами сервис также поддерживает старый control-plane prefix:

| Method | Path | Назначение |
|---|---|---|
| `POST` | `/engine/trader/start` | Alias для запуска runtime из полного payload. |
| `POST` | `/engine/trader/sync` | Alias для перезапуска runtime из полного payload. |
| `POST` | `/engine/trader/stop` | Alias для остановки runtime. |
| `POST` | `/engine/trader/runtime/exchange-health` | Проверка private API доступности Binance/Bybit по ключам из payload. |
| `GET` | `/engine/trader/runtime/active-coins` | Активные symbols и количество открытых runtime trades. |
| `GET` | `/engine/trader/runtime/open-trades-pnl` | Snapshot открытых runtime trades с текущим PnL, если есть свежий orderbook. |
| `GET` | `/engine/trader/runtime/system-load` | CPU/RAM snapshot процесса и runtime state. |
| `GET` | `/engine/trader/runtime/server-info` | Hostname и non-internal IPv4 адреса торгового сервера. |

Lifecycle-команды в `RuntimeManager` выполняются последовательно. Если во время bootstrap приходит повторный `start`/`sync`
с тем же runtime payload, запрос присоединяется к уже идущему запуску и не создает второй bootstrap. Если runtime уже
работает с тем же payload, повторный `start`/`sync` считается успешным no-op. Payload сравнивается по
`runtime_config_id`, `owner_id`, `config` и `keys`; изменение любого из этих полей приводит к последовательному
stop/start после завершения текущей lifecycle-операции. `stop` во время bootstrap выставляет cancel-сигнал: старт
прерывается между шагами metadata/leverage/WS setup, частично созданные ресурсы закрываются, а статус возвращается в
`idle`. Если bootstrap падает после частичного создания WS-клиентов или background-задач, `RuntimeManager` закрывает
созданные ресурсы перед переводом статуса в `error`.

`POST /runtime/start` принимает текущий Django payload:

```json
{
  "runtime_config_id": 1,
  "owner_id": 1,
  "config": {
    "id": 1,
    "name": "runtime",
    "primary_exchange": "binance",
    "secondary_exchange": "bybit",
    "use_testnet": true,
    "trade_amount_usdt": "50",
    "leverage": 10,
    "max_concurrent_trades": 3,
    "top_liquid_pairs_count": 100,
    "max_trade_duration_minutes": 60,
    "max_leg_drawdown_percent": "80",
    "open_threshold": "1",
    "close_threshold": "0.2",
    "orderbook_limit": 20,
    "chunk_size": 10,
    "is_active": true
  },
  "keys": {
    "binance_api_key": "...",
    "binance_secret": "...",
    "bybit_api_key": "...",
    "bybit_secret": "..."
  }
}
```

Если body содержит только `runtime_config_id`, сервис читает активный payload из Django:

```text
GET /api/bots/runtime-configs/{id}/active-payload/
```

`POST /runtime/test-trade` принимает такой же runtime payload и optional объект:

```json
{
  "runtime_config_id": 1,
  "owner_id": 1,
  "config": { "...": "..." },
  "keys": { "...": "..." },
  "test_trade": {
    "symbol": "XRPUSDT",
    "amount_usdt": 15
  }
}
```

Test trade выполняется только для `XRPUSDT` и только когда основной runtime не запущен. Сервис использует среду из
runtime payload: при `use_testnet=true` отправляет ордера в testnet, при `use_testnet=false` отправляет live market
orders. Сервис открывает направление `buy` (long primary / short secondary), ждет `TEST_TRADE_CLOSE_DELAY_MS`, затем
закрывает обе legs reduce-only. `Trade` в Django для этой диагностики не создается.
Размер диагностической сделки берется из `test_trade.amount_usdt` или `TEST_TRADE_AMOUNT_USDT` и ограничивается
`TEST_TRADE_MAX_NOTIONAL_USDT`. Если заданный размер ниже биржевых минимумов по `minQty`/`minNotional`, сервис
автоматически поднимает quantity до минимально допустимого размера; если этот минимум выше
`TEST_TRADE_MAX_NOTIONAL_USDT`, endpoint возвращает ошибку с требуемым размером.

Response содержит общие метрики и метрики по каждой бирже:

```json
{
  "success": true,
  "symbol": "XRP/USDT:USDT",
  "exchange_symbol": "XRPUSDT",
  "amount_usdt": 15,
  "quantity": 25,
  "metrics": {
    "detection_to_open_finished_ms": 42,
    "close_submit_to_close_finished_ms": 39,
    "total_ms": 331,
    "binance": {
      "open": { "submit_to_ack_ms": 20, "submit_to_fill_seen_ms": 20 },
      "close": { "submit_to_ack_ms": 19, "submit_to_fill_seen_ms": 19 },
      "exchange_total_ms": 320
    },
    "bybit": {
      "open": { "submit_to_ack_ms": 38, "submit_to_fill_seen_ms": null },
      "close": { "submit_to_ack_ms": 36, "submit_to_fill_seen_ms": null },
      "exchange_total_ms": 329
    }
  }
}
```

## 4. Exchange Behavior

Поддерживаются только:

- `binance` - Binance USD-M Futures, USDT perpetual.
- `bybit` - Bybit V5 linear, приоритет USDT-settled instruments.

Open/close ордера отправляются только через trade WebSocket:

- Binance: `wss://ws-fapi.binance.com/ws-fapi/v1`, method `order.place`.
- Bybit: `wss://stream.bybit.com/v5/trade`, op `order.create`.

Close использует explicit quantity и `reduceOnly=true`. Binance close не использует `closePosition=true`.
Bybit `switch-isolated` считается optional для unified accounts: если Bybit отвечает `unified account is forbidden`,
сервис пропускает переключение margin mode и продолжает leverage/order flow.
Leverage/margin bootstrap выполняется с паузой между symbols и retry/backoff на биржевой rate limit. Если часть symbols
не удалось подготовить после retries, runtime продолжает старт при `LEVERAGE_SETUP_STRICT=false` и пишет warning в log.

Market data:

- Binance partial depth stream через futures public WS.
- Bybit `orderbook.{depth}.{symbol}` через linear public WS.
- Обновление одного symbol триггерит проверку только этого symbol.

Symbol selection:

- Список symbols строится при старте runtime из общих Binance USD-M / Bybit linear USDT perpetual instruments.
- Основной score отбора - абсолютное изменение цены за 24 часа, нормализованное в проценты.
- Для общего score используется меньший модуль 24h change между Binance и Bybit, чтобы symbol не попадал в выборку
  из-за одиночного выброса только на одной бирже.
- При одинаковом 24h change используется tie-breaker по меньшему 24h quote volume между двумя биржами.
- `top_liquid_pairs_count` задает количество symbols, которые подписываются на market-data WS и участвуют в торговле.

## 5. State Model

Минимальный state на symbol:

- `idle`;
- `opening`;
- `open`;
- `closing`;
- `close_pending_persistence`;
- `error_exposure`;
- `paused`.

State предотвращает double-open и double-close. После успешного exchange close symbol находится в
`close_pending_persistence` до успешного Django close sync; callback `AsyncTradeWriter` возвращает symbol в `idle`, если
у него нет нового active trade и runtime не находится в pause. Потеря trade WS вызывает auto-pause через ready-change
callback; `RuntimeManager` переподключает trade WS с backoff и возвращает runtime в `running`, когда оба trade clients
готовы и execution state не находится в risk lock. Неизвестный результат submit одной из ног переводит runtime в
risk lock/error exposure и пишет `TraderRuntimeConfigError`.

Если open submit завершился частично, `ExecutionEngine` отправляет reduce-only rollback для каждой подтвержденной ноги
по фактическому `filledQty`/quantity из WS ACK. Успешный rollback не создает Django open trade, пишет
`open_rollback_submitted` и `open_failed` в event/recovery logs и оставляет runtime в risk lock до ручной сверки биржевых
позиций. Если rollback невозможен или падает, runtime также остается в risk lock, а reconciliation/error logs являются
источником для ручного закрытия остаточной позиции.

Open trade закрывается по двум локальным условиям:

- `profit`: текущий PnL достиг `close_threshold`;
- `timeout`: время с `openedAt` достигло `max_trade_duration_minutes`.

`profit` close требует свежий orderbook для расчета текущего PnL. `timeout` close не зависит от свежего orderbook:
если стакан недоступен, service все равно отправляет reduce-only close по сохраненному active trade, а для локальной
записи close использует emergency fallback от open prices там, где exchange WS ACK не возвращает fill price.

## 6. Django Sync

Сервис использует существующие Django endpoints:

- `GET /api/bots/runtime-configs/{id}/active-payload/`;
- `POST /api/bots/real-trades/`;
- `PATCH /api/bots/real-trades/{id}/`;
- `POST /api/bots/runtime-config-errors/`.

`Trade` создается после успешного open submit с:

- `runtime_config`;
- `coin`;
- `primary_exchange` / `secondary_exchange` в формате Django choices (`binance_futures`, `bybit_futures`);
- `order_type`;
- `amount`;
- `leverage`;
- open prices, open order IDs, spread и commission.

`Trade` обновляется после close submit с:

- close prices;
- close order IDs;
- close spread/commission;
- `profit_usdt`;
- `profit_percentage`;
- `status`;
- `close_reason`;
- `closed_at`.

Если close произошел до успешного open sync, `AsyncTradeWriter` сначала создает open-запись, затем применяет close update
к той же записи. Django outage не блокирует in-memory close logic: очередь продолжает retry.

## 7. Timing Logs

Сервис пишет timing logs через асинхронный `AsyncEventWriter`. Запись не выполняется перед отправкой ордеров и не
ожидается в open/close hot path: `ExecutionEngine` только добавляет объект события в in-memory очередь после завершения
параллельного WS submit двух legs.

Событие открытия:

```json
{
  "type": "trade_timing",
  "phase": "open",
  "localTradeId": "...",
  "runtimeConfigId": 1,
  "symbol": "XRP/USDT:USDT",
  "direction": "buy",
  "signal_detected_at": 1711000000000,
  "signal_detected_iso": "2024-03-21T10:00:00.000Z",
  "actual_opened_at": 1711000000042,
  "actual_opened_iso": "2024-03-21T10:00:00.042Z",
  "detection_to_actual_open_ms": 42,
  "binance_ack_at": 1711000000038,
  "bybit_ack_at": 1711000000042,
  "binance_fill_seen_at": 1711000000038,
  "bybit_fill_seen_at": null
}
```

Событие закрытия:

```json
{
  "type": "trade_timing",
  "phase": "close",
  "localTradeId": "...",
  "runtimeConfigId": 1,
  "symbol": "XRP/USDT:USDT",
  "direction": "buy",
  "close_reason": "profit",
  "close_signal_detected_at": 1711000100000,
  "close_signal_detected_iso": "2024-03-21T10:01:40.000Z",
  "actual_closed_at": 1711000100041,
  "actual_closed_iso": "2024-03-21T10:01:40.041Z",
  "signal_to_actual_close_ms": 41,
  "binance_ack_at": 1711000100036,
  "bybit_ack_at": 1711000100041,
  "binance_fill_seen_at": 1711000100036,
  "bybit_fill_seen_at": null
}
```

`actual_opened_at` и `actual_closed_at` считаются как максимальное время готовности двух legs: `filledAt`, если exchange
client его знает, иначе `acknowledgedAt`. Для Bybit trade WS ACK означает принятие заявки; окончательные fills требуют
private execution stream или reconciliation.

## 8. Конфигурация

`.env.example` содержит:

- `PORT`;
- `SERVICE_SHARED_TOKEN`;
- `DJANGO_API_URL`;
- `BINANCE_API_KEY`;
- `BINANCE_API_SECRET`;
- `BYBIT_API_KEY`;
- `BYBIT_API_SECRET`;
- `USE_TESTNET`;
- `TRADE_AMOUNT_USDT`;
- `MAX_CONCURRENT_TRADES`;
- `MAX_TRADE_NOTIONAL_USDT`;
- `OPEN_THRESHOLD`;
- `CLOSE_THRESHOLD`;
- `ORDERBOOK_LIMIT`;
- `ORDERBOOK_MAX_AGE_MS`;
- `ORDERBOOK_MAX_SKEW_MS`;
- `ENABLE_ASYNC_PERSISTENCE`;
- `ENABLE_BACKGROUND_RECONCILIATION`;
- `ASYNC_EVENT_LOG_PATH`;
- `RECOVERY_MARKER_PATH`;
- `PERSISTENCE_RETRY_DELAY_MS`;
- `ERROR_REPORT_THROTTLE_MS`;
- `LEVERAGE_SETUP_DELAY_MS`;
- `LEVERAGE_SETUP_RETRY_DELAY_MS`;
- `LEVERAGE_SETUP_MAX_RETRIES`;
- `LEVERAGE_SETUP_STRICT`;
- `BYBIT_RECV_WINDOW_MS`;
- `TEST_TRADE_AMOUNT_USDT`;
- `TEST_TRADE_MAX_NOTIONAL_USDT`;
- `TEST_TRADE_CLOSE_DELAY_MS`.

Numeric env values can use `_` separators, for example `ORDERBOOK_MAX_AGE_MS=10_000`.

Bybit private REST для bootstrap/reconciliation подписывает запросы с offset от публичного `/v5/market/time`; offset
кэшируется на короткий срок. `BYBIT_RECV_WINDOW_MS` задает окно подписи для Bybit private REST и trade WebSocket
`order.create`, чтобы временный clock skew сервера не ломал reconciliation и отправку ордеров.

Секреты не логируются. `RuntimeErrorReporter` редактирует фрагменты `apiKey`, `secret`, `token` и `signature`.

## 9. Команды

```bash
cd arbitration-ws-futures-trader
pnpm install
pnpm build
pnpm test
pnpm start
```

В текущей локальной среде shell может не видеть `pnpm`; можно запускать локальные binaries после установки зависимостей.

## 10. Проверки

Тесты покрывают:

- spread/PnL/qty rounding;
- state transitions и `TradeCounter`;
- параллельный submit двух legs до persistence enqueue;
- reduce-only rollback подтвержденной open leg при падении второй leg;
- reduce-only optimistic profit/timeout close без position reader;
- timeout close при недоступном свежем orderbook;
- timing logs для времени обнаружения, времени фактического открытия и времени фактического закрытия;
- порядок `AsyncTradeWriter`: open создается перед close, если close queued first;
- Binance WS signing;
- redaction runtime errors.

## 11. Риски и ограничения

- Binance `order.place` с `newOrderRespType=RESULT` дает fill-like result для market order, но commission может быть
  уточнена только через user data/reconciliation. В текущем сервисе commission fallback равен `0`, а background
  reconciliation должен использоваться для расследования расхождений.
- Bybit trade WS ACK означает принятие заявки, а окончательные fills приходят через private execution stream. Текущий
  hot path сохраняет ACK order ID и использует fallback VWAP/price для немедленного локального состояния; расширенная
  fill-ledger синхронизация требует отдельного private execution stream или Django-модели для raw fills.
- Bybit private REST и trade WS требуют timestamp в допустимом окне. Сервис использует server-time offset для private
  REST и расширяемый `BYBIT_RECV_WINDOW_MS`, но системные часы торгового сервера должны синхронизироваться через NTP.
- Частичный open submit может оставить биржевую позицию, если подтвержденная нога не закрылась rollback-ордером.
  Runtime переводится в risk lock, а оператор должен проверить реальные Binance/Bybit позиции перед `resume`/`sync`.
- Асинхронная persistence имеет crash window: процесс может упасть между exchange submit и flush локального event/recovery
  marker. Risk documented explicitly; mitigation - background reconciliation by runtime symbols and manual Django error
  review.
- `close_pending_persistence` блокирует новый open по symbol до успешного Django close sync. Если Django sync не
  восстанавливается, остальные symbols могут продолжать торговлю в рамках `max_concurrent_trades`, но заблокированный
  symbol требует восстановления persistence или ручной сверки.
- `RuntimeConfigClient.reportLifecycleStatus` является no-op, потому что текущий Django `TraderRuntimeConfigViewSet`
  не предоставляет service-token write endpoint для статуса runtime.

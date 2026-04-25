# Отчет: realtime signal execution в `arbitration-trader`

## Область работ

Изменения выполнены локально в runtime path `arbitration-trader`:

- `src/classes/Trader.ts`
- `src/classes/RuntimeManager.ts`
- `src/config.ts`
- `src/main.ts`
- `src/services/api.ts`
- `src/exchanges/bybit-client.ts`
- `.env.example`
- `tests/trader-realtime-scheduler.test.ts`
- `tests/runtime-manager-sync.test.ts`
- `tests/bybit-client.test.ts`
- `DOCS.md`
- `WORKFLOW.md`

Дополнительно затронуты Django service-request defaults:

- `arbitration-art-django/arbitration_art_django/settings/base.py`
- `arbitration-art-django/apps/bots/api/views.py`
- `arbitration-art-django/apps/bots/permissions.py`
- `arbitration-art-django/.env.example`
- `arbitration-art-django/DOCS.md`

Торговые формулы spread/PnL/drawdown, recovery, cleanup, reduce-only close и Django close sync не переписывались. Exchange-client изменение ограничено Bybit Unified Account обработкой `setIsolatedMargin()` error `100028`.

## Текущий critical path до правок

### Open

1. `OrderBookProvider.onUpdate(symbol)`.
2. `Trader.scheduleCheck(symbol)` через `queueMicrotask`.
3. `Trader.checkSpreads()` читает обе книги, считает размер, VWAP и entry signal.
4. При сигнале `executeOpen()`:
   - резервирует слот `TradeCounter`;
   - пишет `open_intent`;
   - проверяет реальные позиции через `fetchPositions`;
   - пишет `open_orders_submitting`;
   - отправляет оба market order через `Promise.allSettled`;
   - синхронизирует результат с Django и execution journal.

Blocking-операции перед отправкой ордеров:

- запись `open_intent` в execution journal;
- `fetchPositions` на обеих биржах как pre-open safety check;
- запись `open_orders_submitting` в execution journal.

Эти операции оставлены в critical path, потому что они защищают от duplicate/manual exposure и небезопасного восстановления после сбоя.

### Close

1. `OrderBookProvider.onUpdate(symbol)`.
2. `Trader.checkSpreads()` при наличии `activeTrade` считает strict/emergency prices.
3. `checkExit()` проверяет liquidation/drawdown и profit-close.
4. При сигнале `executeClose()`:
   - пишет `close_started`;
   - подтверждает фактические позиции на обеих биржах;
   - отправляет reduce-only close orders только по открытым ногам;
   - сохраняет partial-close state;
   - считает PnL;
   - синхронизирует close с Django.

Blocking-операции перед close orders:

- запись `close_started`;
- подтверждение фактических позиций через `fetchConfirmedPosition`.

Они оставлены из-за idempotency, partial-close safety и защиты от position mismatch.

## Что изменено

### Event-driven coalescing без потери последнего update

`Trader.scheduleCheck()` хранит последний local timestamp market event по symbol. Если новая книга приходит во время активной проверки, runtime ставит один флаг rerun. После завершения текущего decision path symbol переоценивается по последнему snapshot.

Эффект:

- entry/profit/liquidation signal не ждут interval tick;
- update, пришедший во время активного path, не теряется;
- по одному symbol не растет неограниченная очередь задач.

### Freshness/skew gate для пары orderbook snapshot

Перед расчетом VWAP и сигналов `Trader.getPrices()` проверяет:

- возраст primary и secondary snapshot: `ORDERBOOK_PAIR_MAX_AGE_MS`, default `2000`;
- skew между local timestamps: `ORDERBOOK_PAIR_MAX_SKEW_MS`, default `1000`.

Если пара книг stale/skewed, entry/profit/liquidation signal не исполняется на этих данных.

### Latency metrics

В runtime logs добавлены структурированные записи `latency_metrics`:

- `open_signal`
  - `socket_update_to_check_start_ms`
  - `check_start_to_signal_detected_ms`
  - `signal_detected_to_order_submit_start_ms`
  - `order_submit_start_to_exchange_ack_ms`
- `close_signal`
  - `socket_update_to_check_start_ms`
  - `check_start_to_signal_detected_ms`
  - `close_signal_detected_to_close_submit_start_ms`
  - `order_submit_start_to_exchange_ack_ms`
- `close_sync`
  - `full_close_sync_duration_ms`
  - `django_synced`

Метрики пишутся только при фактическом open/close signal path, поэтому они не должны зашумлять обычный поток book updates.

### Runtime lifecycle idempotency

`RuntimeManager` считает повторный `start` или `sync` с тем же payload для уже запущенного runtime идемпотентным no-op. Это защищает freshly bootstrapped runtime от повторных Django retry/timeout запросов: текущие traders не останавливаются, если конфигурация фактически не изменилась. Если payload отличается, `sync` выполняет обычный graceful restart.

В Django default `SERVICE_REQUEST_TIMEOUT_SECONDS` увеличен до `90`, чтобы lifecycle-запрос не таймаутился во время тяжелого bootstrap `arbitration-trader`: загрузка рынков, сверка позиций, подготовка leverage/margin и WebSocket subscriptions.

### Runtime autostart

Если в `.env` задан `TRADER_INSTANCE_ID`, `arbitration-trader` при запуске control plane запрашивает у Django `GET /api/bots/runtime-configs/{TRADER_INSTANCE_ID}/active-payload/` с `X-Service-Token`. Значение `TRADER_INSTANCE_ID` - это `TraderRuntimeConfig.id` в базе Django. Если конфиг активен и не архивирован, Django возвращает полный runtime payload, и trader запускает screening через `RuntimeManager.start(payload)`. Если конфиг неактивен, trader остается idle и продолжает принимать lifecycle-команды.

### Bybit Unified Account

Bybit `retCode=100028` на `setIsolatedMargin()` считается нефатальным для Unified Account. Клиент логирует warning и продолжает `setLeverage()`, не исключая символ из tradeable universe.

## Новый critical path

### Open

1. Socket update обновляет локальный orderbook store.
2. `onUpdate` вызывает `scheduleCheck(symbol, Date.now())`.
3. Если symbol свободен, check стартует в microtask; если занят, ставится один rerun flag.
4. `checkSpreads()` валидирует свежесть пары snapshot, считает VWAP/spread/entry edge.
5. При сигнале фиксируется `signalDetectedAtMs`.
6. `executeOpen()` выполняет неизмененные safety steps и отправляет оба market order concurrent.
7. После ack логируется latency profile.

### Close

1. Socket update вызывает check по symbol.
2. `checkSpreads()` валидирует свежесть strict/emergency snapshot pair.
3. `checkExit()` немедленно проверяет liquidation/drawdown, затем profit-close.
4. При close signal фиксируется `signalDetectedAtMs`.
5. `executeClose()` выполняет safety confirmation и отправляет reduce-only close orders.
6. После ack и Django sync логируется latency profile.

Timeout-close остается watchdog flow раз в 10 секунд.

## Сохраненные safety guarantees

- Per-symbol serialization сохранена через `runningChecks`, `scheduledChecks`, `rerunRequested` и `state.busy`.
- Duplicate open/close по одному symbol не запускается параллельно.
- Pre-open `fetchPositions` сохранен.
- Close `fetchConfirmedPosition` и size mismatch risk lock сохранены.
- `executionJournal` продолжает блокировать небезопасные restart-состояния.
- `pendingCloseSync`, `partialClose`, unmanaged exposure cleanup и reconciliation flow не упрощались.

## Риски и ограничения

- Pre-open и pre-close REST-проверки остаются основным latency cost. Они намеренно не убраны, потому что без замены на надежный локальный position cache это ухудшит безопасность real trading.
- Значения `ORDERBOOK_PAIR_MAX_AGE_MS` и `ORDERBOOK_PAIR_MAX_SKEW_MS` могут потребовать подстройки под конкретную пару бирж и качество WebSocket-соединения.
- Метрики логируются в процессный stdout/stderr через текущий logger; отдельного metrics backend не добавлялось.

## Проверки

Выполнено:

- `.\node_modules\.bin\tsc.CMD` - успешно.
- `.\node_modules\.bin\tsx.CMD --test tests\*.test.ts` - успешно, 27/27 tests passed.

Примечание по окружению: `pnpm` в текущей PowerShell-сессии не найден. Первый запуск тестов внутри sandbox упал с `spawn EPERM`, поэтому тестовый запуск был повторен вне sandbox через локальный `tsx.CMD`.

Команды для повторной проверки:

```bash
cd arbitration-trader
pnpm test
pnpm build
```

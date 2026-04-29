# Задача: low-latency Fastify trader для Binance USD-M и Bybit Futures

## Цель

Создать новое standalone-приложение на Node.js, TypeScript и Fastify на базе идей из `arbitration-trader`, но с максимально коротким критическим путем от обнаружения арбитражного сигнала до отправки ордеров.

Главный приоритет: максимально быстро открыть и закрыть сделку по условиям стратегии. Запись в базу, расширенная сверка, журналирование, восстановление и диагностические проверки должны выполняться после отправки торговых команд или в фоновых потоках, если они не нужны для немедленного решения.

## Рабочее название

`arbitration-ws-futures-trader`

## Область торговли

Оставить только две биржи:

- Binance Futures USD-M (`USDM`, `linear`, USDT perpetual).
- Bybit Futures (`linear`, USDT/USDC perpetual по фактической поддержке, приоритет USDT linear).

Не переносить поддержку:

- MEXC.
- Gate.
- Spot.
- COIN-M / inverse, если это не потребуется отдельной задачей.
- Любые exchange-адаптеры, которые не участвуют в паре Binance USD-M <-> Bybit Futures.

## Жесткое требование по исполнению

Открытие и закрытие сделок выполняются только через WebSocket trade API:

- Binance USD-M Futures: WebSocket API `order.place` через `wss://ws-fapi.binance.com/ws-fapi/v1`.
- Bybit V5 Trade WebSocket: `order.create` через `wss://stream.bybit.com/v5/trade`.

REST API нельзя использовать для отправки open/close ордеров.

REST допускается только вне hot path:

- загрузка market metadata;
- получение лимитов инструмента;
- первичная настройка leverage/margin, если биржа не дает эквивалентный быстрый WS API;
- холодный bootstrap;
- фоновая reconciliation;
- аварийная диагностика;
- sync с Django/БД.

## Обязательная синхронизация с Django

Django остается обязательной control-plane и persistence-системой. Low-latency исполнение означает только то, что запись в Django не стоит перед WebSocket submit ордеров. После submit, ACK и fill-событий данные должны быть надежно досинхронизированы с Django.

Нужно поддержать полную интеграцию с текущими Django-моделями:

- `TraderRuntimeConfig` - источник runtime-конфигурации, lifecycle-состояния и owner binding.
- `Trade` - основная запись реальной сделки, включая open/close order IDs, цены, комиссии, PnL, статус и причину закрытия.
- `TraderRuntimeConfigError` - запись ошибок runtime, sync, validation, exchange/trade WS и recovery.

Фактические ордера должны попадать в Django через `Trade`:

- `primary_open_order_id`;
- `secondary_open_order_id`;
- `primary_close_order_id`;
- `secondary_close_order_id`;
- фактические open/close prices;
- open/close commission;
- `status`;
- `close_reason`;
- `profit_usdt`;
- `profit_percentage`;
- `opened_at` / `closed_at` по контракту Django.

Если текущей модели `Trade` недостаточно для хранения расширенного order ledger, fills или raw exchange payloads, это должно быть оформлено отдельным изменением Django-модели и миграцией. Минимальный обязательный контракт нового сервиса - корректно и полностью заполнять существующие поля `Trade`.

## Ключевой принцип hot path

Hot path должен быть минимальным:

```text
market data update
  -> in-memory orderbook update
  -> spread / PnL condition
  -> minimal local guard
  -> parallel WebSocket order submit
  -> exchange ACK / execution stream handling
  -> async persistence and reconciliation
```

На hot path запрещено:

- ходить в базу;
- ждать Django API;
- делать REST-запросы к биржам;
- заново грузить market metadata;
- проверять позиции перед profit-close, если локальное состояние сделки достаточно для reduce-only close;
- писать синхронные файлы перед отправкой ордеров;
- выполнять тяжелую диагностику;
- делать повторные полные проверки, которые можно заменить заранее подготовленными in-memory данными.

Минимальные проверки на hot path допустимы только если без них можно открыть дубликат, отправить неверный side/qty или нарушить локальный risk lock.

## Архитектура приложения

Приложение должно быть новым сервисом, а не массовым refactor текущего `arbitration-trader`.

Предлагаемая структура:

```text
arbitration-ws-futures-trader/
├── package.json
├── tsconfig.json
├── .env.example
├── DOCS.md
├── src/
│   ├── main.ts
│   ├── config.ts
│   ├── control-plane/
│   │   └── server.ts
│   ├── exchanges/
│   │   ├── exchange-types.ts
│   │   ├── binance-usdm/
│   │   │   ├── binance-usdm-market-ws.ts
│   │   │   ├── binance-usdm-trade-ws.ts
│   │   │   └── binance-usdm-metadata.ts
│   │   └── bybit-linear/
│   │       ├── bybit-linear-market-ws.ts
│   │       ├── bybit-linear-trade-ws.ts
│   │       └── bybit-linear-metadata.ts
│   ├── market-data/
│   │   ├── orderbook-store.ts
│   │   └── symbol-router.ts
│   ├── strategy/
│   │   ├── spread-engine.ts
│   │   ├── pnl-engine.ts
│   │   └── signal-state.ts
│   ├── execution/
│   │   ├── execution-engine.ts
│   │   ├── order-intent.ts
│   │   ├── trade-state.ts
│   │   └── latency-metrics.ts
│   ├── persistence/
│   │   ├── async-trade-writer.ts
│   │   └── async-event-writer.ts
│   ├── django-sync/
│   │   ├── runtime-config-client.ts
│   │   ├── trade-sync-service.ts
│   │   └── runtime-error-reporter.ts
│   └── recovery/
│       └── background-reconciliation.ts
└── tests/
```

## Что можно взять из `arbitration-trader`

Перенести или адаптировать:

- расчет spread и PnL;
- нормализацию символов;
- округление qty по `stepSize`;
- учет `minQty` / `minNotional`;
- модель `activeTrade`;
- общую идею `TradeCounter`;
- обработку двух направлений:
  - `buy`: long Binance / short Bybit или long primary / short secondary;
  - `sell`: short Binance / long Bybit или short primary / long secondary;
- lifecycle control plane на Fastify;
- фоновые recovery/reconciliation идеи.

Не переносить в hot path:

- синхронный execution journal перед ордерами;
- Django write перед ордерами;
- позиционную сверку перед каждым profit-close;
- универсальные multi-exchange abstractions для MEXC/Gate;
- сложные defensive checks, которые задерживают отправку open/close ордеров.

## WebSocket trade clients

Для каждой биржи нужен постоянный заранее поднятый trading WebSocket:

- соединение создается на старте runtime;
- auth выполняется до начала сканирования;
- соединение держится warm;
- ping/pong и reconnect не должны блокировать market data loop;
- при reconnect торговля ставится на pause до восстановления trade WS;
- order request payload должен собираться максимально быстро;
- подпись и timestamp готовятся без лишних аллокаций, насколько это разумно в Node.js;
- отправка двух ног сделки выполняется параллельно.

Binance:

- использовать `order.place`;
- open: market order в нужную сторону;
- close: reduce-only market order в противоположную сторону;
- для close не использовать `closePosition=true` как основной путь, потому что для Binance USD-M он предназначен для conditional `STOP_MARKET` / `TAKE_PROFIT_MARKET`, а не обычного market-close.

Bybit:

- использовать `order.create`;
- open: market order в нужную сторону;
- close: reduce-only market order в противоположную сторону;
- для full close допустимо использовать биржевой механизм `qty="0"` с `reduceOnly=true` / `closeOnTrigger=true` только если это подтверждено тестами для выбранной категории и не увеличивает задержку.

## Market data

Market data также должен работать через WebSocket.

Требования:

- локальный in-memory orderbook на каждую биржу и символ;
- обновления должны сразу триггерить проверку только затронутого symbol;
- без глобального polling loop для входов/выходов;
- использовать top-of-book или ограниченный VWAP в зависимости от выбранного latency/accuracy tradeoff;
- глубина книги должна быть достаточной для расчета qty, но не должна тормозить hot path;
- stale/skew checks должны быть простыми in-memory сравнениями timestamp.

## Execution flow: open

1. Orderbook update обновляет локальное состояние.
2. `spread-engine` проверяет entry condition.
3. Если сигнал есть, локально атомарно резервируется symbol/trade slot.
4. Немедленно формируются две ноги сделки.
5. Две WebSocket trade-команды отправляются параллельно.
6. ACK/fill события связываются с локальным `orderIntentId`.
7. После отправки ордеров запускаются фоновые задачи:
   - запись события открытия;
   - создание `Trade` в Django;
   - сверка фактических fills;
   - latency metrics;
   - recovery marker.

DB/Django failure после успешного submit не должен блокировать уже открытую позицию и не должен мешать close logic. Локальное in-memory состояние является основным источником правды до завершения persistence, но sync с Django обязателен и должен ретраиться до успешного создания `Trade` или явного перехода runtime в recovery/error state.

## Execution flow: close

1. Orderbook update обновляет локальное состояние.
2. `pnl-engine` проверяет profit-close condition.
3. Если условие закрытия выполнено, закрытие отправляется сразу по локальному `activeTrade`.
4. Перед первым profit-close не делать REST `fetchPosition`.
5. Две reduce-only WebSocket trade-команды отправляются параллельно.
6. ACK/fill события обновляют локальное состояние.
7. После submit выполняются:
   - расчет фактического close PnL;
   - обновление `Trade` в Django;
   - reconciliation;
   - latency metrics.

Для timeout, shutdown и recovery-close можно использовать более консервативный путь с фоновой проверкой позиции, но profit-close должен быть оптимистичным и быстрым.

## State model

Минимальное состояние на symbol:

- `idle`;
- `opening`;
- `open`;
- `closing`;
- `close_pending_persistence`;
- `error_exposure`;
- `paused`.

Состояние должно предотвращать:

- двойной open по одному symbol;
- двойной close одной и той же сделки;
- открытие новых сделок при потере trade WS;
- открытие новых сделок при глобальном risk lock.

## Persistence и recovery

Persistence не должна участвовать в принятии hot-path решения.

Нужны фоновые очереди:

- `AsyncTradeWriter` для Django/БД;
- `AsyncEventWriter` для JSONL/логов/метрик;
- `BackgroundReconciliation` для сверки биржевых позиций и локального состояния.
- `RuntimeErrorReporter` для записи `TraderRuntimeConfigError`.
- `RuntimeConfigClient` для чтения `TraderRuntimeConfig` active payload и отправки lifecycle/sync статусов, если текущий Django API это поддерживает.

Если запись в Django/БД не удалась:

- сделка остается в локальном состоянии;
- retry идет в фоне;
- close может выполняться по локальному состоянию;
- после успешного close обе операции должны быть досинхронизированы.

Требования к `Trade` sync:

- после успешного open создать `Trade` с `runtime_config`, `owner` через serializer, `coin`, exchanges, `order_type`, `amount`, `leverage`, open prices, open order IDs, open spread и open commission;
- после успешного close обновить тот же `Trade`: close prices, close order IDs, close spread, close commission, PnL, `status`, `close_reason`, `closed_at`;
- если close произошел до успешного создания `Trade`, sync-очередь должна сначала создать open-запись, затем применить close-update;
- если Django недоступен, runtime не должен терять локальную сделку и должен продолжать retries;
- если sync невозможно восстановить автоматически, runtime пишет `TraderRuntimeConfigError` и переходит в состояние, где новые сделки запрещены до ручного вмешательства.

Требования к `TraderRuntimeConfig` sync:

- runtime стартует из payload текущего `TraderRuntimeConfig`;
- все `Trade` записи нового сервиса должны быть привязаны к `runtime_config`, а не к `bot`;
- сервис должен уметь восстановить открытые сделки по `runtime_config_id`;
- lifecycle/status изменения должны быть совместимы с текущим Django control plane.

Требования к `TraderRuntimeConfigError` sync:

- ошибки старта, runtime, exchange WS, trade WS, validation, persistence и recovery записываются в Django через service-token API;
- error text не должен содержать secrets, API keys, подписи, private payloads или JWT/service tokens;
- повторяющиеся ошибки должны throttling/de-duplication, чтобы не заспамить Django.

Для crash recovery нужен минимальный durable marker, но его запись не должна стоять перед отправкой ордеров. Допустимый вариант: асинхронная append-only очередь с flush в фоне и явным known risk, что процесс может упасть между submit и flush.

## Risk controls

Несмотря на low-latency приоритет, оставить минимальные hard guards:

- trading запрещен, пока оба trade WS не authenticated/ready;
- trading запрещен, если market data по symbol stale;
- один active trade на symbol;
- глобальный лимит concurrent trades;
- max notional per trade;
- reduce-only для close;
- pause/risk lock при неизвестном результате submit одной из ног;
- reconnect переводит runtime в защитный режим до восстановления состояния.

Все тяжелые проверки должны быть вынесены из hot path.

## Latency metrics

Метрики обязательны, но запись метрик асинхронная.

Фиксировать минимум:

- `market_update_received_at`;
- `signal_checked_at`;
- `signal_detected_at`;
- `orders_submit_started_at`;
- `binance_ws_send_at`;
- `bybit_ws_send_at`;
- `binance_ack_at`;
- `bybit_ack_at`;
- `binance_fill_seen_at`;
- `bybit_fill_seen_at`;
- `persistence_started_at`;
- `persistence_finished_at`.

Основные SLA-метрики:

- market update -> signal detected;
- signal detected -> first WS send;
- signal detected -> both WS sends;
- signal detected -> both ACKs;
- close signal detected -> both close WS sends.

## Fastify control plane

Минимальные endpoints:

- `GET /health`;
- `GET /ready`;
- `POST /runtime/start`;
- `POST /runtime/stop`;
- `POST /runtime/pause`;
- `POST /runtime/resume`;
- `GET /runtime/state`;
- `GET /runtime/latency`;

Control plane не должен блокировать market data и execution loop.

## Конфигурация

`.env.example` должен включать:

- `PORT`;
- `SERVICE_SHARED_TOKEN`;
- `DJANGO_API_URL`;
- `BINANCE_API_KEY`;
- `BINANCE_API_SECRET` или параметры ключа, выбранного для Binance WS signing;
- `BYBIT_API_KEY`;
- `BYBIT_API_SECRET`;
- `USE_TESTNET`;
- `TRADE_AMOUNT_USDT`;
- `MAX_CONCURRENT_TRADES`;
- `MAX_TRADE_NOTIONAL_USDT`;
- `OPEN_THRESHOLD`;
- `CLOSE_THRESHOLD`;
- `ORDERBOOK_MAX_AGE_MS`;
- `ORDERBOOK_MAX_SKEW_MS`;
- `ENABLE_ASYNC_PERSISTENCE`;
- `ENABLE_BACKGROUND_RECONCILIATION`;

Секреты нельзя логировать.

## Проверки реализации

Минимальный набор:

- `pnpm build`;
- unit tests для spread/PnL/qty rounding;
- unit tests для state transitions;
- mock WebSocket tests для параллельного submit двух ног;
- reconnect tests для trade WS;
- тест, что persistence не вызывается до отправки open orders;
- тест, что profit-close не вызывает REST position check перед reduce-only WS submit;
- тест, что open создает `Trade` с open order IDs после WebSocket submit;
- тест, что close обновляет тот же `Trade` с close order IDs и PnL;
- тест, что close может выполниться до успешного Django open sync, а очередь затем досинхронизирует open и close в правильном порядке;
- тест, что runtime/recovery ошибки пишутся как `TraderRuntimeConfigError`;
- latency metric tests для open/close flow.

## Definition of Done

Задача считается выполненной, когда:

- создано новое Fastify/TypeScript приложение;
- в hot path оставлены только in-memory расчеты и WebSocket order submit;
- Binance USD-M и Bybit Futures умеют открывать и закрывать позиции через WebSocket;
- DB/Django persistence выполняется после submit и не блокирует open/close;
- полная синхронизация с Django реализована для `TraderRuntimeConfig`, `Trade` и `TraderRuntimeConfigError`;
- все open/close exchange order IDs сохраняются в `Trade`;
- при временной недоступности Django sync ретраится и не теряет сделку;
- REST не используется для open/close;
- MEXC/Gate и лишние exchange paths отсутствуют;
- добавлен `DOCS.md` нового приложения с фактической архитектурой, командами запуска и рисками;
- есть проверки latency-sensitive behavior;
- в документации явно описан риск асинхронной persistence и recovery strategy.

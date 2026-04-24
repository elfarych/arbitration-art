# Анализ сервиса `arbitration-trader`

Дата анализа: 2026-04-24.

## Статус реализации

Обозначенные в анализе недостатки закрыты в коде текущего trader-сервиса:

- control plane переведен на Fastify и вынесен из `src/main.ts` в `src/control-plane/server.ts`;
- `main.ts` содержит только wiring `RuntimeManager`, Fastify server и process shutdown;
- runtime payload валидируется до `setActiveRuntime(payload)`;
- `TradeCounter` вынесен в отдельный модуль, а failed-open cleanup освобождает слот и ставит cooldown независимо от результата cleanup;
- open trades из Django обязательны для восстановления: recovery symbols включаются в runtime universe, а отсутствие matching chunk abort-ит startup;
- Binance market orders проверяются на полный fill и reconciled через `origClientOrderId`;
- entry signal проходит hard economic edge filter с fee/slippage/funding/latency buffers;
- funding snapshots из ticker payload участвуют в оценке entry edge, если next funding попадает в окно удержания;
- close-flow повторно подтверждает flat position и проверяет ожидаемую сторону позиции перед записью close в Django;
- startup выполняет account-mode preflight для выбранных exchange clients;
- `unhandledRejection` считается fatal и запускает controlled shutdown;
- `OrderBookStore` хранит cached top levels и подрезает внутренние maps после delta;
- leverage/margin setup использует in-process cache подтвержденных настроек;
- universe filtering использует минимум объемов primary/secondary и fail-closed поведение;
- `Trader.ts` разгружен через `SignalEngine`, `CloseSyncService`, `position-recovery`, `TradeCounter` и `trade-state`;
- добавлен минимальный unit-test suite для math, payload validation, signal engine, trade counter и orderbook store;
- добавлен `shadow_mode` с записью entry signals в JSONL без размещения ордеров.

Оставшиеся ограничения описаны в `DOCS.md`: нет distributed lock, recovery все еще матчится по symbol без strategy/account/process id, exchange execution tests требуют mocked clients и private smoke-проверки не запускались в текущей среде.

## Область анализа

Проверены текущие исходники `arbitration-trader`:

- `src/main.ts`
- `src/config.ts`
- `src/classes/RuntimeManager.ts`
- `src/classes/Trader.ts`
- `src/services/api.ts`
- `src/services/market-info.ts`
- `src/utils/math.ts`
- `src/exchanges/*-client.ts`
- `src/exchanges/ws/*`
- `package.json`, `tsconfig.json`, `.env.example`

Анализ выполнен без подключения к биржам, без live-запросов с приватными ключами и без размещения ордеров. Проверка сборки выполнена командой:

```powershell
.\node_modules\.bin\tsc.CMD
```

Результат: TypeScript build проходит успешно.

## Краткий вывод

`arbitration-trader` выглядит как серьезный real-trading прототип, а не игрушечный сканер: есть runtime lifecycle, shared orderbook providers, recovery из Django, VWAP по глубине стакана, rollback при частичном open, reduce-only close, retry Django close sync и базовые drawdown/timeout guards.

Качество кода выше среднего для прототипа, но ниже уровня, на который можно спокойно полагаться в production real trading. Главные причины:

- нет строгой runtime-валидации payload от Django;
- нет автоматических тестов для торговой математики и state machine;
- `Trader.ts` концентрирует слишком много критичной логики в одном классе;
- recovery и close-flow имеют сценарии, где экспозиция может остаться без управления или быть неверно отражена в Django;
- стратегия открывает сделки по относительному расширению spread к EMA baseline, а не по доказанному положительному net edge после комиссий, funding, проскальзывания и latency.

Потенциал стратегии есть только при очень аккуратной калибровке, низких комиссиях, малом размере позиции, устойчивых межбиржевых дислокациях и обязательном shadow/backtest этапе. В текущем виде стратегия недостаточно доказана для запуска на значимый капитал.

## Сильные стороны

1. **Хорошее разделение control plane и runtime.**
   `main.ts` отвечает за HTTP-команды, `RuntimeManager` управляет lifecycle, `Trader` держит per-symbol state.

2. **Есть защита от части real-trading аварий.**
   В `Trader.ts` реализованы global `TradeCounter`, `busy` mutex на символ, rollback успешной ноги при failed open, дополнительный cleanup через `fetchPositions`, reduce-only close и retry close persistence.

3. **Стаканы нормализованы через отдельные providers.**
   Binance, Bybit, Gate и MEXC имеют отдельные WS-провайдеры, а торговый цикл работает с единым `OrderBookSnapshot`.

4. **Сигнал учитывает глубину, а не только top-of-book.**
   `calculateVWAP()` используется для entry/exit расчетов, что лучше, чем торговля по лучшему bid/ask.

5. **Recovery не игнорируется полностью.**
   Открытые сделки подтягиваются из Django перед стартом трейдеров, а восстановленные позиции занимают слот в `TradeCounter`.

6. **Сборка строгая.**
   `tsconfig.json` включает `strict: true`, локальный `tsc` проходит.

## Критичные логические риски

### 1. Нет строгой валидации runtime payload

Файлы: `src/main.ts`, `src/config.ts`, `src/classes/RuntimeManager.ts`.

`readJsonBody()` возвращает `any`, payload приводится к `RuntimeCommandPayload` без runtime-схемы. Затем `config` конвертирует числовые поля через `Number(...)` без проверки диапазонов.

Риски:

- `chunk_size <= 0` в `RuntimeManager.startRuntime()` может привести к бесконечному циклу при разбиении symbols на chunks.
- `trade_amount_usdt`, `leverage`, `open_threshold`, `close_threshold`, `max_leg_drawdown_percent` могут стать `NaN`.
- `max_concurrent_trades <= 0` или `NaN` тихо блокирует торговлю или ломает лимиты.
- неверный `orderbook_limit` может привести к неожиданной глубине подписок.

Рекомендация: добавить отдельную runtime-схему валидации для `RuntimeCommandPayload` до `setActiveRuntime(payload)`. Минимум: positive integer/finite number checks, allowed exchanges, primary != secondary, диапазоны leverage, thresholds, duration, chunk size, top pairs, token presence.

### 2. `TradeCounter` может утечь при failed open cleanup

Файл: `src/classes/Trader.ts`.

В `executeOpen()` слот резервируется до размещения ордеров. Если затем случается ошибка, catch вызывает `handleOpenCleanup()`, а `tradeCounter.release()` выполняется только после успешного cleanup.

Если cleanup сам выбросит ошибку, слот не освободится, cooldown/baseline reset не выполнятся, и runtime может постепенно заблокировать новые сделки.

Рекомендация: освобождение слота и перевод символа в cooldown должны выполняться в `finally` или через отдельный флаг `slotReserved`, независимо от результата cleanup. Ошибку cleanup нужно логировать как критичную, но не ломать внутренние счетчики.

### 3. Восстановленная сделка может быть проигнорирована

Файл: `src/classes/RuntimeManager.ts`.

Open trades из Django распределяются только по traders, созданным для `finalTradeableSymbols`. Если символ открытой сделки не прошел текущие фильтры ликвидности, market info, leverage/margin setup или orderbook provider setup, сделка логируется как "no matching trader chunk" и игнорируется.

Риск: на бирже может остаться реальная открытая позиция, которую runtime после рестарта не мониторит и не закрывает.

Рекомендация: open trades должны иметь приоритет над текущим universe filtering. Для них нужен recovery-path: либо создать отдельный recovery trader по символу, либо force-close под контролем, либо abort runtime с явной ошибкой.

### 4. Binance market order не проверяется на полный fill

Файл: `src/exchanges/binance-client.ts`.

Bybit/Gate/MEXC клиенты проверяют, что market order действительно заполнен полностью. Binance-клиент возвращает `OrderResult`, даже если статус не `FILLED`, а `filledQty` fallback-ится к `amount`.

Риск: `Trader.executeOpen()` может считать обе ноги успешными, записать Django trade на полный amount, но фактическая Binance-экспозиция будет частичной или отсутствующей.

Рекомендация: сделать для Binance тот же контракт, что и для остальных клиентов: assert `status === FILLED`, `filledQty >= requestedAmount * tolerance`, `avgPrice > 0`; при неопределенном статусе выполнять reconciliation через order/userTrades.

### 5. Entry signal может открыть отрицательный net spread

Файлы: `src/classes/Trader.ts`, `src/utils/math.ts`.

Открытие происходит по условию:

```text
currentSpread >= baselineSpread + openThreshold
```

Это относительное расширение к EMA baseline. Условие не требует, чтобы текущий spread был положительным после комиссий и ожидаемого проскальзывания.

Пример: если baseline был `-5%`, то spread `-2.9%` при `openThreshold=2%` уже может дать сигнал. Это не арбитраж в классическом смысле, а ставка на дальнейшую mean reversion.

Рекомендация: разделить signal threshold и hard economic threshold. Entry должен проходить минимум:

```text
expected_net_edge = open_spread - taker_fees - estimated_slippage - funding_buffer - latency_buffer
expected_net_edge > min_open_edge
```

### 6. Funding rate не участвует в стратегии

Файлы: торговая логика `src/classes/Trader.ts`, exchange clients.

Стратегия торгует futures/perpetual contracts, но не учитывает funding rates, время до funding, expected funding payment и разные funding schedules между биржами.

Риск: сделка может выглядеть прибыльной по spread/PnL, но иметь отрицательное ожидание после funding. Особенно это важно при `max_trade_duration_minutes` до 60 минут и longer-tail зависаниях позиций.

Рекомендация: добавить funding-aware фильтр:

- не открывать сделку перед неблагоприятным funding;
- учитывать projected funding в entry/exit;
- хранить funding snapshots в метриках сделки.

### 7. Close-flow доверяет `fetchPositions()` как абсолютной истине

Файл: `src/classes/Trader.ts`.

Перед close код читает позиции с обеих бирж. Если позиция не найдена, leg считается `already_closed`, а цена берется из стакана или open price fallback.

Риск: если `fetchPositions()` вернет false negative из-за eventual consistency, account mode, API lag или ошибки нормализации, runtime может записать flat-state в Django при живой позиции.

Рекомендация: перед фиксацией `already_closed` делать повторную проверку, сверять expected side/size, отличать `confirmed flat` от `unknown`, а unknown не закрывать в Django.

### 8. Нет проверки account mode

Файлы: `src/exchanges/binance-client.ts`, `src/exchanges/bybit-client.ts`, `src/exchanges/mexc-client.ts`.

Код в основном предполагает one-way position mode:

- Binance order не передает `positionSide`.
- Bybit order использует `positionIdx: 0`.
- MEXC частично проверяет `positionMode`, но поведение reduce-only зависит от режима.

Риск: в hedge mode заявки могут отклоняться или открывать/закрывать не ту сторону позиции.

Рекомендация: на runtime startup проверять и явно документировать/фиксировать required account mode для каждой биржи.

### 9. `unhandledRejection` только логируется

Файл: `src/main.ts`.

`uncaughtException` запускает shutdown, а `unhandledRejection` только логируется. Для real-trading процесса это опасно: незамеченный rejection может означать сломанную state machine при продолжающемся процессе.

Рекомендация: treat unhandled rejection as fatal для active runtime: controlled stop, close positions, process exit под supervisor.

## Неоптимальные решения и технический долг

### 1. `OrderBookStore.getOrderBook()` сортирует уровни при каждом чтении

Файл: `src/exchanges/ws/orderbook-store.ts`.

Каждый вызов `getOrderBook()` сортирует все bids/asks из `Map`. Этот метод вызывается на каждом tick по обоим providers и может стать CPU hotspot при большом числе symbols.

Дополнительный риск: `applyAbsoluteDelta()` добавляет новые price levels, но не подрезает `Map` до depth limit. При долгой работе maps могут расти, а сортировка будет дорожать.

Рекомендация: хранить top-N в структуре с контролируемым размером или периодически prune levels после delta; добавить метрики размера maps.

### 2. Leverage/margin setup выполняется для всех tradeable symbols на старте

Файл: `src/classes/RuntimeManager.ts`.

Для 100+ symbols startup делает много private REST-запросов. Это увеличивает время старта, риск rate limit и вероятность, что весь runtime не запустится из-за временных ошибок по части symbols.

Рекомендация: кешировать подтвержденные настройки, проверять только изменившиеся symbols/config или переносить setup ближе к entry с контролируемым preflight.

### 3. Universe filtering зависит только от primary exchange volume

Файл: `src/classes/RuntimeManager.ts`.

Символы фильтруются по `quoteVolume` primary exchange. Secondary exchange может быть заметно менее ликвидной.

VWAP потом отфильтрует часть сигналов по глубине, но startup все равно подпишется на лишние symbols.

Рекомендация: учитывать min(primaryVolume, secondaryVolume), spread stability, orderbook depth и reject-rate по символу.

### 4. При сбое volume fetch runtime идет во все common symbols

Файл: `src/classes/RuntimeManager.ts`.

Если `primaryClient.fetchTickers()` упал, сервис продолжает со всеми common symbols. Это fail-open поведение может резко увеличить нагрузку и включить неликвидные пары.

Рекомендация: для real trading лучше fail-closed или использовать жесткий cap с conservative fallback.

### 5. `Trader.ts` слишком большой и смешивает ответственности

Файл: `src/classes/Trader.ts`.

Один класс содержит:

- signal calculation;
- baseline state;
- open orchestration;
- rollback/cleanup;
- exit checks;
- timeout watchdog;
- PnL snapshots;
- Django persistence retry;
- close finalization.

Это усложняет тестирование и повышает риск регрессий.

Рекомендация: выделить минимум:

- `SignalEngine`;
- `ExecutionCoordinator`;
- `PositionRecoveryService`;
- `CloseSyncService`;
- `TradeStateStore`.

### 6. Много `any` в критичных местах

Файлы: `src/main.ts`, `src/classes/Trader.ts`, `src/exchanges/*`.

Часть `any` неизбежна на границе exchange API, но сейчас `any` используется и для runtime payload, Django decimals, positions и raw orders.

Рекомендация: держать `unknown` на внешних границах, валидировать и нормализовать в typed DTO до попадания в торговую логику.

### 7. Нет автоматического test suite

В проекте есть manual smoke scripts, но нет unit/integration тестов.

Минимальный набор:

- `calculateOpenSpread`;
- `calculateTruePnL`;
- `calculateRealPnL`;
- `checkLegDrawdown`;
- `calculateVWAP`;
- `TradeCounter`;
- `executeOpen` success/failure/partial fill;
- cleanup failure не должен ломать счетчик;
- close partial success retry;
- pending Django close sync;
- recovery по open trades;
- invalid runtime payload validation.

## Качество кода

Оценка: **6.5/10 для production real-trading**, **8/10 для исследовательского прототипа**.

Что хорошо:

- понятная модульная структура;
- строгий TypeScript build;
- exchange clients имеют единый интерфейс;
- есть попытка нормализовать contract sizes для Gate/MEXC;
- есть локальная защита от duplicate open/close через `busy`;
- есть retry для критичного Django close sync.

Что снижает оценку:

- нет runtime validation;
- нет тестов;
- торговая state machine не изолирована;
- recovery не гарантирует управление всем фактическим exposure;
- недостаточно жесткий exchange execution contract для Binance;
- нет funding/balance/account-mode preflight;
- часть ошибок логируется через `console.error`, а не через общий logger;
- процесс может продолжить работу после `unhandledRejection`.

## Оценка торговой стратегии

### Что стратегия фактически делает

Это cross-exchange futures/perpetual spread strategy:

1. выбирает пересекающиеся USDT perpetual symbols на двух биржах;
2. фильтрует ликвидные пары;
3. считает bid/ask VWAP на обеих биржах;
4. ведет EMA baseline spread отдельно для `buy` и `sell`;
5. открывает market orders двумя ногами, когда spread расширился относительно baseline;
6. закрывает по estimated true PnL, timeout или drawdown guard.

### Это не безрисковый арбитраж

Стратегия не фиксирует прибыль на входе. Она открывает позицию на расширении spread и рассчитывает, что spread сузится или закроется выгодно. Это ближе к statistical basis trading, чем к deterministic arbitrage.

Ключевые источники риска:

- market order taker fees на обеих биржах;
- проскальзывание между сигналом и исполнением;
- legging risk при частичном/failed order;
- funding payments;
- API latency и stale orderbook;
- независимая liquidation/margin модель на двух биржах;
- резкое widening spread при новостях, delisting, funding squeeze, exchange outage;
- ошибки нормализации контрактов и account mode.

### Потенциал

Потенциал ограниченный, но не нулевой.

Стратегия может работать:

- на малом размере позиции;
- на парах со стабильной глубиной;
- при низких fee tiers или rebates;
- на устойчивых межбиржевых premium дислокациях;
- если close threshold и timeout подобраны по историческим данным;
- если funding учтен и не съедает edge.

Стратегия с высокой вероятностью будет убыточной или нестабильной:

- на retail fee tier;
- при больших market orders;
- на volatile/news режимах;
- без latency monitoring;
- без backtest/shadow метрик;
- если entry допускает отрицательный net spread;
- если используется production mode без testnet/small-cap smoke.

### Что нужно измерить перед реальными деньгами

1. Распределение `open_spread`, `close_spread`, realized slippage по каждой бирже.
2. Hit-rate сигналов: сколько сделок закрывается по profit, timeout, drawdown.
3. Median/95p время удержания позиции.
4. Fee-adjusted и funding-adjusted PnL.
5. Частоту partial/failure/rollback.
6. Разницу между expected PnL и real fill PnL.
7. Stale orderbook rate и resync rate по providers.
8. API latency на private order endpoints.
9. PnL по symbol/exchange pair.

Без этих метрик оценивать expected value стратегии нельзя.

## Приоритетный план улучшений

1. Добавить runtime payload validation и fail-fast до `setActiveRuntime`.
2. Исправить `TradeCounter` release/cooldown при cleanup failures.
3. Сделать recovery open trades обязательным: нельзя игнорировать trade без matching chunk.
4. Усилить Binance order reconciliation и full-fill assert.
5. Добавить account mode preflight для всех бирж.
6. Добавить economic entry filter: fees, slippage buffer, funding buffer, minimum absolute net edge.
7. Добавить тесты для math/state machine/execution failures.
8. Разделить `Trader.ts` на signal, execution, recovery, close-sync компоненты.
9. Оптимизировать `OrderBookStore`: pruning, cached top levels, metrics.
10. Запустить shadow mode: без ордеров, но с записью сигналов, expected fills и последующего realized outcome.

## Итоговая оценка готовности

Текущее состояние подходит для:

- code review;
- testnet/sandbox;
- paper/shadow mode;
- very small live smoke с заранее ограниченным account risk.

Текущее состояние не подходит для:

- unattended production trading;
- значимого капитала;
- нескольких одновременно запущенных процессов на один account;
- торговли без внешнего мониторинга и ручного kill switch.

Главный вывод: код уже содержит правильные зачатки production-подхода, но стратегия и runtime safety еще не доказаны. Перед увеличением капитала нужно закрыть recovery/execution-validation риски и собрать статистику по net edge после комиссий, funding и реального исполнения.

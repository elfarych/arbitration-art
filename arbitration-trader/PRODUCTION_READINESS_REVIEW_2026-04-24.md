# Production readiness review `arbitration-trader`

Дата анализа: 2026-04-24.

## 1. Краткий вывод

`arbitration-trader` выглядит как серьезный real-trading прототип с заметной инженерной доработкой: есть runtime control plane, строгая валидация payload, native REST/WS-клиенты, VWAP по стакану, hard economic entry filter, восстановление открытых сделок из Django, retry close sync, reduce-only rollback/close, account-mode preflight и базовые unit tests.

При этом сервис нельзя считать production-ready для автономной торговли значимым капиталом. Главная проблема не в TypeScript-сборке, а в поведении при аварийных состояниях: есть сценарии, где реальная биржевая экспозиция может остаться без активного runtime-сопровождения или быть неверно отражена в Django. Для торговли реальными деньгами это блокирующий риск.

Итоговая оценка:

| Область | Оценка |
|---|---|
| Архитектура сервиса | 7/10 |
| Качество TypeScript-кода | 7/10 |
| Exchange abstraction | 6.5/10 |
| Trading safety | 4/10 |
| Observability | 4/10 |
| Тестовое покрытие | 3.5/10 |
| Production readiness для real money | 3.5/10 |

Практический статус:

- подходит для code review, testnet, shadow/paper режима и очень малого live smoke после ручной подготовки;
- не подходит для unattended production trading;
- не подходит для существенного капитала;
- не подходит для запуска нескольких процессов на один exchange account;
- не должен торговать production без внешнего мониторинга, kill switch, reconciliation и заранее ограниченного account risk.

## 2. Область проверки

Проверены ключевые файлы `arbitration-trader`:

- `src/main.ts`
- `src/config.ts`
- `src/control-plane/server.ts`
- `src/control-plane/shutdown.ts`
- `src/classes/RuntimeManager.ts`
- `src/classes/Trader.ts`
- `src/classes/TradeCounter.ts`
- `src/classes/trade-state.ts`
- `src/services/runtime-payload-validation.ts`
- `src/services/signal-engine.ts`
- `src/services/market-info.ts`
- `src/services/api.ts`
- `src/services/close-sync-service.ts`
- `src/services/position-recovery.ts`
- `src/services/shadow-recorder.ts`
- `src/exchanges/*-client.ts`
- `src/exchanges/ws/*`
- `tests/*`
- `package.json`, `tsconfig.json`, `.env.example`, `DEPLOY_LINUX.md`

Также точечно проверен Django contract для `TraderRuntimeConfig` и payload builder:

- `arbitration-art-django/apps/bots/services/trader_runtime_shared.py`
- `arbitration-art-django/apps/bots/models.py`

Live/private smoke на биржах не выполнялся, ордера не размещались.

## 3. Сильные стороны

1. Runtime payload валидируется до старта.

   `parseRuntimeCommandPayload()` проверяет положительные числа, exchange names, distinct exchanges, лимиты leverage/chunk/orderbook, наличие ключей для выбранных бирж. Это закрывает класс опасных ошибок вроде `chunk_size=0`, `NaN` thresholds и отсутствующих credentials.

2. Есть нормальная control plane архитектура.

   `main.ts` содержит wiring, HTTP-логика вынесена в `control-plane/server.ts`, shutdown handling - в `control-plane/shutdown.ts`, runtime lifecycle - в `RuntimeManager`.

3. Есть реальные safety-механизмы в торговом цикле.

   `Trader` использует per-symbol `busy`, общий `TradeCounter`, cooldown после failed open, reduce-only rollback, position-based cleanup, close retry и pending close sync при недоступном Django.

4. Entry считает VWAP по глубине, а не только top-of-book.

   `calculateVWAP()` требует достаточную видимую глубину для entry/profit-close и допускает приблизительную оценку только для emergency exits.

5. Entry filter стал экономически осмысленнее.

   `SignalEngine` открывает сделку только если выполнены два условия:

   - spread расширился относительно EMA baseline;
   - `expectedNetEdge` после fee/slippage/latency/funding buffers не ниже `min_open_net_edge_percent`.

6. Recovery из Django не игнорируется.

   Runtime загружает open trades для текущего `runtime_config_id`, добавляет recovery symbols в universe и abort-ит startup, если recovery trade нельзя включить в runtime.

7. Биржевые клиенты проверяют full fill.

   Binance/Bybit/Gate/MEXC клиенты делают polling/reconciliation и вызывают `assertFilledMarketOrder()`. Это сильно лучше, чем слепо доверять первому ответу market order.

8. WebSocket orderbook providers в целом аккуратные.

   Для Bybit/Gate/MEXC есть stale checks, reconnect, sequence validation, resync и normalized `OrderBookStore`.

9. Сборка строгая.

   `tsconfig.json` включает `strict: true`, локальный `tsc` проходит.

10. Есть базовый unit-test suite.

    Покрыты math helpers, payload validation, signal engine, trade counter и orderbook store.

## 4. Блокирующие риски для real money

### 4.1. Failed-open cleanup может оставить биржевую позицию без локального состояния

Файл: `src/classes/Trader.ts`

Сценарий:

1. Обе ноги открылись или одна нога открылась.
2. Затем падает `api.openTrade()` или одна из операций возвращает ошибку после фактического fill.
3. `executeOpen()` вызывает `safeHandleOpenCleanup()`.
4. `safeHandleOpenCleanup()` логирует критическую ошибку, но подавляет exception.
5. `executeOpen()` освобождает `TradeCounter`, сбрасывает baselines, ставит cooldown и возвращает `state.busy=false`.

Если cleanup не смог закрыть реальную позицию, runtime продолжит считать символ свободным. Через cooldown он может открыть новую сделку поверх неучтенной экспозиции. Django при этом может не иметь open trade record, значит recovery после рестарта не спасет.

Это P0 для реальных денег.

Что нужно сделать:

- ввести состояние `unmanagedExposure` или `quarantined`;
- запрещать новые entries по символу и желательно глобально по runtime до ручного/автоматического reconciliation;
- продолжать retry cleanup до подтвержденного flat;
- создать аварийную запись в Django или отдельный incident record, если реальные позиции могли открыться, но trade record не создан;
- вынести такой runtime в unhealthy status, чтобы `/health` и Django видели проблему.

### 4.2. Stop/shutdown может завершить runtime при незакрытых позициях

Файлы:

- `src/classes/RuntimeManager.ts`
- `src/classes/Trader.ts`

`RuntimeManager.stopActiveRuntime()`:

- сразу делает `this.activeRuntime = null`;
- вызывает `Promise.allSettled(current.traders.map(trader => trader.stop(true)))`;
- закрывает WS;
- очищает active runtime config.

`Trader.closeAllPositions()` ловит ошибки закрытия по символу и только логирует их. `executeClose()` тоже ловит ошибку и не пробрасывает ее наружу.

Сценарий:

1. Пользователь вызывает `POST /engine/trader/stop`.
2. Одна позиция не закрывается из-за exchange error, rate limit, network timeout или side mismatch.
3. Ошибка логируется.
4. Runtime считается остановленным.
5. Позиция остается на бирже, но активный trader уже не мониторит ее.

Django trade, вероятно, останется `open`, но до следующего `start` позиция не сопровождается. Для real money это неприемлемо.

Что нужно сделать:

- `stop` должен возвращать ошибку или `degraded` status, если не все позиции подтвержденно закрыты;
- runtime не должен очищать active state, пока есть незакрытая биржевая экспозиция или pending close;
- нужен отдельный режим `stopping_with_open_exposure`, который продолжает retry close;
- supervisor не должен убивать процесс до flat/reconciled состояния.

### 4.3. Partial close теряет реальные цены уже закрытой ноги

Файл: `src/classes/Trader.ts`

`executeClose()` закрывает обе ноги через `Promise.all(closePromises)`. Если одна нога успешно закрылась, а вторая упала, метод попадает в `catch`, оставляет `activeTrade` и будет пробовать снова.

На следующей попытке закрытая нога будет определена как flat, а цена для нее будет взята из текущего стакана или open price fallback. Реальная цена уже исполненного close order не сохраняется.

Последствие:

- риск позиции снижен, потому что retry может закрыть вторую ногу;
- но итоговый PnL и close spread в Django могут быть неверными;
- аналитика стратегии, статистика slippage и решение о масштабировании капитала будут искажены.

Что нужно сделать:

- хранить per-leg close state: order id, fill price, commission, timestamp;
- при partial close retry не терять уже исполненную ногу;
- синхронизировать partial close в Django или в отдельный execution ledger.

### 4.4. Binance orderbook provider не имеет stale guard

Файл: `src/exchanges/ws/binance-orderbook-provider.ts`

Bybit/Gate/MEXC providers блокируют торговлю, если `localTimestamp` старше `MAX_STALE_MS`. Binance provider возвращает snapshot, если `isSynced=true`, без проверки возраста.

Сценарий:

- WebSocket не закрыт, но поток по символу перестал обновляться;
- локальный book остается `isSynced=true`;
- `Trader` продолжает торговать по старому Binance стакану.

Для market-order стратегии это P1/P0 в зависимости от размера позиции.

Что нужно сделать:

- добавить `MAX_STALE_MS` в Binance provider;
- блокировать `getOrderBook()` при старом `localTimestamp`;
- добавить heartbeat/connection liveness metrics;
- логировать stale rate по символам.

### 4.5. Нет exchange-account reconciliation loop

Сервис восстанавливается из Django open trades, но не имеет независимого цикла сверки:

- реальные позиции на биржах;
- локальный `PairState`;
- Django `Trade`;
- ожидаемое направление и размер.

Если пользователь вручную открыл/закрыл позицию, cleanup failed после failed open, Django API был недоступен или exchange вернул inconsistent position list, runtime может не увидеть расхождение.

Что нужно сделать:

- периодически читать `fetchPositions()` по всем активным/recent symbols;
- сверять с Django и local state;
- при mismatch переходить в `risk_locked`;
- запрещать новые entries до ручного подтверждения или автоматического flatten;
- писать reconciliation incidents.

### 4.6. Нет distributed lock на account/runtime

`TradeCounter` процесс-локальный. Два процесса `arbitration-trader` с одним account могут открыть сделки одновременно и обойти лимиты `max_concurrent_trades`.

Что нужно сделать:

- Redis/DB lease на `runtime_config_id + account/exchange route`;
- heartbeat lease renewal;
- fail-closed при потере lease;
- запрет второго активного runtime на стороне Django и/или deploy supervisor.

## 5. Логические риски стратегии

### 5.1. Это не безрисковый арбитраж

Стратегия открывает cross-exchange futures/perpetual spread position, когда spread расширился относительно EMA baseline и прошел минимальный net edge filter. Она не фиксирует прибыль на входе. Это ближе к statistical basis/spread mean reversion, чем к deterministic arbitrage.

Риск: spread может расширяться дальше, особенно на новостях, funding squeeze, delisting risk, exchange outage, liquidation cascade или локальном дефиците ликвидности на одной бирже.

### 5.2. Funding учитывается только приблизительно и статически

`MarketInfoService` берет funding snapshots из tickers при bootstrap. `SignalEngine` использует их для entry estimate, если next funding попадает в окно удержания.

Ограничения:

- funding не обновляется во время долгой работы runtime;
- неизвестный funding rate дает `0`, если нет дополнительного `funding_buffer_percent`;
- нет учета фактических funding payments в real PnL;
- нет отдельной защиты перед funding timestamp.

Что нужно сделать:

- регулярно обновлять funding snapshots;
- хранить funding expectation на входе;
- учитывать фактические funding payments в post-trade analytics;
- запрещать вход перед неблагоприятным funding, если ожидаемый edge недостаточен.

### 5.3. Close threshold использует упрощенную fee-модель

Файл: `src/utils/math.ts`

`calculateTruePnL()` использует hardcoded fee estimate `0.0020`, то есть 0.20% от notional. Это может не совпадать:

- с реальными taker fee tier по каждой бирже;
- с BNB/discount fee mode;
- с maker/taker mix;
- с MEXC/Gate fee currency;
- с runtime `entry_fee_buffer_percent`.

Финальный `calculateRealPnL()` считает реальные commissions, но решение о profit close принимает `calculateTruePnL()`. Это может закрывать слишком рано или слишком поздно.

Что нужно сделать:

- вынести fee model в конфиг;
- считать expected close PnL через тот же fee/slippage/funding model, что entry;
- сравнивать close threshold с expected net PnL, а не с hardcoded estimate.

### 5.4. Profit percentage может вводить в заблуждение при leverage

`calculateRealPnL()` делит прибыль на `amount * min(openPrimary, openSecondary)`, то есть на notional, а не на isolated margin after leverage.

Это не баг само по себе, но UI/аналитика должны явно показывать, что процент не равен ROE на маржу. Иначе пользователь может неверно оценить риск/доходность.

### 5.5. Lot size объединяется недостаточно строго

Файлы:

- `src/services/market-info.ts`
- `src/classes/Trader.ts`
- `src/exchanges/binance-client.ts`
- `src/exchanges/gate-client.ts`

Сейчас unified `stepSize` берется как `Math.max(primaryInfo.stepSize, secondaryInfo.stepSize)`, а precision местами считается через `Math.round(-Math.log10(stepSize))`.

Риски:

- если шаги не кратны друг другу, больший шаг не гарантирует валидность на обеих биржах;
- для шагов типа `0.0005` `Math.round(-log10(step))` дает недостаточную точность;
- dynamic sizing может округлить amount в значение, которое не проходит одну из бирж.

Что нужно сделать:

- вычислять общий допустимый шаг как least common multiple для decimal increments;
- использовать decimal/string-based precision, а не `log10`;
- добавить тесты на non-power-of-ten lot steps.

### 5.6. Нет балансового и margin preflight перед entry

Runtime выставляет leverage/margin на старте, но перед entry не проверяет:

- available balance на обеих биржах;
- maintenance margin;
- existing manual positions;
- risk limit tier;
- max order size;
- isolated margin sufficiency после комиссии и slippage.

Если одна биржа отклонит ордер из-за margin/balance, вторая может исполниться. Cleanup помогает, но это уже legging risk.

## 6. Неоптимальные решения и технический долг

### 6.1. Binance WS subscription не chunked

`BinanceOrderBookProvider` собирает все streams в один URL. При большом `top_liquid_pairs_count` URL может стать слишком длинным или упереться в exchange limits. Bybit provider уже chunk-ит subscription payload, Binance - нет.

Рекомендация: делать несколько WS-соединений или dynamic stream subscribe с лимитом streams per connection.

### 6.2. Volume/ticker data запрашивается несколько раз на startup

`RuntimeManager` fetches tickers для liquidity filtering, затем `MarketInfoService.initialize()` снова fetches tickers для prices/funding/collision protection.

Рекомендация: передавать уже загруженные tickers в `MarketInfoService` или ввести bootstrap context.

### 6.3. Leverage/margin setup на все symbols дорогой

Startup выполняет private REST setup для всех tradeable symbols. Это снижает вероятность неожиданного отказа при entry, но:

- увеличивает время старта;
- повышает rate-limit risk;
- может исключить много symbols из-за временных API ошибок;
- cache только in-process.

Рекомендация: оставить preflight для recovery/open-risk symbols, а для остальных использовать lazy setup with confirmed cache and retry budget либо устойчивый persisted setup cache.

### 6.4. OrderBookStore все еще сортирует на каждый delta

Кэш top levels есть, prune есть, но каждый `applyAbsoluteDelta()` пересортировывает bids/asks. При большом числе symbols и высокой частоте updates это может стать CPU hotspot.

Рекомендация: добавить метрики CPU per provider, book update rate, map size; оптимизировать только после измерений.

### 6.5. ShadowRecorder пишет appendFile на каждый signal

Для shadow mode это просто, но при большом числе signals может создать IO pressure и огромный JSONL без rotation.

Рекомендация: buffered writer, rotation, backpressure, отдельные summary metrics.

### 6.6. Deploy docs не соответствуют текущей модели конфигурации

`DEPLOY_LINUX.md` все еще описывает production `.env` с `BINANCE_API_KEY`, `BINANCE_SECRET_KEY`, `BYBIT_API_KEY`, `BYBIT_SECRET_KEY`. Текущий trader получает exchange keys из Django runtime payload, а `.env.example` содержит только infrastructure variables.

Риск: оператор production может настроить сервис неверно.

## 7. Observability и operational gaps

Недостаточно для production:

- нет Prometheus/metrics endpoint;
- нет счетчиков stale books, reconnects, resyncs, order failures, cleanup failures, close retries;
- нет алертов на pending close sync;
- нет алерта на cleanup failure after failed open;
- нет runtime status `degraded/risk_locked`;
- нет audit trail по каждой leg execution;
- нет kill switch с подтвержденным flatten status;
- нет max daily loss / max session loss / max consecutive failures;
- нет production confirmation поверх `use_testnet=false`;
- HTTP control plane слушает `0.0.0.0` и защищен только shared token, без встроенного IP allowlist/TLS/mTLS.

Shared token сам по себе не должен быть единственной защитой real-money control plane. Нужны private network, firewall, reverse proxy auth или mTLS.

## 8. Тестовое покрытие

Что есть:

- `math.test.ts`
- `orderbook-store.test.ts`
- `runtime-payload-validation.test.ts`
- `signal-engine.test.ts`
- `trade-counter.test.ts`

Чего критически не хватает:

- `Trader.executeOpen()` success;
- failed first leg / failed second leg;
- Django `openTrade()` failure after both exchange fills;
- cleanup failure after failed open;
- symbol quarantine после cleanup failure;
- `executeClose()` success;
- partial close success + second leg failure;
- pending Django close sync;
- shutdown close failure;
- recovery with non-scannable but open symbol;
- Binance stale book guard;
- lot step merge for non-power-of-ten increments;
- mocked exchange clients for each native client contract;
- contract tests against Django serializer shape.

Пока эти тесты не покрыты, любые изменения в trade state machine остаются высокорисковыми.

## 9. Потенциал торговой стратегии

Потенциал есть, но он ограничен и требует доказательства данными.

Стратегия может иметь положительное ожидание при условиях:

- малый размер позиции относительно видимой и реальной глубины;
- низкий taker fee tier или rebates;
- устойчивые межбиржевые dislocations;
- быстрый VPS/региональная близость к API;
- строгая фильтрация stale books;
- корректная funding model;
- статистически подобранные thresholds;
- контроль tail-risk и exchange outage risk.

Стратегия с высокой вероятностью будет нестабильной или отрицательной:

- на retail taker fees;
- на market orders без fee tier advantage;
- на парах с тонкой secondary liquidity;
- во время новостей и резких funding dislocations;
- при high latency;
- без shadow статистики по expected vs actual fills;
- без daily loss limits;
- без reconciliation.

Что обязательно измерить до production:

1. Entry signal count per symbol/exchange route.
2. Expected net edge distribution.
3. Real open slippage by leg.
4. Real close slippage by leg.
5. Fee-adjusted PnL.
6. Funding-adjusted PnL.
7. Time-to-close distribution.
8. Profit/timeout/drawdown/error close ratios.
9. Partial fill / rollback / cleanup failure frequency.
10. Stale book rate per provider.
11. Private order latency p50/p95/p99.
12. Difference between signal PnL and realized PnL.
13. PnL by symbol and by exchange route.

Без этих данных нельзя честно оценить expected value.

## 10. Production readiness checklist

Перед реальными деньгами нужно закрыть минимум:

1. Add risk lock/quarantine for failed open cleanup.
2. Stop/shutdown must not mark runtime stopped if positions are not confirmed flat.
3. Add exchange-account reconciliation loop.
4. Add Binance stale orderbook guard.
5. Persist per-leg execution state for partial close retries.
6. Add distributed runtime/account lock.
7. Wire `shadow_mode` and risk buffers through Django/Quasar or another controlled config path.
8. Add production confirmation for `use_testnet=false`.
9. Add max loss controls: per trade, per day, per runtime session.
10. Add balance/margin/risk-tier preflight before entry.
11. Add metrics and alerts for stale books, cleanup failures, pending close sync and runtime degraded state.
12. Add mocked integration tests for open/close/recovery failure paths.
13. Run private exchange smoke tests with tiny size for every enabled route.
14. Run shadow mode long enough to collect statistically useful data.
15. Fix `DEPLOY_LINUX.md` to match current payload-based credentials model.

## 11. Рекомендуемый порядок стабилизации

### Phase 1 - safety blockers

1. Implement `risk_locked` / `unmanagedExposure` state.
2. Stop new entries after any cleanup failure.
3. Keep runtime active and retrying when shutdown close fails.
4. Add Binance stale guard.
5. Add reconciliation loop.

### Phase 2 - correctness and accounting

1. Persist leg-level executions.
2. Fix partial close accounting.
3. Replace hardcoded close fee estimate with configurable fee model.
4. Refresh funding snapshots during runtime.
5. Improve lot-size merge and precision handling.

### Phase 3 - validation

1. Add mocked state-machine tests.
2. Add exchange-client contract tests.
3. Add Django payload contract tests.
4. Run testnet/private smoke per exchange.
5. Run shadow mode and collect metrics.

### Phase 4 - production controls

1. Distributed lock.
2. Metrics endpoint and alerts.
3. Production confirmation workflow.
4. Daily/session loss limits.
5. Operator runbook for stuck positions, pending close sync and exchange outage.

## 12. Проверки

Выполнено:

```powershell
cd arbitration-trader
.\node_modules\.bin\tsc.CMD
```

Результат: TypeScript build проходит.

Выполнено:

```powershell
cd arbitration-trader
.\node_modules\.bin\tsx.CMD --test tests/*.test.ts
```

В sandbox команда упала с `spawn EPERM` из-за Node test runner. После запуска вне sandbox прошли все тесты:

- tests: 13
- pass: 13
- fail: 0

Не выполнялось:

- live REST/WS smoke с приватными ключами;
- testnet order placement;
- production order placement;
- Django integration test against live API;
- long-running shadow run.

## 13. Финальная оценка

Текущий `arbitration-trader` - не игрушечный скрипт, а неплохой real-trading prototype. В нем уже есть многие правильные инженерные решения. Но для production real money важнее всего поведение при сбоях, а именно там остаются блокирующие риски.

Главный вывод: запускать на значимый капитал нельзя. Безопасный следующий шаг - закрыть P0/P1 risks, включить shadow mode через управляемый конфиг, собрать статистику expected vs realized execution и только потом делать минимальный live smoke с заранее ограниченными средствами на отдельных аккаунтах.

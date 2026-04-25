# Arbitration Trader Workflow

Краткое пошаговое описание фактической работы `arbitration-trader`.

## 1. Назначение

`arbitration-trader` - standalone сервис реальной арбитражной торговли между двумя futures/derivatives биржами. Он принимает lifecycle-команды от Django, поднимает один активный runtime на процесс, сканирует ликвидные пары, открывает две противоположные позиции и закрывает их по прибыли, timeout, shutdown или risk-событию.

## 2. Точка входа

1. При запуске процесса `arbitration-trader` поднимает Fastify control plane. Если `TRADER_INSTANCE_ID` задан, процесс запрашивает в Django `GET /api/bots/runtime-configs/{TRADER_INSTANCE_ID}/active-payload/` с `X-Service-Token` и стартует runtime по полученному payload.
2. Django также отправляет команды в Fastify control plane:
   - `POST /engine/trader/start`
   - `POST /engine/trader/sync`
   - `POST /engine/trader/stop`
3. Почти все маршруты требуют `X-Service-Token`.
4. Перед запуском runtime payload проходит валидацию:
   - корректный `runtime_config_id`;
   - допустимые названия бирж;
   - `primary_exchange != secondary_exchange`;
   - положительные торговые лимиты;
   - присутствуют ключи для выбранных бирж.

Если payload невалиден, сервис сразу возвращает ошибку и runtime не стартует.

Если `start` или `sync` приходит для уже запущенного runtime с тем же payload, `RuntimeManager` не перезапускает процесс и оставляет текущие traders работать. Если payload изменился, `sync` выполняет штатный graceful restart.

## 3. Старт runtime

`RuntimeManager.startRuntime()` выполняет bootstrap в таком порядке:

1. Сохраняет runtime payload в активную конфигурацию процесса.
2. Проверяет production guards:
   - разрешен ли live mode;
   - совпадает ли окружение;
   - не превышены ли production caps.
3. Захватывает host-local process lock, чтобы не запустить второй runtime в том же deployment.
4. Проверяет execution journal и блокирует старт при незавершенных open/close/cleanup intents.
5. Создает REST clients для primary и secondary биржи.
6. Проверяет режимы аккаунтов и базовую доступность private API.
7. Загружает markets и собирает пересечение USDT perpetual/futures symbols.
8. Получает открытые сделки из Django для текущего `runtime_config_id`.
9. Получает реальные открытые позиции с обеих бирж.
10. Сверяет Django open trades с фактическими биржевыми позициями.
11. Отбирает ликвидные symbols, добавляет recovery symbols и строит итоговый universe.
12. Объединяет рыночные ограничения:
    - `stepSize`
    - `minQty`
    - `minNotional`
13. Выставляет isolated margin и leverage на обеих биржах.
14. Создает общие orderbook providers.
15. Делит symbols на chunks.
16. Создает `Trader` instances, общий `TradeCounter` и `RuntimeRiskLock`.
17. Восстанавливает уже открытые сделки в нужные `Trader`.
18. Запускает все `Trader` workers.

Если на любом шаге обнаружена критическая проблема, старт прерывается до начала торговли.

## 4. Что делает каждый Trader

Каждый `Trader` отвечает за свой chunk symbols и работает по одному циклу:

1. Подписывается на обновления orderbook по своим symbols.
2. Хранит локальный state по каждому symbol:
   - baseline spread;
   - active trade;
   - cooldown;
   - pending close sync;
   - unmanaged exposure;
   - запрет на новые входы.
3. На каждом обновлении книги считает VWAP-цены и spread.
4. Если сделки нет:
   - обновляет EMA baseline;
   - проверяет лимит `TradeCounter`;
   - проверяет cooldown;
   - проверяет `RuntimeRiskLock`;
   - проверяет экономический edge с учетом fee/slippage/funding/latency buffers;
   - при выполнении условий запускает открытие сделки.
5. Если сделка есть:
   - следит за drawdown/liquidation guard;
   - проверяет прибыль на закрытие;
   - дополнительно проверяет timeout по watchdog.

## 5. Как открывается сделка

При сигнале на вход сервис делает следующее:

1. Блокирует symbol через `busy`, чтобы не открыть дублирующую сделку.
2. В shadow mode только пишет сигнал в JSONL и не отправляет ордера.
3. Резервирует слот в `TradeCounter`.
4. Пишет `open_intent` в execution journal.
5. Одновременно отправляет market orders на обе биржи:
   - `buy`: long primary, short secondary;
   - `sell`: short primary, long secondary.
6. После исполнения:
   - берет реальные fill prices и комиссии;
   - пересчитывает фактический open spread;
   - создает запись сделки в Django;
   - пишет успешную синхронизацию в execution journal;
   - сохраняет `activeTrade` в памяти runtime.

## 6. Как закрывается сделка

Когда сделка уже открыта, входы больше не рассматриваются. Закрытие идет так:

1. Сначала проверяются аварийные причины:
   - drawdown;
   - liquidation risk.
2. Затем проверяется profit-close.
3. Затем timeout-close.
4. При закрытии сервис:
   - блокирует symbol;
   - пишет `close_started` в execution journal;
   - получает фактические позиции с обеих бирж;
   - проверяет, что размер позиции совпадает с Django trade в пределах tolerance;
   - отправляет reduce-only close orders;
   - сохраняет fill sizes, цены и комиссии;
   - рассчитывает итоговый PnL;
   - отправляет close result в Django;
   - после успешной sync очищает локальный state и освобождает слот `TradeCounter`.

## 7. Stop и shutdown

Остановка runtime проходит контролируемо:

1. Новые входы блокируются.
2. Все активные сделки переводятся в режим закрытия.
3. Если есть `pendingCloseSync`, сначала добивается синхронизация с Django.
4. Если есть `unmanagedExposure`, запускаются cleanup retries до подтвержденного flat-состояния.
5. Runtime считается полностью остановленным только когда exposure снят или явно разрешена остановка без закрытия.

Если exposure остался, runtime не делает новые входы, но продолжает жить в защитном состоянии до завершения cleanup/sync.

## 8. Работа с ошибками и защитные механизмы

### 8.1. Ошибки на входе

- Невалидный payload -> HTTP 400, старт не происходит.
- Неверный `X-Service-Token` -> доступ к lifecycle/diagnostic routes запрещен.
- Попытка `stop` не того `runtime_config_id` -> операция отклоняется.

### 8.2. Ошибки bootstrap

- Нет process lock -> второй runtime не стартует.
- В execution journal есть незавершенные intents -> старт блокируется до ручной разборки.
- Не совпали Django open trades и реальные позиции на бирже -> старт блокируется.
- Не удалось восстановить сделки по symbols/chunks -> старт блокируется.
- Не удалось подтвердить leverage/margin setup -> symbol исключается или runtime не стартует, если конфигурация невалидна.

### 8.3. Ошибки открытия сделки

- Если одна нога открылась, а вторая нет, сервис пытается:
  - сделать reverse reduce-only rollback;
  - затем полную cleanup-проверку по реальным позициям.
- Если cleanup подтвержден, слот освобождается и symbol уходит в cooldown.
- Если cleanup не подтвержден:
  - фиксируется `unmanagedExposure`;
  - включается `RuntimeRiskLock`;
  - новые входы глобально блокируются;
  - cleanup повторяется до flat-состояния.

### 8.4. Ошибки закрытия сделки

- Если одна нога закрылась, а вторая нет, сервис сохраняет частичный результат и повторяет попытки по оставшейся ноге.
- Если биржа не может подтвердить фактический размер позиции, close считается недостоверным и будет повторен позже.
- Если close на бирже уже произошел, а Django sync не прошел:
  - состояние сделки локально сохраняется;
  - слот `TradeCounter` не освобождается;
  - создается `pendingCloseSync`;
  - сервис повторяет sync с Django до успеха.

### 8.5. Ошибки во время работы runtime

- Любое обнаруженное unmanaged exposure или reconciliation mismatch включает `RuntimeRiskLock`.
- Пока `RuntimeRiskLock` активен, новые сделки не открываются.
- Если worker падает неожиданно, ошибка логируется, отправляется в Django как runtime error, после чего запускается controlled stop.
- Если order placement завершился transport error, exchange clients пытаются сверить фактический статус ордера через свои механизмы reconciliation, прежде чем считать операцию проваленной.

## 9. Итоговая логика безопасности

Сервис старается не продолжать торговлю в неясном состоянии. Если он не уверен в том, что:

- позиции совпадают с Django;
- cleanup завершен;
- close корректно синхронизирован;
- runtime flat и безопасен для новых входов,

то новые сделки блокируются, а процесс остается в recovery/reconciliation режиме до подтверждения состояния.

## 10. Realtime-проверка сигналов

Entry, profit-close и liquidation/drawdown-close запускаются от `onUpdate` shared orderbook providers. Для каждого symbol поддерживается только один active decision path: если новая книга пришла во время текущей проверки или исполнения, runtime помечает symbol на повторную проверку и после завершения текущего path переоценивает его по самому свежему локальному snapshot. Это не создает неограниченную очередь задач по одному symbol.

Перед расчетом VWAP и сигналов runtime проверяет свежесть пары книг: обе книги должны быть не старше `ORDERBOOK_PAIR_MAX_AGE_MS`, а разница их локальных timestamps не должна превышать `ORDERBOOK_PAIR_MAX_SKEW_MS`. Если freshness/skew нарушены, entry/profit/liquidation signal не исполняется на этой паре snapshot.

Timeout-close остается interval-based risk-control и проверяется watchdog раз в 10 секунд. Cleanup, pending close sync и reconciliation также остаются защитными retry-процессами, а не latency-critical сигналами.

При реальном open/close в лог пишутся `latency_metrics` с этапами socket update -> check start -> signal detected -> order submit -> exchange ack, а для close дополнительно фиксируется `full_close_sync_duration_ms`.

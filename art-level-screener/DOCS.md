# DOCS — art-level-screener

Бэкенд расчёта горизонтальных уровней Binance USDⓈ-M Futures. Три независимых
Node.js/TypeScript-сервиса, связанные через Redis. Предназначен как источник
данных для раздела «скринер уровней» во фронтенде `quasar/arbitration-art-q`.

Документация описывает текущее фактическое состояние системы. Обновляется при
каждом значимом изменении (архитектура, API, схема Redis, env, команды, потоки
данных, риски).

## Архитектура (поток данных)

```
Binance Futures
   │  REST snapshot + 1m WS
   ▼
binance-futures-connector ──► Redis  binance-futures:candles:<sym>:<tf>
                                      binance-futures:price/updated/symbols
                                       │
              ┌────────────────────────┴───────────────────────────┐
              ▼ (раз в 10с)                        (сырые свечи по запросу) │
      levels-processor ──► Redis  levels:screener:<tf>                      │
                                  levels:detail:<tf>:<sym>                  │
                                  levels:timeframes                         │
                                       │                                    │
        (timeframes · detail · health) ▼            (расчёт уровней on-demand) ▼
                                  levels-api (Fastify) ──────────────────► JSON для скринера
                                       │
                                       ▼
                            quasar/arbitration-art-q (раздел скринера)
```

Сервисы развязаны через Redis: каждый можно запускать/перезапускать независимо.
Контракт между ними — ключи Redis (см. схемы в разделах ниже); контракт наружу
(для фронтенда) — HTTP API сервиса `levels-api`.

`levels-api` для `GET /screener/:tf` читает сырые свечи коннектора
(`binance-futures:*`) и считает уровни на лету по параметрам запроса; список
таймфреймов (`GET /timeframes`) отдаёт из своей конфигурации (env `TIMEFRAMES`).
Из процессорных ключей (`levels:*`) читает только `GET /screener/:tf/:symbol`
(детали). Поэтому экран скринера (список ТФ + расчёт) полностью независим от
процессора — нужны лишь свечи коннектора.

`level-notifier` — четвёртый сервис (worker, без HTTP): раз в ~10с тянет активные
per-user конфиги уведомлений из Django и шлёт Telegram-алерты, когда цена монеты
подходит к уровню. Уровни он считает сам из свечей коннектора тем же кодом, что и
`levels-api` (`lib/screener-compute`), поэтому от `levels-processor` тоже не
зависит. Подробности — в разделе `services/level-notifier` ниже.

### Порядок запуска

Нужен доступный Redis (по умолчанию `redis://127.0.0.1:6379`).

1. `binance-futures-connector` — наполняет Redis свечами.
2. `levels-processor` — раз в 10с считает уровни из свечей.
3. `levels-api` — отдаёт рассчитанные уровни по HTTP.

Каждый сервис: `cp .env.example .env` → `npm install` → `npm run dev`
(или `npm run build && npm start`). Подробности — в `README.md` сервиса.

### Согласование префиксов Redis

Префиксы ключей должны совпадать по цепочке:

- `binance-futures-connector` пишет под `REDIS_KEY_PREFIX` (по умолч. `binance-futures`);
- `levels-processor` читает из `SOURCE_PREFIX` (= префикс коннектора) и пишет под
  `OUTPUT_PREFIX` (по умолч. `levels`);
- `levels-api` читает свечи из `SOURCE_PREFIX` (= префикс коннектора) для
  on-demand расчёта `/screener/:tf`; из `LEVELS_PREFIX` (= `OUTPUT_PREFIX`
  процессора) читает только детали монеты `/screener/:tf/:symbol`. Список ТФ
  берёт из своей конфигурации (env `TIMEFRAMES`), а не из Redis.

Рассогласование `SOURCE_PREFIX` у API и коннектора → `/screener/:tf` отдаёт `404`
(нет свечей для расчёта). `TIMEFRAMES` у API должен соответствовать ТФ коннектора.

---

## services/binance-futures-connector — коннектор свечей (Node.js/TS)

Собирает свечи Binance USDⓈ-M Futures и пишет в Redis для потребителей. Работает
только с публичными данными биржи — **exchange API keys не требуются**. Подробности
запуска и схемы Redis — в [README сервиса](services/binance-futures-connector/README.md).

### Поток работы

1. **Discovery** (`SymbolDiscovery`). `exchangeInfo` + `ticker/24hr` → USDT-перпетуалы
   со статусом TRADING и суточным `quoteVolume ≥ MIN_24H_VOLUME_USDT`, сортировка
   по объёму.
2. **Распределение** (`ConnectorManager`). Символы делятся на группы по
   `SYMBOLS_PER_CONNECTOR` (20), каждая → отдельный `Connector` с одним WS.
3. **Онбординг без гэпа** (`Connector.onboard`). Включается буферизация live-1m,
   затем тянется снапшот всех ТФ (REST, `SNAPSHOT_DEPTH` баров), серии
   засеиваются, буфер доливается поверх — данные между снапшотом и сокетом не
   теряются. Тот же приём при добавлении символов и reconnect.
4. **Live-агрегация** (`CandleAggregator`). По combined 1m-сокету на каждый апдейт
   обновляется 1m-серия и пересчитывается текущий бар 5m/15m/1h из 1m-свечей
   интервала (open первой, high/low экстремумы, close последней, volume сумма).
5. **Запись** (`CandleRepository`). Раз в `FLUSH_INTERVAL_MS` (3с) все серии и цены
   группы пишутся одним Redis pipeline.
6. **Ребаланс** (`ConnectorManager.refresh`). Раз в `REFRESH_INTERVAL_MS` (1ч)
   набор пересчитывается без рестарта: выбывшие символы удаляются вместе с
   данными в Redis; новые доливаются в коннектор со свободными слотами или новый.

### Схема Redis (вывод)

| Ключ | Значение |
|------|----------|
| `<prefix>:candles:<SYMBOL>:<tf>` | JSON-массив свечей `{openTime,open,high,low,close,volume}` |
| `<prefix>:price:<SYMBOL>` | последняя цена (число) |
| `<prefix>:updated:<SYMBOL>` | время (мс) последнего live-апдейта — свежесть данных |
| `<prefix>:symbols` | JSON-массив активных символов |

Префикс — `REDIS_KEY_PREFIX` (по умолч. `binance-futures`).

### Лимиты и устойчивость

- **Вес REST** (`WeightRateLimiter`): последовательная очередь с поминутным
  бюджетом (80% от лимита), синхронизация по `X-MBX-USED-WEIGHT-1M`.
- **Один сокет на группу**: combined-стрим `wss://fstream.binance.com/market/stream`
  с динамическими `SUBSCRIBE`/`UNSUBSCRIBE` — добавление/удаление символов без
  переподключения. Важно: путь `/market/stream` (не `/ws`) — `/ws` принимает
  подписку, но не отдаёт поток; сообщения приходят в обёртке `{stream, data}`.
- **Reconnect** с экспоненциальной задержкой и переснапшотом (закрытие гэпа).
- **Watchdog «немого» сокета**: если за `WS_STALE_TIMEOUT_MS` (30с) нет ни
  сообщений, ни ping — `terminate()` → reconnect. Закрывает дыру с half-open
  соединением, где `close` не приходит.
- **Свежесть данных**: ключ `:updated:<SYMBOL>` (мс последнего live-апдейта) —
  потребитель отличает живые данные от «замороженных» при обрыве.
- **Graceful shutdown** по SIGINT/SIGTERM.

### Ключевые решения

- **Снапшот всех ТФ по REST** (а не агрегация истории из 1m) — точная история
  старших ТФ сразу; live из 1m лишь поддерживает текущие бары.
- **Свеча в Redis — массив OHLCV-объектов под одним ключом**: потребитель читает
  серию одним `GET`. Оптимально под расчёт уровней (не точечные апдейты).
- **Декомпозиция по слоям** (binance / aggregation / redis / core) — каждый класс
  с одной ответственностью; стек ws + ioredis + undici + pino, strict TS.
- **Нативные клиенты, без `ccxt`** — прямые HTTP (undici) и WS (`ws`) к официальным
  эндпоинтам Binance. Согласуется с правилом репозитория для торговых TS-сервисов.

---

## services/levels-processor — расчёт уровней (Node.js/TS)

Читает свечи из Redis (от коннектора), считает горизонтальные уровни и публикует
для скринера. Детали и схема Redis — в
[README сервиса](services/levels-processor/README.md).

### Поток

1. **Чтение** (`CandleSource`). Раз в `INTERVAL_MS` (10с) берёт `:symbols` и все
   `:candles:<sym>:<tf>` одним `MGET`.
2. **Расчёт** (`levels/`): `extrema` (значимые экстремумы по окну `PERIOD`) →
   active/broken → реальные касания с `NATR`-допуском и `MIN_GAP` → фильтр
   `MIN_TOUCHES`. Дистанция до ближайшего активного уровня — в **NATR**.
3. **Запись** (`LevelsRepository`). Один pipeline с TTL (`OUTPUT_TTL_MS`):
   - `levels:screener:<tf>` — массив монет, **отсортирован по `distanceNatr` ↑**
     (готовый экран скринера);
   - `levels:detail:<tf>:<sym>` — полные уровни для drill-down;
   - `levels:timeframes` — список ТФ.
4. **Цикл** (`Application`). Интервал с защитой от наложения проходов; graceful
   shutdown. TTL-ключи → выбывшие монеты исчезают сами.

### Схема Redis (вывод, контракт для levels-api)

| Ключ | Значение |
|------|----------|
| `<prefix>:screener:<tf>` | JSON-массив `ScreenerEntry`, отсортирован по `distanceNatr` ↑ |
| `<prefix>:detail:<tf>:<SYMBOL>` | JSON `SymbolDetail` — полные уровни (active/broken) |
| `<prefix>:timeframes` | JSON-массив обрабатываемых ТФ |

Префикс — `OUTPUT_PREFIX` (по умолч. `levels`). Формы `ScreenerEntry` /
`SymbolDetail` / `LevelView` — см. [API.md](services/levels-api/API.md).

### Алгоритм (кратко)

Допуск зоны касания **адаптивен к волатильности**: `threshold% = NATR_MULTIPLIER · NATR`,
где NATR (Normalized ATR = ATR/цена·100, Wilder ATR) — волатильность в % от цены.
Это масштабирует зону касания по таймфреймам без ручных порогов.

- **Значимые экстремумы**: свеча — экстремум, если её `high`/`low` не уступает
  всем `PERIOD` соседям слева/справа (нестрого); последние `EXTREMA_WINDOW` свечей
  у правого края пропускаются.
- **active / broken**: active — после уровня пробоя нет (рисуется до правого края);
  broken — пробит ровно один раз (повторный пробой → уровень отбрасывается), не
  старше `MAX_BROKEN_AGE` свечей, и цена сейчас по ту сторону (с `breakoutDistance`).
- **Реальные касания** (только **справа от формирования** уровня): сколько раз
  цена отдельно возвращалась в полосу `±threshold%` вокруг уровня **после**
  свечи-экстремума, его создавшей. Серия касаний считается от `level.index + 1`
  (сам экстремум — это уровень, а не касание; проход цены до его образования не
  учитывается), с `previousInside = true` на старте, чтобы остаточные свечи сразу
  после пика не засчитались. Подходы ближе `MIN_GAP` свечей считаются одним
  касанием. Уровни с касаниями `< MIN_TOUCHES` отбрасываются.
- **Дистанция в NATR** (`distancePct / natr`) до ближайшего активного уровня —
  главная метрика близости для скринера.

### Ключевые решения

- **Индекс per-TF + детали per-symbol**: API отдаёт `screener:<tf>` почти как
  есть (фильтр по ТФ = выбор ключа, сортировка уже готова); детали — отдельно.
- **TTL вместо ручной очистки** выбывших символов — данные самосогласованы.
- **Алгоритм портирован 1:1 с Python-прототипа `level_screener`** (сверено: NATR,
  уровни, дистанция совпали до знака). Прототип остался в отдельном репозитории
  `art-levels-screener` как эталон и для визуализации разметки в PNG — в рантайм
  арбитража не входит.

---

## services/levels-api — HTTP API (Node.js/Fastify/TS)

Считает экран скринера по запросу из сырых свечей коннектора и отдаёт в JSON;
служебные эндпоинты читают рассчитанные ключи процессора. Полная спецификация
для интеграции фронтенда — в [API.md сервиса](services/levels-api/API.md);
интерактивно — Swagger UI на `/docs`, OpenAPI на `/docs/json`.

### Эндпоинты

| Метод | Путь | Назначение |
|-------|------|------------|
| GET | `/health` | Статус сервиса и Redis (`LevelsReader.ping`) |
| GET | `/timeframes` | Поддерживаемые ТФ из конфигурации API (env `TIMEFRAMES`) |
| GET | `/config` | Env-дефолты детекции уровней + кэпы анализа + Binance REST/weight-лимит — для **клиентского** расчёта анализа (фронт считает анализ сам и должен использовать те же параметры, что скринер) |
| GET | `/screener/:tf` | Экран скринера: **расчёт on-demand** из свечей коннектора по параметрам запроса + фильтры/сортировка/пагинация |
| GET | `/screener/:tf/:symbol` | Полные уровни по монете (`levels:detail:<tf>:<sym>`, рассчитанные процессором) |
| GET | `/analysis/:tf/:symbol` | **Серверный fallback** (не на фронт-пути): анализ пробоев по монете, свечи+трейды напрямую с Binance REST. Фронт считает анализ сам — см. ниже |

### Расчёт `/screener/:tf` on-demand

Код в `src/levels/` (порт алгоритма процессора), `src/redis/candle-source.ts`
(чтение свечей коннектора), `src/lib/screener-compute.ts` (оркестрация).

Поток одного запроса:

1. **Объёмный пре-фильтр** (если задан `minVolume > 0`). Читает `:symbols` и
   `:candles:<sym>:<VOLUME_TIMEFRAME>` (`1h`), считает USDT-оборот = сумма
   `volume·close` по последним `VOLUME_LOOKBACK` (24) свечам, отбрасывает монеты
   ниже порога. Дешёвый отсев до тяжёлого расчёта уровней.
2. **Расчёт уровней** только по прошедшим монетам: читает `:candles:<sym>:<tf>`,
   считает уровни (`calculateHorizontalLevels`) с эффективными параметрами,
   формирует `ScreenerEntry`, сортирует по `distanceNatr` ↑. Если запрошенный ТФ
   совпадает с `VOLUME_TIMEFRAME`, свечи переиспользуются (без повторного `MGET`).
3. **Post-фильтры/сортировка/пагинация** (`applyScreenerQuery`): `side`,
   `maxDistanceNatr`, `minActive`, `search`, `sort`, `order`, `limit`, `offset`.

**Параметры расчёта.** Дефолты — из env (`PERIOD`, `EXTREMA_WINDOW`,
`MAX_BROKEN_AGE`, `MIN_TOUCHES`, `MIN_GAP`, `NATR_MULTIPLIER`, `ATR_PERIOD`,
совпадают с дефолтами процессора). Per-request переопределяются только
`natrMultiplier` (погрешность зоны касания) и `minGap` (разрыв между касаниями);
`minVolume` управляет пре-фильтром. Остальные параметры фиксированы дефолтами.

**Коды ответа.** `404` — нет источника для расчёта (пустой `:symbols` или ТФ без
свечей у всех монет). `200` с `total: 0` — источник есть, но объёмный фильтр
отсёк все монеты (это валидный пустой результат, не ошибка).

### `/config` — параметры для клиентского анализа

`GET /config` (`src/routes/config.ts`) отдаёт env-дефолты детекции уровней
(`app.config.levels`), кэпы анализа (`app.config.analysis`) и Binance REST-базу +
weight-лимит. Нужен потому, что **анализ пробоев считается на фронте** (см. ниже):
браузер должен использовать те же параметры детекции, что и скринер, иначе найдёт
другие уровни. Фронт фетчит `/config` один раз и кэширует (`levelsApi.config()`).

### Анализ пробоев `/analysis/:tf/:symbol` (серверный fallback)

> **Где реально считается анализ.** В текущей архитектуре анализ пробоев считается
> **в браузере**, а не этим эндпоинтом. Фронт (`quasar/.../src/stores/levels/compute/`)
> — зеркало `src/{levels,lib/analysis-compute,binance}` — сам тянет свечи/трейды
> **напрямую с Binance** (own IP, weight-лимит распределяется по пользователям) и
> шлёт готовый `AnalysisResult` в Django на сохранение. `/analysis` оставлен как
> серверный fallback (отладка/возможный батч), в фронт-путь не подключён.
> **Дублированный алгоритм требует синхронизации** (AGENTS §5.2, §9): любая правка
> детекции/скана/проверки здесь дублируется во фронтовом `compute/`.

Бэктест пробоев горизонтальных уровней по одной монете. Код в
`src/lib/analysis-compute.ts` (движок), `src/binance/rest-client.ts` +
`src/binance/rate-limiter.ts` (нативный Binance REST на undici), `src/routes/analysis.ts`.

Источник данных — **Binance USDⓈ-M Futures REST напрямую**, не Redis: так honored
произвольное число свечей (`candles`, до `ANALYSIS_MAX_CANDLES`) и используются
официальные klines/aggTrades. Публичные данные, без ключей и подписи (правило §5.2).

Поток одного запроса:

1. **Свечи**: `GET /fapi/v1/klines` — `candles` свечей по `:tf` (дефолт `ANALYSIS_DEFAULT_CANDLES=1000`, максимум `ANALYSIS_MAX_CANDLES=3000`); значения >1500 грузятся пагинацией назад по `endTime` (`klinesHistory`).
2. **Уровни**: тот же код, что у `/screener` (`src/levels/`: `findExtrema` +
   `countTouches` + `computeNatr`). Эффективные параметры: `natrMultiplier`
   (погрешность зоны в долях NATR) и `minGap` из query, остальное — env-дефолты.
   Расхождений с экраном скринера нет.
3. **Пробои**: проход слева направо — для каждого валидного уровня (касаний
   `≥ MIN_TOUCHES` **до** пробоя) первая свеча, **закрывшаяся** за уровнем
   (top → close выше, bottom → close ниже). По закрытию, а не по фитилю: тычок
   одной свечи за уровень, закрывшийся обратно, пробоем не считается. Фильтр по
   `direction`.
4. **Проверка по трейдам** (`GET /fapi/v1/aggTrades`, пагинация по времени), две фазы:
   - **Фаза 1 — пересечение.** Скан трейдов по всей свече пробоя
     `[openTime, +длительность ТФ]` → первый трейд за **уровнем** = `crossTime`
     (пересечение происходит внутри свечи, не на её открытии). Используется сам
     уровень, а не зона погрешности (`natrMultiplier` — допуск только для детекции
     уровня), поэтому cross находится почти для каждого пробоя.
   - **Фаза 2 — движение.** От `crossTime` отсчитывается `maxBreakoutSeconds`; в этом
     окне берётся **пиковое** движение за уровень (`movePct`) и время до пика
     (`elapsedMs`), плюс первый трейд, достигший `minMovePct` (`reachTime`).
     **match** = пик достиг `minMovePct` (`reachTime` найден). Движение и время
     заполняются для **каждого** пробоя, не только совпавших.
5. **Дедуп**: кластер близких экстремумов даёт несколько уровней на одной цене,
   пробивающих (почти) одну и ту же свечу — это один пробой. Схлопываются пробои
   одного направления с ценами в пределах зоны погрешности и свечами в пределах
   `MAX_BROKEN_AGE` свечей (остаётся самый ранний, касания — максимум кластера).
6. **Статистика**: `summary` (`breakoutsFound`, `evaluated`, `matched`,
   `matchRate`, `byDirection`) + список `breakouts`.

**Ограничения.**
- Окно одного запроса `aggTrades` — до 1 часа (правило Binance при `startTime`+
  `endTime`); при `maxBreakoutSeconds` > 3600 режется до 1ч. **Глубина истории не
  ограничена** — `startTime`/`endTime` отдают и старые трейды, бэктест работает и
  по давним свечам. `evaluated` исключает лишь пробои без трейдов в окне
  (`reason='no_trades'`).
- Зона касания/пробоя — по одному NATR на всё окно (как в скринере), не адаптивно.
- На каждый пробой ≥ 1 запрос `aggTrades` (до `ANALYSIS_MAX_TRADE_PAGES`) — много
  пробоев = дольше ответ; вес REST держит `WeightRateLimiter` (бюджет
  `BINANCE_WEIGHT_LIMIT_PER_MIN`).

**Коды ответа.** `404` — мало свечей или Binance отклонил пару/ТФ (4xx);
`502` — ошибка Binance (5xx).

### Ключевые решения

- **Fastify + TypeBox**: одни схемы дают валидацию query/params, сериализацию
  ответов и OpenAPI. Типы запросов/ответов выводятся из схем (без `any`).
- **Расчёт по запросу вместо чтения кеша**: экран считается из свежих свечей
  под параметры пользователя (объём, погрешность, minGap). Кеша нет — каждый
  запрос читает свечи и считает уровни (CPU + `MGET` на запрос); за счёт этого
  параметры динамические и результат всегда актуален. Объёмный пре-фильтр
  сокращает число расчётов уровней.
- **Алгоритм продублирован из процессора** (`src/levels/`, порт 1:1). Контракт
  вывода (`ScreenerEntry`/`LevelView`) — TypeBox-схемы в `src/schemas/level.ts`.
  При правке формул синхронизировать обе копии (`levels-processor/src/levels/` и
  `levels-api/src/levels/`). `/analysis` детектирует уровни **той же копией
  `levels-api/src/levels/`**, что и `/screener` — внутри API расхождений нет;
  риск расхождения остаётся только между API и процессором (общего пакета нет).
- **Анализ берёт данные с Binance, а не из Redis**: `/analysis` независим от
  коннектора и процессора (свечи и трейды тянутся напрямую). Трейды в пайплайне
  больше нигде не используются — только здесь.
- **Служебные эндпоинты**: `/timeframes` отдаёт ТФ из конфигурации (env
  `TIMEFRAMES`) — не зависит от процессора; `/health` пингует Redis;
  `/screener/:tf/:symbol` отдаёт `levels:detail:*` процессора как есть (без
  параметров расчёта). Детальный роут фронтендом пока не используется.
- **Без аутентификации**: сервис рассчитан на внутреннюю сеть. Если API уходит за
  периметр — добавить auth (см. раздел безопасности в `AGENTS.md` репозитория).

---

## services/level-notifier — Telegram-уведомления по уровням (Node.js/TS)

Worker без HTTP. Раз в `INTERVAL_MS` (10с) опрашивает Django, считает уровни и
шлёт пользователям Telegram-уведомления, когда цена подходит к активному уровню по
их персональным настройкам. Один конфиг на пользователя; один бот на сервис,
`chat_id` — у каждого пользователя свой.

### Поток

```
Django  GET /api/levels/notification-configs/  (X-Service-Token)
   │   активные конфиги (enabled=true, chat_id≠"") + favorites владельца
   ▼
level-notifier (каждые 10с):
   1. группирует конфиги по (timeframe, natrMultiplier, minGap, minVolume)
   2. на группу — computeScreener(свечи коннектора)  ← Redis binance-futures:*
   3. на конфиг — фильтр favorites → дистанция nearest-уровня ≤ distanceValue
   4. дедуп (Redis level-notifier:state:*) → Telegram sendMessage
   ▼
Telegram Bot API  + ссылка ${SITE_BASE_URL}/#/levels/SYMBOL?tf=TF
```

Группировка по параметрам расчёта означает: одинаковые наборы (tf+natr+gap+vol)
считаются один раз за тик, а не на каждого пользователя.

### Сопоставление настроек с расчётом

- `natr_multiplier`, `min_gap` → `LevelParams` (через `resolveLevelParams`):
  меняют набор уровней, поэтому подаются **в расчёт**, а не фильтруют результат.
- `min_volume` → пре-фильтр объёма `computeScreener` (сумма `volume·close` по
  `VOLUME_LOOKBACK` свечам `VOLUME_TIMEFRAME` — те же `1h × 24`, что у скринера).
- `distance_mode`+`distance_value` → порог по ближайшему активному уровню
  (`nearest.distancePct` или `nearest.distanceNatr`).
- `only_favorites` → ограничение набора символов списком `favorites` владельца.

### Дедуп (анти-спам)

Состояние в Redis, владелец — сам сервис (Django сервис **не пишет**). Ключ
`level-notifier:state:<ownerId>:<tf>:<symbol>` = `{levelPrice, notifiedAt}`,
TTL = `NOTIFY_COOLDOWN_MS`. Политика: edge-trigger на вход в зону + кулдаун
(30 мин) на пару (пользователь, ТФ, монета, уровень). Уведомление шлётся, когда
по символу нет состояния, в зону вошёл **другой** уровень, или кулдаун истёк
(ключ сам протух). Микро-сдвиг цены уровня (< 0.15%) считается тем же уровнем.

### Telegram

**Отправка алертов** (`telegram/telegram-client.ts`): `POST .../bot<token>/sendMessage`
(undici), `parse_mode=HTML`. Ошибка `4xx` (неверный `chat_id` / пользователь не
нажал `/start`) — лог `warn` без ретраев (ретрай не поможет); сетевые/`5xx` —
ретрай с backoff. Сбой отправки не валит тик.

**Приём `/start` → ответ `chat_id`** (`telegram/command-listener.ts`): отдельный
цикл long polling (`getUpdates`, не webhook — работает без публичного HTTPS). На
`/start` бот отвечает пользователю его `chat_id` (в `<code>`-блоке, чтобы скопировать
тапом) — чтобы тот вставил его в диалог уведомлений. Подтверждённый `offset` хранится
в Redis (`level-notifier:telegram:offset`), поэтому после рестарта старые `/start`
не переотвечаются. Запускается из `Application.start()` рядом с тиком; на shutdown
останавливается. `getUpdates`-цикл и `sendMessage` используют один токен.

**Бот** создаётся через @BotFather. Важно: у бота **не должно быть webhook** —
Telegram запрещает `getUpdates` при активном webhook (`409 Conflict`), и допускает
только **одного** консьюмера `getUpdates` на токен. Поэтому: отдельный бот под
уведомления (не переиспользовать бота, у которого стоит webhook), один инстанс
`level-notifier`. При `409`/сетевой ошибке цикл логирует `warn` и делает backoff.
Пока пользователь не нажал `/start`, `sendMessage` ему вернёт `400 chat not found`.

### Конфигурация (env)

| Переменная | Назначение | Дефолт |
|---|---|---|
| `REDIS_URL` | Redis (свечи + state) | `redis://127.0.0.1:6379` |
| `SOURCE_PREFIX` | префикс свечей — **= `REDIS_KEY_PREFIX` коннектора** | `binance-futures` |
| `INTERVAL_MS` | период тика | `10000` |
| `NOTIFY_COOLDOWN_MS` | кулдаун анти-спама | `1800000` (30 мин) |
| `DJANGO_API_URL` | база Django c `/api` | `http://127.0.0.1:8000/api` |
| `SERVICE_SHARED_TOKEN` | сервис-токен — **= Django/engine** | (обяз.) |
| `TELEGRAM_BOT_TOKEN` | токен бота от @BotFather | (обяз., только в `.env`) |
| `SITE_BASE_URL` | origin фронта для ссылки | `http://localhost:9000` |
| `VOLUME_TIMEFRAME` / `VOLUME_LOOKBACK` | источник объёмного пре-фильтра | `1h` / `24` |
| `PERIOD`…`ATR_PERIOD` | дефолты уровней (как у processor/api) | см. `.env.example` |
| `LOG_LEVEL` | уровень логов | `info` |

`SERVICE_SHARED_TOKEN` и `TELEGRAM_BOT_TOKEN` — секреты: реальные значения только
в `.env` (gitignored), в `.env.example` — плейсхолдеры.

### Алгоритм уровней — дубликат

`src/levels/*` + `src/lib/screener-compute.ts` + `src/redis/candle-source.ts` —
копия `levels-api` (источник правды). Любая правка детекции уровней/касаний/NATR
делается синхронно во всех копиях (AGENTS §5.2, `compute/README.md`).

### Запуск

`cp .env.example .env` (заполнить токены) → `npm install` → `npm run dev`
(или `build`+`start`). Нужны живые Redis, `binance-futures-connector` и Django.
Зарегистрирован в корневом `ecosystem.config.cjs` (`pm2 start ecosystem.config.cjs`).

---

## Интеграция с arbitration-art

- **Бэкенд скринера**: `levels-api` — источник данных для раздела «скринер
  уровней» во фронтенде `quasar/arbitration-art-q` (route `/levels`, store
  `levels`, см. его `DOCS.md` §25B).
- **Контракт наружу**: HTTP API (`API.md` + OpenAPI на `/docs/json`). Фронт
  использует `GET /timeframes` и `GET /screener/:tf` (сортировка по близости,
  пагинация по 20). Параметры расчёта (`minVolume`, `natrMultiplier`, `minGap`)
  идут в query `/screener/:tf` — задаются в шапке экрана скринера. Свечи для
  графиков фронт берёт напрямую с Binance, не из `levels-api`.
- **Страница монеты + анализ**: анализ считается **на фронте**. Фронт берёт
  параметры детекции из `GET /config` (чтобы совпасть со скринером), сам тянет
  свечи/трейды напрямую с Binance и считает анализ копией этого алгоритма
  (`quasar/.../src/stores/levels/compute/`), затем шлёт готовый `AnalysisResult` в
  **Django** (`POST /api/levels/analyses/`) на сохранение под пользователем. Сюда
  (`/analysis`) фронт **не ходит** — это серверный fallback. Дублированный
  алгоритм требует синхронизации (AGENTS §5.2). См. `arbitration-art-django/DOCS.md` §10A.
- **Уведомления по уровням**: `level-notifier` читает per-user конфиги из Django
  (`GET /api/levels/notification-configs/`, сервис-токен) и шлёт Telegram-алерты со
  ссылкой `${SITE_BASE_URL}/#/levels/SYMBOL?tf=TF` на страницу монеты во фронте.
  Конфиги создаются из диалога «уведомления» в шапке скринера
  (`quasar/.../LevelsNotificationsDialog.vue`, `PUT /api/levels/notification-config/`).
  См. `arbitration-art-django/DOCS.md` §10A и фронт `DOCS.md` §25B.
- **База на фронте**: `process.env.LEVELS_API_URL` (по умолч. `http://127.0.0.1:3000`).
- **Поллинг**: `/screener/:tf` считается под запрос — каждый ответ свежий
  (`updatedAt` = время расчёта). Для живого экрана фронт поллит список каждые
  ~10с с теми же параметрами.
- **CORS**: `levels-api` отдаёт `CORS_ORIGIN` (по умолч. `*`); для прода
  ограничить до origin фронтенда и сделать сервис доступным по HTTPS (иначе
  mixed content на HTTPS-фронте).

## Production-сборка (Docker / Dokploy)

Каждый из четырёх сервисов собирается в **свой** образ из собственного каталога
(`services/<service>/`). У каждого — отдельный `Dockerfile` и `.dockerignore`. В
Dokploy это четыре независимых приложения; деплоить и масштабировать их можно по
отдельности (так же, как сервисы развязаны через Redis в рантайме).

`Dockerfile` — multi-stage (одинаковый шаблон у всех, аналог
`arbitration-bot-engine/Dockerfile`):

- Stage 1 (`builder`) на `node:22-slim`: ставит **все** зависимости
  (`npm ci` по `package-lock.json`), компилирует TypeScript (`npm run build` →
  `tsc` → `./dist`).
- Stage 2 (`runtime`) на `node:22-slim`: ставит **только** прод-зависимости
  (`npm ci --omit=dev` — без `tsc`/`tsx`/`@types/*`), копирует `dist/` из builder.
  PID 1 — `tini` для корректного SIGTERM от Dokploy/Docker. Запуск от non-root
  `node` user. Старт — `node dist/index.js`.

Пакетный менеджер образа — **npm** (`package-lock.json` есть у всех четырёх
сервисов). `pnpm-lock.yaml`, если лежит рядом, в сборке не участвует и срезан
`.dockerignore`. `.dockerignore` также режет `node_modules/`, `dist/`, `.env*`
(кроме `.env.example`), `.git/`, доки — чтобы локальный `.env` (у `level-notifier`
там сервис-токен и Telegram-токен) не попал в образ.

Build context для Dokploy (на каждый сервис):

- **Build Context** / **Dockerfile Path** = `art-level-screener/services/<service>/`.
- HTTP-порт открывает **только** `levels-api` (`EXPOSE 3000`, биндит `HOST=0.0.0.0`)
  — его пробрасывать через Traefik/прокси Dokploy. `binance-futures-connector`,
  `levels-processor`, `level-notifier` — воркеры без порта (наружу не публикуются).

Зависимости рантайма и порядок: всем четырём нужен доступный **Redis**
(`REDIS_URL`); смысловой порядок — `binance-futures-connector` → `levels-processor`
→ `levels-api`, `level-notifier` — независимый воркер. Согласование префиксов
Redis (см. раздел «Согласование префиксов Redis») должно соблюдаться и в проде.

Обязательные env vars в Dokploy (полный список — в `.env.example` каждого сервиса):

- **все**: `REDIS_URL`; согласованные префиксы (`REDIS_KEY_PREFIX` коннектора =
  `SOURCE_PREFIX` процессора/api/notifier; `OUTPUT_PREFIX` процессора =
  `LEVELS_PREFIX` api); общий `TIMEFRAMES`.
- **levels-api**: `HOST=0.0.0.0`, `PORT` (дефолт `3000`), `CORS_ORIGIN`
  (на проде ограничить до origin фронтенда).
- **level-notifier**: `DJANGO_API_URL` (с `/api`), `SERVICE_SHARED_TOKEN`
  (**посимвольно** = токен в `arbitration-art-django`), `TELEGRAM_BOT_TOKEN`,
  `SITE_BASE_URL` (origin фронта для ссылки в алерте). См. AGENTS §9.

Риски при деплое:

- **`.env` в образ не кладём.** Все env vars приходят через Dokploy env injection;
  `.dockerignore` страхует от попадания локального `.env` с токенами в образ.
- **Single-instance у воркеров.** `binance-futures-connector` и `levels-processor`
  не имеют distributed lock — держать **по одному** контейнеру на общий Redis,
  иначе двойная запись/двойной расчёт. `level-notifier` хранит дедуп-состояние в
  Redis (`level-notifier:state:*`), но cooldown не атомарен между инстансами —
  тоже один контейнер. `levels-api` — stateless reader, его реплики безопасны.
- **Graceful shutdown.** `tini` доставляет SIGTERM в Node; `levels-api` успевает
  закрыть HTTP-сервер, воркеры — завершить текущий тик.
- **Исходящий доступ.** Коннектору и `levels-api` (`/analysis`) нужен исходящий
  доступ к `fapi.binance.com`/`fstream.binance.com`; `level-notifier` — к Django
  и `api.telegram.org`. В изолированной сети открыть egress.

Локальный smoke build (опционально, из каталога сервиса):

```bash
cd art-level-screener/services/levels-api
docker build -t levels-api:local .
```

## Риски и ограничения

- **Свежие экстремумы у правого края** не детектируются (`EXTREMA_WINDOW` —
  свойство алгоритма): уровень появляется, когда экстремум «устоялся».
- **Зависимость от коннектора**: экран скринера (`/timeframes` + `/screener/:tf`)
  не зависит от процессора — список ТФ из конфигурации, уровни считаются из свечей
  коннектора. Пустой Redis или остановленный коннектор → `/screener/:tf` отдаёт
  `404`/пустые экраны. От процессора зависит только `/screener/:tf/:symbol`
  (детали): без `levels:detail:*` он отдаёт `404`.
- **Стоимость on-demand расчёта**: `/screener/:tf` без кеша читает свечи (`MGET`)
  и считает уровни на каждый запрос — CPU-нагрузка в одном Node-процессе. При
  высокой конкуррентности/частом поллинге это давит на event loop; при росте
  нагрузки рассмотреть кеш по набору параметров или вынос расчёта в worker.
- **API без auth** — не выставлять наружу без добавления аутентификации.
- **Лимиты Binance**: коннектор держит бюджет веса REST; агрессивное снижение
  `REFRESH_INTERVAL_MS` или рост числа символов повышают нагрузку на лимит.
- **Стоимость `/analysis`**: тянет свечи + по запросу `aggTrades` на каждый пробой
  напрямую с Binance в одном Node-процессе. Много пробоев или большое `candles` →
  десятки REST-запросов и заметная задержка ответа; вес делит общий бюджет
  `BINANCE_WEIGHT_LIMIT_PER_MIN` с другими `/analysis`-запросами. На частый вызов
  не рассчитан (исследовательский инструмент, не поллинг).
- **`/analysis` ходит в публичный интернет** (Binance REST) с сервера API — в
  изолированной сети нужен исходящий доступ к `fapi.binance.com`.

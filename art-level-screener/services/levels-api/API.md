# Levels Screener API

HTTP API горизонтальных уровней Binance Futures для скринера. Экран
`GET /screener/{tf}` **считается под запрос** из свечей по параметрам запроса;
ответ — JSON.

- **Base URL:** `http://<host>:<port>` (по умолчанию `http://localhost:3000`)
- **Формат:** JSON, UTF-8
- **CORS:** включён (`CORS_ORIGIN`, по умолчанию `*`)
- **Интерактивная спека:** Swagger UI — `GET /docs`; OpenAPI JSON — `GET /docs/json`
- **Аутентификация:** нет (сервис рассчитан на внутреннюю сеть; добавляется при необходимости)

Экран считается на каждый запрос, поэтому ответ всегда свежий (`updatedAt` =
время расчёта). Для живого экрана делайте **поллинг** каждые 5–10 секунд с теми
же параметрами.

---

## Модели

### LevelView
Один уровень с временем начала и дистанцией до текущей цены. Используется в
`ScreenerEntry.levels`, `nearest` и в `SymbolDetail.active/broken`.

| Поле | Тип | Описание |
|------|-----|----------|
| `price` | number | Цена уровня |
| `time` | integer | **Время начала уровня** — открытие свечи-экстремума (мс, Unix) |
| `kind` | `"top" \| "bottom"` | По максимумам / по минимумам |
| `side` | `"support" \| "resistance"` | Относительно цены: ниже — support, выше — resistance |
| `touches` | integer | Реальное число касаний ценой |
| `distancePct` | number | Дистанция до текущей цены, % |
| `distanceNatr` | number \| null | Дистанция в NATR (`distancePct / natr`); `null` при `natr = 0` |
| `breakoutDistance` | number \| null | Дистанция пробоя, % — только для пробитых, иначе `null` |

### ScreenerEntry
Запись монеты в экране скринера.

| Поле | Тип | Описание |
|------|-----|----------|
| `symbol` | string | Торговая пара, напр. `BTCUSDT` |
| `price` | number | Текущая цена |
| `natr` | number | Волатильность, % от цены (Normalized ATR) |
| `levels` | LevelView[] | **Все активные (непробитые) уровни**, отсортированы по близости (NATR ↑) |
| `nearest` | LevelView \| null | Ближайший активный уровень (= `levels[0]`); `null`, если активных нет |
| `activeCount` | integer | Число активных уровней (= `levels.length`) |
| `brokenCount` | integer | Число недавно пробитых уровней |
| `updatedAt` | integer | Время расчёта, мс (Unix) |

### SymbolDetail
Полные данные по монете и таймфрейму.

| Поле | Тип | Описание |
|------|-----|----------|
| `symbol` | string | Пара |
| `timeframe` | string | Таймфрейм |
| `price` | number | Текущая цена |
| `natr` | number | NATR, % |
| `nearest` | LevelView \| null | Ближайший активный уровень |
| `active` | LevelView[] | Активные уровни (не пробиты), по близости |
| `broken` | LevelView[] | Недавно пробитые уровни (с `breakoutDistance`) |
| `updatedAt` | integer | Время расчёта, мс |

### AnalysisBreakout
Один пробой уровня и его проверка по трейдам. Используется в `AnalysisResponse.breakouts`.

| Поле | Тип | Описание |
|------|-----|----------|
| `price` | number | Цена уровня |
| `levelTime` | integer | Формирование уровня — открытие свечи-экстремума (мс) |
| `kind` | `"top" \| "bottom"` | top — пробой сопротивления вверх, bottom — пробой поддержки вниз |
| `direction` | `"up" \| "down"` | Направление пробоя |
| `touches` | integer | Число касаний уровня **до** пробоя |
| `breakoutCandleTime` | integer | Открытие свечи первого пробоя — первой свечи, закрывшейся за уровнем (мс) |
| `crossTime` | integer \| null | Трейд, первым вышедший за уровень (мс); `null` — за свечу трейда за уровнем не было |
| `reachTime` | integer \| null | Трейд, на котором достигнуто мин. движение (мс); `null` — не достигнуто |
| `elapsedMs` | integer \| null | Время от пересечения уровня до пикового движения, мс |
| `movePct` | number \| null | Пиковый ход за уровень в окне `[cross, +maxBreakoutSeconds]`, % |
| `matched` | boolean | Пик движения достиг `minMovePct` в окне |
| `reason` | string | `ok` \| `no_trades` \| `no_cross` \| `min_move_not_reached` |

---

## Эндпоинты

### `GET /health`
Статус сервиса и Redis.

```json
{ "status": "ok", "redis": "up" }
```

### `GET /timeframes`
Поддерживаемые таймфреймы (из конфигурации API, env `TIMEFRAMES`). Не зависит от
процессора.

```json
["1m", "5m", "15m", "1h"]
```

### `GET /config`
Параметры расчёта для **клиентского** анализа. Фронтенд считает анализ пробоев в
браузере (см. ниже про `/analysis`) и должен использовать **те же** параметры
детекции уровней, что и скринер, иначе найдёт другие уровни. Эндпоинт отдаёт
авторитетные env-дефолты, чтобы фронт их не хардкодил.

```json
{
  "levels": {
    "period": 40,
    "extremaWindow": 20,
    "maxBrokenAge": 30,
    "minTouches": 2,
    "minGap": 12,
    "natrMultiplier": 0.3,
    "atrPeriod": 14
  },
  "analysis": {
    "defaultCandles": 1000,
    "maxCandles": 10000,
    "aggTradesLimit": 1000,
    "maxTradePages": 12
  },
  "binance": {
    "restUrl": "https://fapi.binance.com",
    "weightLimitPerMin": 2400
  }
}
```

### `GET /screener/{tf}`
Экран скринера по таймфрейму. Уровни считаются под запрос из свечей. Список
**отсортирован по близости к уровню** (`distanceNatr` ↑) — ближайшие первыми.

**Path:** `tf` — таймфрейм (напр. `1h`).

**Query (все опциональны):**

| Параметр | Тип | По умолч. | Описание |
|----------|-----|-----------|----------|
| `minVolume` | number ≥ 0 | — | Минимальный оборот в USDT (сумма `volume·close` по 24 свечам 1h). Пре-фильтр до расчёта уровней; `0`/нет — выключен |
| `natrMultiplier` | number ≥ 0 | env (`0.3`) | Погрешность зоны касания в долях NATR (ширина полосы = `natr·natrMultiplier`) |
| `minGap` | integer ≥ 1 | env (`12`) | Минимальный разрыв в свечах между касаниями (ближе — одно касание) |
| `side` | `support` \| `resistance` | — | Фильтр по стороне ближайшего уровня |
| `maxDistanceNatr` | number ≥ 0 | — | Только монеты ближе этого числа NATR к уровню |
| `minActive` | integer ≥ 0 | — | Минимум активных уровней у монеты |
| `search` | string | — | Подстрока символа (регистр игнорируется) |
| `sort` | `distance` \| `natr` \| `symbol` | `distance` | Поле сортировки |
| `order` | `asc` \| `desc` | `asc` | Направление |
| `limit` | integer 1..500 | `100` | Размер страницы |
| `offset` | integer ≥ 0 | `0` | Смещение |

`minVolume`, `natrMultiplier`, `minGap` влияют на расчёт; остальные параметры —
post-фильтры/сортировка/пагинация поверх результата.

**Ответ `200`:**
```json
{
  "timeframe": "1h",
  "total": 36,
  "count": 1,
  "items": [
    {
      "symbol": "INJUSDT",
      "price": 6.502,
      "natr": 2.93,
      "activeCount": 7,
      "brokenCount": 0,
      "nearest": {
        "price": 6.288, "time": 1780246800000, "kind": "bottom", "side": "support",
        "touches": 3, "distancePct": 3.29, "distanceNatr": 1.12, "breakoutDistance": null
      },
      "levels": [
        { "price": 6.288, "time": 1780246800000, "kind": "bottom", "side": "support", "touches": 3, "distancePct": 3.29, "distanceNatr": 1.12, "breakoutDistance": null },
        { "price": 7.344, "time": 1780340400000, "kind": "top", "side": "resistance", "touches": 2, "distancePct": 12.95, "distanceNatr": 4.42, "breakoutDistance": null }
      ],
      "updatedAt": 1780508042301
    }
  ]
}
```
`total` — число монет после фильтров (до пагинации); `count` — в текущем ответе.
`levels` — все активные уровни монеты, отсортированы по близости (`distanceNatr ↑`).

**Ошибки:** `404` — нет источника для расчёта (нет активных символов или у ТФ нет
свечей). Если источник есть, но объёмный фильтр отсёк все монеты — это `200` с
`total: 0` и пустым `items`, не ошибка.

```json
{ "error": "not_found", "message": "Нет данных для таймфрейма 99z" }
```

### `GET /screener/{tf}/{symbol}`
Полные уровни по монете (рассчитаны процессором, параметры расчёта по умолчанию;
query-параметры расчёта не применяются). `symbol` регистронезависим.

**Ответ `200`** — `SymbolDetail`:
```json
{
  "symbol": "BTCUSDT", "timeframe": "1h",
  "price": 66005.1, "natr": 0.94,
  "nearest": {
    "price": 78077.1, "time": 1778454000000, "kind": "top", "side": "resistance",
    "touches": 16, "distancePct": 18.29, "distanceNatr": 19.46, "breakoutDistance": null
  },
  "active": [
    { "price": 78077.1, "time": 1778454000000, "kind": "top", "side": "resistance", "touches": 16, "distancePct": 18.29, "distanceNatr": 19.46, "breakoutDistance": null }
  ],
  "broken": [],
  "updatedAt": 1780500000000
}
```

**Ошибки:** `404` — нет данных для пары/таймфрейма.

### `GET /analysis/:tf/:symbol`
> **Серверный fallback.** В текущем фронт-пути **не используется**: анализ
> считается в браузере (фронт сам тянет свечи/трейды напрямую с Binance тем же
> алгоритмом — зеркало `lib/analysis-compute.ts` в
> `quasar/arbitration-art-q/src/stores/levels/compute/`) и шлёт готовый результат
> в Django на сохранение. Эндпоинт оставлен для отладки/возможного серверного
> батча. Параметры детекции для клиентского расчёта фронт берёт из `GET /config`.

Анализ пробоев горизонтальных уровней по монете (бэктест по окну свечей).
Свечи и трейды берутся **напрямую с Binance USDⓈ-M Futures REST** (не из Redis):
так honored произвольное число свечей и используются официальные данные. Уровни
детектируются **тем же кодом, что и в `/screener`** (extrema + касания + NATR),
поэтому расхождений с экраном скринера нет. `symbol` регистронезависим.

Алгоритм: загрузить `candles` свечей → найти уровни → для каждого уровня найти
первый пробой — **первую свечу, проколовшую уровень фитилём** (по фитилю, без
закрепления; первый прокол считается, даже если свеча закрылась обратно), проход слева направо → по трейдам найти **момент пересечения
уровня** (`crossTime`, первый трейд за уровнем в пределах свечи пробоя) → в окне
`[crossTime, +maxBreakoutSeconds]` посчитать **пиковое движение** за уровень
(`movePct`, со временем до пика `elapsedMs`) и достижение `minMovePct` (`reachTime`).
`maxBreakoutSeconds` меряется **от пересечения**, а не от открытия свечи. Движение
и время считаются для **каждого** пробоя (не только совпавших); `matched` =
пик достиг `minMovePct`. Погрешность (`natrMultiplier`) — это допуск для детекции
уровня (касания), на трейдовый пробой не влияет (cross — по самому уровню).
Дубли схлопываются: пробои одного направления с ценами в пределах зоны
погрешности и свечами в пределах `MAX_BROKEN_AGE` считаются одним событием.

> **Потребитель:** этот эндпоинт вызывает **Django** (`apps.levels`), которое
> проксирует расчёт и сохраняет результат в БД под пользователем; фронт ходит в
> Django (`/api/levels/analyses/`), а не сюда напрямую. Меняешь форму ответа —
> синхронизируй Django (`_persist_analysis`, сериализаторы).

**Path:** `tf` — таймфрейм; `symbol` — пара (напр. `BTCUSDT`).

**Query (все опциональны):**

| Параметр | Тип | По умолч. | Описание |
|----------|-----|-----------|----------|
| `natrMultiplier` | number ≥ 0 | env (`0.3`) | Погрешность зоны касания/пробоя в долях NATR (полоса = `natr·natrMultiplier`) |
| `minGap` | integer ≥ 1 | env (`12`) | Минимальный разрыв в свечах между касаниями уровня |
| `direction` | `up` \| `down` \| `both` | `both` | Какие пробои анализировать |
| `maxBreakoutSeconds` | integer ≥ 1 | `300` | Макс. время пробоя по трейдам, сек (от пересечения зоны до мин. движения) |
| `minMovePct` | number ≥ 0 | `0.5` | Минимальное движение за уровень, % |
| `candles` | integer ≥ 61 | env `ANALYSIS_DEFAULT_CANDLES` (`1000`) | Сколько свечей грузить; сверху ограничено `ANALYSIS_MAX_CANDLES` (`10000`). Значения >1500 грузятся из Binance пагинацией |

**Ответ `200`** — `AnalysisResponse`:
```json
{
  "symbol": "BTCUSDT",
  "timeframe": "15m",
  "params": { "natrMultiplier": 0.3, "minGap": 12, "direction": "both", "maxBreakoutSeconds": 300, "minMovePct": 0.5, "candles": 500 },
  "candlesAnalyzed": 500,
  "range": { "from": 1780000000000, "to": 1780450000000 },
  "summary": {
    "breakoutsFound": 8, "evaluated": 8, "matched": 5, "unmatched": 3, "matchRate": 0.625,
    "byDirection": { "up": { "found": 5, "matched": 3 }, "down": { "found": 3, "matched": 2 } }
  },
  "breakouts": [
    {
      "price": 66120.0, "levelTime": 1780100000000, "kind": "top", "direction": "up",
      "touches": 3, "breakoutCandleTime": 1780250000000,
      "crossTime": 1780250012000, "reachTime": 1780250090000, "elapsedMs": 78000,
      "movePct": 0.74, "matched": true, "reason": "ok"
    }
  ]
}
```

**Ограничения:**
- **Поиск пересечения — по всей свече пробоя.** `crossTime` (первый трейд за
  уровнем) ищется в окне `[открытие свечи пробоя, +длительность ТФ]` (пересечение
  происходит внутри свечи, не на её открытии). После пересечения
  `maxBreakoutSeconds` отсчитывается **от `crossTime`**, и в этом окне берётся
  пиковое движение. Если за свечу трейда за уровнем не было — `reason='no_cross'`
  (на практике редко, т.к. свеча уровень уже пробила).
- **Окно одного запроса `aggTrades` ≤ 1 час** (правило Binance при заданных
  `startTime`+`endTime`); скан идёт пагинацией по времени до текущего дедлайна.
  Глубина истории **не ограничена** — `startTime`/`endTime` отдают и старые трейды,
  поэтому бэктест работает и по давним свечам. `evaluated` исключает лишь пробои,
  у которых в окне совсем не было трейдов (`reason='no_trades'`).
- Допуск касаний при детекции уровня — по **одному NATR на всё окно** (как в
  скринере), не адаптивно по бару. На трейдовый пробой (`crossTime`/движение) он не
  влияет — там используется сам уровень.
- На каждый пробой идёт один и более запрос `aggTrades` (до `ANALYSIS_MAX_TRADE_PAGES`
  страниц: скан свечи + окно после пересечения) — много пробоев = дольше ответ.

**Ошибки:** `404` — мало свечей для анализа или Binance отклонил пару/ТФ; `502` —
ошибка обращения к Binance (5xx).

---

## Примеры (curl)

```bash
# Ближайшие к уровню монеты на 1h
curl 'http://localhost:3000/screener/1h?limit=20'

# Оборот ≥ 10M USDT, погрешность 0.5 NATR, разрыв касаний 20 свечей
curl 'http://localhost:3000/screener/1h?minVolume=10000000&natrMultiplier=0.5&minGap=20'

# Только поддержки ближе 1.5 NATR
curl 'http://localhost:3000/screener/1h?side=support&maxDistanceNatr=1.5'

# Поиск + сортировка по волатильности
curl 'http://localhost:3000/screener/15m?search=BTC&sort=natr&order=desc'

# Детали по монете
curl 'http://localhost:3000/screener/1h/BTCUSDT'

# Анализ пробоев вверх на 15m: 800 свечей, движение ≥ 0.5% за ≤ 120с
curl 'http://localhost:3000/analysis/15m/BTCUSDT?direction=up&candles=800&minMovePct=0.5&maxBreakoutSeconds=120'
```

## Примечания для фронтенда

- **Параметры расчёта в шапке:** `minVolume`, `natrMultiplier`, `minGap` задаются
  пользователем и идут в query `/screener/{tf}`; ТФ — в пути. При смене любого
  параметра перезапрашивайте экран.
- **Поллинг:** экран считается под запрос (ответ свежий); обновляйте каждые
  5–10с с теми же параметрами.
- **Свежесть:** `updatedAt` — мс Unix, время расчёта ответа.
- **Дистанция в NATR** — основная метрика близости к уровню (нормирована по
  волатильности): чем меньше `distanceNatr`, тем ближе цена к уровню.
- **Готовая сортировка:** `screener/{tf}` уже отсортирован по близости — можно
  рендерить как есть; фильтры применяйте через query.
- **Типы:** строгие схемы доступны в OpenAPI (`/docs/json`) — можно
  сгенерировать клиентские типы (openapi-typescript и т.п.).

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

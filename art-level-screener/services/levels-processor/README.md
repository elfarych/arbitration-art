# levels-processor

Сервис расчёта горизонтальных уровней. Раз в 10 секунд читает свечи из Redis
(пишет коннектор), считает уровни и публикует обратно в Redis в форме, удобной
для API-скринера: список монет с дистанцией до ближайшего уровня в NATR с
фильтром по таймфрейму.

## Запуск

```bash
cp .env.example .env
npm install
npm run dev            # tsx watch
# или
npm run build && npm start
```

Нужен Redis с данными от коннектора (`SOURCE_PREFIX`, по умолчанию `binance-futures`).

## Что считает

Алгоритм — порт улучшенного `level_screener` (Python):

- **Значимые экстремумы** по широкому окну (`PERIOD`).
- **active / broken**: active — уровень после себя ни разу не превышен; broken —
  превышен ровно один раз, недавно, и цена сейчас по ту сторону.
- **Реальные касания** ценой в полосе `±(NATR·NATR_MULTIPLIER)` с разделением по
  `MIN_GAP` свечей; уровни с касаниями < `MIN_TOUCHES` отбрасываются.
- **Дистанция в NATR** до ближайшего активного уровня — главная метрика скринера.

## Схема Redis (для API)

| Ключ | Значение |
|------|----------|
| `<prefix>:screener:<tf>` | JSON-массив `ScreenerEntry`, **отсортирован по `distanceNatr` ↑** — готовый экран скринера |
| `<prefix>:detail:<tf>:<SYMBOL>` | JSON `SymbolDetail` — полные уровни (active/broken) для drill-down |
| `<prefix>:timeframes` | JSON-массив обрабатываемых ТФ |

Префикс — `OUTPUT_PREFIX` (по умолчанию `levels`). На ключи ставится TTL
(`OUTPUT_TTL_MS`) — выбывшие монеты сами исчезают, API всегда видит актуальное.

### LevelView (элемент `levels`/`active`/`broken`)

```jsonc
{
  "price": 6.288,
  "time": 1780246800000,         // время начала уровня (свеча-экстремум), мс
  "kind": "bottom",              // top (по максимумам) | bottom (по минимумам)
  "side": "support",             // относительно цены: support (ниже) | resistance (выше)
  "touches": 3,                  // реальное число касаний ценой
  "distancePct": 3.29,           // дистанция до текущей цены, %
  "distanceNatr": 1.12,          // дистанция в NATR — ключевая метрика
  "breakoutDistance": null       // дистанция пробоя % (только для broken)
}
```

### ScreenerEntry

```jsonc
{
  "symbol": "INJUSDT",
  "price": 6.502,
  "natr": 2.93,                  // волатильность, % от цены
  "levels": [ /* все активные уровни (LevelView), по близости */ ],
  "nearest": { /* LevelView = levels[0] */ },  // null, если активных нет
  "activeCount": 7,
  "brokenCount": 0,
  "updatedAt": 1780508042301
}
```

### SymbolDetail

```jsonc
{
  "symbol": "BTCUSDT", "timeframe": "1h",
  "price": 66184.5, "natr": 0.9036,
  "nearest": { /* LevelView */ },
  "active": [ /* LevelView[] (непробитые), по близости */ ],
  "broken": [ /* LevelView[] (пробитые, с breakoutDistance) */ ],
  "updatedAt": 1780500000000
}
```

## Использование из будущего API

- **Список монет по ТФ** (экран скринера): `GET <prefix>:screener:<tf>` → отдать как есть
  (уже отсортирован по близости; фильтры/пагинацию делать поверх массива).
- **Фильтр по ТФ**: выбор ключа `screener:<tf>` (`timeframes` — список доступных).
- **Детали монеты**: `GET <prefix>:detail:<tf>:<symbol>`.

## Архитектура

```
index.ts → Application (цикл 10с, без наложения проходов)
  └─ Processor          один проход: читать → считать → писать
       ├─ CandleSource       чтение свечей/символов (MGET)
       ├─ levels/            extrema · natr · touches · horizontal-levels · distance
       └─ LevelsRepository   запись screener/detail/timeframes (pipeline + TTL)
```

Корректность алгоритма сверена 1:1 с Python `level_screener`.

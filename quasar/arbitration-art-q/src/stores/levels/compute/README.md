# compute/ — клиентский расчёт анализа пробоев

⚠️ **ВНИМАНИЕ: дублированная логика. Требует ручной синхронизации.**

Этот каталог — **зеркало** алгоритма детекции уровней и анализа пробоев из
`art-level-screener/services/levels-api`. Фронтенд считает анализ сам (в браузере,
с прямым обращением к Binance), чтобы не нагружать CPU сервера и распределить
weight-лимит Binance по IP пользователей. Результат после расчёта сохраняется в
Django (`POST /api/levels/analyses/`).

## Источник правды

Единственный источник правды — **levels-api**. Любая правка алгоритма (детекция
уровней, скан пробоев, проверка по трейдам, дедуп, NATR/касания/экстремумы)
делается **в обоих местах синхронно**. Если правки разойдутся, анализ начнёт
находить **другие** уровни, чем скринер, и потеряет смысл.

## Соответствие файлов

| Здесь (frontend) | Источник (levels-api `src/`) | Отличия |
|---|---|---|
| `levels/types.ts` | `levels/types.ts` | trimmed (только Candle/LevelParams/LevelKind) |
| `levels/natr.ts` | `levels/natr.ts` | identical |
| `levels/extrema.ts` | `levels/extrema.ts` | identical |
| `levels/touches.ts` | `levels/touches.ts` | identical |
| `analysis-compute.ts` | `lib/analysis-compute.ts` | identical body; импорты + типы результата из `../api/levelsApi` |
| `binance/rate-limiter.ts` | `binance/rate-limiter.ts` | identical (в браузере `observe()` не вызывается) |
| `binance/rest-client.ts` | `binance/rest-client.ts` | **переписан на `fetch`** (прямой Binance, без прокси, без `undici`/`observe`) |
| `analysisClient.ts` | — | frontend-only оркестратор (нет в источнике) |

## Параметры

`period / extremaWindow / maxBrokenAge / minTouches / atrPeriod` и конфиг анализа
(`aggTradesLimit / maxTradePages`) **не хардкодим** — фронт тянет их с levels-api
`GET /config` (`levelsApi.config()`), чтобы они всегда совпадали со скринером.

`LevelParams.tolerancePct?` (часть синхронного алгоритма) — допуск зоны напрямую в
% от цены: при `>0` переопределяет `natr · natrMultiplier`. Используется процентным
режимом погрешности (тумблер `NATR / %` в скринере и диалоге анализа). В этом режиме
`analysis-compute.ts` эхо-выдаёт эффективный множитель `tolerancePct/natr` в
`params.natrMultiplier` (анализ по одной монете → `natr` известен), чтобы не менять
форму `AnalysisResult` и сохранить запись в Django без новой колонки.

## Доверие

Django сохраняет клиент-посчитанный результат (осознанный trust-tradeoff: см.
`arbitration-art-django/apps/levels/DOCS`/`DOCS.md`). Агрегаты (`summary`) Django
**пересчитывает сам** из присланных пробоев; форджить можно только сами пробои.

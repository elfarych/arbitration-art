# binance-futures-connector

Сервис-коннектор Binance USDⓈ-M Futures: снимает снапшоты свечей, поддерживает
их в реальном времени через 1m-сокеты с агрегацией старших ТФ и пишет в Redis.
Источник данных для сервиса, считающего уровни и дистанцию до них.

## Возможности

- Обнаружение всех USDT-перпетуалов Binance Futures с суточным объёмом ≥ порога.
- Группировка по 20 символов (настраивается) — **одно** WS-соединение на группу.
- Снапшот истории всех ТФ (REST) + live-агрегация 5m/15m/1h из 1m-сокета.
- Защита от гэпа: буферизация live-апдейтов на время снапшота.
- Запись в Redis раз в 3 секунды (pipeline).
- Ежечасная ребалансировка набора **без перезапуска**: новые символы доливаются,
  выбывшие удаляются вместе с данными в Redis.
- Аккуратность с лимитами: очередь REST-запросов с учётом веса (`X-MBX-USED-WEIGHT-1M`).
- Reconnect с переснапшотом, **watchdog «немого» сокета** (нет сообщений
  `WS_STALE_TIMEOUT_MS` → принудительный разрыв), graceful shutdown.
- Отметка свежести данных в Redis (`:updated:<SYMBOL>`) — потребитель видит,
  актуальны ли данные.

## Запуск

```bash
cp .env.example .env      # при необходимости поправить
npm install
npm run dev               # разработка (tsx watch)
# или
npm run build && npm start
```

Нужен доступный Redis (по умолчанию `redis://127.0.0.1:6379`).

## Конфигурация (.env)

См. `.env.example`. Ключевое: `MIN_24H_VOLUME_USDT` (порог объёма),
`SYMBOLS_PER_CONNECTOR` (размер группы), `SNAPSHOT_DEPTH` (глубина истории),
`TIMEFRAMES` (набор ТФ, `1m` обязателен), `FLUSH_INTERVAL_MS`, `REFRESH_INTERVAL_MS`.

## Схема Redis

| Ключ | Значение |
|------|----------|
| `<prefix>:candles:<SYMBOL>:<tf>` | JSON-массив свечей `{openTime,open,high,low,close,volume}` |
| `<prefix>:price:<SYMBOL>` | последняя цена (число) |
| `<prefix>:updated:<SYMBOL>` | время (мс) последнего live-апдейта — свежесть данных |
| `<prefix>:symbols` | JSON-массив активных символов |

Префикс — `REDIS_KEY_PREFIX` (по умолчанию `binance-futures`). Потребитель читает
всю серию одного ТФ одним `GET` и считает по ней уровни.

## Архитектура

```
index.ts → Application
  ├─ WeightRateLimiter      учёт веса REST (поминутное окно)
  ├─ BinanceRestClient      exchangeInfo / ticker24hr / klines (undici)
  ├─ SymbolDiscovery        фильтр USDT-перпетуалов по объёму
  ├─ CandleRepository       запись/очистка в Redis (ioredis)
  └─ ConnectorManager       discovery, распределение, ребаланс
       └─ Connector (×N)    20 символов = 1 сокет
            ├─ KlineStream        /market/stream, SUBSCRIBE/UNSUBSCRIBE, reconnect, watchdog
            └─ CandleAggregator   1m → 5m/15m/1h, серии в памяти
```

Подробности алгоритма — в корневом [DOCS.md](../../DOCS.md).

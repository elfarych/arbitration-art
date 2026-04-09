# Техническое задание (ТЗ): Интеграция MEXC Futures и Gate.io Futures

## 1. Общее описание задачи
Обеспечить поддержку криптобирж **MEXC** и **Gate.io** (сегмент USDT-Linear Futures) в арбитражном торговом ядре. 
Архитектура системы уже модульная, поэтому новая интеграция не требует изменения базовой бизнес-логики (`Trader.ts` или математических формул расчета). Необходимо разработать классы-коннекторы, реализующие строгий интерфейс `IExchangeClient`.

---

## 2. Разработка Коннекторов (Классы)
Создать два новых файла в директории `src/exchanges/`:
- `mexc-client.ts` (Class `MexcClient`)
- `gate-client.ts` (Class `GateClient`)

Каждый класс обязан реализовать следующие методы интерфейса:
- `loadMarkets()`
- `getUsdtSymbols()`
- `getMarketInfo(symbol)`
- `setLeverage(symbol, leverage)`
- `setIsolatedMargin(symbol)`
- `createMarketOrder(symbol, side, amount, params)`
- `watchOrderBook(symbol, limit)`

---

## 3. Критические нюансы интеграции (Опыт предыдущих итераций)

### 3.1. Задержка отчетности API (Анти-0.00 Баг)
Обе биржи (особенно MEXC) обладают слабой инфраструктурой репликации баз данных. При отправке Market-ордера ответ может прийти без указания `average` (цены исполнения) или комиссии.
**Требование:** В методе `createMarketOrder` каждого клиента реализовать цикл интеллектуального ожидания (Polling Loop), аналогичный Bybit:
```typescript
let retries = 0;
while ((!filled.average || filled.status !== 'closed') && retries < 5) {
    await new Promise(r => setTimeout(r, 1000));
    retries++;
    try {
        const checked = await this.exchange.fetchOrder(order.id, symbol);
        if (checked && checked.average) filled = checked;
        if (filled.average && filled.status === 'closed') break;
    } catch (e) {}
}
```

### 3.2. Точность лотов (TICK_SIZE vs DECIMAL)
Интерфейсы MEXC и Gate могут возвращать настройки шага цены (`precision.amount` и `precision.price`) в виде десятичных дробей (например, `0.001`), а не целых чисел.
**Требование:** В `getMarketInfo()` жестко закрепить парсинг через логарифм:
```typescript
const stepSize = Number(market.precision?.amount) || 1;
const quantityPrecision = Math.max(0, Math.round(-Math.log10(stepSize)));
```

### 3.3. Лимиты запросов (Rate Limits) при инициализации
При загрузке топ-100 монет и установке плеча/маржи биржи могут забанить IP-адрес.
**Требование:** 
- В конструкторе CCXT обязательно прописать `enableRateLimit: true`.
- Изучить лимиты MEXC и Gate на конечные точки установки маржи. При необходимости, в `main.ts` скорректировать размер пакета (`batchSize`) и интервал задержки, чтобы вместить все 3-4 биржи в безопасное окно 10 запросов/сек.

### 3.4. Изолированная маржа (Isolated Mode)
Не все биржи переключают режим маржи одинаковым запросом.
- **MEXC**: Требует переключения через специфический API (`POST /api/v1/margin/isolated`).
- **Gate.io**: Аналогично, нужно использовать метод API `privateFuturesPostPositionsSymbolMarginType`.
**Требование:** Тщательно протестировать методы `setIsolatedMargin()` через встроенную CCXT-функцию `setMarginMode('isolated', symbol)`. Если она не работает, написать прямые axios-обертки или `implicit API` вызовы CCXT.

### 3.5. Комиссии (Fee parsing)
Зачастую MEXC предлагает акцию `0% Taker Fee`.
**Требование:** Извлекать комиссию через `extractCommission()`, но если биржа возвращает `undefined`, безопасно устанавливать `0`, не ломая калькуляцию реального PnL. Для Gate.io учесть возможные списания комиссий в токене `GT` (конвертировать в USDT по текущему курсу, либо запретить конвертацию в настройках биржи).

---

## 4. Конфигурационные файлы
- Добавить в `.env` и `.env.example`:
  - `MEXC_API_KEY`
  - `MEXC_SECRET`
  - `GATE_API_KEY`
  - `GATE_SECRET`
- Отредактировать файл `src/config.ts` для поддержки этих ключей с валидацией наличия.

---

## 5. Доработка основного цикла (main.ts)
В функции `main.ts` реализовать выбор "Ног" для арбитража на основе `.env`:
- Если раньше жестко сравнивались Binance и Bybit, теперь нужно искать пересечения (`commonSymbols`) между массивами всех активных бирж из конфига.
- Реализовать матрицу соединений (Например: Binance-MEXC, Bybit-Gate, Binance-Gate и т.д.).
- Сохранить обрезку неликвидных токенов (`commonSymbols = commonSymbols.slice(0, 100)`).

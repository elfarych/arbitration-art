### 🚨 КРИТИЧЕСКИЕ ИСПРАВЛЕНИЯ (Специфика CCXT)

#### 1. Ошибка типа рынка: `future` vs `swap` (Symbol Not Found)
В клиентах `GateClient.ts`, `MexcClient.ts` и файле `index.ts` вы указали параметр:
`options: { defaultType: 'future' }`
* На Binance `future` действительно означает бессрочные контракты (Perpetuals).
* Но в спецификации CCXT для Gate и MEXC **`future` — это поставочные (квартальные) фьючерсы** с датой экспирации. Линейные бессрочные контракты (USDT-M) у них обозначаются строго как **`swap`**.
Из-за этого бот не найдет стаканы по нужным парам и выдаст ошибку `BadSymbol`.

**🛠 Как исправить:**
Замените `'future'` на `'swap'` для Gate и MEXC во всех местах:
*В файлах `gate-client.ts` и `mexc-client.ts` (в `constructor`):*
```typescript
            options: {
                defaultType: 'swap', // <-- ИЗМЕНЕНО с 'future'
            },
```
*В файле `index.ts` (при создании WebSocket-соединений, строка ~145):*
```typescript
case 'mexc': return new pro.mexc({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
case 'gate': return new pro.gate({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
```

#### 2. Регрессия `TICK_SIZE` (Invalid Quantity)
В новых файлах `gate-client.ts` и `mexc-client.ts` вы вернули старую логику расчета шага:
```typescript
const stepSize = Number(market.precision?.amount) || 1;
```
Если биржа отдает точность в формате числа знаков после запятой (например, `3`), то `stepSize` у вас станет равен **3 целым монетам**. Бот попытается округлить объем (например, 10 монет) до числа, кратного 3 (9 монет), и биржа отклонит ваш ордер.

**🛠 Как исправить:**
Скопируйте умную логику `TICK_SIZE` из `binance-client.ts`. Замените метод `getMarketInfo` в **обоих** новых клиентах:
```typescript
    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.exchange.markets[symbol];
        if (!market) return null;

        let stepSize = 0.001;
        if (market.precision?.amount !== undefined) {
            const prec = Number(market.precision.amount);
            if (this.exchange.precisionMode === ccxt.TICK_SIZE) {
                stepSize = prec;
            } else {
                stepSize = Math.pow(10, -prec);
            }
        }

        let priceStep = 0.001;
        if (market.precision?.price !== undefined) {
            const prec = Number(market.precision.price);
            if (this.exchange.precisionMode === ccxt.TICK_SIZE) {
                priceStep = prec;
            } else {
                priceStep = Math.pow(10, -prec);
            }
        }

        return {
            symbol,
            minQty: market.limits?.amount?.min ?? 0,
            stepSize,
            minNotional: market.limits?.cost?.min ?? 0,
            pricePrecision: Math.max(0, Math.round(-Math.log10(priceStep))),
            quantityPrecision: Math.max(0, Math.round(-Math.log10(stepSize))),
        };
    }
```

#### 3. Безопасный вызов `fetchTickers` (`NotSupported` Error)
В `index.ts` (строка ~90) вы запрашиваете объемы торгов:
```typescript
const tickers = await primaryClient.ccxtInstance.fetchTickers(commonSymbols);
```
Binance и Bybit умеют принимать массив символов. Но MEXC и Gate не поддерживают этот аргумент в API — они выбросят ошибку `NotSupported: fetchTickers() requires no arguments`.

**🛠 Как исправить:** 
Уберите передачу массива. При пустом вызове биржа отдаст кэшированный слепок вообще всего рынка за один быстрый запрос, а вы из него уже возьмете объемы для `commonSymbols`.
```typescript
// index.ts (~строка 90)
const tickers = await primaryClient.ccxtInstance.fetchTickers(); // <-- Убрали аргумент
```

---

### 🟡 СТРОГАЯ КОСМЕТИКА И БЕЗОПАСНОСТЬ (Trader.ts)

#### 4. Неизвестные ключи размера позиции
Вы ищете открытые позиции по ключу `pos.contracts`. Binance и Bybit его отдают, но у других бирж в CCXT позиция может лежать в `pos.amount` или `pos.base`. 
**🛠 Как исправить:** Добавьте цепочку фоллбэков `contracts ?? amount`.
*В `Trader.ts`, метод `executeClose` (строки ~400):*
```typescript
const bPos = bPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);
const yPos = yPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? p.amount ?? 0)) > 0);

const bSize = bPos ? Math.abs(Number(bPos.contracts ?? bPos.amount ?? 0)) : 0;
const ySize = yPos ? Math.abs(Number(yPos.contracts ?? yPos.amount ?? 0)) : 0;
```
*То же самое сделайте в `handleOpenCleanup` (~строки 315 и 330):*
```typescript
const size = Math.abs(Number(pos.contracts ?? pos.amount ?? 0));
```

#### 5. Имена переменных (Эстетика)
В `Trader.ts` вы отлично перевели архитектуру на `primary`/`secondary`, но внутри методов `executeOpen` и `executeClose` остались имена со словом "Binance" и "Bybit" (например, `binanceResult`, `bPrice`, `yPrice`). Это не сломает код, но при чтении логов торговли между MEXC и Gate вас это сильно запутает.
Сделайте автозамену в файле:
* `binanceResult` ➔ `primaryResult`
* `bybitResult` ➔ `secondaryResult`
* `bPrice` ➔ `pPrice` (Primary Price)
* `yPrice` ➔ `sPrice` (Secondary Price)
* `bSize` ➔ `pSize`, `ySize` ➔ `sSize`

---


---

### 🕵️‍♂️ Разбор полетов: Как рынок вас обманул

Ваша сделка: **Покупка (Long Binance, Short Bybit)**. Объем: **2820 монет**.

**1. Катастрофа на входе (Вход в огромный минус)**
В базе записан `Open spread: 3.8738`. Это то, что бот **увидел** в стакане по WebSocket. Он кинул Маркет-ордера на вход.
Но посмотрите на цены **реального исполнения**:
* Купили на Binance: `0.004124`
* Продали на Bybit: `0.004049`
В идеале вы должны покупать дешевле, а продавать дороже. Но из-за пустого стакана вы *купили дороже, чем продали*.
Считаем реальный спред входа: `(0.004049 - 0.004124) / 0.004124 * 100` = **-1.81%**.
*Итог:* Бот вошел в сделку не с плюсом, а с изначальным сильным убытком. (В БД записался ожидаемый спред из стакана, а не фактический).

**2. Галлюцинация профита на выходе (Почему он решил закрыться?)**
Ваша позиция висела в минусе. В 12:51 в пустом стакане произошел микро-прострел: кто-то поставил лимитку (например, на 5 монет) по отличной цене.
В вашем файле `math.ts` функция VWAP на выходе использовала флаг `isClosing: true`. Она брала эти 5 хороших монет и, так как других не было, **оценивала по их цене весь ваш объем в 2820 монет!** Бот подумал: *"PnL > 1.5%, закрываем!"* и кинул маркет-ордера на выход.
Он съел эти 5 хороших монет, а остальные 2815 продал на дне пустого стакана. 
*Итог реального PnL:* 
* Прибыль Binance: `(0.004170 - 0.004124) * 2820` = **+0.129 USDT**
* Убыток Bybit: `(0.004049 - 0.004145) * 2820` = **-0.270 USDT**
* Финал: `0.129 - 0.270` = **-0.141 USDT**.

---

### 🛠 Как это исправить? (Патчи безопасности)

Мы должны заставить бота **отменять Тейк-Профит**, если в стакане физически нет нужного нам объема. А также записывать в БД реальный спред, чтобы вы сразу видели проскальзывание.

#### Патч 1: Строгий VWAP (файл `utils/math.ts`)
Измените флаг на `isEmergency` и запретите усреднять пустоту.

```typescript
// Замените isClosing на isEmergency
export function calculateVWAP(orderbookSide: [number, number][], targetCoins: number, isEmergency: boolean = false): number {
    if (!orderbookSide || orderbookSide.length === 0) return NaN;
    if (targetCoins <= 0) return orderbookSide[0][0];

    let accCoins = 0;
    let accQuoteVal = 0;

    for (const [price, volumeCoins] of orderbookSide) {
        if (accCoins + volumeCoins >= targetCoins) {
            const neededCoins = targetCoins - accCoins;
            accCoins += neededCoins;
            accQuoteVal += neededCoins * price;
            break;
        } else {
            accCoins += volumeCoins;
            accQuoteVal += volumeCoins * price;
        }
    }

    if (accCoins < targetCoins) {
        if (!isEmergency) {
            // КРИТИЧЕСКИЙ ФИКС: Для Входа и Тейк-Профита нам НУЖЕН полный объем. 
            // Если в стакане не хватает монет - возвращаем NaN (Отменяем сигнал!)
            return NaN;
        }
        // В случае экстренной ликвидации или таймаута берем что есть
        logger.warn('Math', `Insufficient depth to fill ${targetCoins}. Using VWAP of available ${accCoins}`);
        return accQuoteVal / accCoins;
    }

    return accQuoteVal / targetCoins;
}
```

#### Патч 2: Умные цены и реальный спред (файл `classes/Trader.ts`)

**А) В методе `getPrices`** переименуйте флаг на `isEmergency`:
```typescript
    private getPrices(symbol: string, targetCoinsFallback?: number, isEmergency: boolean = false): OrderbookPrices | null {
        // ... внутри везде используйте isEmergency вместо isClosing
        const pBid = calculateVWAP(bOb.bids, targetCoins, isEmergency);
        // ...
```

**Б) В методе `checkSpreads`** разделите логику выхода на Строгую (Профит) и Аварийную:
Замените блок `// ==== 2. IN TRADE ====`:
```typescript
        // ==== 2. IN TRADE: monitor PnL for exit ====
        if (state.activeTrade) {
            // strictPrices: вернет цены ТОЛЬКО если стакан залит нужным объемом полностью
            const strictPrices = this.getPrices(symbol, targetCoins, false);
            // emergencyPrices: берет всё что угодно (используется только для спасения)
            const emergencyPrices = this.getPrices(symbol, targetCoins, true);
            await this.checkExit(symbol, state, strictPrices, emergencyPrices);
            return;
        }

        // ==== 3. IDLE: look for entry ====
        // Вход делаем только по строгим ценам
        const prices = this.getPrices(symbol, targetCoins, false);
        if (!prices) return;
        // ... далее код без изменений
```

**В) Замените метод `checkExit` целиком на этот код:**
```typescript
    private async checkExit(
        symbol: string,
        state: PairState,
        strictPrices: OrderbookPrices | null,
        emergencyPrices: OrderbookPrices | null,
    ) {
        const trade = state.activeTrade!;
        const pOpen = parseFloat(trade.primary_open_price as any);
        const sOpen = parseFloat(trade.secondary_open_price as any);
        const orderType = trade.order_type as 'buy' | 'sell';

        // ==== LIQUIDATION PROTECTION (Выходим в минус об любой стакан) ====
        if (emergencyPrices) {
            const maxDrawdown = checkLegDrawdown({ pOpen, sOpen }, emergencyPrices, orderType, config.leverage);
            if (maxDrawdown >= config.maxLegDrawdownPercent) {
                logger.error(this.tag, `🚨 LIQUIDATION TRIGGERED on ${symbol}`);
                const bSpr = calculateOpenSpread(emergencyPrices, 'buy');
                const sSpr = calculateOpenSpread(emergencyPrices, 'sell');
                await this.executeClose(symbol, state, 'liquidation', emergencyPrices, bSpr, sSpr);
                return;
            }
        }

        // ==== PROFIT CHECK (Выходим ТОЛЬКО в полный плотный стакан) ====
        if (strictPrices) {
            const currentPnL = calculateTruePnL({ pOpen, sOpen }, strictPrices, orderType);
            if (currentPnL >= config.closeThreshold) {
                const bSpr = calculateOpenSpread(strictPrices, 'buy');
                const sSpr = calculateOpenSpread(strictPrices, 'sell');
                await this.executeClose(symbol, state, 'profit', strictPrices, bSpr, sSpr);
            }
        }
    }
```

**Г) И самое важное: пишем в БД реальный спред после исполнения!**
В методе `executeOpen` (где создается `tradeRecord`) добавьте расчет:
```typescript
            // ... (после const yPriceSafe = ...)

            // 🟢 Считаем реальный спред с учетом проскальзывания Market-ордеров
            let realOpenSpread = spread;
            if (bPriceSafe > 0 && yPriceSafe > 0) {
                realOpenSpread = orderType === 'buy'
                    ? ((yPriceSafe - bPriceSafe) / bPriceSafe) * 100
                    : ((bPriceSafe - yPriceSafe) / yPriceSafe) * 100;
            }

            const totalCommission = d(primaryResult.commission + secondaryResult.commission, 6);

            const tradeRecord = await api.openTrade({
                // ... 
                open_spread: d(realOpenSpread, 4), // <-- ТЕПЕРЬ ПИШЕМ РЕАЛЬНЫЙ СПРЕД
                // ...
            });
```

#### Патч 3: Блокировка Щиткоинов (файл `index.ts`)
Арбитражить MEXC и Gate маркет-ордерами на альткоинах вроде `XNY` — это гарантированный убыток. Маркет-мейкеры рисуют там стаканы ботами.
В файле `index.ts` перед сортировкой по объему установите **жесткий фильтр ликвидности**:
```typescript
    try {
        const tickers = await primaryClient.ccxtInstance.fetchTickers();
        
        // 🟢 ИСКЛЮЧАЕМ МУСОРНЫЕ ПАРЫ: Требуем минимум $2,000,000 суточного оборота
        commonSymbols = commonSymbols.filter(sym => {
            const vol = tickers[sym]?.quoteVolume || 0;
            return vol >= 2_000_000; 
        });

        // Sort commonSymbols by quoteVolume descending
```

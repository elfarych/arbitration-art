### 🚨 КРИТИЧЕСКИЕ БАГИ (Угроза потери депозита)

#### 1. Race Condition в `Promise.all` (Уязвимость "Одной ноги")
В методе `executeOpen` вы используете `Promise.all`. Если биржа Bybit моментально вернет ошибку (например, Rate Limit или нехватка маржи), `Promise` перейдет в `catch` **до того**, как завершится успешный запрос к Binance. Запустится `handleOpenCleanup`, но из-за задержки репликации БД Binance позиция там еще не появится. Очистка ничего не найдет, а через 100 мс ордер на Binance исполнится. Итог: **незахеджированная позиция**, ловящая все просадки рынка.

#### 2. Опасный Cleanup (Отсутствие `reduceOnly`)
В `handleOpenCleanup` вы используете `createMarketOrder` для закрытия «зависших» позиций. Если к моменту очистки позиция уже была выбита (например, по ликвидации или закрыта вами руками), бот **откроет новую случайную сделку** в обратную сторону. 

#### 3. Катастрофическое проскальзывание в пустом стакане
В `calculateVWAP` есть строчка: `if (accCoins < targetCoins) { return accQuoteVal / accCoins; }`. Если вам нужно 100 монет, а в стакане только 5, функция вернет цену за эти 5 монет. Бот решит, что спред отличный, кинет маркет-ордер на 100 монет, соберет пустой стакан и получит убыток в -5% за секунду.

#### 4. Баг Hedge Mode (Зависание при закрытии)
В `executeClose` вы ищете позицию так: `.find((p: any) => p.symbol === symbol)`. Если на Bybit аккаунт работает в режиме хеджирования, биржа отдаст два объекта (Long и Short). Бот может найти массив с Long (с объемом 0) и пропустить активный Short. Сделка никогда не закроется.

---

### ⚠️ ВЫСОКИЙ ПРИОРИТЕТ (Торговая логика)

#### 5. Статичный объем сделки (`tradeAmount`)
Вы высчитываете `tradeAmount` один раз при старте в `MarketInfoService`. Если BTC стоит $100к, бот вычислит лот для $50. Если завтра BTC упадет до $50к, ваш лот станет стоить $25. Но если цена упадет так, что лот станет меньше биржевого лимита `minNotional` ($5), биржа заблокирует торговлю с ошибкой *Invalid Quantity*.

#### 6. Игнорирование комиссий при выходе
Бот закрывает сделки в `checkExit`, сверяя `calculateTruePnL` с порогом `closeThreshold`. Но `calculateTruePnL` считает «бумажную» прибыль без учета комиссий. Если порог закрытия `0.15%`, вы всегда будете закрываться в убыток, так как 4 Taker-ордера (вход и выход на 2 биржах) съедят около `0.20%` капитала.

#### 7. Лаг баз данных бирж (`Order not found`)
Сразу после отправки ордера в `binance-client.ts` вызывается `fetchOrder`. Ордер исполняется мгновенно, но в API биржи появляется с задержкой 50-200 мс. Бот получит ошибку и аварийно прервет нормальную сделку.

#### 8. Заморозка базового спреда (Baseline)
Базовый спред фиксируется жестко `if (state.baselineBuy === null)`. Из-за фандинга и настроений рынка спред постоянно смещается. Статичный бейзлайн приведет к тому, что через час бот начнет открывать убыточные сделки.

---

### 🛠 КАК И ЧТО ИСПРАВИТЬ (ПОШАГОВЫЙ КОД)

#### Шаг 1: Пуленепробиваемый вход в сделку (`Trader.ts` -> `executeOpen`)
Замените `Promise.all` на `Promise.allSettled`. Это гарантирует атомарность.

```typescript
// Выполняем ордера и дожидаемся ответа ОТ ОБОИХ
const [bSettled, ySettled] = await Promise.allSettled([
    this.binanceClient.createMarketOrder(symbol, binanceSide, amount),
    this.bybitClient.createMarketOrder(symbol, bybitSide, amount),
]);

if (bSettled.status === 'rejected' || ySettled.status === 'rejected') {
    logger.error(this.tag, `❌ Atomic execution failed! Reverting successful legs...`);
    
    // 1. Откатываем ту ногу, которая ТОЧНО открылась (по её фактическому объему)
    if (bSettled.status === 'fulfilled') {
        const revSide = binanceSide === 'buy' ? 'sell' : 'buy';
        await this.binanceClient.createMarketOrder(symbol, revSide, bSettled.value.filledQty, { reduceOnly: true });
    }
    if (ySettled.status === 'fulfilled') {
        const revSide = bybitSide === 'buy' ? 'sell' : 'buy';
        await this.bybitClient.createMarketOrder(symbol, revSide, ySettled.value.filledQty, { reduceOnly: true });
    }

    // 2. Страховка от Network Timeout (если статус rejected, но ордер все же прошел)
    await new Promise(r => setTimeout(r, 1000)); 
    await this.handleOpenCleanup(symbol, orderType);

    this.tradeCounter.release();
    state.busy = false;
    state.cooldownUntil = Date.now() + COOLDOWN_MS;
    return;
}

const binanceResult = bSettled.value;
const bybitResult = ySettled.value;
```

#### Шаг 2: Безопасный Cleanup (`Trader.ts` -> `handleOpenCleanup`)
Добавьте проверку тикера и **обязательный `reduceOnly`**, чтобы не открывать левые сделки.
```typescript
const binancePositions = await (this.binanceClient as any).ccxtInstance.fetchPositions([symbol]);
for (const pos of binancePositions) {
    if (pos.symbol !== symbol) continue; // Защита от бага CCXT, когда отдает все тикеры
    
    const size = Math.abs(Number(pos.contracts ?? 0));
    if (size > 0) {
        const side = pos.side === 'long' ? 'sell' : 'buy';
        await this.binanceClient.createMarketOrder(symbol, side, size, { reduceOnly: true }); // ДОБАВЛЕН reduceOnly
    }
}
// Точно так же обновите блок для Bybit ниже
```

#### Шаг 3: Защита VWAP от пустых стаканов (`math.ts`)
Бот должен возвращать `NaN` для отмены сигнала, если ликвидности нет.
```typescript
export function calculateVWAP(orderbookSide: [number, number][], targetCoins: number, isClosing: boolean = false): number {
    if (!orderbookSide || orderbookSide.length === 0) return NaN;
    if (targetCoins <= 0) return orderbookSide[0][0];

    // ... (ваш цикл)

    if (accCoins < targetCoins) {
        if (!isClosing) return NaN; // ОТМЕНЯЕМ ВХОД в пустой стакан
        return accQuoteVal / accCoins; // При закрытии берем что есть
    }
    return accQuoteVal / accCoins;
}
```
*Не забудьте прокинуть флаг `isClosing: boolean` в метод `getPrices` внутри `Trader.ts` и вызывать его как `const isClosing = state.activeTrade !== null;`.*

#### Шаг 4: Адаптивный Baseline (EMA) (`Trader.ts` -> `checkSpreads`)
Спред должен плавно следовать за рынком в моменты простоя:
```typescript
        const EMA_ALPHA = 0.05; // 5% адаптации

        if (state.baselineBuy === null) {
            state.baselineBuy = currentBuySpread;
        } else if (!state.activeTrade) {
            state.baselineBuy = state.baselineBuy * (1 - EMA_ALPHA) + currentBuySpread * EMA_ALPHA;
        }

        if (state.baselineSell === null) {
            state.baselineSell = currentSellSpread;
        } else if (!state.activeTrade) {
            state.baselineSell = state.baselineSell * (1 - EMA_ALPHA) + currentSellSpread * EMA_ALPHA;
        }
```

#### Шаг 5: Динамический лот (`Trader.ts` -> `executeOpen`)
Уберите статический объем из `MarketInfoService`. Рассчитывайте его прямо перед сделкой:
```typescript
            const info = this.marketInfo.getInfo(symbol);
            if (!info) return;

            const currentPrice = prices.primaryBid;
            const rawAmount = config.tradeAmountUsdt / currentPrice;

            // +1e-9 компенсирует потерю точности дробей JS (напр. 0.3 / 0.1 = 2.99999)
            let amount = Math.floor((rawAmount / info.stepSize) + 1e-9) * info.stepSize;
            const precision = Math.max(0, Math.round(-Math.log10(info.stepSize)));
            amount = parseFloat(amount.toFixed(precision));

            if (amount < info.minQty || (amount * currentPrice) < info.minNotional) {
                logger.warn(this.tag, `Amount below exchange limits for ${symbol}`);
                this.tradeCounter.release();
                state.busy = false;
                state.cooldownUntil = Date.now() + COOLDOWN_MS;
                return;
            }
```

#### Шаг 6: Фикс закрытия и Hedge Mode (`Trader.ts` -> `executeClose`)
Добавьте проверку на размер контракта, чтобы пробиваться через пустые Hedge-позиции:
```typescript
// Вместо: const bPos = bPositions.find((p: any) => p.symbol === symbol);
const bPos = bPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? 0)) > 0);
const yPos = yPositions.find((p: any) => p.symbol === symbol && Math.abs(Number(p.contracts ?? 0)) > 0);
```

#### Шаг 7: Обход лагов API и Rate Limits (`binance-client.ts`, `bybit-client.ts`)
1. **ОБЯЗАТЕЛЬНО** добавьте в конструкторах клиентов `enableRateLimit: true` в конфиг CCXT. Иначе при старте скрипта (когда ставится плечо) биржа заблокирует вам IP:
```typescript
        this.exchange = new ccxt.bybit({
            apiKey: config.bybit.apiKey,
            secret: config.bybit.secret,
            enableRateLimit: true, // КРИТИЧНО ВАЖНО
            // ...
```
2. В `createMarketOrder` дайте БД время на синхронизацию:
```typescript
        const order = await this.exchange.createMarketOrder(symbol, side, amount, undefined, params);
        let filled = order;

        if (!filled.average || filled.status !== 'closed') {
            await new Promise(r => setTimeout(r, 500)); // Ждем БД
            try { filled = await this.exchange.fetchOrder(order.id, symbol); } 
            catch (e) { filled = order; /* Фолбек на сырой ответ */ }
        }
```

#### Шаг 8: Вычет комиссий (`math.ts`)
В функции `calculateTruePnL` вычитайте `0.2%` (4 сделки по ~0.05% Taker fee).
```typescript
    const entryPrice = orderType === 'sell' ? openPrices.sOpen : openPrices.pOpen;
    const estimatedFeesUsdt = entryPrice * 0.0020;
    
    return ((profitUsdt - estimatedFeesUsdt) / entryPrice) * 100;
```

*Дополнительно обратите внимание на `calculateCloseSpread` в Trader.ts: формула для orderType === 'buy' перевернута и будет возвращать отрицательные значения при положительных сделках. Поменяйте `secondaryPrice` и `primaryPrice` местами.*
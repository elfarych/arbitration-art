### 🛠 Финальный чек-лист перед запуском (Polishing)

#### 1. Устаревший расчет точности CCXT (Отказ торговать)
В `binance-client.ts` и `bybit-client.ts` вычисляется размер шага лота: `Math.pow(10, -(market.precision.amount))`.
В новых версиях библиотеки CCXT большинство бирж переведены на режим `TICK_SIZE`. Это значит, что биржа отдает **уже готовый шаг** (например, `0.001`), а не количество нулей. Если код возведет `Math.pow(10, -0.001)`, он получит `0.9977`. Из-за этого при расчете сайза бот получит бесконечные дроби и биржа выдаст ошибку `Invalid Quantity`.
**Как исправить:** Заставьте CCXT самому подсказать, в каком формате пришла точность.
*В обоих клиентах обновите метод `getMarketInfo`:*
```typescript
    getMarketInfo(symbol: string): SymbolMarketInfo | null {
        const market = this.exchange.markets[symbol];
        if (!market) return null;

        let stepSize = 0.001;
        if (market.precision?.amount !== undefined) {
            const prec = Number(market.precision.amount);
            // Умная проверка: если биржа отдает готовый шаг (TICK_SIZE), берем его. 
            // Иначе возводим в степень.
            if (this.exchange.precisionMode === ccxt.TICK_SIZE) {
                stepSize = prec;
            } else {
                stepSize = Math.pow(10, -prec);
            }
        }

        return {
            symbol,
            minQty: market.limits?.amount?.min ?? 0,
            stepSize,
            // ... остальной код
```

#### 2. Рассинхрон стейта с Django API (Критично для БД)
В `Trader.ts`, метод `executeClose`. 
Если сделка успешно закроется на биржах, но в момент отправки в Django ваш сервер "моргнет" сетью (502 Gateway Timeout), сработает блок `catch`. Но код пойдет дальше и выполнит `state.activeTrade = null`. Бот навсегда забудет про эту сделку, а в Django она так и останется в статусе `open`.
**Как исправить:** Так как позиции на бирже уже точно закрыты, нужно сделать бесконечный `while` цикл для отправки данных в БД (до победного конца).
*Замените блок отправки `api.closeTrade` (строка ~337):*
```typescript
            const closeStatus = reason === 'profit' ? 'closed' : 'force_closed';

            let isDbSaved = false;
            while (!isDbSaved && this.isRunning) {
                try {
                    await api.closeTrade(trade.id, {
                        // ... ваши параметры payload
                        closed_at: new Date().toISOString(),
                    });
                    isDbSaved = true;
                } catch (dbErr: any) {
                    logger.error(this.tag, `❌ CRITICAL: Django update failed (ID: ${trade.id}): ${dbErr.message}. Retrying in 5s...`);
                    await new Promise(r => setTimeout(r, 5000)); // Ждем и пробуем снова
                }
            }

            // Очищаем стейт ТОЛЬКО если БД приняла запрос
            state.activeTrade = null;
            state.openedAtMs = null;
            this.tradeCounter.release();
```

#### 3. Баг гигантских комиссий при оплате в BNB (Binance)
В `binance-client.ts`, метод `extractCommission`.
Если у вас на фьючерсах Binance стоит галочка *"Использовать BNB для скидки 10%"*, биржа спишет `fee.cost`, скажем, `0.001 BNB`. 
Ваш код поймет, что это не USDT, и выполнит `fee.cost * order.average`. Но `order.average` — это цена торгуемой монеты (например, $65,000 для BTC). Бот умножит 0.001 на 65000 и запишет гигантскую "галлюцинаторную" комиссию в $65 вместо реальных копеек, навсегда сломав статистику в Django.
**Как исправить:**
```typescript
    private extractCommission(order: any): number {
        if (order.fees && Array.isArray(order.fees)) {
            return order.fees.reduce((total: number, fee: any) => {
                if (['USDT', 'BUSD', 'USDC'].includes(fee.currency)) return total + (fee.cost ?? 0);
                
                // Спасение графиков: если комиссия списывается в BNB, оцениваем её стандартным % Taker fee
                if (fee.currency === 'BNB') {
                    const notional = (order.filled ?? 0) * (order.average ?? order.price ?? 0);
                    return total + (notional * 0.00045); 
                }

                return total + (fee.cost ?? 0) * (order.average ?? order.price ?? 0);
            }, 0);
        }
        // ... (Сделайте то же самое для нижнего блока `if (order.fee)`)
```

#### 4. Нехватка флага `isClosing: true` в таймаутах и очистке Dust
**A. Тайм-ауты (Trader.ts):** В методах `checkTimeouts` и `closeAllPositions` вы вызываете получение VWAP-цен через `const prices = this.getPrices(symbol);`. Если в этот момент на рынке "прокол" (стакан временно пуст), бот вернет `null` и прервет закрытие позиции! Передайте третий параметр `true` (как вы это сделали в `checkSpreads`), чтобы бот закрыл по любой доступной рыночной цене:
```typescript
const prices = this.getPrices(symbol, undefined, true); // Добавить флаг 'true'
```
**B. Закрытие Dust (Пыль):** Чтобы биржа не ругалась ошибками `Quantity is below min_qty` при попытке закрыть остаточную микро-пыль (например, `0.00000001` BTC), в `executeClose` и `handleOpenCleanup` вместо `bSize > 0` лучше проверять по лимиту тикера: `bSize >= minQty` (где `const minQty = this.marketInfo.getInfo(symbol)?.minQty || 0`).

---

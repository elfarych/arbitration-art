### 🔬 Последние штрихи (Микро-баги)

#### 1. Баг сохранения в БД при выключении (Graceful Shutdown)
В методе `stop()` вы присваиваете `this.isRunning = false`, а затем вызываете закрытие позиций `closeAllPositions`. Бот успешно закрывает позиции на биржах, переходит к сохранению в базу данных и видит условие:
```typescript
while (!isDbSaved && this.isRunning) { ... }
```
Так как `this.isRunning` уже `false`, **цикл полностью пропускается**, и закрытая сделка навсегда остается в статусе `open` в вашей базе Django.

**Как исправить:** Отвяжите цикл от `this.isRunning` и добавьте счетчик попыток (`retries`), чтобы бот не завис навечно при "мертвой" базе. 
*В `Trader.ts` метод `executeClose` (строка ~422):*
```typescript
            try {
                let isDbSaved = false;
                let retries = 0;
                // Даем 10 попыток (суммарно 50 секунд) на сохранение в БД даже при выключении
                while (!isDbSaved && retries < 10) {
                    try {
                        await api.closeTrade(trade.id, { /* payload... */ closed_at: new Date().toISOString() });
                        isDbSaved = true;
                    } catch (dbErr: any) {
                        retries++;
                        logger.error(this.tag, `❌ CRITICAL: Django update failed (ID: ${trade.id}): ${dbErr.message}. Attempt ${retries}/10. Retrying in 5s...`);
                        if (retries < 10) await new Promise(r => setTimeout(r, 5000));
                    }
                }
            } catch (err: any) { ... }
```

#### 2. Нулевые ордера (Dust Cleanup Bug)
Вы добавили отличную проверку `if (bSize >= minQty)`. Но если у вас нет позиции на бирже (`bSize = 0`), а биржа из-за сбоя или особенностей монеты не отдала `minQty` (и сработал фоллбэк `0`), выражение превратится в `if (0 >= 0)` -> `true`. Бот попытается отправить на биржу ордер с объемом 0 и получит системную ошибку *Amount must be greater than 0*.

**Как исправить:** Просто добавьте строгое условие `> 0`. 
*В `Trader.ts` метод `executeClose` (строки ~376 и ~387):*
```typescript
            if (bSize > 0 && bSize >= minQty) { // <-- добавлено bSize > 0
                // ...
            }

            if (ySize > 0 && ySize >= minQty) { // <-- добавлено ySize > 0
                // ...
            }
```
*То же самое сделайте в `handleOpenCleanup` (строки ~284 и ~300):*
```typescript
                    const size = Math.abs(Number(pos.contracts ?? 0));
                    if (size > 0 && size >= minQty) { // <-- добавлено size > 0
```

#### 3. Точный VWAP при Таймаутах
В методах `checkTimeouts` и `closeAllPositions` вы получаете цены стакана: `this.getPrices(symbol, undefined, true)`. Передавая `undefined`, вы заставляете функцию использовать стандартный `info.tradeAmount`. Но у вас же уже есть **фактический точный объем** открытой сделки! 

**Как исправить:** Прокиньте реальный `targetCoins` из сделки, чтобы расчет проскальзывания при экстренном выходе был математически идеальным.
*В `Trader.ts` метод `checkTimeouts` (строка ~481):*
```typescript
                const targetCoins = parseFloat(state.activeTrade.amount as any);
                const prices = this.getPrices(symbol, targetCoins, true);
```
*И в методе `closeAllPositions` (строка ~500):*
```typescript
                const targetCoins = parseFloat(state.activeTrade!.amount as any);
                const prices = this.getPrices(symbol, targetCoins, true);
```

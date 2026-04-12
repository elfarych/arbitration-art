
---

### 🚨 Фикс 1: Опасность `NaN` в проверке позиций
В `gate-client.ts`, внутри метода `fetchPositions`:
Если позиций нет, биржа может вернуть ответ без ключа `size` или пустой объект. В JavaScript выражение `Number(undefined)` выдает `NaN`. А проверка `NaN !== 0` возвращает **`true`**! Бот зайдет в цикл и попытается открыть фантомную позицию.

**🛠 Как исправить:** Строго проверьте наличие `size`:
```typescript
// Строка ~65
// Замените это:
if (data && Number(data.size) !== 0) {
// На это:
if (data && data.size !== undefined && Number(data.size) !== 0) {
```

### 🚨 Фикс 2: Плечо и Маржа (Query vs JSON Body)
В методах `setLeverage` и `setIsolatedMargin` вы передаете параметры в качестве `data` (JSON body) — это 4-й аргумент вашей функции `request`. Но Gate.io требует передавать параметры настройки плеча строго в **URL (как Query-параметры)**. Биржа просто не увидит ваш JSON.

**🛠 Как исправить:** Уберите пустые скобки `{}`, чтобы параметры стали 3-м аргументом (query):
```typescript
    async setLeverage(symbol: string, leverage: number): Promise<void> {
        const gateSymbol = ccxtToGate(symbol);
        try {
            // 🟢 ПЕРЕНЕСЕНО в 3-й аргумент (query)
            await this.request('POST', `/futures/usdt/positions/${gateSymbol}/leverage`, {
                leverage: leverage.toString(),
                cross_leverage_limit: leverage.toString()
            });
            logger.debug(TAG, `Leverage set to ${leverage}x for ${symbol}`);
// ...

    async setIsolatedMargin(symbol: string): Promise<void> {
        const gateSymbol = ccxtToGate(symbol);
        try {
            // 🟢 ПЕРЕНЕСЕНО в 3-й аргумент (query)
            await this.request('POST', `/futures/usdt/positions/${gateSymbol}/margin`, {
                size: "0" 
            });
```

### 🚨 Фикс 3: Обязательный параметр `contract`
При создании ордера в `GateClient` вы делаете запрос `/futures/usdt/my_trades` для получения комиссий. По жесткой спецификации Gate API v4 параметр `contract` для этого запроса является **обязательным**, иначе биржа выдаст `400 Invalid Param: contract`.

**🛠 Как исправить:** Прокиньте `contract: gateSymbol` в `query`:
```typescript
        // Внутри извлечения комиссий (строка ~182):
        let commission = 0;
        try {
            await new Promise(r => setTimeout(r, 500));
            // 🟢 ДОБАВЛЕН contract: gateSymbol
            const trades = await this.request('GET', '/futures/usdt/my_trades', { contract: gateSymbol, order: orderId });
```

### 🚨 Фикс 4: Иллюзия нулевого PnL при ликвидации (`Trader.ts`)
Представьте: вашу сделку ликвидировало на бирже (позиции больше нет, `pSize = 0`). 
В блоке `executeClose` бот попытается ее закрыть, попадет в блок `else` и приравняет цену закрытия к цене открытия: `pPrice = parseFloat(trade.primary_open_price)`. Математика PnL посчитает: `Цена Открытия - Цена Открытия = 0`. В базе вы увидите 0% убытка, хотя по факту потеряли деньги.

**🛠 Как исправить:** Если позиция "исчезла" (ликвидация), бот должен зафиксировать цену текущего стакана, чтобы в БД записался честный минус.
*Файл `Trader.ts`, метод `executeClose` (строки ~439 и ~449):*
```typescript
            if (pSize > 0 && pSize >= minQty) {
                closePromises.push( /* ... */ );
            } else {
                // 🟢 КРИТИЧЕСКИЙ ФИКС: Оцениваем "исчезнувшую" позицию по рынку
                pPrice = primaryCloseSide === 'buy' ? (prices?.primaryAsk ?? pOpen) : (prices?.primaryBid ?? pOpen);
            }

            if (sSize > 0 && sSize >= minQty) {
                closePromises.push( /* ... */ );
            } else {
                // 🟢 КРИТИЧЕСКИЙ ФИКС: Оцениваем "исчезнувшую" позицию по рынку
                sPrice = secondaryCloseSide === 'buy' ? (prices?.secondaryAsk ?? sOpen) : (prices?.secondaryBid ?? sOpen);
            }
```

---

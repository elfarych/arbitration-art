export interface OrderbookPrices {
    primaryBid: number;
    primaryAsk: number;
    secondaryBid: number;
    secondaryAsk: number;
}

/**
 * Вычисляет "Спред Открытия" в зависимости от направления (sell/buy).
 * Sell: Продажа на Binance, покупка на Bybit -> (pBid - sAsk) / sAsk * 100
 * Buy: Покупка на Binance, продажа на Bybit -> (sBid - pAsk) / pAsk * 100
 */
export function calculateOpenSpread(prices: OrderbookPrices, orderType: 'buy' | 'sell'): number {
    if (orderType === 'sell') {
        const pBid = prices.primaryBid;
        const sAsk = prices.secondaryAsk;
        if (!sAsk) return -Infinity;
        return ((pBid - sAsk) / sAsk) * 100;
    } else {
        const pAsk = prices.primaryAsk;
        const sBid = prices.secondaryBid;
        if (!pAsk) return -Infinity;
        return ((sBid - pAsk) / pAsk) * 100;
    }
}

/**
 * Классический "истинный" (True) PnL в процентах.
 * Вычисляет абсолютный профит в базе (USDT), складывая профит открытия и убыток возврата закрытия,
 * и делит на "начальный капитал" с целью получить железную процентную метрику без иллюзий.
 */
export function calculateTruePnL(
    openPrices: { pOpen: number; sOpen: number },
    currentPrices: OrderbookPrices,
    orderType: 'buy' | 'sell'
): number {
    if (orderType === 'sell') {
        // Мы шортили на Binance (pOpen = pBid) и лонговали на Bybit (sOpen = sAsk).
        // Закрываем: покупаем на Binance (pAsk) и продаем на Bybit (sBid).
        const profitUsdt = 
            (openPrices.pOpen - openPrices.sOpen) + // Рассчитали разницу открытия
            (currentPrices.secondaryBid - currentPrices.primaryAsk); // Обратная конвертация
            
        return (profitUsdt / openPrices.sOpen) * 100;
    } else {
        // Мы лонговали на Binance (pOpen = pAsk) и шортили на Bybit (sOpen = sBid).
        // Закрываем: продаем на Binance (pBid) и покупаем на Bybit (sAsk).
        const profitUsdt = 
            (openPrices.sOpen - openPrices.pOpen) + 
            (currentPrices.primaryBid - currentPrices.secondaryAsk);
            
        return (profitUsdt / openPrices.pOpen) * 100;
    }
}

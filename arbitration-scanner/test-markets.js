const ccxt = require('ccxt');
async function test() {
    const binance = new ccxt.binance({ options: { defaultType: 'swap' } });
    const bybit = new ccxt.bybit({ options: { defaultType: 'swap' } });
    await binance.loadMarkets();
    await bybit.loadMarkets();
    console.log(Object.keys(binance.markets).slice(0, 5));
    console.log(Object.keys(bybit.markets).slice(0, 5));
}
test().catch(console.error);

import { BinanceClient } from './src/exchanges/binance-client.js';

/**
 * Minimal manual smoke test for Binance market metadata.
 *
 * Run with a configured .env to verify that signed/public Binance client setup
 * can load markets and convert BTC/USDT:USDT metadata into the common shape.
 */
async function run() {
    const client = new BinanceClient();
    console.log('Loading Binance markets...');
    await client.loadMarkets();
    
    console.log('USDT Symbols:', client.getUsdtSymbols().slice(0, 5), '...');
    
    const info = client.getMarketInfo('BTC/USDT:USDT');
    console.log('Market Info BTC/USDT:USDT', info);
}
run().catch(console.error);

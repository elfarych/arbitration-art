import { GateClient } from './src/exchanges/gate-client.js';

async function run() {
    const client = new GateClient();
    console.log('Loading markets...');
    await client.loadMarkets();
    
    console.log('USDT Symbols:', client.getUsdtSymbols().slice(0, 5), '...');
    
    const info = client.getMarketInfo('BTC/USDT:USDT');
    console.log('Market Info BTC/USDT:USDT', info);
}
run().catch(console.error);

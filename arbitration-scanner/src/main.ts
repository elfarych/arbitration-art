import * as ccxt from 'ccxt';
import { pro } from 'ccxt';
import { Trader } from './classes/Trader.js';
import { api } from './services/api.js';

const CHUNK_SIZE = 10;

async function bootstrap() {
    console.log('[Scanner] Bootstrapping...');
    
    // 1. Load markets via REST (one-time)
    const restBinance = new ccxt.binanceusdm();
    const restBybit = new ccxt.bybit({ options: { defaultType: 'swap' } });

    console.log('[Scanner] Loading markets from Binance and Bybit...');
    await Promise.all([
        restBinance.loadMarkets(),
        restBybit.loadMarkets(),
    ]);

    // 2. Find common USDT linear perpetual markets
    const binanceSymbols = new Set(
        Object.keys(restBinance.markets).filter(sym => sym.endsWith(':USDT'))
    );
    const bybitSymbols = Object.keys(restBybit.markets).filter(sym => sym.endsWith(':USDT'));
    const commonSymbols = bybitSymbols.filter(sym => binanceSymbols.has(sym));

    console.log(`[Scanner] Found ${commonSymbols.length} intersecting USDT futures pairs.`);

    if (commonSymbols.length === 0) {
        console.error('[Scanner] No common symbols found. Exiting.');
        process.exit(1);
    }

    // 3. Create SHARED pro exchange instances (single WS connection each, multiplexed)
    const sharedBinance = new pro.binanceusdm();
    const sharedBybit = new pro.bybit({ options: { defaultType: 'swap' } });

    // Pre-load markets on shared instances ONCE to avoid 49 parallel loadMarkets() calls
    console.log('[Scanner] Pre-loading markets on WebSocket instances...');
    await Promise.all([
        sharedBinance.loadMarkets(),
        sharedBybit.loadMarkets(),
    ]);
    console.log('[Scanner] Markets loaded. Ready to stream.');

    // 4. Chunk pairs
    const chunks: string[][] = [];
    for (let i = 0; i < commonSymbols.length; i += CHUNK_SIZE) {
        chunks.push(commonSymbols.slice(i, i + CHUNK_SIZE));
    }
    console.log(`[Scanner] Split into ${chunks.length} chunks of ${CHUNK_SIZE}.`);

    // 5. Recover open trades from Django (crash resilience)
    console.log('[Scanner] Checking for open trades from previous session...');
    const openTrades = await api.getOpenTrades();
    console.log(`[Scanner] Found ${openTrades.length} open trades to restore.`);

    // 6. Create traders (all share the same exchange instances)
    const traders: Trader[] = chunks.map((chunk, i) => new Trader(i + 1, chunk, sharedBinance, sharedBybit));

    // 7. Distribute recovered trades to the right trader
    for (const trade of openTrades) {
        const coin = trade.coin;
        const trader = traders.find(t => t.symbols.includes(coin));
        if (trader) {
            await trader.restoreOpenTrades([trade]);
        } else {
            console.warn(`[Scanner] ⚠️ Open trade for ${coin} (ID: ${trade.id}) has no matching trader chunk. Ignoring.`);
        }
    }

    // 8. Graceful shutdown handler
    const shutdown = async () => {
        console.log('\n[Scanner] Graceful shutdown initiated...');
        await Promise.allSettled(traders.map(t => t.stop()));
        try { await sharedBinance.close(); } catch { /* ignore */ }
        try { await sharedBybit.close(); } catch { /* ignore */ }
        console.log('[Scanner] All traders stopped. Bye.');
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // 9. Start all traders (this blocks forever)
    console.log('[Scanner] Starting all traders...');
    await Promise.all(traders.map(t => t.start()));
}

bootstrap().catch(err => {
    console.error('[Scanner] Fatal Bootstrap Error:', err);
    process.exit(1);
});

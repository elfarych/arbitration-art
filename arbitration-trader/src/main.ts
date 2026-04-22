import { pro } from 'ccxt';
import { config } from './config.js';
import { logger } from './utils/logger.js';
import { BinanceClient } from './exchanges/binance-client.js';
import { BybitClient } from './exchanges/bybit-client.js';
import { MexcClient } from './exchanges/mexc-client.js';
import { GateClient } from './exchanges/gate-client.js';
import type { IExchangeClient } from './exchanges/exchange-client.js';
import { MarketInfoService } from './services/market-info.js';
import { Trader, TradeCounter } from './classes/Trader.js';
import { api } from './services/api.js';

const TAG = 'Trader';

/**
 * Bootstrap the standalone scanner/trader process.
 *
 * This service does not wait for Django to start individual bots. It owns the
 * full runtime: choose exchanges, discover common liquid symbols, set account
 * parameters, stream orderbooks, and launch Trader chunks.
 */
async function bootstrap() {
    logger.info(TAG, '═══════════════════════════════════════════');
    logger.info(TAG, '  Arbitration Trader — Real Trading Mode');
    logger.info(TAG, `  Testnet: ${config.useTestnet ? 'YES ⚠️' : 'NO (production)'}`);
    logger.info(TAG, `  Trade Amount: ${config.tradeAmountUsdt} USDT, Leverage: ${config.leverage}x`);
    logger.info(TAG, `  Max Concurrent Trades: ${config.maxConcurrentTrades}`);
    logger.info(TAG, `  Max Trade Duration: ${config.maxTradeDurationMs / 60000} min`);
    logger.info(TAG, `  Open Threshold: ${config.openThreshold}%, Close Threshold: ${config.closeThreshold}%`);
    logger.info(TAG, '═══════════════════════════════════════════');

    // 1. Create REST exchange clients dynamically based on config.
    // REST clients are responsible for market metadata, account setup and order
    // execution. WebSocket clients are created later for orderbook streaming.
    logger.info(TAG, `Initializing exchanges... Primary: ${config.primaryExchange}, Secondary: ${config.secondaryExchange}`);

    const createClient = (name: string): IExchangeClient => {
        switch (name.toLowerCase()) {
            case 'binance': return new BinanceClient();
            case 'bybit': return new BybitClient();
            case 'mexc': return new MexcClient();
            case 'gate': return new GateClient();
            default:
                logger.error(TAG, `Unknown exchange: ${name}`);
                process.exit(1);
        }
    };

    const primaryClient = createClient(config.primaryExchange);
    const secondaryClient = createClient(config.secondaryExchange);

    if (config.primaryExchange === config.secondaryExchange) {
        logger.error(TAG, 'Primary and secondary exchanges MUST be different.');
        process.exit(1);
    }

    // Measure ping
    try {
        logger.info(TAG, 'Measuring latency to exchange matching engines...');
        
        // Warmup requests establish DNS, TCP handshakes and TLS sessions. The
        // second request is a better approximation of steady-state API latency.
        await Promise.all([
            primaryClient.ccxtInstance.fetchTime().catch(() => {}),
            secondaryClient.ccxtInstance.fetchTime().catch(() => {})
        ]);

        // Application-level ping reusing established keep-alive sockets.
        const [bStart, yStart] = [Date.now(), Date.now()];

        await Promise.all([
            primaryClient.ccxtInstance.fetchTime().then(() => {
                const ping = Date.now() - bStart;
                logger.info(TAG, `📡 ${primaryClient.name} Latency: ${ping} ms`);
            }).catch(() => logger.warn(TAG, `Failed to measure latency for ${primaryClient.name}`)),
            secondaryClient.ccxtInstance.fetchTime().then(() => {
                const ping = Date.now() - yStart;
                logger.info(TAG, `📡 ${secondaryClient.name} Latency: ${ping} ms`);
            }).catch(() => logger.warn(TAG, `Failed to measure latency for ${secondaryClient.name}`))
        ]);
    } catch (e: any) {
        logger.warn(TAG, `Failed to measure latency: ${e.message}`);
    }

    // 2. Load markets via REST. Exchange clients cache this metadata for symbol
    // discovery and order-size validation.
    logger.info(TAG, `Loading markets from ${primaryClient.name} and ${secondaryClient.name}...`);
    await Promise.all([
        primaryClient.loadMarkets(),
        secondaryClient.loadMarkets(),
    ]);

    // 3. Find common USDT linear perpetual markets. The rest of the process uses
    // ccxt futures symbols such as BTC/USDT:USDT.
    const primarySymbols = new Set(primaryClient.getUsdtSymbols());
    const secondarySymbols = secondaryClient.getUsdtSymbols();
    let commonSymbols = secondarySymbols.filter(sym => primarySymbols.has(sym));

    logger.info(TAG, `Found ${commonSymbols.length} intersecting USDT futures pairs.`);

    logger.info(TAG, `Fetching 24h volume to determine top ${config.topLiquidPairsCount} liquid pairs...`);
    try {
        const tickers = await primaryClient.ccxtInstance.fetchTickers();
        
        // Exclude illiquid markets. Low-depth symbols can show large spreads that
        // are not executable at the configured trade size.
        commonSymbols = commonSymbols.filter(sym => {
            const vol = tickers[sym]?.quoteVolume || 0;
            return vol >= 2_000_000; 
        });

        // Sort by quote volume descending so the trader focuses on the most
        // liquid markets first.
        commonSymbols.sort((a, b) => {
            const volA = tickers[a]?.quoteVolume || 0;
            const volB = tickers[b]?.quoteVolume || 0;
            return volB - volA;
        });

        const TOP_LIMIT = config.topLiquidPairsCount;
        commonSymbols = commonSymbols.slice(0, TOP_LIMIT);
        logger.info(TAG, `Filtered down to top ${commonSymbols.length} most liquid pairs based on ${primaryClient.name} 24h USDT volume.`);
    } catch (e: any) {
        logger.warn(TAG, `Failed to fetch volume data, proceeding with all ${commonSymbols.length} pairs. Error: ${e.message}`);
    }

    if (commonSymbols.length === 0) {
        logger.error(TAG, 'No common symbols found. Exiting.');
        process.exit(1);
    }

    // 4. Pre-load market info and calculate unified trade amounts before any
    // order setup. This avoids discovering lot-size incompatibilities mid-trade.
    const marketInfo = new MarketInfoService();
    const tradeableSymbols = await marketInfo.initialize(primaryClient, secondaryClient, commonSymbols);

    if (tradeableSymbols.length === 0) {
        logger.error(TAG, 'No tradeable symbols after market info validation. Exiting.');
        process.exit(1);
    }

    // 5. Set leverage and isolated margin on every validated pair on both
    // exchanges. Pairs that fail setup are excluded from trading.
    logger.info(TAG, `Setting leverage ${config.leverage}x and isolated margin on ${tradeableSymbols.length} pairs...`);

    let leverageErrors = 0;
    // Bybit allows about 10 account-setting requests per second. Each pair needs
    // two requests per exchange branch, so a small batch plus delay is safer.
    const batchSize = 5;
    const finalTradeableSymbols: string[] = [];

    const setupSymbol = async (symbol: string) => {
        // Run primary and secondary setup branches in parallel because they touch
        // independent exchange accounts.
        await Promise.all([
            primaryClient.setIsolatedMargin(symbol).then(() => primaryClient.setLeverage(symbol, config.leverage)),
            secondaryClient.setIsolatedMargin(symbol).then(() => secondaryClient.setLeverage(symbol, config.leverage))
        ]);
    };

    for (let i = 0; i < tradeableSymbols.length; i += batchSize) {
        const batch = tradeableSymbols.slice(i, i + batchSize);
        const results = await Promise.allSettled(batch.map(sym => setupSymbol(sym)));

        results.forEach((r, index) => {
            if (r.status === 'fulfilled') {
                finalTradeableSymbols.push(batch[index]);
            } else {
                logger.warn(TAG, `Excluding ${batch[index]} due to setup error: ${(r.reason as Error).message}`);
                leverageErrors++;
            }
        });

        // Delay between batches to prevent Bybit "Too many visits" HTTP 429.
        if (i + batchSize < tradeableSymbols.length) {
            await new Promise(r => setTimeout(r, 1200));
        }
    }

    if (finalTradeableSymbols.length === 0) {
        logger.error(TAG, 'No tradeable symbols left after setup constraint checks. Exiting.');
        process.exit(1);
    }

    logger.info(TAG, `Leverage/margin setup complete. Successful pairs: ${finalTradeableSymbols.length}. Excluded pairs: ${leverageErrors}.`);
    // 6. Create shared ccxt.pro exchange instances for WebSocket streaming.
    // All Trader chunks share the same exchange objects and their orderbook cache.
    logger.info(TAG, 'Creating WebSocket instances...');

    const createWsClient = (name: string): any => {
        const isTestnet = config.useTestnet;
        switch (name.toLowerCase()) {
            case 'binance': return new pro.binanceusdm({ ...(isTestnet && { sandbox: true }) });
            case 'bybit': return new pro.bybit({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            case 'mexc': return new pro.mexc({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            case 'gate': return new pro.gate({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            default: throw new Error(`WS client not implemented for ${name}`);
        }
    };

    const wsPrimary = createWsClient(config.primaryExchange);
    const wsSecondary = createWsClient(config.secondaryExchange);

    // Pre-load markets on WS instances before subscribing to orderbooks.
    await Promise.all([
        wsPrimary.loadMarkets(),
        wsSecondary.loadMarkets(),
    ]);
    logger.info(TAG, 'WebSocket markets loaded. Ready to stream.');

    // 7. Create shared trade counter. This enforces a global concurrent-trade
    // limit across all Trader chunks.
    const tradeCounter = new TradeCounter();

    // 8. Chunk pairs into Trader groups to avoid putting all symbols into one
    // huge state map and to keep logs grouped by trader id.
    const chunks: string[][] = [];
    for (let i = 0; i < finalTradeableSymbols.length; i += config.chunkSize) {
        chunks.push(finalTradeableSymbols.slice(i, i + config.chunkSize));
    }
    logger.info(TAG, `Split into ${chunks.length} chunks of ${config.chunkSize}.`);

    // 9. Recover open trades from Django for crash resilience. The trader will
    // continue monitoring exits for positions that were opened before restart.
    logger.info(TAG, 'Checking for open trades from previous session...');
    const openTrades = await api.getOpenTrades();
    logger.info(TAG, `Found ${openTrades.length} open trades to restore.`);

    // 10. Create traders.
    const traders: Trader[] = chunks.map((chunk, i) =>
        new Trader(
            i + 1, chunk,
            wsPrimary, wsSecondary,
            primaryClient, secondaryClient,
            marketInfo, tradeCounter,
        ),
    );

    // 11. Distribute recovered trades to the chunk that owns each symbol.
    for (const trade of openTrades) {
        const coin = trade.coin;
        const trader = traders.find(t => t.symbols.includes(coin));
        if (trader) {
            trader.restoreOpenTrades([trade]);
        } else {
            logger.warn(TAG, `⚠️ Open trade for ${coin} (ID: ${trade.id}) has no matching trader chunk. Ignoring.`);
        }
    }

    // 12. Graceful shutdown handler. A normal signal attempts to close all active
    // positions before exiting the Node process.
    let isShuttingDown = false;

    const shutdown = async () => {
        if (isShuttingDown) {
            logger.warn(TAG, '⚠️ Repeated shutdown signal received! Forcing exit.');
            process.exit(1);
        }
        isShuttingDown = true;

        logger.info(TAG, '\n🛑 Graceful shutdown initiated. Closing all positions...');

        // Stop all traders and close their positions.
        await Promise.allSettled(
            traders.map(t => t.stop(true)),
        );

        // Close WebSocket connections after traders stop reading orderbooks.
        try { await wsPrimary.close(); } catch { /* ignore */ }
        try { await wsSecondary.close(); } catch { /* ignore */ }

        logger.info(TAG, '✅ All traders stopped. All positions closed. Bye.');
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Catch uncaught errors to prevent silent crashes and attempt a safe shutdown.
    process.on('uncaughtException', (err) => {
        logger.error(TAG, `Uncaught exception: ${err.message}`);
        logger.error(TAG, err.stack || '');
        shutdown();
    });

    process.on('unhandledRejection', (reason: any) => {
        logger.error(TAG, `Unhandled rejection: ${reason?.message || reason}`);
    });

    // 13. Start all traders. This promise normally never resolves.
    logger.info(TAG, `🚀 Starting ${traders.length} traders...`);
    await Promise.all(traders.map(t => t.start()));
}

bootstrap().catch(err => {
    logger.error(TAG, `Fatal Bootstrap Error: ${err.message}`);
    logger.error(TAG, err.stack || '');
    process.exit(1);
});

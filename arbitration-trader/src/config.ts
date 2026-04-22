import * as dotenv from 'dotenv';
dotenv.config();

/**
 * Read a required environment variable and fail during bootstrap if it is absent.
 *
 * The trader places real exchange orders, so missing credentials should stop the
 * process before any market data or order setup starts.
 */
function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`[Config] Missing required environment variable: ${name}`);
    }
    return value;
}

/**
 * Process-wide runtime configuration.
 *
 * Unlike arbitration-bot-engine, this standalone trader uses global exchange
 * credentials from .env and scans many symbols by itself. Values are parsed once
 * at startup and then treated as immutable by the rest of the process.
 */
export const config = {
    // === Exchange credentials ===
    binance: {
        apiKey: requireEnv('BINANCE_API_KEY'),
        secret: requireEnv('BINANCE_SECRET'),
    },
    bybit: {
        apiKey: requireEnv('BYBIT_API_KEY'),
        secret: requireEnv('BYBIT_SECRET'),
    },
    gate: {
        apiKey: process.env.GATE_API_KEY || '',
        secret: process.env.GATE_SECRET || '',
    },
    mexc: {
        apiKey: process.env.MEXC_API_KEY || '',
        secret: process.env.MEXC_SECRET || '',
    },

    // === Exchange Routing ===
    // Active arbitrage route. Supported values: binance, bybit, mexc, gate.
    primaryExchange: process.env.PRIMARY_EXCHANGE?.toLowerCase() || 'binance',
    secondaryExchange: process.env.SECONDARY_EXCHANGE?.toLowerCase() || 'bybit',

    // === Testnet mode ===
    useTestnet: process.env.USE_TESTNET === 'true',

    // === Trading parameters ===
    tradeAmountUsdt: Number(process.env.TRADE_AMOUNT_USDT || '50'),
    leverage: Number(process.env.LEVERAGE || '10'),
    maxConcurrentTrades: Number(process.env.MAX_CONCURRENT_TRADES || '3'),
    maxTradeDurationMs: Number(process.env.MAX_TRADE_DURATION_MINUTES || '60') * 60 * 1000,
    maxLegDrawdownPercent: Number(process.env.MAX_LEG_DRAWDOWN_PERCENT || '80'),

    // === Monitoring parameters ===
    openThreshold: Number(process.env.OPEN_THRESHOLD || '2.0'),
    closeThreshold: Number(process.env.CLOSE_THRESHOLD || '1.5'),
    orderbookLimit: Number(process.env.ORDERBOOK_LIMIT || '50'),
    chunkSize: Number(process.env.CHUNK_SIZE || '10'),
    topLiquidPairsCount: Number(process.env.TOP_LIQUID_PAIRS_COUNT || '100'),

    // === Infrastructure ===
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
} as const;

import * as dotenv from 'dotenv';
dotenv.config();

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`[Config] Missing required environment variable: ${name}`);
    }
    return value;
}

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

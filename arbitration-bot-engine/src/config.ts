import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the engine working directory.
// The service is normally started from arbitration-bot-engine/, so process.cwd()
// should point at the same folder that contains the local .env file.
dotenv.config({ path: path.join(process.cwd(), '.env') });

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`[Config] Missing required environment variable: ${name}`);
    }
    return value;
}

function readPositiveInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === '') return fallback;
    const parsed = Number(raw.replace(/_/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`[Config] ${name} must be a positive number`);
    }
    return parsed;
}

export const config = {
    // Base URL of the Django API without a trailing slash. The API service adds
    // endpoint paths such as /bots/real-trades/ on top of this value.
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    // Enables exchange sandbox/testnet endpoints where the individual client
    // implementation supports them.
    useTestnet: process.env.USE_TESTNET === 'true',
    // Public HTTP port for Django -> engine control requests.
    port: parseInt(process.env.PORT || '3001', 10),
    // MarketInfoService uses this fixed notional only as a preflight guard.
    tradeAmountUsdt: Number(process.env.TRADE_AMOUNT_USDT || '50'),
    // Shared service token for Django <-> runtime communication.
    serviceToken: requireEnv('SERVICE_SHARED_TOKEN'),
    // Maximum age (ms) of an OrderBook snapshot considered fresh enough for a
    // non-emergency trading decision. Updates older than this are treated as
    // missing data: BotTrader skips entry/profit signals until the WS stream
    // catches up. Emergency exits (timeout/liquidation/force-close/shutdown)
    // intentionally bypass this guard because closing on stale prices is still
    // safer than holding the position.
    orderbookMaxAgeMs: readPositiveInt('ORDERBOOK_MAX_AGE_MS', 15_000),
    // Maximum allowed difference (ms) between the local arrival timestamps of
    // the primary and secondary snapshots used for one trading decision. A
    // large skew means one leg's WS is lagging — comparing those books would
    // produce a spread signal that does not exist on the live market. Set to 0
    // to disable the check.
    orderbookMaxSkewMs: readPositiveInt('ORDERBOOK_MAX_SKEW_MS', 2_000),
};

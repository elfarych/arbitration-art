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
};

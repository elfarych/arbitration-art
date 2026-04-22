import * as dotenv from 'dotenv';
import path from 'path';

// Load environment variables from the engine working directory.
// The service is normally started from arbitration-bot-engine/, so process.cwd()
// should point at the same folder that contains the local .env file.
dotenv.config({ path: path.join(process.cwd(), '.env') });

/**
 * Runtime configuration for the Fastify engine process.
 *
 * Important: several exchange clients currently reference additional config
 * fields such as exchange API credentials and tradeAmountUsdt. Those fields are
 * not exported here yet, which means the TypeScript build currently fails until
 * this configuration contract is completed or the clients are refactored to use
 * per-bot credentials only.
 */
export const config = {
    // Base URL of the Django API without a trailing slash. The API service adds
    // endpoint paths such as /bots/real-trades/ on top of this value.
    djangoApiUrl: process.env.DJANGO_API_URL || 'http://127.0.0.1:8000/api',
    // Enables exchange sandbox/testnet endpoints where the individual client
    // implementation supports them.
    useTestnet: process.env.USE_TESTNET === 'true',
    // Public HTTP port for Django -> engine control requests.
    port: parseInt(process.env.PORT || '3001', 10),
};

import { pro } from 'ccxt';
import { BotTrader } from './BotTrader.js';
import { BinanceClient } from '../exchanges/binance-client.js';
import { BybitClient } from '../exchanges/bybit-client.js';
import { MexcClient } from '../exchanges/mexc-client.js';
import { GateClient } from '../exchanges/gate-client.js';
import { MarketInfoService } from '../services/market-info.js';
import { logger } from '../utils/logger.js';
import { api } from '../services/api.js';

/**
 * In-memory orchestration layer for all bot traders running in this process.
 *
 * Django owns persistence and sends lifecycle commands. Engine owns the runtime
 * objects: REST clients, WebSocket clients, market info caches, and BotTrader
 * instances. If this process restarts, Engine reconstructs traders only when
 * Django calls /engine/bot/start again.
 */
export class Engine {
    // Keyed by Django BotConfig.id. This process is single-instance aware only;
    // there is no distributed lock if multiple engine processes receive the
    // same bot_id.
    private traders: Map<number, BotTrader> = new Map();
    // Set of bot ids whose start handlers are still running. Used together with
    // `traders` to prevent the race where two concurrent /engine/bot/start
    // requests both pass the duplicate check before either has finished
    // constructing the trader.
    private starting: Set<number> = new Set();

    private createRestClient(name: string, keys: any) {
        // REST clients place orders and perform account operations. Credentials
        // are validated by extractKeys before this point so that we never hand a
        // client object empty credentials and then fail with an opaque 401 on
        // the latency-critical order path.
        const creds = this.extractKeys(name, keys);
        switch (name) {
            case 'binance_futures': return new BinanceClient(creds.apiKey, creds.secret);
            case 'bybit_futures': return new BybitClient(creds.apiKey, creds.secret);
            case 'mexc_futures': return new MexcClient(creds.apiKey, creds.secret);
            case 'gate_futures': return new GateClient(creds.apiKey, creds.secret);
            default: throw new Error(`Unknown REST exchange: ${name}`);
        }
    }

    private createWsClient(name: string) {
        // WebSocket clients are ccxt.pro instances used only for public orderbook
        // data. They intentionally run unauthenticated: the order/account paths
        // go through the REST clients with user keys, and keeping the WS sockets
        // public removes a credential-leak surface from ccxt.pro internals.
        switch (name) {
            case 'binance_futures': return new pro.binanceusdm();
            case 'bybit_futures': return new pro.bybit({ options: { defaultType: 'swap' } });
            case 'mexc_futures': return new pro.mexc({ options: { defaultType: 'swap' } });
            case 'gate_futures': return new pro.gate({ options: { defaultType: 'swap' } });
            default: throw new Error(`Unknown WS exchange: ${name}`);
        }
    }

    private extractKeys(exchangeName: string, keys: any): { apiKey: string; secret: string } {
        // Django sends one flat keys object per user. This helper maps the bot's
        // exchange name to the credential pair expected by the REST clients.
        // Missing credentials are a hard error: we refuse to construct a client
        // without keys so that the trader cannot reach the order-submission path
        // and discover the gap by means of an exchange 401.
        if (!keys || typeof keys !== 'object') {
            throw new Error(`Missing keys payload for ${exchangeName}`);
        }
        let apiKey = '';
        let secret = '';
        if (exchangeName.startsWith('binance')) {
            apiKey = keys.binance_api_key;
            secret = keys.binance_secret;
        } else if (exchangeName.startsWith('bybit')) {
            apiKey = keys.bybit_api_key;
            secret = keys.bybit_secret;
        } else if (exchangeName.startsWith('gate')) {
            apiKey = keys.gate_api_key;
            secret = keys.gate_secret;
        } else if (exchangeName.startsWith('mexc')) {
            apiKey = keys.mexc_api_key;
            secret = keys.mexc_secret;
        } else {
            throw new Error(`No credential mapping for exchange ${exchangeName}`);
        }
        if (!apiKey || !secret) {
            throw new Error(`Missing API credentials for ${exchangeName}`);
        }
        return { apiKey, secret };
    }

    public async startBot(botId: number, config: any, keys: any) {
        // Duplicate start requests are treated as config syncs to keep Django
        // retries from spawning two loops for the same bot. The starting set
        // also blocks a second start that arrives while initialization is still
        // running for the same bot id.
        if (this.traders.has(botId) || this.starting.has(botId)) {
            logger.warn('Engine', `Bot ${botId} is already running/initializing; syncing config instead.`);
            this.syncBot(botId, config);
            return;
        }

        this.starting.add(botId);
        logger.info('Engine', `Starting Bot ${botId} [${config.coin}]...`);

        try {
            const isReal = config.trade_mode === 'real';
            const tradePrimary = !!config.trade_on_primary_exchange;
            const tradeSecondary = !!config.trade_on_secondary_exchange;

            // REST clients are initialized first because market metadata,
            // leverage, margin mode and real order execution all go through the
            // REST side.
            const primaryRest = this.createRestClient(config.primary_exchange, keys);
            const secondaryRest = this.createRestClient(config.secondary_exchange, keys);

            await Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()]);

            // MarketInfoService merges exchange constraints into one strict view
            // so BotTrader can size orders that are valid on both legs.
            const marketInfo = new MarketInfoService();
            await marketInfo.initialize(primaryRest, secondaryRest, [config.coin]);

            // Configure isolated margin and leverage only for real trading.
            // Each leg's two calls run in parallel because they are independent
            // on every supported exchange; failures are logged but do not abort
            // bot start since most exchanges treat repeated calls as no-ops.
            if (isReal) {
                const setupTasks: Promise<any>[] = [];
                if (tradePrimary) {
                    setupTasks.push(
                        Promise.allSettled([
                            primaryRest.setIsolatedMargin(config.coin),
                            primaryRest.setLeverage(config.coin, config.primary_leverage),
                        ]).then(results => {
                            for (const r of results) {
                                if (r.status === 'rejected') {
                                    logger.warn('Engine', `Primary leg setup warning: ${r.reason?.message ?? r.reason}`);
                                }
                            }
                        }),
                    );
                }
                if (tradeSecondary) {
                    setupTasks.push(
                        Promise.allSettled([
                            secondaryRest.setIsolatedMargin(config.coin),
                            secondaryRest.setLeverage(config.coin, config.secondary_leverage),
                        ]).then(results => {
                            for (const r of results) {
                                if (r.status === 'rejected') {
                                    logger.warn('Engine', `Secondary leg setup warning: ${r.reason?.message ?? r.reason}`);
                                }
                            }
                        }),
                    );
                }
                await Promise.all(setupTasks);
            }

            // WebSocket clients are separate from REST clients because ccxt.pro
            // maintains live orderbook subscriptions.
            const primaryWs = this.createWsClient(config.primary_exchange);
            const secondaryWs = this.createWsClient(config.secondary_exchange);

            await Promise.all([primaryWs.loadMarkets(), secondaryWs.loadMarkets()]);

            const trader = new BotTrader(
                config,
                primaryWs,
                secondaryWs,
                primaryRest as any,
                secondaryRest as any,
                marketInfo,
            );

            // Recover existing open trades from Django so a restarted engine can
            // keep monitoring exit conditions for positions already recorded as
            // open.
            try {
                const openTrades = isReal
                    ? await api.getOpenTrades(botId)
                    : await api.getOpenEmulationTrades(botId);
                trader.restoreOpenTrades(openTrades);
            } catch (e: any) {
                logger.warn('Engine', `Could not fetch open trades for bot ${botId}: ${e.message}`);
            }

            this.traders.set(botId, trader);
            // Do not await trader.start(): it runs long-lived watch loops.
            // Errors are logged here because otherwise an unhandled rejection
            // would be easy to miss in a background bot.
            trader.start().catch(e => logger.error('Engine', `Bot ${botId} crashed: ${e.message}`));
        } finally {
            this.starting.delete(botId);
        }
    }

    public syncBot(botId: number, config: any) {
        logger.info('Engine', `Syncing config for Bot ${botId}`);
        const trader = this.traders.get(botId);
        if (trader) {
            trader.syncConfig(config);
        } else {
            logger.warn('Engine', `Bot ${botId} not found in this engine instance during sync.`);
        }
    }

    public async stopBot(botId: number) {
        const trader = this.traders.get(botId);
        if (trader) {
            // Stop requests are graceful by default: if a trade is active, the
            // trader attempts to close it before being removed from memory.
            await trader.stop(true); // Graceful close positions if active
            this.traders.delete(botId);
            logger.info('Engine', `Removed Bot ${botId}`);
        }
    }

    public async forceClose(botId: number) {
        const trader = this.traders.get(botId);
        if (trader) {
            // Force close leaves the trader registered; after closing the active
            // trade it can continue looking for entries if the bot remains active.
            await trader.forceClose();
        }
    }

    public async stopAll(): Promise<void> {
        // Used by main.ts during SIGINT/SIGTERM. Each bot's stop runs in
        // parallel because they own independent exchange sockets and order
        // submissions; sequential shutdown would multiply the worst-case time
        // by the number of active bots.
        const botIds = Array.from(this.traders.keys());
        if (botIds.length === 0) return;
        logger.info('Engine', `stopAll: shutting down ${botIds.length} bot(s)`);
        await Promise.allSettled(botIds.map(id => this.stopBot(id)));
    }
}

import { BotTrader } from './BotTrader.js';
import { BinanceClient } from '../exchanges/binance-client.js';
import { BybitClient } from '../exchanges/bybit-client.js';
import { MexcClient } from '../exchanges/mexc-client.js';
import { GateClient } from '../exchanges/gate-client.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import { OrderBookStore } from '../market-data/orderbook-store.js';
import { MarketInfoService } from '../services/market-info.js';
import { logger } from '../utils/logger.js';
import { api } from '../services/api.js';

/**
 * In-memory orchestration layer for all bot traders running in this process.
 *
 * Engine owns the runtime objects: native REST clients, native market WS
 * clients, the shared `OrderBookStore`, market-info caches and `BotTrader`
 * instances. Django owns persistence and sends lifecycle commands. If this
 * process restarts, Engine reconstructs traders only when Django calls
 * `/engine/bot/start` again.
 *
 * The engine has no `ccxt` runtime dependency: every exchange interaction
 * goes through `IExchangeClient` (REST) or `MarketWsClient` (orderbook WS).
 */
export class Engine {
    private readonly traders = new Map<number, BotTrader>();
    private readonly starting = new Set<number>();
    // One shared store backs every BotTrader. The native market WS clients
    // push snapshots into this store keyed by `exchangeKey:symbol`, and each
    // trader filters updates relevant to its own pair.
    private readonly orderBookStore = new OrderBookStore();

    public async startBot(botId: number, config: any, keys: any): Promise<void> {
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

            const primaryRest = this.createRestClient(config.primary_exchange, keys);
            const secondaryRest = this.createRestClient(config.secondary_exchange, keys);

            await Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()]);

            const marketInfo = new MarketInfoService();
            await marketInfo.initialize(primaryRest, secondaryRest, [config.coin]);

            // Margin/leverage setup is parallelised both inside each leg
            // (margin + leverage + optional account-settings prefetch) and
            // across the two legs. `prefetchAccountSettings` warms adapter-
            // specific account flags (e.g. Binance Hedge Mode) so the first
            // order never has to probe them lazily on the hot path. Failures
            // here are logged but never abort startBot — every supported
            // exchange returns either a no-op or a benign error for repeated
            // calls, and the adapter falls back to its own sensible default.
            if (isReal) {
                const legSetup = (rest: IExchangeClient, leverage: number): Promise<any>[] => {
                    const tasks: Promise<any>[] = [
                        rest.setIsolatedMargin(config.coin),
                        rest.setLeverage(config.coin, leverage),
                    ];
                    if (typeof rest.prefetchAccountSettings === 'function') {
                        tasks.push(rest.prefetchAccountSettings(config.coin));
                    }
                    return tasks;
                };

                const setupTasks: Promise<any>[] = [];
                if (tradePrimary) {
                    setupTasks.push(
                        Promise.allSettled(legSetup(primaryRest, config.primary_leverage)).then(results => {
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
                        Promise.allSettled(legSetup(secondaryRest, config.secondary_leverage)).then(results => {
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

            // Native market WS clients are produced by the REST adapter so
            // the engine does not need to switch on exchange name twice. The
            // clients push parsed snapshots into the shared OrderBookStore.
            const primaryMarketWs = primaryRest.createMarketWs(this.orderBookStore);
            const secondaryMarketWs = secondaryRest.createMarketWs(this.orderBookStore);

            const trader = new BotTrader(
                config,
                primaryRest,
                secondaryRest,
                primaryMarketWs,
                secondaryMarketWs,
                this.orderBookStore,
                marketInfo,
            );

            try {
                const openTrades = isReal
                    ? await api.getOpenTrades(botId)
                    : await api.getOpenEmulationTrades(botId);
                trader.restoreOpenTrades(openTrades);
            } catch (e: any) {
                logger.warn('Engine', `Could not fetch open trades for bot ${botId}: ${e.message}`);
            }

            this.traders.set(botId, trader);
            // Start subscribes to OrderBookStore and connects WS. We await
            // because connect() resolves once the sockets are open and the
            // subscribe payloads have been sent; the message dispatch happens
            // asynchronously after that.
            await trader.start();
        } catch (err) {
            // If startup fails after we wrote to traders, clean up so future
            // syncs do not see a half-initialized bot.
            this.traders.delete(botId);
            throw err;
        } finally {
            this.starting.delete(botId);
        }
    }

    public syncBot(botId: number, config: any): void {
        logger.info('Engine', `Syncing config for Bot ${botId}`);
        const trader = this.traders.get(botId);
        if (trader) {
            trader.syncConfig(config);
        } else {
            logger.warn('Engine', `Bot ${botId} not found in this engine instance during sync.`);
        }
    }

    public async stopBot(botId: number): Promise<void> {
        const trader = this.traders.get(botId);
        if (trader) {
            await trader.stop(true);
            this.traders.delete(botId);
            logger.info('Engine', `Removed Bot ${botId}`);
        }
    }

    public async forceClose(botId: number): Promise<void> {
        const trader = this.traders.get(botId);
        if (trader) {
            await trader.forceClose();
        }
    }

    public async stopAll(): Promise<void> {
        const botIds = Array.from(this.traders.keys());
        if (botIds.length === 0) return;
        logger.info('Engine', `stopAll: shutting down ${botIds.length} bot(s)`);
        await Promise.allSettled(botIds.map(id => this.stopBot(id)));
    }

    private createRestClient(name: string, keys: any): IExchangeClient {
        const creds = this.extractKeys(name, keys);
        switch (name) {
            case 'binance_futures': return new BinanceClient(creds.apiKey, creds.secret);
            case 'bybit_futures': return new BybitClient(creds.apiKey, creds.secret);
            case 'mexc_futures': return new MexcClient(creds.apiKey, creds.secret);
            case 'gate_futures': return new GateClient(creds.apiKey, creds.secret);
            default: throw new Error(`Unknown REST exchange: ${name}`);
        }
    }

    private extractKeys(exchangeName: string, keys: any): { apiKey: string; secret: string } {
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
}

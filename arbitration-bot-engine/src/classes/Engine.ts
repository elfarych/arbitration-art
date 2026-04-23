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

    private createRestClient(name: string, keys: any) {
        // REST clients place orders and perform account operations. They should
        // use user-specific keys sent by Django, but the current client classes
        // still read global config credentials, which is documented as a build
        // and runtime contract gap.
        const creds = this.extractKeys(name, keys);
        switch (name) {
            case 'binance_futures': return new BinanceClient(creds.apiKey, creds.secret);
            case 'bybit_futures': return new BybitClient(creds.apiKey, creds.secret);
            case 'mexc_futures': return new MexcClient(creds.apiKey, creds.secret);
            case 'gate_futures': return new GateClient(creds.apiKey, creds.secret);
            default: throw new Error(`Unknown REST exchange: ${name}`);
        }
    }

    private createWsClient(name: string, keys: any) {
        // WebSocket clients are ccxt.pro instances used only for orderbook data.
        // They receive the same credentials because some exchanges require auth
        // even for private/account-adjacent websocket operations.
        const creds = this.extractKeys(name, keys);
        const options = { apiKey: creds.apiKey, secret: creds.secret };
        switch (name) {
            case 'binance_futures': return new pro.binanceusdm(options);
            case 'bybit_futures': return new pro.bybit({ ...options, options: { defaultType: 'swap' } });
            case 'mexc_futures': return new pro.mexc({ ...options, options: { defaultType: 'swap' } });
            case 'gate_futures': return new pro.gate({ ...options, options: { defaultType: 'swap' } });
            default: throw new Error(`Unknown WS exchange: ${name}`);
        }
    }

    private extractKeys(exchangeName: string, keys: any) {
        // Django sends one flat keys object per user. This helper maps the bot's
        // exchange name to the credential pair expected by ccxt/REST clients.
        if (!keys) return { apiKey: '', secret: '' };
        if (exchangeName.startsWith('binance')) return { apiKey: keys.binance_api_key, secret: keys.binance_secret };
        if (exchangeName.startsWith('bybit')) return { apiKey: keys.bybit_api_key, secret: keys.bybit_secret };
        if (exchangeName.startsWith('gate')) return { apiKey: keys.gate_api_key, secret: keys.gate_secret };
        if (exchangeName.startsWith('mexc')) {
             // Fallback for mexc or standard generic
             return { apiKey: keys.mexc_api_key || '', secret: keys.mexc_secret || '' };
        }
        return { apiKey: '', secret: '' };
    }

    public async startBot(botId: number, config: any, keys: any) {
        // Duplicate start requests are treated as config syncs to keep Django
        // retries from spawning two loops for the same bot.
        if (this.traders.has(botId)) {
            logger.warn('Engine', `Bot ${botId} is already running! Syncing config instead.`);
            this.syncBot(botId, config);
            return;
        }

        logger.info('Engine', `Starting Bot ${botId} [${config.coin}]...`);

        // REST clients are initialized first because market metadata, leverage,
        // margin mode and real order execution all go through the REST side.
        const primaryRest = this.createRestClient(config.primary_exchange, keys);
        const secondaryRest = this.createRestClient(config.secondary_exchange, keys);

        await Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()]);

        // MarketInfoService merges exchange constraints into one strict view so
        // BotTrader can size orders that are valid on both legs.
        const marketInfo = new MarketInfoService();
        await marketInfo.initialize(primaryRest, secondaryRest, [config.coin]);

        // Configure isolated margin and leverage only for real trading. Emulator
        // mode uses market data and Django persistence but does not touch exchange
        // accounts.
        if (config.trade_mode === 'real') {
            await Promise.allSettled([
                config.trade_on_primary_exchange ? primaryRest.setIsolatedMargin(config.coin).then(() => primaryRest.setLeverage(config.coin, config.primary_leverage)) : Promise.resolve(),
                config.trade_on_secondary_exchange ? secondaryRest.setIsolatedMargin(config.coin).then(() => secondaryRest.setLeverage(config.coin, config.secondary_leverage)) : Promise.resolve()
            ]);
        }

        // WebSocket clients are separate from REST clients because ccxt.pro
        // maintains live orderbook subscriptions.
        const primaryWs = this.createWsClient(config.primary_exchange, keys);
        const secondaryWs = this.createWsClient(config.secondary_exchange, keys);

        await Promise.all([primaryWs.loadMarkets(), secondaryWs.loadMarkets()]);

        const trader = new BotTrader(config, primaryWs, secondaryWs, primaryRest as any, secondaryRest as any, marketInfo);

        // Recover existing open trades from Django so a restarted engine can keep
        // monitoring exit conditions for positions already recorded as open.
        try {
            const openTrades = config.trade_mode === 'real'
                ? await api.getOpenTrades(botId)
                : await api.getOpenEmulationTrades(botId);
            trader.restoreOpenTrades(openTrades);
        } catch (e) {
            logger.warn('Engine', `Could not fetch open trades for bot ${botId}`);
        }

        this.traders.set(botId, trader);
        // Do not await trader.start(): it runs long-lived watch loops. Errors are
        // logged here because otherwise an unhandled rejection would be easy to
        // miss in a background bot.
        trader.start().catch(e => logger.error('Engine', `Bot ${botId} crashed: ${e.message}`));
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
}

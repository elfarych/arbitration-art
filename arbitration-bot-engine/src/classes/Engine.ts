import { pro } from 'ccxt';
import { BotTrader } from './BotTrader.js';
import { BinanceClient } from '../exchanges/binance-client.js';
import { BybitClient } from '../exchanges/bybit-client.js';
import { MexcClient } from '../exchanges/mexc-client.js';
import { GateClient } from '../exchanges/gate-client.js';
import { MarketInfoService } from '../services/market-info.js';
import { logger } from '../utils/logger.js';
import { api } from '../services/api.js';

export class Engine {
    private traders: Map<number, BotTrader> = new Map();

    private createRestClient(name: string, keys: any) {
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
        if (this.traders.has(botId)) {
            logger.warn('Engine', `Bot ${botId} is already running! Syncing config instead.`);
            this.syncBot(botId, config);
            return;
        }

        logger.info('Engine', `Starting Bot ${botId} [${config.coin}]...`);

        const primaryRest = this.createRestClient(config.primary_exchange, keys);
        const secondaryRest = this.createRestClient(config.secondary_exchange, keys);

        await Promise.all([primaryRest.loadMarkets(), secondaryRest.loadMarkets()]);

        const marketInfo = new MarketInfoService();
        await marketInfo.initialize(primaryRest, secondaryRest, [config.coin]);

        // Setup Margin and Leverage
        if (config.trade_mode === 'real') {
            await Promise.allSettled([
                config.trade_on_primary_exchange ? primaryRest.setIsolatedMargin(config.coin).then(() => primaryRest.setLeverage(config.coin, config.primary_leverage)) : Promise.resolve(),
                config.trade_on_secondary_exchange ? secondaryRest.setIsolatedMargin(config.coin).then(() => secondaryRest.setLeverage(config.coin, config.secondary_leverage)) : Promise.resolve()
            ]);
        }

        const primaryWs = this.createWsClient(config.primary_exchange, keys);
        const secondaryWs = this.createWsClient(config.secondary_exchange, keys);

        await Promise.all([primaryWs.loadMarkets(), secondaryWs.loadMarkets()]);

        const trader = new BotTrader(config, primaryWs, secondaryWs, primaryRest as any, secondaryRest as any, marketInfo);

        // Recover existing open trades from Django
        try {
            const openTrades = config.trade_mode === 'real' ? await api.getOpenTrades() : await api.getOpenEmulationTrades();
            trader.restoreOpenTrades(openTrades);
        } catch (e) {
            logger.warn('Engine', `Could not fetch open trades for bot ${botId}`);
        }

        this.traders.set(botId, trader);
        trader.start().catch(e => logger.error('Engine', `Bot ${botId} crashed: ${e.message}`));
    }

    public syncBot(botId: number, config: any) {
        logger.info('Engine', `Syncing config for Bot ${botId}: ${JSON.stringify(config)}`);
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
            await trader.stop(true); // Graceful close positions if active
            this.traders.delete(botId);
            logger.info('Engine', `Removed Bot ${botId}`);
        }
    }

    public async forceClose(botId: number) {
        const trader = this.traders.get(botId);
        if (trader) {
            await trader.forceClose();
        }
    }
}

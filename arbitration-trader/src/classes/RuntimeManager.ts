import { pro } from 'ccxt';
import { clearActiveRuntime, config, setActiveRuntime } from '../config.js';
import { Trader, TradeCounter } from './Trader.js';
import { BinanceClient } from '../exchanges/binance-client.js';
import { BybitClient } from '../exchanges/bybit-client.js';
import { GateClient } from '../exchanges/gate-client.js';
import { MexcClient } from '../exchanges/mexc-client.js';
import type { IExchangeClient } from '../exchanges/exchange-client.js';
import { api } from '../services/api.js';
import { MarketInfoService } from '../services/market-info.js';
import type { RuntimeCommandPayload } from '../types/index.js';
import { logger } from '../utils/logger.js';

const TAG = 'RuntimeManager';

interface ActiveRuntimeHandle {
    payload: RuntimeCommandPayload;
    traders: Trader[];
    wsPrimary: any;
    wsSecondary: any;
    runPromise: Promise<void>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RuntimeManager {
    private activeRuntime: ActiveRuntimeHandle | null = null;
    private operationChain: Promise<void> = Promise.resolve();

    private withLock<T>(operation: () => Promise<T>): Promise<T> {
        const nextOperation = this.operationChain.then(operation, operation);
        this.operationChain = nextOperation.then(() => undefined, () => undefined);
        return nextOperation;
    }

    public start(payload: RuntimeCommandPayload): Promise<void> {
        return this.withLock(async () => {
            if (this.activeRuntime) {
                logger.warn(TAG, `Start requested while runtime ${this.activeRuntime.payload.runtime_config_id} is active. Restarting gracefully.`);
                await this.stopActiveRuntime();
            }

            await this.startRuntime(payload);
        });
    }

    public sync(payload: RuntimeCommandPayload): Promise<void> {
        return this.withLock(async () => {
            if (this.activeRuntime) {
                logger.info(TAG, `Sync requested for runtime ${payload.runtime_config_id}. Stopping current runtime first.`);
                await this.stopActiveRuntime();
            }

            await this.startRuntime(payload);
        });
    }

    public stop(runtimeConfigId?: number): Promise<void> {
        return this.withLock(async () => {
            if (!this.activeRuntime) {
                logger.info(TAG, 'Stop requested with no active runtime.');
                return;
            }

            if (
                runtimeConfigId !== undefined
                && this.activeRuntime.payload.runtime_config_id !== runtimeConfigId
            ) {
                throw new Error(
                    `Stop requested for runtime ${runtimeConfigId}, but active runtime is ${this.activeRuntime.payload.runtime_config_id}.`,
                );
            }

            await this.stopActiveRuntime();
        });
    }

    public shutdown(): Promise<void> {
        return this.withLock(async () => {
            if (this.activeRuntime) {
                await this.stopActiveRuntime();
            }
        });
    }

    public getStatus(): { activeRuntimeConfigId: number | null } {
        return {
            activeRuntimeConfigId: this.activeRuntime?.payload.runtime_config_id ?? null,
        };
    }

    private monitorRuntimeTermination(runtimeConfigId: number, runPromise: Promise<void>): void {
        void runPromise
            .then(() => {
                if (this.activeRuntime?.payload.runtime_config_id !== runtimeConfigId) {
                    return;
                }

                logger.error(TAG, `Runtime ${runtimeConfigId} stopped unexpectedly. Marking runtime as inactive.`);
                return this.withLock(async () => {
                    if (this.activeRuntime?.payload.runtime_config_id !== runtimeConfigId) {
                        return;
                    }

                    await this.stopActiveRuntime();
                });
            })
            .catch((error: any) => {
                logger.error(TAG, `Runtime ${runtimeConfigId} crashed: ${error.message}`);
                logger.error(TAG, error.stack || '');

                if (this.activeRuntime?.payload.runtime_config_id !== runtimeConfigId) {
                    return;
                }

                return this.withLock(async () => {
                    if (this.activeRuntime?.payload.runtime_config_id !== runtimeConfigId) {
                        return;
                    }

                    logger.error(TAG, `Stopping runtime ${runtimeConfigId} after worker failure.`);
                    await this.stopActiveRuntime();
                });
            });
    }

    private async startRuntime(payload: RuntimeCommandPayload): Promise<void> {
        logger.info(TAG, `Starting runtime ${payload.runtime_config_id} (${payload.config.name})`);

        setActiveRuntime(payload);

        let wsPrimary: any = null;
        let wsSecondary: any = null;

        try {
            logger.info(TAG, '═══════════════════════════════════════════');
            logger.info(TAG, `  Trader Runtime: ${config.runtimeName}`);
            logger.info(TAG, `  Testnet: ${config.useTestnet ? 'YES ⚠️' : 'NO (production)'}`);
            logger.info(TAG, `  Trade Amount: ${config.tradeAmountUsdt} USDT, Leverage: ${config.leverage}x`);
            logger.info(TAG, `  Max Concurrent Trades: ${config.maxConcurrentTrades}`);
            logger.info(TAG, `  Max Trade Duration: ${config.maxTradeDurationMs / 60000} min`);
            logger.info(TAG, `  Open Threshold: ${config.openThreshold}%, Close Threshold: ${config.closeThreshold}%`);
            logger.info(TAG, '═══════════════════════════════════════════');

            const primaryClient = this.createClient(config.primaryExchange);
            const secondaryClient = this.createClient(config.secondaryExchange);

            if (config.primaryExchange === config.secondaryExchange) {
                throw new Error('Primary and secondary exchanges MUST be different.');
            }

            try {
                logger.info(TAG, 'Measuring latency to exchange matching engines...');
                await Promise.all([
                    primaryClient.ccxtInstance.fetchTime().catch(() => {}),
                    secondaryClient.ccxtInstance.fetchTime().catch(() => {}),
                ]);

                const [primaryStart, secondaryStart] = [Date.now(), Date.now()];
                await Promise.all([
                    primaryClient.ccxtInstance.fetchTime()
                        .then(() => {
                            logger.info(TAG, `📡 ${primaryClient.name} Latency: ${Date.now() - primaryStart} ms`);
                        })
                        .catch(() => logger.warn(TAG, `Failed to measure latency for ${primaryClient.name}`)),
                    secondaryClient.ccxtInstance.fetchTime()
                        .then(() => {
                            logger.info(TAG, `📡 ${secondaryClient.name} Latency: ${Date.now() - secondaryStart} ms`);
                        })
                        .catch(() => logger.warn(TAG, `Failed to measure latency for ${secondaryClient.name}`)),
                ]);
            } catch (error: any) {
                logger.warn(TAG, `Failed to measure latency: ${error.message}`);
            }

            logger.info(TAG, `Loading markets from ${primaryClient.name} and ${secondaryClient.name}...`);
            await Promise.all([
                primaryClient.loadMarkets(),
                secondaryClient.loadMarkets(),
            ]);

            const primarySymbols = new Set(primaryClient.getUsdtSymbols());
            const secondarySymbols = secondaryClient.getUsdtSymbols();
            let commonSymbols = secondarySymbols.filter(symbol => primarySymbols.has(symbol));

            logger.info(TAG, `Found ${commonSymbols.length} intersecting USDT futures pairs.`);

            logger.info(TAG, `Fetching 24h volume to determine top ${config.topLiquidPairsCount} liquid pairs...`);
            try {
                const tickers = await primaryClient.ccxtInstance.fetchTickers();
                commonSymbols = commonSymbols.filter(symbol => (tickers[symbol]?.quoteVolume || 0) >= 2_000_000);
                commonSymbols.sort((left, right) => (tickers[right]?.quoteVolume || 0) - (tickers[left]?.quoteVolume || 0));
                commonSymbols = commonSymbols.slice(0, config.topLiquidPairsCount);
                logger.info(TAG, `Filtered down to top ${commonSymbols.length} most liquid pairs based on ${primaryClient.name} 24h USDT volume.`);
            } catch (error: any) {
                logger.warn(TAG, `Failed to fetch volume data, proceeding with all ${commonSymbols.length} pairs. Error: ${error.message}`);
            }

            if (commonSymbols.length === 0) {
                throw new Error('No common symbols found.');
            }

            const marketInfo = new MarketInfoService();
            const tradeableSymbols = await marketInfo.initialize(primaryClient, secondaryClient, commonSymbols);

            if (tradeableSymbols.length === 0) {
                throw new Error('No tradeable symbols after market info validation.');
            }

            logger.info(TAG, `Setting leverage ${config.leverage}x and isolated margin on ${tradeableSymbols.length} pairs...`);

            let leverageErrors = 0;
            const batchSize = 5;
            const finalTradeableSymbols: string[] = [];

            const setupSymbol = async (symbol: string) => {
                await Promise.all([
                    primaryClient.setIsolatedMargin(symbol).then(() => primaryClient.setLeverage(symbol, config.leverage)),
                    secondaryClient.setIsolatedMargin(symbol).then(() => secondaryClient.setLeverage(symbol, config.leverage)),
                ]);
            };

            for (let index = 0; index < tradeableSymbols.length; index += batchSize) {
                const batch = tradeableSymbols.slice(index, index + batchSize);
                const results = await Promise.allSettled(batch.map(symbol => setupSymbol(symbol)));

                results.forEach((result, resultIndex) => {
                    if (result.status === 'fulfilled') {
                        finalTradeableSymbols.push(batch[resultIndex]);
                    } else {
                        logger.warn(TAG, `Excluding ${batch[resultIndex]} due to setup error: ${(result.reason as Error).message}`);
                        leverageErrors++;
                    }
                });

                if (index + batchSize < tradeableSymbols.length) {
                    await sleep(1200);
                }
            }

            if (finalTradeableSymbols.length === 0) {
                throw new Error('No tradeable symbols left after setup constraint checks.');
            }

            logger.info(TAG, `Leverage/margin setup complete. Successful pairs: ${finalTradeableSymbols.length}. Excluded pairs: ${leverageErrors}.`);
            logger.info(TAG, 'Creating WebSocket instances...');

            wsPrimary = this.createWsClient(config.primaryExchange);
            wsSecondary = this.createWsClient(config.secondaryExchange);

            await Promise.all([
                wsPrimary.loadMarkets(),
                wsSecondary.loadMarkets(),
            ]);
            logger.info(TAG, 'WebSocket markets loaded. Ready to stream.');

            const tradeCounter = new TradeCounter();
            const chunks: string[][] = [];
            for (let index = 0; index < finalTradeableSymbols.length; index += config.chunkSize) {
                chunks.push(finalTradeableSymbols.slice(index, index + config.chunkSize));
            }

            logger.info(TAG, `Split into ${chunks.length} chunks of ${config.chunkSize}.`);
            logger.info(TAG, 'Checking for open trades from previous session...');

            const openTrades = await api.getOpenTrades(config.runtimeConfigId);
            logger.info(TAG, `Found ${openTrades.length} open trades to restore.`);

            const traders: Trader[] = chunks.map((chunk, index) => (
                new Trader(
                    index + 1,
                    chunk,
                    wsPrimary,
                    wsSecondary,
                    primaryClient,
                    secondaryClient,
                    marketInfo,
                    tradeCounter,
                )
            ));

            for (const trade of openTrades) {
                const trader = traders.find(item => item.symbols.includes(trade.coin));
                if (trader) {
                    trader.restoreOpenTrades([trade]);
                } else {
                    logger.warn(TAG, `Open trade for ${trade.coin} (ID: ${trade.id}) has no matching trader chunk. Ignoring.`);
                }
            }

            const runPromise = Promise.all(
                traders.map(trader => trader.start()),
            )
                .then(() => undefined);

            this.activeRuntime = {
                payload,
                traders,
                wsPrimary,
                wsSecondary,
                runPromise,
            };
            this.monitorRuntimeTermination(payload.runtime_config_id, runPromise);

            logger.info(TAG, `Runtime ${payload.runtime_config_id} started successfully.`);
        } catch (error) {
            if (wsPrimary) {
                try {
                    await wsPrimary.close();
                } catch {
                    // Ignore cleanup errors on failed startup.
                }
            }

            if (wsSecondary) {
                try {
                    await wsSecondary.close();
                } catch {
                    // Ignore cleanup errors on failed startup.
                }
            }

            clearActiveRuntime();
            throw error;
        }
    }

    private async stopActiveRuntime(): Promise<void> {
        const current = this.activeRuntime;
        if (!current) {
            clearActiveRuntime();
            return;
        }

        logger.info(TAG, `Stopping runtime ${current.payload.runtime_config_id} gracefully.`);

        this.activeRuntime = null;

        await Promise.allSettled(current.traders.map(trader => trader.stop(true)));

        try {
            await current.wsPrimary.close();
        } catch {
            // Ignore websocket close errors during shutdown.
        }

        try {
            await current.wsSecondary.close();
        } catch {
            // Ignore websocket close errors during shutdown.
        }

        await Promise.race([
            current.runPromise.catch(() => undefined),
            sleep(5000),
        ]);

        clearActiveRuntime();
        logger.info(TAG, `Runtime ${current.payload.runtime_config_id} stopped.`);
    }

    private createClient(name: string): IExchangeClient {
        switch (name.toLowerCase()) {
            case 'binance':
                return new BinanceClient();
            case 'bybit':
                return new BybitClient();
            case 'mexc':
                return new MexcClient();
            case 'gate':
                return new GateClient();
            default:
                throw new Error(`Unknown exchange: ${name}`);
        }
    }

    private createWsClient(name: string): any {
        const isTestnet = config.useTestnet;
        switch (name.toLowerCase()) {
            case 'binance':
                return new pro.binanceusdm({ ...(isTestnet && { sandbox: true }) });
            case 'bybit':
                return new pro.bybit({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            case 'mexc':
                return new pro.mexc({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            case 'gate':
                return new pro.gate({ ...(isTestnet && { sandbox: true }), options: { defaultType: 'swap' } });
            default:
                throw new Error(`WS client not implemented for ${name}`);
        }
    }
}

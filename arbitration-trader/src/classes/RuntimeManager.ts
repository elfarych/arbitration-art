import * as crypto from 'node:crypto';
import { clearActiveRuntime, config, setActiveRuntime } from '../config.js';
import { Trader } from './Trader.js';
import { TradeCounter } from './TradeCounter.js';
import { BinanceClient } from '../exchanges/binance-client.js';
import { BybitClient } from '../exchanges/bybit-client.js';
import { GateClient } from '../exchanges/gate-client.js';
import { MexcClient } from '../exchanges/mexc-client.js';
import type { ExchangeClientOptions, IExchangeClient } from '../exchanges/exchange-client.js';
import { createOrderBookProvider } from '../exchanges/ws/orderbook-provider-factory.js';
import { api } from '../services/api.js';
import { getSystemLoadSnapshot } from '../services/diagnostics.js';
import { MarketInfoService } from '../services/market-info.js';
import type {
    ExchangeHealthCheckResult,
    OrderBookProvider,
    RuntimeCommandPayload,
    RuntimeTradesDiagnostics,
    SystemLoadSnapshot,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const TAG = 'RuntimeManager';

interface ActiveRuntimeHandle {
    payload: RuntimeCommandPayload;
    traders: Trader[];
    primaryClient: IExchangeClient;
    secondaryClient: IExchangeClient;
    primaryBooks: OrderBookProvider;
    secondaryBooks: OrderBookProvider;
    runPromise: Promise<void>;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class RuntimeManager {
    private activeRuntime: ActiveRuntimeHandle | null = null;
    private operationChain: Promise<void> = Promise.resolve();
    private confirmedSetupKeys = new Set<string>();

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

    public getActiveTradesDiagnostics(runtimeConfigId?: number): RuntimeTradesDiagnostics {
        const activeRuntimeConfigId = this.activeRuntime?.payload.runtime_config_id ?? null;
        const isRequestedRuntimeActive = Boolean(
            this.activeRuntime
            && (runtimeConfigId === undefined || activeRuntimeConfigId === runtimeConfigId),
        );

        if (!this.activeRuntime || !isRequestedRuntimeActive) {
            return {
                requested_runtime_config_id: runtimeConfigId ?? null,
                active_runtime_config_id: activeRuntimeConfigId,
                is_requested_runtime_active: false,
                trade_count: 0,
                active_coins: [],
                trades: [],
            };
        }

        const trades = this.activeRuntime.traders.flatMap(trader => trader.getActiveTradeSnapshots());

        return {
            requested_runtime_config_id: runtimeConfigId ?? activeRuntimeConfigId,
            active_runtime_config_id: activeRuntimeConfigId,
            is_requested_runtime_active: true,
            trade_count: trades.length,
            active_coins: trades.map(trade => trade.coin),
            trades,
        };
    }

    public async getSystemLoad(): Promise<SystemLoadSnapshot> {
        return getSystemLoadSnapshot();
    }

    public async checkExchangeHealth(payload: RuntimeCommandPayload): Promise<{
        requested_runtime_config_id: number;
        active_runtime_config_id: number | null;
        exchanges: ExchangeHealthCheckResult[];
    }> {
        const exchanges = [
            payload.config.primary_exchange.toLowerCase(),
            payload.config.secondary_exchange.toLowerCase(),
        ].filter((value, index, arr) => arr.indexOf(value) === index);

        const results = await Promise.all(
            exchanges.map(async exchange => {
                try {
                    const client = this.createClient(exchange, this.buildClientOptions(exchange, payload));
                    await client.pingPrivate();
                    return {
                        exchange,
                        available: true,
                        error: null,
                    } satisfies ExchangeHealthCheckResult;
                } catch (error: any) {
                    logger.warn(TAG, `Exchange health check failed for ${exchange}: ${error.message}`);
                    return {
                        exchange,
                        available: false,
                        error: error.message,
                    } satisfies ExchangeHealthCheckResult;
                }
            }),
        );

        return {
            requested_runtime_config_id: payload.runtime_config_id,
            active_runtime_config_id: this.activeRuntime?.payload.runtime_config_id ?? null,
            exchanges: results,
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

        let primaryBooks: OrderBookProvider | null = null;
        let secondaryBooks: OrderBookProvider | null = null;

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

            logger.info(TAG, 'Checking required account modes...');
            await Promise.all([
                primaryClient.validateAccountMode(),
                secondaryClient.validateAccountMode(),
            ]);

            try {
                logger.info(TAG, 'Measuring latency to exchange matching engines...');
                await Promise.all([
                    primaryClient.fetchTime().catch(() => {}),
                    secondaryClient.fetchTime().catch(() => {}),
                ]);

                const [primaryStart, secondaryStart] = [Date.now(), Date.now()];
                await Promise.all([
                    primaryClient.fetchTime()
                        .then(() => {
                            logger.info(TAG, `📡 ${primaryClient.name} Latency: ${Date.now() - primaryStart} ms`);
                        })
                        .catch(() => logger.warn(TAG, `Failed to measure latency for ${primaryClient.name}`)),
                    secondaryClient.fetchTime()
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

            logger.info(TAG, 'Checking for open trades from previous session...');
            const openTrades = await api.getOpenTrades(config.runtimeConfigId);
            logger.info(TAG, `Found ${openTrades.length} open trades to restore.`);
            const recoverySymbols = [...new Set(openTrades.map(trade => trade.coin))];

            const missingRecoverySymbols = recoverySymbols.filter(symbol => !primarySymbols.has(symbol) || !secondarySymbols.includes(symbol));
            if (missingRecoverySymbols.length > 0) {
                throw new Error(
                    `Open trades exist for symbols that are not available on both exchanges: ${missingRecoverySymbols.join(', ')}.`,
                );
            }

            logger.info(TAG, `Fetching 24h volume from both exchanges to determine top ${config.topLiquidPairsCount} liquid pairs...`);
            let scannableSymbols: string[] = [];
            try {
                const [primaryTickers, secondaryTickers] = await Promise.all([
                    primaryClient.fetchTickers(),
                    secondaryClient.fetchTickers(),
                ]);

                scannableSymbols = commonSymbols
                    .filter(symbol => {
                        const primaryVolume = primaryTickers[symbol]?.quoteVolume || 0;
                        const secondaryVolume = secondaryTickers[symbol]?.quoteVolume || 0;
                        return Math.min(primaryVolume, secondaryVolume) >= 2_000_000;
                    })
                    .sort((left, right) => {
                        const leftVolume = Math.min(
                            primaryTickers[left]?.quoteVolume || 0,
                            secondaryTickers[left]?.quoteVolume || 0,
                        );
                        const rightVolume = Math.min(
                            primaryTickers[right]?.quoteVolume || 0,
                            secondaryTickers[right]?.quoteVolume || 0,
                        );
                        return rightVolume - leftVolume;
                    })
                    .slice(0, config.topLiquidPairsCount);

                logger.info(TAG, `Filtered down to top ${scannableSymbols.length} most liquid pairs based on min cross-exchange 24h USDT volume.`);
            } catch (error: any) {
                if (openTrades.length === 0) {
                    throw new Error(`Failed to fetch volume data and no recovery trades are available: ${error.message}`);
                }

                logger.error(TAG, `Failed to fetch volume data. Runtime will manage recovery trades only and block new entries. Error: ${error.message}`);
                scannableSymbols = [];
            }

            const runtimeSymbols = unique([...scannableSymbols, ...recoverySymbols]);
            const entryDisabledSymbols = new Set(runtimeSymbols.filter(symbol => !scannableSymbols.includes(symbol)));

            if (runtimeSymbols.length === 0) {
                throw new Error('No symbols left after liquidity filtering and recovery selection.');
            }

            const marketInfo = new MarketInfoService();
            const tradeableSymbols = await marketInfo.initialize(primaryClient, secondaryClient, runtimeSymbols);

            if (tradeableSymbols.length === 0) {
                throw new Error('No tradeable symbols after market info validation.');
            }

            const missingTradeableRecovery = recoverySymbols.filter(symbol => !tradeableSymbols.includes(symbol));
            if (missingTradeableRecovery.length > 0) {
                throw new Error(
                    `Open trades cannot be restored because market info is unavailable for: ${missingTradeableRecovery.join(', ')}.`,
                );
            }

            logger.info(TAG, `Setting leverage ${config.leverage}x and isolated margin on ${tradeableSymbols.length} pairs...`);

            let leverageErrors = 0;
            const batchSize = 5;
            const finalTradeableSymbols: string[] = [];

            const setupSymbol = async (symbol: string) => {
                const setupKey = this.buildSetupCacheKey(payload, symbol);
                if (this.confirmedSetupKeys.has(setupKey)) {
                    logger.debug(TAG, `Skipping cached leverage/margin setup for ${symbol}`);
                    return;
                }

                await Promise.all([
                    primaryClient.setIsolatedMargin(symbol).then(() => primaryClient.setLeverage(symbol, config.leverage)),
                    secondaryClient.setIsolatedMargin(symbol).then(() => secondaryClient.setLeverage(symbol, config.leverage)),
                ]);
                this.confirmedSetupKeys.add(setupKey);
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

            const missingSetupRecovery = recoverySymbols.filter(symbol => !finalTradeableSymbols.includes(symbol));
            if (missingSetupRecovery.length > 0) {
                throw new Error(
                    `Open trades cannot be restored because leverage/margin setup failed for: ${missingSetupRecovery.join(', ')}.`,
                );
            }

            logger.info(TAG, `Leverage/margin setup complete. Successful pairs: ${finalTradeableSymbols.length}. Excluded pairs: ${leverageErrors}.`);
            logger.info(TAG, 'Creating orderbook providers...');

            primaryBooks = createOrderBookProvider(config.primaryExchange);
            secondaryBooks = createOrderBookProvider(config.secondaryExchange);

            await Promise.all([
                primaryBooks.connect(),
                secondaryBooks.connect(),
            ]);

            await Promise.all([
                primaryBooks.subscribe(finalTradeableSymbols),
                secondaryBooks.subscribe(finalTradeableSymbols),
            ]);
            logger.info(TAG, 'Orderbook providers are connected and subscribed.');

            const tradeCounter = new TradeCounter();
            const chunks: string[][] = [];
            for (let index = 0; index < finalTradeableSymbols.length; index += config.chunkSize) {
                chunks.push(finalTradeableSymbols.slice(index, index + config.chunkSize));
            }

            logger.info(TAG, `Split into ${chunks.length} chunks of ${config.chunkSize}.`);

            const traders: Trader[] = chunks.map((chunk, index) => (
                new Trader(
                    index + 1,
                    chunk,
                    primaryBooks!,
                    secondaryBooks!,
                    primaryClient,
                    secondaryClient,
                    marketInfo,
                    tradeCounter,
                    entryDisabledSymbols,
                )
            ));

            for (const trade of openTrades) {
                const trader = traders.find(item => item.symbols.includes(trade.coin));
                if (trader) {
                    trader.restoreOpenTrades([trade]);
                } else {
                    throw new Error(`Open trade for ${trade.coin} (ID: ${trade.id}) has no matching trader chunk.`);
                }
            }

            const runPromise = Promise.all(
                traders.map(trader => trader.start()),
            )
                .then(() => undefined);

            this.activeRuntime = {
                payload,
                traders,
                primaryClient,
                secondaryClient,
                primaryBooks,
                secondaryBooks,
                runPromise,
            };
            this.monitorRuntimeTermination(payload.runtime_config_id, runPromise);

            logger.info(TAG, `Runtime ${payload.runtime_config_id} started successfully.`);
        } catch (error) {
            if (primaryBooks) {
                try {
                    await primaryBooks.close();
                } catch {
                    // Ignore cleanup errors on failed startup.
                }
            }

            if (secondaryBooks) {
                try {
                    await secondaryBooks.close();
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
            await current.primaryBooks.close();
        } catch {
            // Ignore websocket close errors during shutdown.
        }

        try {
            await current.secondaryBooks.close();
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

    private buildClientOptions(name: string, payload: RuntimeCommandPayload): ExchangeClientOptions {
        const commonOptions = { useTestnet: payload.config.use_testnet };

        switch (name.toLowerCase()) {
            case 'binance':
                return {
                    ...commonOptions,
                    apiKey: payload.keys.binance_api_key,
                    secret: payload.keys.binance_secret,
                };
            case 'bybit':
                return {
                    ...commonOptions,
                    apiKey: payload.keys.bybit_api_key,
                    secret: payload.keys.bybit_secret,
                };
            case 'mexc':
                return {
                    ...commonOptions,
                    apiKey: payload.keys.mexc_api_key,
                    secret: payload.keys.mexc_secret,
                };
            case 'gate':
                return {
                    ...commonOptions,
                    apiKey: payload.keys.gate_api_key,
                    secret: payload.keys.gate_secret,
                };
            default:
                throw new Error(`Unknown exchange: ${name}`);
        }
    }

    private createClient(name: string, options?: ExchangeClientOptions): IExchangeClient {
        switch (name.toLowerCase()) {
            case 'binance':
                return new BinanceClient(options);
            case 'bybit':
                return new BybitClient(options);
            case 'mexc':
                return new MexcClient(options);
            case 'gate':
                return new GateClient(options);
            default:
                throw new Error(`Unknown exchange: ${name}`);
        }
    }

    private buildSetupCacheKey(payload: RuntimeCommandPayload, symbol: string): string {
        const selectedKeys = [
            this.exchangeApiKey(payload.config.primary_exchange, payload),
            this.exchangeApiKey(payload.config.secondary_exchange, payload),
        ].join('|');
        const accountFingerprint = crypto
            .createHash('sha256')
            .update(selectedKeys)
            .digest('hex')
            .slice(0, 16);

        return [
            accountFingerprint,
            payload.config.primary_exchange,
            payload.config.secondary_exchange,
            symbol,
            payload.config.leverage,
        ].join(':');
    }

    private exchangeApiKey(exchange: string, payload: RuntimeCommandPayload): string {
        switch (exchange.toLowerCase()) {
            case 'binance':
                return payload.keys.binance_api_key || '';
            case 'bybit':
                return payload.keys.bybit_api_key || '';
            case 'mexc':
                return payload.keys.mexc_api_key || '';
            case 'gate':
                return payload.keys.gate_api_key || '';
            default:
                return '';
        }
    }

}

function unique(values: string[]): string[] {
    return [...new Set(values)];
}

import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { OrderExecution, OrderIntent, TradeWsClient } from '../exchange-types.js';
import { appConfig } from '../../config.js';

const MAINNET_URL = 'wss://stream.bybit.com/v5/trade';
const TESTNET_URL = 'wss://stream-testnet.bybit.com/v5/trade';
const ORDER_TIMEOUT_MS = 5000;

interface BybitWsResponse {
    reqId?: string;
    op?: string;
    retCode?: number;
    retMsg?: string;
    data?: {
        orderId?: string;
        orderLinkId?: string;
    };
    header?: {
        Timenow?: string;
    };
}

export interface BybitLinearTradeWsOptions {
    apiKey: string;
    apiSecret: string;
    useTestnet: boolean;
    wsFactory?: (url: string) => WebSocket;
}

export class BybitLinearTradeWs implements TradeWsClient {
    readonly exchange = 'bybit' as const;

    private socket: WebSocket | null = null;
    private ready = false;
    private readonly emitter = new EventEmitter();
    private readonly pending = new Map<string, {
        resolve: (execution: OrderExecution) => void;
        reject: (error: Error) => void;
        intent: OrderIntent;
        timeout: NodeJS.Timeout;
    }>();

    constructor(private readonly options: BybitLinearTradeWsOptions) {}

    async connect(): Promise<void> {
        if (!this.options.apiKey || !this.options.apiSecret) {
            throw new Error('Bybit API credentials are required.');
        }

        await this.close();
        const url = this.options.useTestnet ? TESTNET_URL : MAINNET_URL;
        const socket = this.options.wsFactory ? this.options.wsFactory(url) : new WebSocket(url);
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
            const cleanup = () => {
                socket.off('open', onOpen);
                socket.off('error', onError);
            };
            const onOpen = () => {
                cleanup();
                resolve();
            };
            const onError = (error: Error) => {
                cleanup();
                reject(error);
            };
            socket.once('open', onOpen);
            socket.once('error', onError);
        });

        socket.on('message', data => this.handleMessage(data.toString()));
        socket.on('close', () => this.handleClose());
        socket.on('error', error => this.failAll(error instanceof Error ? error : new Error(String(error))));

        await this.authenticate();
        this.setReady(true);
    }

    async close(): Promise<void> {
        this.setReady(false);
        const socket = this.socket;
        this.socket = null;
        if (!socket || socket.readyState === WebSocket.CLOSED) {
            return;
        }
        await new Promise<void>(resolve => {
            socket.once('close', () => resolve());
            socket.close();
            setTimeout(resolve, 1000).unref();
        });
    }

    isReady(): boolean {
        return this.ready;
    }

    onReadyChange(listener: (ready: boolean) => void): () => void {
        this.emitter.on('ready', listener);
        return () => this.emitter.off('ready', listener);
    }

    submitMarketOrder(intent: OrderIntent): Promise<OrderExecution> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.ready) {
            return Promise.reject(new Error('Bybit trade WebSocket is not ready.'));
        }

        const payload = {
            reqId: intent.clientOrderId,
            header: {
                'X-BAPI-TIMESTAMP': String(Date.now()),
                'X-BAPI-RECV-WINDOW': String(appConfig.bybitRecvWindowMs),
            },
            op: 'order.create',
            args: [
                {
                    category: 'linear',
                    symbol: intent.symbol,
                    side: intent.side === 'buy' ? 'Buy' : 'Sell',
                    orderType: 'Market',
                    qty: formatDecimal(intent.quantity),
                    reduceOnly: intent.reduceOnly,
                    orderLinkId: intent.clientOrderId,
                    positionIdx: 0,
                },
            ],
        };

        return new Promise<OrderExecution>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(intent.clientOrderId);
                reject(new Error(`Bybit order.create timeout for ${intent.clientOrderId}`));
            }, ORDER_TIMEOUT_MS);
            this.pending.set(intent.clientOrderId, { resolve, reject, intent, timeout });
            this.socket?.send(JSON.stringify(payload), error => {
                if (error) {
                    clearTimeout(timeout);
                    this.pending.delete(intent.clientOrderId);
                    reject(error);
                }
            });
        });
    }

    private authenticate(): Promise<void> {
        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('Bybit trade WebSocket is not open.'));
        }

        const expires = Date.now() + 10_000;
        const signature = createHmac('sha256', this.options.apiSecret)
            .update(`GET/realtime${expires}`)
            .digest('hex');
        const reqId = `auth-${expires}`;

        return new Promise<void>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(reqId);
                reject(new Error('Bybit auth timeout.'));
            }, ORDER_TIMEOUT_MS);

            this.pending.set(reqId, {
                intent: {
                    intentId: reqId,
                    clientOrderId: reqId,
                    exchange: 'bybit',
                    symbol: '',
                    side: 'buy',
                    quantity: 0,
                    reduceOnly: false,
                    createdAt: Date.now(),
                },
                timeout,
                resolve: () => resolve(),
                reject,
            });

            this.socket?.send(JSON.stringify({
                reqId,
                op: 'auth',
                args: [this.options.apiKey, expires, signature],
            }), error => {
                if (error) {
                    clearTimeout(timeout);
                    this.pending.delete(reqId);
                    reject(error);
                }
            });
        });
    }

    private handleMessage(raw: string): void {
        let message: BybitWsResponse;
        try {
            message = JSON.parse(raw) as BybitWsResponse;
        } catch {
            return;
        }

        const requestId = message.reqId ?? (message.op === 'auth' ? this.findPendingAuthRequestId() : undefined);
        if (!requestId) {
            return;
        }

        const pending = this.pending.get(requestId);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(requestId);

        if (message.retCode !== 0) {
            pending.reject(new Error(`Bybit ${message.op ?? 'request'} failed: ${message.retMsg ?? message.retCode ?? 'unknown error'}`));
            return;
        }

        if (message.op === 'auth') {
            pending.resolve({
                exchange: 'bybit',
                symbol: '',
                orderId: requestId,
                clientOrderId: requestId,
                side: 'buy',
                quantity: 0,
                avgPrice: 0,
                filledQty: 0,
                commission: 0,
                commissionAsset: 'USDT',
                acknowledgedAt: Date.now(),
                filledAt: null,
                raw: message,
            });
            return;
        }

        pending.resolve({
            exchange: this.exchange,
            symbol: pending.intent.symbol,
            orderId: message.data?.orderId ?? pending.intent.clientOrderId,
            clientOrderId: message.data?.orderLinkId ?? pending.intent.clientOrderId,
            side: pending.intent.side,
            quantity: pending.intent.quantity,
            avgPrice: 0,
            filledQty: 0,
            commission: 0,
            commissionAsset: 'USDT',
            acknowledgedAt: Date.now(),
            filledAt: null,
            raw: message,
        });
    }

    private handleClose(): void {
        this.setReady(false);
        this.failAll(new Error('Bybit trade WebSocket closed.'));
    }

    private failAll(error: Error): void {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeout);
            pending.reject(error);
        }
        this.pending.clear();
    }

    private setReady(next: boolean): void {
        if (this.ready === next) {
            return;
        }
        this.ready = next;
        this.emitter.emit('ready', next);
    }

    private findPendingAuthRequestId(): string | undefined {
        return [...this.pending.keys()].find(key => key.startsWith('auth-'));
    }
}

function formatDecimal(value: number): string {
    return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

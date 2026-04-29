import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import type { OrderExecution, OrderIntent, TradeWsClient } from '../exchange-types.js';

const MAINNET_URL = 'wss://ws-fapi.binance.com/ws-fapi/v1';
const TESTNET_URL = 'wss://testnet.binancefuture.com/ws-fapi/v1';
const ORDER_TIMEOUT_MS = 5000;

interface BinanceWsResponse {
    id?: string;
    status?: number;
    result?: {
        orderId?: number | string;
        clientOrderId?: string;
        avgPrice?: string;
        executedQty?: string;
        origQty?: string;
        status?: string;
        updateTime?: number;
    };
    error?: {
        code?: number;
        msg?: string;
    };
}

export interface BinanceUsdmTradeWsOptions {
    apiKey: string;
    apiSecret: string;
    useTestnet: boolean;
    wsFactory?: (url: string) => WebSocket;
}

export class BinanceUsdmTradeWs implements TradeWsClient {
    readonly exchange = 'binance' as const;

    private socket: WebSocket | null = null;
    private ready = false;
    private readonly emitter = new EventEmitter();
    private readonly pending = new Map<string, {
        resolve: (execution: OrderExecution) => void;
        reject: (error: Error) => void;
        intent: OrderIntent;
        timeout: NodeJS.Timeout;
    }>();

    constructor(private readonly options: BinanceUsdmTradeWsOptions) {}

    async connect(): Promise<void> {
        if (!this.options.apiKey || !this.options.apiSecret) {
            throw new Error('Binance API credentials are required.');
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
                this.setReady(true);
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
            return Promise.reject(new Error('Binance trade WebSocket is not ready.'));
        }

        const payload = this.createOrderPayload(intent);
        return new Promise<OrderExecution>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pending.delete(payload.id);
                reject(new Error(`Binance order.place timeout for ${intent.clientOrderId}`));
            }, ORDER_TIMEOUT_MS);
            this.pending.set(payload.id, { resolve, reject, intent, timeout });
            this.socket?.send(JSON.stringify(payload), error => {
                if (error) {
                    clearTimeout(timeout);
                    this.pending.delete(payload.id);
                    reject(error);
                }
            });
        });
    }

    private createOrderPayload(intent: OrderIntent): { id: string; method: 'order.place'; params: Record<string, string | number> } {
        const timestamp = Date.now();
        const params: Record<string, string | number> = {
            apiKey: this.options.apiKey,
            newClientOrderId: intent.clientOrderId,
            newOrderRespType: 'RESULT',
            positionSide: 'BOTH',
            quantity: formatDecimal(intent.quantity),
            recvWindow: 5000,
            side: intent.side === 'buy' ? 'BUY' : 'SELL',
            symbol: intent.symbol,
            timestamp,
            type: 'MARKET',
        };

        if (intent.reduceOnly) {
            params.reduceOnly = 'true';
        }

        params.signature = signBinanceParams(params, this.options.apiSecret);

        return {
            id: intent.clientOrderId,
            method: 'order.place',
            params,
        };
    }

    private handleMessage(raw: string): void {
        let message: BinanceWsResponse;
        try {
            message = JSON.parse(raw) as BinanceWsResponse;
        } catch {
            return;
        }

        if (!message.id) {
            return;
        }

        const pending = this.pending.get(message.id);
        if (!pending) {
            return;
        }

        clearTimeout(pending.timeout);
        this.pending.delete(message.id);

        if (message.status !== 200 || message.error) {
            pending.reject(new Error(`Binance order.place failed: ${message.error?.msg ?? message.status ?? 'unknown error'}`));
            return;
        }

        const result = message.result ?? {};
        const avgPrice = Number(result.avgPrice ?? 0);
        const filledQty = Number(result.executedQty ?? result.origQty ?? pending.intent.quantity);
        pending.resolve({
            exchange: this.exchange,
            symbol: pending.intent.symbol,
            orderId: String(result.orderId ?? pending.intent.clientOrderId),
            clientOrderId: result.clientOrderId ?? pending.intent.clientOrderId,
            side: pending.intent.side,
            quantity: pending.intent.quantity,
            avgPrice: Number.isFinite(avgPrice) ? avgPrice : 0,
            filledQty: Number.isFinite(filledQty) ? filledQty : pending.intent.quantity,
            commission: 0,
            commissionAsset: 'USDT',
            acknowledgedAt: Date.now(),
            filledAt: result.status === 'FILLED' ? Date.now() : null,
            raw: message,
        });
    }

    private handleClose(): void {
        this.setReady(false);
        this.failAll(new Error('Binance trade WebSocket closed.'));
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
}

export function signBinanceParams(params: Record<string, string | number>, apiSecret: string): string {
    const query = Object.entries(params)
        .filter(([key]) => key !== 'signature')
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
        .join('&');
    return createHmac('sha256', apiSecret).update(query).digest('hex');
}

function formatDecimal(value: number): string {
    return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
}

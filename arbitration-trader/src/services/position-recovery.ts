import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { ExchangePosition } from '../types/index.js';
import { logger } from '../utils/logger.js';

const POSITION_CONFIRM_DELAY_MS = 750;

export interface ConfirmedPosition {
    size: number;
    side: 'long' | 'short';
}

export async function fetchConfirmedPosition(
    client: IExchangeClient,
    symbol: string,
    expectedSide: 'long' | 'short',
    minQty: number,
    logTag: string,
): Promise<ConfirmedPosition | null> {
    const first = await findPosition(client, symbol, minQty);
    if (first) {
        return assertExpectedSide(first, client.name, symbol, expectedSide);
    }

    await sleep(POSITION_CONFIRM_DELAY_MS);
    const second = await findPosition(client, symbol, minQty);
    if (second) {
        return assertExpectedSide(second, client.name, symbol, expectedSide);
    }

    logger.info(logTag, `${client.name} position for ${symbol} is confirmed flat after recheck.`);
    return null;
}

async function findPosition(
    client: IExchangeClient,
    symbol: string,
    minQty: number,
): Promise<ExchangePosition | null> {
    const positions = await client.fetchPositions([symbol]);
    return positions.find(position => {
        const size = Math.abs(Number(position.amount ?? position.contracts ?? 0));
        return position.symbol === symbol && size > 0 && size >= minQty;
    }) ?? null;
}

function assertExpectedSide(
    position: ExchangePosition,
    exchange: string,
    symbol: string,
    expectedSide: 'long' | 'short',
): ConfirmedPosition {
    if (position.side !== expectedSide) {
        throw new Error(
            `${exchange} ${symbol} position side mismatch: expected ${expectedSide}, got ${position.side}.`,
        );
    }

    return {
        side: position.side,
        size: Math.abs(Number(position.amount ?? position.contracts ?? 0)),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

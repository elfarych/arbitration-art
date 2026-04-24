import type { IExchangeClient } from '../exchanges/exchange-client.js';
import type { ExchangePosition, RuntimeCommandPayload, TradeRecord } from '../types/index.js';

interface AccountReconciliationOptions {
    payload: RuntimeCommandPayload;
    primaryClient: IExchangeClient;
    secondaryClient: IExchangeClient;
    openTrades: TradeRecord[];
    sizeTolerancePercent: number;
}

interface ExpectedPosition {
    symbol: string;
    side: 'long' | 'short';
    amount: number;
    tradeId: number;
}

export async function assertAccountPositionsReconciled(options: AccountReconciliationOptions): Promise<void> {
    assertOpenTradesMatchRuntime(options.openTrades, options.payload);

    const [primaryPositions, secondaryPositions] = await Promise.all([
        options.primaryClient.fetchAllOpenPositions(),
        options.secondaryClient.fetchAllOpenPositions(),
    ]);

    const primaryExpected = buildExpectedPositions(options.openTrades, 'primary');
    const secondaryExpected = buildExpectedPositions(options.openTrades, 'secondary');

    const issues = [
        ...comparePositions(options.primaryClient.name, primaryExpected, primaryPositions, options.sizeTolerancePercent),
        ...comparePositions(options.secondaryClient.name, secondaryExpected, secondaryPositions, options.sizeTolerancePercent),
    ];

    if (issues.length > 0) {
        throw new Error(
            `Account-wide position reconciliation failed: ${issues.slice(0, 20).join('; ')}`,
        );
    }
}

function assertOpenTradesMatchRuntime(openTrades: TradeRecord[], payload: RuntimeCommandPayload): void {
    const seenSymbols = new Set<string>();
    const expectedPrimary = payload.config.primary_exchange;
    const expectedSecondary = payload.config.secondary_exchange;
    const issues: string[] = [];

    for (const trade of openTrades) {
        if (trade.runtime_config !== payload.runtime_config_id) {
            issues.push(`trade ${trade.id} has runtime_config=${trade.runtime_config}, expected ${payload.runtime_config_id}`);
        }

        if (seenSymbols.has(trade.coin)) {
            issues.push(`duplicate open trade for ${trade.coin}`);
        }
        seenSymbols.add(trade.coin);

        if (normalizeExchangeRoute(trade.primary_exchange) !== expectedPrimary) {
            issues.push(`trade ${trade.id} primary_exchange=${trade.primary_exchange}, expected ${expectedPrimary}`);
        }

        if (normalizeExchangeRoute(trade.secondary_exchange) !== expectedSecondary) {
            issues.push(`trade ${trade.id} secondary_exchange=${trade.secondary_exchange}, expected ${expectedSecondary}`);
        }

        const amount = Number(trade.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
            issues.push(`trade ${trade.id} has invalid amount=${trade.amount}`);
        }
    }

    if (issues.length > 0) {
        throw new Error(`Open trade recovery contract mismatch: ${issues.join('; ')}`);
    }
}

function buildExpectedPositions(openTrades: TradeRecord[], leg: 'primary' | 'secondary'): Map<string, ExpectedPosition> {
    const expected = new Map<string, ExpectedPosition>();

    for (const trade of openTrades) {
        const side = expectedSide(trade.order_type, leg);
        expected.set(trade.coin, {
            symbol: trade.coin,
            side,
            amount: Number(trade.amount),
            tradeId: trade.id,
        });
    }

    return expected;
}

function comparePositions(
    exchangeName: string,
    expected: Map<string, ExpectedPosition>,
    actual: ExchangePosition[],
    tolerancePercent: number,
): string[] {
    const issues: string[] = [];
    const actualBySymbol = new Map<string, ExchangePosition[]>();

    for (const position of actual) {
        const bucket = actualBySymbol.get(position.symbol) ?? [];
        bucket.push(position);
        actualBySymbol.set(position.symbol, bucket);
    }

    for (const [symbol, expectedPosition] of expected.entries()) {
        const matching = actualBySymbol.get(symbol) ?? [];
        if (matching.length === 0) {
            issues.push(`${exchangeName} missing expected ${expectedPosition.side} position for ${symbol} trade ${expectedPosition.tradeId}`);
            continue;
        }

        const sameSide = matching.find(position => position.side === expectedPosition.side);
        if (!sameSide) {
            issues.push(`${exchangeName} ${symbol} side mismatch: expected ${expectedPosition.side}, got ${matching.map(position => position.side).join(',')}`);
            continue;
        }

        const actualAmount = Math.abs(Number(sameSide.amount ?? sameSide.contracts ?? 0));
        if (!isAmountWithinTolerance(expectedPosition.amount, actualAmount, tolerancePercent)) {
            issues.push(`${exchangeName} ${symbol} amount mismatch: expected ${expectedPosition.amount}, got ${actualAmount}`);
        }
    }

    for (const position of actual) {
        const expectedPosition = expected.get(position.symbol);
        const size = Math.abs(Number(position.amount ?? position.contracts ?? 0));
        if (!expectedPosition) {
            issues.push(`${exchangeName} unexpected ${position.side} position ${position.symbol} size=${size}`);
            continue;
        }

        if (position.side !== expectedPosition.side) {
            issues.push(`${exchangeName} unexpected ${position.side} position ${position.symbol} size=${size}; expected ${expectedPosition.side}`);
        }
    }

    return issues;
}

function expectedSide(orderType: 'buy' | 'sell', leg: 'primary' | 'secondary'): 'long' | 'short' {
    if (leg === 'primary') {
        return orderType === 'buy' ? 'long' : 'short';
    }

    return orderType === 'buy' ? 'short' : 'long';
}

function normalizeExchangeRoute(value: string): string {
    return value
        .toLowerCase()
        .replace(/[_\s-]?futures$/, '')
        .trim();
}

function isAmountWithinTolerance(expected: number, actual: number, tolerancePercent: number): boolean {
    if (!Number.isFinite(expected) || expected <= 0 || !Number.isFinite(actual) || actual <= 0) {
        return false;
    }

    const tolerance = expected * (tolerancePercent / 100);
    return Math.abs(expected - actual) <= Math.max(tolerance, Number.EPSILON);
}

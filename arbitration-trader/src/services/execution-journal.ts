import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';

type ExecutionKind = 'open' | 'close' | 'cleanup';

type ExecutionJournalEventName =
    | 'entry_signal_detected'
    | 'entry_recheck_started'
    | 'entry_recheck_passed'
    | 'entry_recheck_rejected'
    | 'open_intent'
    | 'open_orders_submitting'
    | 'open_orders_submit_started'
    | 'open_order_create_ack'
    | 'open_order_confirmed'
    | 'open_leg_filled'
    | 'open_django_synced'
    | 'open_aborted_before_orders'
    | 'open_failed'
    | 'close_signal_detected'
    | 'close_orders_submit_started'
    | 'close_order_create_ack'
    | 'close_order_confirmed'
    | 'cleanup_started'
    | 'cleanup_completed'
    | 'cleanup_failed'
    | 'close_started'
    | 'close_leg_filled'
    | 'close_sync_pending'
    | 'close_synced'
    | 'close_failed';

export interface ExecutionJournalEvent {
    ts: string;
    runtime_config_id: number;
    owner_id: number;
    intent_id: string;
    kind: ExecutionKind;
    event: ExecutionJournalEventName;
    symbol: string;
    data?: Record<string, unknown>;
}

interface IntentState {
    kind: ExecutionKind;
    symbol: string;
    event: ExecutionJournalEventName;
}

export class ExecutionJournal {
    constructor(private readonly path: string) {}

    createIntentId(kind: ExecutionKind, symbol: string): string {
        return `${config.runtimeConfigId}:${kind}:${symbol}:${Date.now()}:${randomUUID()}`;
    }

    async record(
        intentId: string,
        kind: ExecutionKind,
        event: ExecutionJournalEventName,
        symbol: string,
        data: Record<string, unknown> = {},
    ): Promise<void> {
        const payload: ExecutionJournalEvent = {
            ts: new Date().toISOString(),
            runtime_config_id: config.runtimeConfigId,
            owner_id: config.ownerId,
            intent_id: intentId,
            kind,
            event,
            symbol,
            data,
        };

        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, `${JSON.stringify(payload)}\n`, 'utf8');
    }

    async assertNoUnsafeUnresolvedRuntime(runtimeConfigId: number): Promise<void> {
        if (!config.failOnUnresolvedExecutionJournal) {
            return;
        }

        const content = await this.readJournal();
        if (!content) {
            return;
        }

        const states = new Map<string, IntentState>();
        const invalidLines: number[] = [];
        const lines = content.split(/\r?\n/);

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index].trim();
            if (!line) {
                continue;
            }

            try {
                const event = JSON.parse(line) as Partial<ExecutionJournalEvent>;
                if (event.runtime_config_id !== runtimeConfigId || !event.intent_id || !event.kind || !event.event || !event.symbol) {
                    continue;
                }

                states.set(event.intent_id, {
                    kind: event.kind,
                    symbol: event.symbol,
                    event: event.event,
                });
            } catch {
                invalidLines.push(index + 1);
            }
        }

        if (invalidLines.length > 0) {
            throw new Error(
                `Execution journal ${this.path} contains invalid JSON lines: ${invalidLines.slice(0, 10).join(', ')}.`,
            );
        }

        const unsafe = [...states.entries()]
            .filter(([, state]) => isUnsafeTerminalState(state))
            .map(([intentId, state]) => `${state.symbol}:${state.kind}:${state.event}:${intentId}`);

        if (unsafe.length > 0) {
            throw new Error(
                `Execution journal has unresolved execution intents for runtime ${runtimeConfigId}: `
                + `${unsafe.slice(0, 10).join(', ')}. Inspect exchange positions and journal before restart.`,
            );
        }
    }

    private async readJournal(): Promise<string | null> {
        try {
            return await readFile(this.path, 'utf8');
        } catch (error: any) {
            if (error?.code === 'ENOENT') {
                return null;
            }
            throw error;
        }
    }
}

function isUnsafeTerminalState(state: IntentState): boolean {
    if (state.kind === 'open') {
        return !['open_django_synced', 'open_aborted_before_orders', 'entry_recheck_rejected', 'cleanup_completed'].includes(state.event);
    }

    if (state.kind === 'cleanup') {
        return state.event !== 'cleanup_completed';
    }

    return state.event !== 'close_synced';
}

export const executionJournal = new ExecutionJournal(config.executionJournalPath);

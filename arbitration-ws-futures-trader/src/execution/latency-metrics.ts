export interface TradeLatencyMetrics {
    localTradeId: string;
    symbol: string;
    direction: 'buy' | 'sell';
    market_update_received_at?: number;
    signal_checked_at?: number;
    signal_detected_at?: number;
    orders_submit_started_at?: number;
    binance_ws_send_at?: number;
    bybit_ws_send_at?: number;
    binance_ack_at?: number;
    bybit_ack_at?: number;
    binance_fill_seen_at?: number;
    bybit_fill_seen_at?: number;
    actual_opened_at?: number;
    actual_closed_at?: number;
    signal_to_actual_open_ms?: number;
    signal_to_actual_close_ms?: number;
    persistence_started_at?: number;
    persistence_finished_at?: number;
}

export class LatencyMetricsStore {
    private readonly entries: TradeLatencyMetrics[] = [];

    add(entry: TradeLatencyMetrics): void {
        this.entries.push(entry);
        if (this.entries.length > 500) {
            this.entries.shift();
        }
    }

    recent(): TradeLatencyMetrics[] {
        return [...this.entries];
    }

    latest(): TradeLatencyMetrics | null {
        return this.entries.at(-1) ?? null;
    }
}

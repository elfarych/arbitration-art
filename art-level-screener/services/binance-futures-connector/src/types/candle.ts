/** Свеча OHLCV. `openTime` — время открытия в миллисекундах UTC. */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

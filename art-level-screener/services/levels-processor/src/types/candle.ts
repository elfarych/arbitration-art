/** Свеча OHLCV (формат, в котором коннектор пишет свечи в Redis). */
export interface Candle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

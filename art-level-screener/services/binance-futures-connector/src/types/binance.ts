/** Типы ответов Binance USDⓈ-M Futures (REST и WebSocket). */

export interface ExchangeInfoSymbol {
  symbol: string;
  contractType: string;
  status: string;
  baseAsset: string;
  quoteAsset: string;
}

export interface ExchangeInfoResponse {
  symbols: ExchangeInfoSymbol[];
}

export interface Ticker24h {
  symbol: string;
  quoteVolume: string;
  lastPrice: string;
}

/**
 * Строка klines:
 * [openTime, open, high, low, close, volume, closeTime, ...прочее].
 */
export type KlineRow = [
  number,
  string,
  string,
  string,
  string,
  string,
  number,
  ...unknown[],
];

export interface WsKlinePayload {
  t: number; // openTime
  T: number; // closeTime
  s: string; // symbol
  i: string; // interval
  o: string;
  c: string;
  h: string;
  l: string;
  v: string;
  x: boolean; // закрыта ли свеча
}

export interface WsKlineEvent {
  e: 'kline';
  E: number;
  s: string;
  k: WsKlinePayload;
}

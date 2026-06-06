import type { Config } from '../config/env';
import type { LevelsReader } from '../redis/levels-reader';
import type { CandleSource } from '../redis/candle-source';
import type { BinanceRestClient } from '../binance/rest-client';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    levels: LevelsReader;
    candles: CandleSource;
    binance: BinanceRestClient;
  }
}

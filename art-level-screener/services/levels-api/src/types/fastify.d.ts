import type { Config } from '../config/env';
import type { LevelsReader } from '../redis/levels-reader';
import type { CandleSource } from '../redis/candle-source';

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    levels: LevelsReader;
    candles: CandleSource;
  }
}

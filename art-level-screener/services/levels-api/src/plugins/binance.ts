/** Plugin: native Binance Futures REST client decorator (`app.binance`).

Used by the breakout-analysis route as the source of candles and aggregated
trades. Public market data only — no keys, no signing. */

import fp from 'fastify-plugin';

import { BinanceRestClient } from '../binance/rest-client';
import { WeightRateLimiter } from '../binance/rate-limiter';

export default fp(
  (app) => {
    const limiter = new WeightRateLimiter(app.config.binance.weightLimitPerMin);
    app.decorate('binance', new BinanceRestClient(app.config.binance.restUrl, limiter));
    return Promise.resolve();
  },
  { name: 'binance' },
);

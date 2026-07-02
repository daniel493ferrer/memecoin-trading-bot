import type { TradingStrategy } from '../types.js';

/** Example stricter strategy favoring broad, buy-led early momentum. */
export const momentumStrategy: TradingStrategy = {
  name: 'momentum',
  evaluate: ({ observation }) => {
    if (observation.score < 80) return { buy: false, reason: 'score below 80' };
    if (observation.uniqueBuyers < 5) return { buy: false, reason: 'fewer than 5 unique buyers' };
    if (observation.buySellRatio < 2) return { buy: false, reason: 'buy/sell ratio below 2' };
    if (observation.priceChangePct < 5) return { buy: false, reason: 'price growth below 5%' };
    return { buy: true, reason: 'strong broad-based momentum' };
  },
};

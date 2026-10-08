import type { TradingStrategy } from '../types.js';

/**
 * Enters a launch that is already pumping with broad participation, aiming to
 * catch part of the move (exits come from the take-profit/stop config).
 */
export const breakoutStrategy: TradingStrategy = {
  name: 'breakout',
  evaluate: ({ observation }) => {
    if (observation.priceChangePct < 30) return { buy: false, reason: 'price up less than 30%' };
    if (observation.recentPriceChangePct <= 0) return { buy: false, reason: 'pump already stalling' };
    if (observation.uniqueBuyers < 8) return { buy: false, reason: 'fewer than 8 buyers' };
    if (observation.buySellRatio < 1.3) return { buy: false, reason: 'sellers too strong' };
    if (observation.largestBuyerPct > 40) return { buy: false, reason: 'one wallet drives the pump' };
    return { buy: true, reason: `breakout +${observation.priceChangePct.toFixed(0)}% with ${observation.uniqueBuyers} buyers` };
  },
};

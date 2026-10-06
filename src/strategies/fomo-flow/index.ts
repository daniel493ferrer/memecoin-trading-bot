import type { TradingStrategy } from '../types.js';

export const fomoFlowStrategy: TradingStrategy = {
  name: 'fomo-flow',

  evaluate: ({ candidate, observation }) => {
    if (candidate.source !== 'fomo') {
      return { buy: false, reason: 'candidate did not originate from FOMO' };
    }

    if (observation.developmentStatus === 'expired') {
      return { buy: false, reason: 'FOMO flow deteriorated or failed to qualify' };
    }

    if (observation.score < 65) {
      return { buy: false, reason: `FOMO flow score ${observation.score}/100 below 65` };
    }

    return {
      buy: true,
      reason:
        `FOMO flow qualified ${observation.score}/100 — ` +
        `${observation.uniqueBuyers} independent buyers, ` +
        `buy/sell ratio ${Number.isFinite(observation.buySellRatio) ? observation.buySellRatio.toFixed(2) : '∞'}, ` +
        `largest buyer ${observation.largestBuyerPct.toFixed(1)}%`,
    };
  },
};

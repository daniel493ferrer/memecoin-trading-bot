import type { ObservationReport } from '../../observation.js';
import type { TradingStrategy } from '../types.js';

const clamp01 = (value: number): number =>
  Math.max(0, Math.min(1, value));

const safeRatio = (value: number): number =>
  Number.isFinite(value) && value > 0 ? value : 0;

function scoreObservation(o: ObservationReport): number {
  // The score rewards breadth, buy-led flow and acceleration, while penalizing
  // concentration. It deliberately avoids absolute return targets.
  const buyerBreadth = clamp01(o.uniqueBuyers / Math.max(1, o.trades * 0.55));
  const flowBalance = clamp01(
    safeRatio(o.buySellRatio) / 3,
  );
  const recentPressure = clamp01(o.recentBuyPressurePct / 70);
  const buyAcceleration = clamp01(o.buyAcceleration / 2);
  const volumeAcceleration = clamp01(o.volumeAcceleration / 2);
  const priceContinuation = clamp01(
    (o.recentPriceChangePct + 5) / 15,
  );
  const activity = clamp01(o.tradeRate / 1.5);
  const concentration = clamp01(o.largestBuyerPct / 60);

  const raw =
    buyerBreadth * 22 +
    flowBalance * 18 +
    recentPressure * 18 +
    buyAcceleration * 12 +
    volumeAcceleration * 10 +
    priceContinuation * 10 +
    activity * 10 -
    concentration * 20;

  return Math.round(Math.max(0, Math.min(100, raw)));
}

export const earlyQualityStrategy: TradingStrategy = {
  name: 'early-quality',

  evaluate: ({ observation }) => {
    if (observation.developmentStatus === 'expired') {
      return { buy: false, reason: 'candidate development deteriorated or expired' };
    }

    if (observation.trades < 5 || observation.uniqueBuyers < 3) {
      return { buy: false, reason: 'insufficient independent early participation' };
    }

    if (observation.buyVolumeSol <= 0 || observation.recentBuyPressurePct < 50) {
      return { buy: false, reason: 'buy-side demand is not dominant enough' };
    }

    if (observation.largestBuyerPct > 55) {
      return { buy: false, reason: 'buy flow is too concentrated in one wallet' };
    }

    if (observation.recentPriceChangePct < 0) {
      return { buy: false, reason: 'recent price regime is deteriorating' };
    }

    const entryScore = scoreObservation(observation);

    if (entryScore < 65) {
      return {
        buy: false,
        reason: `entry quality score ${entryScore}/100 below 65`,
      };
    }

    return {
      buy: true,
      reason:
        `early-quality entry ${entryScore}/100: broad buyers, buy-led flow, ` +
        'accelerating activity and controlled concentration',
    };
  },
};

export { scoreObservation };

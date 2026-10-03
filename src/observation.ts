import type { BotConfig } from './config.js';
import type { PumpFunStream } from './discovery/pumpfun.js';
import type { PumpTradeEvent, TokenCandidate } from './types.js';
import { sleep } from './utils.js';

export interface ObservationReport {
  ok: boolean;
  reasons: string[];
  score: number;

  trades: number;
  uniqueBuyers: number;
  buyVolumeSol: number;
  sellVolumeSol: number;
  buySellRatio: number;
  largestBuyerPct: number;

  firstPrice: number;
  lastPrice: number;
  peakPrice: number;
  priceChangePct: number;
  recentPriceChangePct: number;

  recentBuyVolumeSol: number;
  recentSellVolumeSol: number;
  recentBuySellRatio: number;
  recentBuyPressurePct: number;

  tradeRate: number;
  buyAcceleration: number;
  volumeAcceleration: number;
}

interface Session {
  events: PumpTradeEvent[];
}

export class CandidateObserver {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly stream: PumpFunStream,
    private readonly config: BotConfig['observation'],
  ) {
    this.stream.on('trade', (event: PumpTradeEvent) => {
      const session = this.sessions.get(event.mint);
      if (!session) return;

      if (
        !Number.isFinite(event.price) ||
        event.price <= 0 ||
        !Number.isFinite(event.solAmount) ||
        event.solAmount <= 0
      ) {
        return;
      }

      session.events.push(event);
    });
  }

  async observe(candidate: TokenCandidate): Promise<ObservationReport> {
    if (!this.config.enabled) {
      return this.emptyReport(true, []);
    }

    if (this.sessions.size >= this.config.maxConcurrentCandidates) {
      return this.emptyReport(false, ['observation capacity reached']);
    }

    const session: Session = { events: [] };
    this.sessions.set(candidate.mint, session);
    this.stream.watchToken(candidate.mint);

    const startedAt = Date.now();
    const minDurationMs = this.config.minObservationSeconds * 1_000;
    const maxDurationMs = this.config.durationSeconds * 1_000;
    const intervalMs = this.config.evaluationIntervalMs;

    try {
      while (Date.now() - startedAt < maxDurationMs) {
        const elapsed = Date.now() - startedAt;

        if (elapsed >= minDurationMs) {
          const report = this.evaluate(session.events);

          if (this.isEarlyEntrySignal(report)) {
            return report;
          }
        }

        await sleep(intervalMs);
      }

      return this.evaluate(session.events);
    } finally {
      this.sessions.delete(candidate.mint);
      this.stream.unwatchToken(candidate.mint);
    }
  }

  private isEarlyEntrySignal(report: ObservationReport): boolean {
    return (
      report.trades >= this.config.minTrades &&
      report.uniqueBuyers >= this.config.minUniqueBuyers &&
      report.buyVolumeSol >= this.config.minBuyVolumeSol &&
      report.buySellRatio >= this.config.minBuySellRatio &&
      report.largestBuyerPct <= this.config.maxSingleBuyerPct &&
      report.score >= this.config.minScore &&
      report.recentPriceChangePct > 0 &&
      report.recentBuyPressurePct >= 55 &&
      report.buyAcceleration >= 1 &&
      report.volumeAcceleration >= 1
    );
  }

  private evaluate(events: PumpTradeEvent[]): ObservationReport {
    const buys = events.filter(
      (event) => event.txType === 'buy' && event.solAmount > 0,
    );
    const sells = events.filter(
      (event) => event.txType === 'sell' && event.solAmount > 0,
    );

    const buyVolumeSol = this.sum(buys);
    const sellVolumeSol = this.sum(sells);

    const buySellRatio =
      sellVolumeSol > 0
        ? buyVolumeSol / sellVolumeSol
        : buyVolumeSol > 0
          ? Infinity
          : 0;

    const buyerVolumes = new Map<string, number>();

    for (const buy of buys) {
      buyerVolumes.set(
        buy.trader,
        (buyerVolumes.get(buy.trader) ?? 0) + buy.solAmount,
      );
    }

    const largestBuyerVolume = Math.max(0, ...buyerVolumes.values());

    const largestBuyerPct =
      buyVolumeSol > 0
        ? (largestBuyerVolume / buyVolumeSol) * 100
        : 100;

    const firstPrice = events[0]?.price ?? 0;
    const lastPrice = events.at(-1)?.price ?? 0;

    const peakPrice = events.reduce(
      (peak, event) => Math.max(peak, event.price),
      firstPrice,
    );

    const priceChangePct =
      firstPrice > 0
        ? ((lastPrice / firstPrice) - 1) * 100
        : 0;

    const midpoint =
      events.length > 1
        ? Math.floor(events.length / 2)
        : events.length;

    const firstHalf = events.slice(0, midpoint);
    const secondHalf = events.slice(midpoint);

    const firstBuys = firstHalf.filter((e) => e.txType === 'buy');
    const secondBuys = secondHalf.filter((e) => e.txType === 'buy');

    const firstBuyVolume = this.sum(firstBuys);
    const secondBuyVolume = this.sum(secondBuys);

    const firstSellVolume = this.sum(
      firstHalf.filter((e) => e.txType === 'sell'),
    );

    const secondSellVolume = this.sum(
      secondHalf.filter((e) => e.txType === 'sell'),
    );

    const recentBuySellRatio =
      secondSellVolume > 0
        ? secondBuyVolume / secondSellVolume
        : secondBuyVolume > 0
          ? Infinity
          : 0;

    const recentTotalVolume =
      secondBuyVolume + secondSellVolume;

    const recentBuyPressurePct =
      recentTotalVolume > 0
        ? (secondBuyVolume / recentTotalVolume) * 100
        : 0;

    const recentFirstPrice =
      secondHalf[0]?.price ?? firstPrice;

    const recentLastPrice =
      secondHalf.at(-1)?.price ?? lastPrice;

    const recentPriceChangePct =
      recentFirstPrice > 0
        ? ((recentLastPrice / recentFirstPrice) - 1) * 100
        : 0;

    const firstBuyCount = firstBuys.length;
    const secondBuyCount = secondBuys.length;

    const buyAcceleration =
      firstBuyCount > 0
        ? secondBuyCount / firstBuyCount
        : secondBuyCount > 0
          ? 2
          : 0;

    const firstVolume =
      firstBuyVolume + firstSellVolume;

    const secondVolume =
      secondBuyVolume + secondSellVolume;

    const volumeAcceleration =
      firstVolume > 0
        ? secondVolume / firstVolume
        : secondVolume > 0
          ? 2
          : 0;

    const tradeRate =
      events.length /
      Math.max(1, this.config.durationSeconds);

    const reasons: string[] = [];

    if (events.length < this.config.minTrades) {
      reasons.push(
        `${events.length} trades below min ${this.config.minTrades}`,
      );
    }

    if (buyerVolumes.size < this.config.minUniqueBuyers) {
      reasons.push(
        `${buyerVolumes.size} unique buyers below min ${this.config.minUniqueBuyers}`,
      );
    }

    if (buyVolumeSol < this.config.minBuyVolumeSol) {
      reasons.push(
        `buy volume ${buyVolumeSol.toFixed(3)} SOL below min ${this.config.minBuyVolumeSol}`,
      );
    }

    if (buySellRatio < this.config.minBuySellRatio) {
      reasons.push(
        `buy/sell ratio ${buySellRatio.toFixed(2)} below min ${this.config.minBuySellRatio}`,
      );
    }

    if (largestBuyerPct > this.config.maxSingleBuyerPct) {
      reasons.push(
        `largest buyer is ${largestBuyerPct.toFixed(1)}% of buy volume`,
      );
    }

    if (priceChangePct < this.config.minPriceChangePct) {
      reasons.push(
        `price change ${priceChangePct.toFixed(1)}% below min ${this.config.minPriceChangePct}%`,
      );
    }

    const score = Math.round(
      this.component(
        events.length,
        this.config.minTrades,
        15,
      ) +
        this.component(
          buyerVolumes.size,
          this.config.minUniqueBuyers,
          15,
        ) +
        this.component(
          buyVolumeSol,
          this.config.minBuyVolumeSol,
          15,
        ) +
        this.ratioScore(
          buySellRatio,
          this.config.minBuySellRatio,
          15,
        ) +
        this.pressureScore(
          recentBuyPressurePct,
          60,
          10,
        ) +
        this.accelerationScore(
          buyAcceleration,
          1,
          10,
        ) +
        this.accelerationScore(
          volumeAcceleration,
          1,
          5,
        ) +
        (largestBuyerPct <= this.config.maxSingleBuyerPct
          ? 5
          : 0) +
        (recentPriceChangePct >= 0 ? 10 : 0),
    );

    if (score < this.config.minScore) {
      reasons.push(
        `quality score ${score}/100 below min ${this.config.minScore}`,
      );
    }

    return {
      ok: reasons.length === 0,
      reasons,
      score,

      trades: events.length,
      uniqueBuyers: buyerVolumes.size,
      buyVolumeSol,
      sellVolumeSol,
      buySellRatio,
      largestBuyerPct,

      firstPrice,
      lastPrice,
      peakPrice,
      priceChangePct,
      recentPriceChangePct,

      recentBuyVolumeSol: secondBuyVolume,
      recentSellVolumeSol: secondSellVolume,
      recentBuySellRatio,
      recentBuyPressurePct,

      tradeRate,
      buyAcceleration,
      volumeAcceleration,
    };
  }

  private sum(events: PumpTradeEvent[]): number {
    return events.reduce(
      (sum, event) => sum + event.solAmount,
      0,
    );
  }

  private component(
    value: number,
    minimum: number,
    weight: number,
  ): number {
    if (minimum <= 0) return weight;
    return Math.min(weight, (value / minimum) * weight);
  }

  private ratioScore(
    ratio: number,
    minimum: number,
    weight: number,
  ): number {
    if (!Number.isFinite(ratio)) return weight;
    if (minimum <= 0) return weight;
    return Math.min(weight, (ratio / minimum) * weight);
  }

  private pressureScore(
    pressurePct: number,
    targetPct: number,
    weight: number,
  ): number {
    return Math.min(
      weight,
      (pressurePct / targetPct) * weight,
    );
  }

  private accelerationScore(
    value: number,
    neutral: number,
    weight: number,
  ): number {
    if (value <= 0) return 0;
    return Math.min(
      weight,
      (value / neutral) * weight,
    );
  }

  private emptyReport(
    ok: boolean,
    reasons: string[],
  ): ObservationReport {
    return {
      ok,
      reasons,
      score: ok ? 100 : 0,

      trades: 0,
      uniqueBuyers: 0,
      buyVolumeSol: 0,
      sellVolumeSol: 0,
      buySellRatio: 0,
      largestBuyerPct: 0,

      firstPrice: 0,
      lastPrice: 0,
      peakPrice: 0,
      priceChangePct: 0,
      recentPriceChangePct: 0,

      recentBuyVolumeSol: 0,
      recentSellVolumeSol: 0,
      recentBuySellRatio: 0,
      recentBuyPressurePct: 0,

      tradeRate: 0,
      buyAcceleration: 0,
      volumeAcceleration: 0,
    };
  }
}

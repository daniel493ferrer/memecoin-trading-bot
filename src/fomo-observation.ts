import type { BotConfig } from './config.js';
import type { FomoStream } from './discovery/fomo.js';
import type { FomoAlert, TokenCandidate } from './types.js';
import type { ObservationCheckpoint, ObservationReport } from './observation.js';
import { sleep } from './utils.js';

interface Session {
  events: FomoAlert[];
  checkpoints: ObservationCheckpoint[];
}

export class FomoObserver {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly stream: FomoStream,
    private readonly config: BotConfig['discovery']['fomo'],
  ) {
    this.stream.on('alert', (event: FomoAlert) => {
      this.sessions.get(event.tokenAddress)?.events.push(event);
    });
  }

  async observe(candidate: TokenCandidate): Promise<ObservationReport> {
    const session: Session = { events: [], checkpoints: [] };
    const initial = this.stream.latestAlert(candidate.mint);
    if (initial) session.events.push(initial);

    this.sessions.set(candidate.mint, session);
    const startedAt = Date.now();

    try {
      while (Date.now() - startedAt < this.config.observationSeconds * 1_000) {
        const elapsed = (Date.now() - startedAt) / 1_000;
        const report = this.evaluate(session.events, elapsed);

        if (elapsed >= this.config.minObservationSeconds) {
          session.checkpoints.push(this.checkpoint(report));
          if (this.isQualified(report)) {
            return this.withHistory(report, session, 'qualified');
          }
        }

        if (this.shouldAbort(report, elapsed)) {
          return this.withHistory(report, session, 'expired');
        }

        await sleep(250);
      }

      const report = this.evaluate(session.events, (Date.now() - startedAt) / 1_000);
      return this.withHistory(
        report,
        session,
        this.isQualified(report) ? 'qualified' : 'expired',
      );
    } finally {
      this.sessions.delete(candidate.mint);
    }
  }

  private isQualified(report: ObservationReport): boolean {
    return (
      report.uniqueBuyers >= this.config.minUniqueTraders &&
      report.buyVolumeSol >= this.config.minBuyUsd &&
      report.buySellRatio >= this.config.minBuySellRatio &&
      report.largestBuyerPct <= this.config.maxSingleTraderPct &&
      report.score >= this.config.minScore
    );
  }

  private shouldAbort(report: ObservationReport, elapsed: number): boolean {
    return (
      elapsed >= this.config.minObservationSeconds &&
      report.sellVolumeSol > report.buyVolumeSol &&
      report.uniqueBuyers < this.config.minUniqueTraders
    );
  }

  private evaluate(events: FomoAlert[], elapsed: number): ObservationReport {
    const buys = events.filter((e) => e.alertType === 'buy');
    const sells = events.filter((e) => e.alertType === 'sell');
    const buyVolumeUsd = buys.reduce((s, e) => s + e.usdValue, 0);
    const sellVolumeUsd = sells.reduce((s, e) => s + e.usdValue, 0);
    const buySellRatio =
      sellVolumeUsd > 0 ? buyVolumeUsd / sellVolumeUsd :
      buyVolumeUsd > 0 ? Infinity : 0;

    const buyerVolumes = new Map<string, number>();
    for (const event of buys) {
      buyerVolumes.set(event.trader, (buyerVolumes.get(event.trader) ?? 0) + event.usdValue);
    }

    const largestBuyer = Math.max(0, ...buyerVolumes.values());
    const largestBuyerPct = buyVolumeUsd > 0 ? (largestBuyer / buyVolumeUsd) * 100 : 100;
    const total = buyVolumeUsd + sellVolumeUsd;
    const buyPressure = total > 0 ? (buyVolumeUsd / total) * 100 : 0;

    const breadth = Math.min(30, buyerVolumes.size * 6);
    const flow = Math.min(25, buyPressure / 4);
    const ratio = Number.isFinite(buySellRatio) ? Math.min(20, buySellRatio * 5) : 20;
    const size = Math.min(15, (buyVolumeUsd / Math.max(1, this.config.minBuyUsd)) * 5);
    const concentration =
      largestBuyerPct <= this.config.maxSingleTraderPct
        ? 10
        : Math.max(0, 10 - (largestBuyerPct - this.config.maxSingleTraderPct));
    const score = Math.round(Math.min(100, breadth + flow + ratio + size + concentration));

    const reasons: string[] = [];
    if (buyerVolumes.size < this.config.minUniqueTraders) reasons.push('insufficient independent FOMO buyers');
    if (buyVolumeUsd < this.config.minBuyUsd) reasons.push('insufficient FOMO buy volume');
    if (buySellRatio < this.config.minBuySellRatio) reasons.push('FOMO buy/sell flow is not dominant');
    if (largestBuyerPct > this.config.maxSingleTraderPct) reasons.push('FOMO flow is too concentrated');
    if (score < this.config.minScore) reasons.push(`FOMO flow score ${score}/100 below ${this.config.minScore}`);

    return {
      ok: reasons.length === 0,
      reasons,
      score,
      trades: events.length,
      uniqueBuyers: buyerVolumes.size,
      buyVolumeSol: buyVolumeUsd,
      sellVolumeSol: sellVolumeUsd,
      buySellRatio,
      largestBuyerPct,
      firstPrice: 0,
      lastPrice: 0,
      peakPrice: 0,
      priceChangePct: 0,
      recentPriceChangePct: 0,
      recentBuyVolumeSol: 0,
      recentSellVolumeSol: 0,
      recentBuySellRatio: buySellRatio,
      recentBuyPressurePct: buyPressure,
      tradeRate: elapsed > 0 ? events.length / elapsed : 0,
      buyAcceleration: 0,
      volumeAcceleration: 0,
      observationSeconds: elapsed,
      developmentStatus: reasons.length === 0 ? 'qualified' : 'developing',
      checkpoints: [],
    };
  }

  private checkpoint(report: ObservationReport): ObservationCheckpoint {
    return {
      elapsedSeconds: report.observationSeconds,
      score: report.score,
      trades: report.trades,
      uniqueBuyers: report.uniqueBuyers,
      buyVolumeSol: report.buyVolumeSol,
      sellVolumeSol: report.sellVolumeSol,
      buySellRatio: report.buySellRatio,
      largestBuyerPct: report.largestBuyerPct,
      priceChangePct: 0,
      recentPriceChangePct: 0,
      recentBuyPressurePct: report.recentBuyPressurePct,
      tradeRate: report.tradeRate,
      buyAcceleration: 0,
      volumeAcceleration: 0,
      healthy: report.ok,
    };
  }

  private withHistory(
    report: ObservationReport,
    session: Session,
    status: ObservationReport['developmentStatus'],
  ): ObservationReport {
    return {
      ...report,
      developmentStatus: status,
      checkpoints: [...session.checkpoints],
    };
  }
}

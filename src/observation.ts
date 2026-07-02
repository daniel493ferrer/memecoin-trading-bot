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
  priceChangePct: number;
}

interface Session {
  events: PumpTradeEvent[];
}

/** Collects a short trade sample before allowing a candidate into the buy pipeline. */
export class CandidateObserver {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly stream: PumpFunStream,
    private readonly config: BotConfig['observation'],
  ) {
    this.stream.on('trade', (event: PumpTradeEvent) => {
      const session = this.sessions.get(event.mint);
      if (session && Number.isFinite(event.price) && Number.isFinite(event.solAmount)) {
        session.events.push(event);
      }
    });
  }

  async observe(candidate: TokenCandidate): Promise<ObservationReport> {
    if (!this.config.enabled) return this.emptyReport(true, []);
    if (this.sessions.size >= this.config.maxConcurrentCandidates) {
      return this.emptyReport(false, ['observation capacity reached']);
    }

    const session: Session = { events: [] };
    this.sessions.set(candidate.mint, session);
    this.stream.watchToken(candidate.mint);
    try {
      await sleep(this.config.durationSeconds * 1_000);
      return this.evaluate(session.events);
    } finally {
      this.sessions.delete(candidate.mint);
      this.stream.unwatchToken(candidate.mint);
    }
  }

  private evaluate(events: PumpTradeEvent[]): ObservationReport {
    const buys = events.filter((event) => event.txType === 'buy' && event.solAmount > 0);
    const sells = events.filter((event) => event.txType === 'sell' && event.solAmount > 0);
    const buyVolumeSol = buys.reduce((sum, event) => sum + event.solAmount, 0);
    const sellVolumeSol = sells.reduce((sum, event) => sum + event.solAmount, 0);
    const buySellRatio = sellVolumeSol > 0 ? buyVolumeSol / sellVolumeSol : buyVolumeSol > 0 ? Infinity : 0;

    const buyerVolumes = new Map<string, number>();
    for (const buy of buys) {
      buyerVolumes.set(buy.trader, (buyerVolumes.get(buy.trader) ?? 0) + buy.solAmount);
    }
    const largestBuyerVolume = Math.max(0, ...buyerVolumes.values());
    const largestBuyerPct = buyVolumeSol > 0 ? (largestBuyerVolume / buyVolumeSol) * 100 : 100;

    const firstPrice = events[0]?.price ?? 0;
    const lastPrice = events.at(-1)?.price ?? 0;
    const priceChangePct = firstPrice > 0 ? ((lastPrice / firstPrice) - 1) * 100 : 0;

    const reasons: string[] = [];
    if (events.length < this.config.minTrades) reasons.push(`${events.length} trades below min ${this.config.minTrades}`);
    if (buyerVolumes.size < this.config.minUniqueBuyers) reasons.push(`${buyerVolumes.size} unique buyers below min ${this.config.minUniqueBuyers}`);
    if (buyVolumeSol < this.config.minBuyVolumeSol) reasons.push(`buy volume ${buyVolumeSol.toFixed(3)} SOL below min ${this.config.minBuyVolumeSol}`);
    if (buySellRatio < this.config.minBuySellRatio) reasons.push(`buy/sell ratio ${buySellRatio.toFixed(2)} below min ${this.config.minBuySellRatio}`);
    if (largestBuyerPct > this.config.maxSingleBuyerPct) reasons.push(`largest buyer is ${largestBuyerPct.toFixed(1)}% of buy volume`);
    if (priceChangePct < this.config.minPriceChangePct) reasons.push(`price change ${priceChangePct.toFixed(1)}% below min ${this.config.minPriceChangePct}%`);

    const score = Math.round(
      this.component(events.length, this.config.minTrades, 20) +
      this.component(buyerVolumes.size, this.config.minUniqueBuyers, 20) +
      this.component(buyVolumeSol, this.config.minBuyVolumeSol, 20) +
      this.component(buySellRatio, this.config.minBuySellRatio, 20) +
      (largestBuyerPct <= this.config.maxSingleBuyerPct ? 10 : 0) +
      (priceChangePct >= this.config.minPriceChangePct ? 10 : 0),
    );
    if (score < this.config.minScore) reasons.push(`quality score ${score}/100 below min ${this.config.minScore}`);

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
      priceChangePct,
    };
  }

  private component(value: number, target: number, weight: number): number {
    if (target === 0) return weight;
    return Math.min(weight, (value / target) * weight);
  }

  private emptyReport(ok: boolean, reasons: string[]): ObservationReport {
    return {
      ok, reasons, score: ok ? 100 : 0, trades: 0, uniqueBuyers: 0,
      buyVolumeSol: 0, sellVolumeSol: 0, buySellRatio: 0,
      largestBuyerPct: 100, priceChangePct: 0,
    };
  }
}

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ObservationReport } from './observation.js';
import type { TokenCandidate } from './types.js';

export interface CandidateRecord {
  timestamp: number;
  mint: string;
  symbol: string;
  name: string;
  source: string;
  venue: string;
  discoveredAt: number;

  devBuySol: number;
  initialLiquiditySol: number;

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

  score: number;
  observationOk: boolean;
  reasons: string[];

  decision: 'buy' | 'reject';
  decisionReason: string;
}

export class CandidateRecorder {
  constructor(private readonly file: string) {}

  async record(
    candidate: TokenCandidate,
    observation: ObservationReport,
    decision: 'buy' | 'reject',
    decisionReason: string,
  ): Promise<void> {
    const record: CandidateRecord = {
      timestamp: Date.now(),
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      source: candidate.source,
      venue: candidate.venue,
      discoveredAt: candidate.discoveredAt,

      devBuySol: candidate.devBuySol ?? 0,
      initialLiquiditySol: candidate.initialLiquiditySol ?? 0,

      trades: observation.trades,
      uniqueBuyers: observation.uniqueBuyers,
      buyVolumeSol: observation.buyVolumeSol,
      sellVolumeSol: observation.sellVolumeSol,
      buySellRatio: observation.buySellRatio,
      largestBuyerPct: observation.largestBuyerPct,

      firstPrice: observation.firstPrice,
      lastPrice: observation.lastPrice,
      peakPrice: observation.peakPrice,
      priceChangePct: observation.priceChangePct,
      recentPriceChangePct: observation.recentPriceChangePct,
      recentBuyVolumeSol: observation.recentBuyVolumeSol,
      recentSellVolumeSol: observation.recentSellVolumeSol,
      recentBuySellRatio: observation.recentBuySellRatio,
      recentBuyPressurePct: observation.recentBuyPressurePct,

      tradeRate: observation.tradeRate,
      buyAcceleration: observation.buyAcceleration,
      volumeAcceleration: observation.volumeAcceleration,

      score: observation.score,
      observationOk: observation.ok,
      reasons: observation.reasons,

      decision,
      decisionReason,
    };

    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(
      this.file,
      JSON.stringify(record) + '\n',
      'utf8',
    );
  }
}

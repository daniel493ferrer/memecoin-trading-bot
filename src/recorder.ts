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
  observationSeconds: number;
  developmentStatus: ObservationReport['developmentStatus'];
  checkpoints: ObservationReport['checkpoints'];

  score: number;
  observationOk: boolean;
  reasons: string[];

  decision: 'buy' | 'reject';
  decisionReason: string;
}

export class CandidateRecorder {
  constructor(private readonly file: string) {}

  async recordPrefilterReject(
    candidate: TokenCandidate,
    reason: string,
  ): Promise<void> {
    const timestamp = Date.now();
    const record: CandidateRecord = {
      timestamp,
      mint: candidate.mint,
      symbol: candidate.symbol,
      name: candidate.name,
      source: candidate.source,
      venue: candidate.venue,
      discoveredAt: candidate.discoveredAt,

      devBuySol: candidate.devBuySol ?? 0,
      initialLiquiditySol: candidate.initialLiquiditySol ?? 0,

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
      observationSeconds: 0,
      developmentStatus: 'expired',
      checkpoints: [],

      score: 0,
      observationOk: false,
      reasons: [reason],

      decision: 'reject',
      decisionReason: reason,
    };
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(record) + '\\n', 'utf8');
  }

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
      observationSeconds: observation.observationSeconds,
      developmentStatus: observation.developmentStatus,
      checkpoints: observation.checkpoints,

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

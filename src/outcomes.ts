import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PumpFunStream } from './discovery/pumpfun.js';
import type { PumpTradeEvent } from './types.js';

export interface OutcomeResult {
  mint: string;
  startedAt: number;
  durationSeconds: number;
  entryPrice: number;
  lastPrice: number;
  peakPrice: number;
  troughPrice: number;
  maxGainPct: number;
  maxDrawdownPct: number;
  finalChangePct: number;
  trades: number;
  buyTrades: number;
  sellTrades: number;
}

export class CandidateOutcomeTracker {
  constructor(
    private readonly stream: PumpFunStream,
    private readonly file: string,
  ) {}

  async track(
    mint: string,
    entryPrice: number,
    durationSeconds: number,
  ): Promise<OutcomeResult | null> {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return null;
    }

    let lastPrice = entryPrice;
    let peakPrice = entryPrice;
    let troughPrice = entryPrice;
    const events: PumpTradeEvent[] = [];

    const onTrade = (event: PumpTradeEvent): void => {
      if (event.mint !== mint || !Number.isFinite(event.price) || event.price <= 0) {
        return;
      }

      events.push(event);
      lastPrice = event.price;
      peakPrice = Math.max(peakPrice, event.price);
      troughPrice = Math.min(troughPrice, event.price);
    };

    this.stream.watchToken(mint);
    this.stream.on('trade', onTrade);

    const startedAt = Date.now();

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, durationSeconds * 1_000);
      });

      const result: OutcomeResult = {
        mint,
        startedAt,
        durationSeconds,
        entryPrice,
        lastPrice,
        peakPrice,
        troughPrice,
        maxGainPct: ((peakPrice / entryPrice) - 1) * 100,
        maxDrawdownPct:
          peakPrice > 0
            ? ((troughPrice / peakPrice) - 1) * 100
            : 0,
        finalChangePct: ((lastPrice / entryPrice) - 1) * 100,
        trades: events.length,
        buyTrades: events.filter((e) => e.txType === 'buy').length,
        sellTrades: events.filter((e) => e.txType === 'sell').length,
      };

      await mkdir(dirname(this.file), { recursive: true });

      await appendFile(
        this.file,
        JSON.stringify({
          timestamp: Date.now(),
          ...result,
        }) + '\n',
        'utf8',
      );

      return result;
    } finally {
      this.stream.off('trade', onTrade);
      this.stream.unwatchToken(mint);
    }
  }
}

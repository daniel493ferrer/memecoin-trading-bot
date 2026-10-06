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

interface Session {
  entryPrice: number;
  startedAt: number;
  lastPrice: number;
  peakPrice: number;
  troughPrice: number;
  events: PumpTradeEvent[];
}

export class CandidateOutcomeTracker {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly stream: PumpFunStream,
    private readonly file: string,
  ) {
    // Keep exactly one trade listener on the shared stream. Outcome tracking
    // can run for many candidates concurrently; adding one EventEmitter
    // listener per candidate causes MaxListenersExceededWarning and needless
    // listener churn.
    this.stream.on('trade', (event: PumpTradeEvent) => {
      const session = this.sessions.get(event.mint);
      if (!session || !Number.isFinite(event.price) || event.price <= 0) {
        return;
      }

      session.events.push(event);
      session.lastPrice = event.price;
      session.peakPrice = Math.max(session.peakPrice, event.price);
      session.troughPrice = Math.min(session.troughPrice, event.price);
    });
  }

  async track(
    mint: string,
    entryPrice: number,
    durationSeconds: number,
  ): Promise<OutcomeResult | null> {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
      return null;
    }

    if (this.sessions.has(mint)) {
      return null;
    }

    const session: Session = {
      entryPrice,
      startedAt: Date.now(),
      lastPrice: entryPrice,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      events: [],
    };

    this.sessions.set(mint, session);
    this.stream.watchToken(mint);

    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, durationSeconds * 1_000);
      });

      const result: OutcomeResult = {
        mint,
        startedAt: session.startedAt,
        durationSeconds,
        entryPrice: session.entryPrice,
        lastPrice: session.lastPrice,
        peakPrice: session.peakPrice,
        troughPrice: session.troughPrice,
        maxGainPct: ((session.peakPrice / session.entryPrice) - 1) * 100,
        maxDrawdownPct:
          session.peakPrice > 0
            ? ((session.troughPrice / session.peakPrice) - 1) * 100
            : 0,
        finalChangePct:
          ((session.lastPrice / session.entryPrice) - 1) * 100,
        trades: session.events.length,
        buyTrades: session.events.filter((e) => e.txType === 'buy').length,
        sellTrades: session.events.filter((e) => e.txType === 'sell').length,
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
      this.sessions.delete(mint);
      this.stream.unwatchToken(mint);
    }
  }
}

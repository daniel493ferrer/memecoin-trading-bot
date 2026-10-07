import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../logger.js';
import { short, sleep } from '../utils.js';
import type { PumpTradeEvent, TokenCandidate } from '../types.js';
import type { CurveState } from '../paper.js';

/**
 * Real-time pump.fun feed via the PumpPortal data websocket.
 *
 * Emits:
 *   'newToken'  (candidate: TokenCandidate)
 *   'migration' (mint: string)
 *   'trade'     (event: PumpTradeEvent)
 */
export class PumpFunStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private watchedMints = new Map<string, number>();
  private subscribedMints = new Set<string>();
  /** Latest bonding-curve reserves per watched mint — used for paper fills. */
  private curves = new Map<string, CurveState>();
  private syncTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private reconnectDelayMs = 1_000;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: {
      newTokens: boolean;
      migrations: boolean;
      apiKey: string;
    },
  ) {
    super();
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.syncTimer) {
      clearTimeout(this.syncTimer);
      this.syncTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to live trades for a mint (used to price open positions). */
  watchToken(mint: string): void {
    const refs = this.watchedMints.get(mint) ?? 0;
    this.watchedMints.set(mint, refs + 1);
    if (refs === 0) this.scheduleTradeSync();
  }

  /** Latest known bonding-curve reserves for a watched mint, if any trade was seen. */
  getCurve(mint: string): CurveState | undefined {
    return this.curves.get(mint);
  }

  /** Seed curve reserves from a creation event so the first fill has a price. */
  private setCurve(mint: string, vSol: number, vTokens: number): void {
    if (vSol > 0 && vTokens > 0) this.curves.set(mint, { vSol, vTokens, updatedAt: Date.now() });
  }

  unwatchToken(mint: string): void {
    const refs = this.watchedMints.get(mint) ?? 0;
    if (refs <= 1) {
      this.watchedMints.delete(mint);
      this.curves.delete(mint);
    } else {
      this.watchedMints.set(mint, refs - 1);
    }
    if (refs > 0) this.scheduleTradeSync();
  }

  private scheduleTradeSync(): void {
    if (this.syncTimer || this.stopped) return;

    // Coalesce candidate churn into one PumpPortal request. Without this,
    // dozens of concurrent observations generate a subscribe/unsubscribe
    // message for every individual mint.
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null;
      this.syncTradeSubscriptions();
    }, 100);
  }

  private syncTradeSubscriptions(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const desired = new Set(this.watchedMints.keys());
    const removed = [...this.subscribedMints].filter((mint) => !desired.has(mint));
    const added = [...desired].filter((mint) => !this.subscribedMints.has(mint));

    if (removed.length > 0) {
      this.send({ method: 'unsubscribeTokenTrade', keys: removed });
      for (const mint of removed) this.subscribedMints.delete(mint);
    }

    if (added.length > 0) {
      this.send({ method: 'subscribeTokenTrade', keys: added });
      for (const mint of added) this.subscribedMints.add(mint);
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const url = new URL(this.wsUrl);
    url.searchParams.set('api-key', this.opts.apiKey);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = 1_000;
      log.ok('pump.fun stream connected');

      if (this.opts.newTokens) {
        this.send({ method: 'subscribeNewToken' });
      }

      if (this.opts.migrations) {
        this.send({ method: 'subscribeMigration' });
      }

      this.subscribedMints.clear();
      this.syncTradeSubscriptions();
    });

    ws.on('message', (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.on('error', (err) => {
      log.warn(`pump.fun stream error: ${err.message}`);
    });

    ws.on('close', async () => {
      if (this.stopped) return;

      log.warn(
        `pump.fun stream disconnected — reconnecting in ${this.reconnectDelayMs / 1000}s`,
      );

      await sleep(this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      this.connect();
    });
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private handleMessage(msg: Record<string, any>): void {
    if (msg.txType === 'create' && msg.mint) {
      const candidate: TokenCandidate = {
        mint: msg.mint,
        symbol: String(msg.symbol ?? '?'),
        name: String(msg.name ?? '?'),
        source: 'pumpfun',
        venue: 'pump',
        creator: msg.traderPublicKey,
        devBuySol: Number(msg.solAmount ?? 0),
        discoveredAt: Date.now(),
      };

      this.emit('newToken', candidate);
      // Listeners subscribe synchronously; only keep reserves for mints
      // someone is watching so unwatched launches cannot grow the map.
      if (this.watchedMints.has(msg.mint)) {
        this.setCurve(
          msg.mint,
          Number(msg.vSolInBondingCurve ?? 0),
          Number(msg.vTokensInBondingCurve ?? 0),
        );
      }
      return;
    }

    if (msg.txType === 'migrate' && msg.mint) {
      log.info(`migration detected: ${short(msg.mint)}`);
      this.emit('migration', msg.mint as string);
      return;
    }

    if (msg.message && !msg.txType) {
      const message = String(msg.message);
      // PumpPortal uses normal websocket acknowledgements for successful
      // subscription changes. They are not warnings and should not flood logs.
      if (
        message.startsWith('Successfully subscribed') ||
        message === 'Unsubscribed.'
      ) {
        return;
      }
      log.warn('pump.fun stream message: ' + message);
      return;
    }

    if (
      (msg.txType === 'buy' || msg.txType === 'sell') &&
      this.watchedMints.has(msg.mint)
    ) {
      const vSol = Number(msg.vSolInBondingCurve ?? 0);
      const vTokens = Number(msg.vTokensInBondingCurve ?? 0);

      if (vSol > 0 && vTokens > 0) {
        this.setCurve(msg.mint, vSol, vTokens);
        const event: PumpTradeEvent = {
          mint: msg.mint,
          txType: msg.txType,
          trader: msg.traderPublicKey,
          solAmount: Number(msg.solAmount ?? 0),
          tokenAmount: Number(msg.tokenAmount ?? 0),
          price: vSol / vTokens,
          vSol,
          vTokens,
          timestamp: Date.now(),
        };

        this.emit('trade', event);
      }
    }
  }
}

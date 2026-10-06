import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../logger.js';
import { sleep } from '../utils.js';
import type { FomoAlert, TokenCandidate } from '../types.js';

export interface FomoStreamOptions {
  enabled: boolean;
  chain: 'solana';
  minUsd: number;
  apiKey: string;
}

export class FomoStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private stopped = false;
  private reconnectDelayMs = 1_000;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: FomoStreamOptions,
  ) {
    super();
  }

  start(): void {
    if (!this.opts.enabled) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  private connect(): void {
    if (this.stopped || !this.opts.enabled) return;

    const url = new URL(this.wsUrl);
    url.searchParams.set('key', this.opts.apiKey);
    url.searchParams.set('chain', this.opts.chain);
    url.searchParams.set('minUsd', String(this.opts.minUsd));

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = 1_000;
      log.ok('FOMO Solana alert stream connected');
    });

    ws.on('message', (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames.
      }
    });

    ws.on('error', (err) => {
      log.warn(`FOMO stream error: ${err.message}`);
    });

    ws.on('close', async () => {
      if (this.stopped) return;
      log.warn(
        `FOMO stream disconnected — reconnecting in ${this.reconnectDelayMs / 1000}s`,
      );
      await sleep(this.reconnectDelayMs);
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
      this.connect();
    });
  }

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type !== 'alert') return;

    const alertType = String(msg.alertType ?? '');
    if (alertType !== 'buy' && alertType !== 'sell') return;

    const chain = String(msg.chain ?? '');
    if (chain !== 'solana') return;

    const mint = String(msg.tokenAddress ?? '');
    const symbol = String(msg.token ?? '?');
    const usdValue = Number(msg.usdValue ?? 0);
    const trader = String(msg.trader ?? '');
    if (!mint || !trader || !Number.isFinite(usdValue) || usdValue <= 0) return;

    const alert: FomoAlert = {
      eventId: String(msg.eventId ?? ''),
      alertType,
      trader,
      token: symbol,
      tokenAddress: mint,
      chain,
      usdValue,
      timestamp: Number(msg.ts ?? Date.now()),
    };

    this.emit('alert', alert);

    if (alertType === 'buy') {
      const candidate: TokenCandidate = {
        mint,
        symbol,
        name: symbol,
        source: 'fomo',
        venue: 'amm',
        discoveredAt: Date.now(),
      };
      this.emit('newToken', candidate);
    }
  }
}

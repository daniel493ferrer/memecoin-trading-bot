import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PublicKey } from '@solana/web3.js';
import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import type { BotConfig } from '../config.js';
import { log } from '../logger.js';
import { WSOL_MINT } from '../utils.js';

export interface Mention {
  mint: string;
  channel: string;
  text: string;
}

const NOT_TOKENS = new Set([
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '11111111111111111111111111111111',
]);

/**
 * Solana token addresses in a message: bare contract addresses and the ones
 * inside pump.fun / DexScreener / Birdeye / GMGN / Axiom links.
 */
export function extractSolanaMints(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/[1-9A-HJ-NP-Za-km-z]{32,44}/g)) {
    const candidate = match[0];
    if (NOT_TOKENS.has(candidate)) continue;
    try {
      new PublicKey(candidate);
      found.add(candidate);
    } catch {
      // Not a valid base58 public key.
    }
  }
  return [...found];
}

/** File holding the saved Telegram login, created by `npm run telegram-login`. */
export function sessionPath(cfg: BotConfig['influencers']): string {
  return path.resolve(cfg.sessionFile);
}

/**
 * Reads the configured Telegram channels with the user's own account and
 * emits 'mention' (Mention) for every Solana token address posted.
 */
export class TelegramWatcher extends EventEmitter {
  private client: TelegramClient | null = null;
  private stops: Array<() => void> = [];

  constructor(
    private readonly cfg: BotConfig['influencers'],
    private readonly apiId: number,
    private readonly apiHash: string,
  ) {
    super();
  }

  /** Connect; with `readChannels` also watch the configured channels. */
  async start(readChannels = true): Promise<void> {
    const file = sessionPath(this.cfg);
    if (!fs.existsSync(file)) {
      log.error('influencers: no Telegram login yet — run `npm run telegram-login` once, then restart');
      return;
    }
    const session = new StringSession(fs.readFileSync(file, 'utf8').trim());
    this.client = new TelegramClient(session, this.apiId, this.apiHash, { connectionRetries: 5 });
    this.client.setLogLevel?.('error' as never);
    await this.client.connect();

    for (const channel of readChannels ? this.cfg.channels : []) {
      try {
        const stop = this.client.updates.watch(channel, (update: { message?: { message?: string } }) => {
          const text = update.message?.message ?? '';
          for (const mint of extractSolanaMints(text)) {
            this.emit('mention', { mint, channel, text: text.slice(0, 200) } satisfies Mention);
          }
        });
        this.stops.push(stop);
      } catch (err) {
        log.warn(`influencers: cannot watch ${channel}: ${(err as Error).message}`);
      }
    }
    log.ok(`Telegram connected — watching ${this.stops.length} channel(s), alerts go to your Saved Messages`);
  }

  /** Send a message to the user's own Saved Messages; silently skipped when not connected. */
  async notify(message: string): Promise<void> {
    try {
      await this.client?.sendMessage('me', { message });
    } catch {
      // Alerts are best-effort.
    }
  }

  async stop(): Promise<void> {
    for (const stop of this.stops) stop();
    this.stops = [];
    await this.client?.disconnect().catch(() => {});
  }
}

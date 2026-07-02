import fs from 'node:fs';
import path from 'node:path';
import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { BotConfig } from './config.js';
import { log } from './logger.js';
import { short } from './utils.js';

export interface ManagedWallet {
  name: string;
  keypair: Keypair;
  pubkey: PublicKey;
}

/**
 * Loads wallets from a JSON file and hands them out for buys.
 *
 * Accepted file formats:
 *   ["base58key", "base58key", ...]
 *   [{ "name": "main", "privateKey": "base58key" }, ...]
 */
export class WalletManager {
  private wallets: ManagedWallet[] = [];
  private nextIndex = 0;

  constructor(private readonly cfg: BotConfig['wallets']) {}

  load(): void {
    const file = path.resolve(this.cfg.file);
    if (!fs.existsSync(file)) {
      throw new Error(
        `${this.cfg.file} not found. Copy wallets.example.json to ${this.cfg.file} and add your base58 private keys.`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${this.cfg.file} is not valid JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new Error(`${this.cfg.file} must be a non-empty JSON array of wallets.`);
    }

    this.wallets = raw.map((entry: unknown, i: number) => {
      if (typeof entry !== 'string' && (!entry || typeof entry !== 'object' || Array.isArray(entry))) {
        throw new Error(`${this.cfg.file}: entry ${i} must be a private-key string or wallet object.`);
      }
      const walletEntry = typeof entry === 'object' ? entry as { name?: unknown; privateKey?: unknown } : null;
      if (walletEntry?.name !== undefined && typeof walletEntry.name !== 'string') {
        throw new Error(`${this.cfg.file}: entry ${i} has an invalid "name" field.`);
      }
      const name = typeof entry === 'string' ? `wallet-${i + 1}` : walletEntry?.name ?? `wallet-${i + 1}`;
      const key = typeof entry === 'string' ? entry : walletEntry?.privateKey;
      if (!key || typeof key !== 'string') {
        throw new Error(`${this.cfg.file}: entry ${i} has no "privateKey" field.`);
      }
      let keypair: Keypair;
      try {
        keypair = Keypair.fromSecretKey(bs58.decode(key.trim()));
      } catch {
        throw new Error(`${this.cfg.file}: entry ${i} ("${name}") is not a valid base58 private key.`);
      }
      return { name, keypair, pubkey: keypair.publicKey };
    });

    // Guard against the same key pasted twice.
    const seen = new Set<string>();
    for (const w of this.wallets) {
      const pk = w.pubkey.toBase58();
      if (seen.has(pk)) throw new Error(`${this.cfg.file}: duplicate wallet ${short(pk)}.`);
      seen.add(pk);
    }

    for (const w of this.wallets) {
      log.info(`wallet loaded: ${w.name} (${short(w.pubkey.toBase58())})`);
    }
  }

  get count(): number {
    return this.wallets.length;
  }

  get all(): ManagedWallet[] {
    return this.wallets;
  }

  byPubkey(pubkey: string): ManagedWallet | undefined {
    return this.wallets.find((w) => w.pubkey.toBase58() === pubkey);
  }

  /** Pick the next wallet according to the configured rotation strategy. */
  next(): ManagedWallet {
    if (this.cfg.rotation === 'random') {
      return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
    const w = this.wallets[this.nextIndex % this.wallets.length];
    this.nextIndex++;
    return w;
  }
}

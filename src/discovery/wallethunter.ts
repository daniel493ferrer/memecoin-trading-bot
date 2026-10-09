import type { ParsedTransactionWithMeta, PublicKey } from '@solana/web3.js';
import { PublicKey as PK } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import type { Rpc } from '../rpc.js';
import type { LeaderBook } from '../leaders.js';
import { log } from '../logger.js';
import { sleep } from '../utils.js';
import { parseLeaderSwap } from './copytrader.js';

/** One swap in a token's history, reduced to what the hunter needs. */
export interface SwapPoint {
  wallet: string;
  side: 'buy' | 'sell';
  /** SOL per token paid or received. */
  price: number;
  slot: number;
}

/**
 * Wallets that bought `mint` cheaply: at least `minMultiple` times below the
 * current price, and not in the first slots of the pool (those are the
 * creator's own snipers and bundles, which cannot be copied). Exported for
 * tests.
 */
export function earlySmartBuyers(
  swaps: SwapPoint[],
  currentPrice: number,
  opts: { minMultiple: number; skipFirstSlots: number; reachedPoolStart: boolean },
): string[] {
  if (swaps.length === 0 || currentPrice <= 0) return [];
  const firstSlot = Math.min(...swaps.map((s) => s.slot));
  const out = new Set<string>();
  for (const s of swaps) {
    if (s.side !== 'buy' || s.price <= 0) continue;
    if (opts.reachedPoolStart && s.slot < firstSlot + opts.skipFirstSlots) continue;
    if (currentPrice / s.price >= opts.minMultiple) out.add(s.wallet);
  }
  return [...out];
}

/**
 * Finds wallets worth copying from on-chain data. For every Solana token the
 * scanner sees in a big run, it walks back through the pool's transactions,
 * finds wallets that bought cheaply (before most of the run), and records
 * them in the leader book. A wallet that does this in several different
 * winners is promoted to a copy-trading leader.
 */
export class WalletHunter {
  private done = new Set<string>();
  private queue: Array<{ mint: string; pair: string; symbol: string }> = [];
  private working = false;

  constructor(
    private readonly rpc: Rpc,
    private readonly cfg: BotConfig['hunter'],
    private readonly book: LeaderBook,
    private readonly onPromote: (address: string) => void,
  ) {}

  /** Queue a winning token for analysis (each mint is analysed once). */
  consider(mint: string, pairAddress: string, symbol: string): void {
    if (this.done.has(mint) || !pairAddress) return;
    this.done.add(mint);
    this.queue.push({ mint, pair: pairAddress, symbol });
    if (!this.working) void this.drain();
  }

  private async drain(): Promise<void> {
    this.working = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift()!;
        try {
          await this.analyse(job.mint, job.pair, job.symbol);
        } catch (err) {
          log.warn(`hunter: could not analyse ${job.symbol}: ${(err as Error).message.slice(0, 160)}`);
        }
      }
    } finally {
      this.working = false;
    }
  }

  private async analyse(mint: string, pair: string, symbol: string): Promise<void> {
    const pool = new PK(pair);
    // Walk back through the pool's history (newest first, 1000 per page).
    const signatures: Array<{ signature: string; slot: number }> = [];
    let before: string | undefined;
    let reachedPoolStart = false;
    for (let page = 0; page < this.cfg.maxPages; page++) {
      const batch = await this.rpc.connection.getSignaturesForAddress(pool, { before, limit: 1000 });
      for (const s of batch) if (!s.err) signatures.push({ signature: s.signature, slot: s.slot });
      if (batch.length < 1000) {
        reachedPoolStart = true;
        break;
      }
      before = batch[batch.length - 1].signature;
    }
    if (signatures.length === 0) return;

    // Current price from the newest swaps, early buys from the oldest.
    const newest = await this.parse(signatures.slice(0, 15), mint);
    const latest = newest.find((s) => s.price > 0);
    if (!latest) return;
    const oldest = await this.parse(signatures.slice(-this.cfg.sampleSize).reverse(), mint);

    const wallets = earlySmartBuyers(oldest, latest.price, {
      minMultiple: this.cfg.minMultiple,
      skipFirstSlots: 3,
      reachedPoolStart,
    });
    let promoted = 0;
    for (const wallet of wallets) {
      if (this.book.recordHit(wallet, mint)) {
        promoted++;
        this.onPromote(wallet);
      }
    }
    log.info(
      `hunter: ${symbol} — ${oldest.length} early swaps read, ${wallets.length} wallet(s) bought ` +
      `${this.cfg.minMultiple}x+ cheaper than now, ${promoted} new leader(s)`,
    );
  }

  /** Parse swaps of `mint` by each transaction's signer, a few at a time. */
  private async parse(sigs: Array<{ signature: string; slot: number }>, mint: string): Promise<SwapPoint[]> {
    const out: SwapPoint[] = [];
    for (let i = 0; i < sigs.length; i += 5) {
      const chunk = sigs.slice(i, i + 5);
      const txs = await Promise.all(chunk.map((s) =>
        this.rpc.connection.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }).catch(() => null)));
      txs.forEach((tx, j) => {
        const point = toSwapPoint(tx, mint, chunk[j].slot);
        if (point) out.push(point);
      });
      await sleep(150); // stay well under free-tier RPC rate limits
    }
    return out;
  }
}

function toSwapPoint(tx: ParsedTransactionWithMeta | null, mint: string, slot: number): SwapPoint | null {
  if (!tx?.meta) return null;
  const signer = (tx.transaction.message.accountKeys[0]?.pubkey as PublicKey | undefined)?.toBase58();
  if (!signer) return null;
  const trade = parseLeaderSwap(tx, signer)[0];
  if (!trade || trade.mint !== mint || trade.tokens <= 0) return null;
  return { wallet: signer, side: trade.side, price: trade.sol / trade.tokens, slot };
}


import { PublicKey } from '@solana/web3.js';
import type { Rpc } from './rpc.js';
import { log } from './logger.js';
import { MAX_TX_VERSION, fetchJson, short } from './utils.js';
import { parseLeaderSwap } from './discovery/copytrader.js';

/**
 * Creator of a pump.fun token, from pump.fun's public coin endpoint.
 * Returns null for other tokens or when the endpoint is unavailable.
 */
export async function lookupCreator(mint: string): Promise<string | null> {
  try {
    const coin = await fetchJson<{ creator?: string }>(`https://frontend-api-v3.pump.fun/coins/${mint}`, undefined, 5_000);
    if (!coin.creator) return null;
    new PublicKey(coin.creator);
    return coin.creator;
  } catch {
    return null;
  }
}

/**
 * Watches token creators' wallets while we hold their token and calls
 * `onCreatorSell(mint)` the moment a creator sells it: the strongest rug
 * signal there is.
 */
export class CreatorWatch {
  /** creator -> { subscription id, mints we hold from them } */
  private watched = new Map<string, { id: number; mints: Set<string> }>();

  constructor(
    private readonly rpc: Rpc,
    private readonly onCreatorSell: (mint: string, creator: string) => void,
  ) {}

  watch(mint: string, creator: string): void {
    const existing = this.watched.get(creator);
    if (existing) {
      existing.mints.add(mint);
      return;
    }
    const mints = new Set([mint]);
    const id = this.rpc.connection.onLogs(
      new PublicKey(creator),
      (entry) => {
        if (entry.err) return;
        void this.rpc.connection
          .getParsedTransaction(entry.signature, { maxSupportedTransactionVersion: MAX_TX_VERSION, commitment: 'confirmed' })
          .then((tx) => {
            if (!tx) return;
            for (const trade of parseLeaderSwap(tx, creator)) {
              if (trade.side === 'sell' && mints.has(trade.mint)) this.onCreatorSell(trade.mint, creator);
            }
          })
          .catch(() => {});
      },
      'confirmed',
    );
    this.watched.set(creator, { id, mints });
    log.info(`creator watch: following ${short(creator)} (creator of ${short(mint)})`);
  }

  /** Stop watching for `mint`; drops the subscription when nothing is left. */
  unwatch(mint: string): void {
    for (const [creator, entry] of this.watched) {
      if (!entry.mints.delete(mint) || entry.mints.size > 0) continue;
      this.watched.delete(creator);
      void this.rpc.connection.removeOnLogsListener(entry.id).catch(() => {});
    }
  }

  async stop(): Promise<void> {
    for (const [creator, entry] of this.watched) {
      this.watched.delete(creator);
      await this.rpc.connection.removeOnLogsListener(entry.id).catch(() => {});
    }
  }
}

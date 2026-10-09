import { EventEmitter } from 'node:events';
import { PublicKey, type ParsedTransactionWithMeta } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import type { Rpc } from '../rpc.js';
import { log } from '../logger.js';
import { WSOL_MINT, short, sleep } from '../utils.js';

export interface LeaderTrade {
  leader: string;
  label: string;
  side: 'buy' | 'sell';
  mint: string;
  /** SOL the leader spent (buy) or received (sell), fees included. */
  sol: number;
  /** Share of the leader's prior token balance sold (sells only), 0-100. */
  soldPct: number;
  /** Tokens bought or sold (UI units). */
  tokens: number;
  signature: string;
  /** Seconds between the leader's trade landing and us seeing it. */
  delaySeconds: number;
}

/** Mints that are never the traded token. */
const IGNORED_MINTS = new Set([
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * Watches "leader" wallets (traders with a proven record) through Helius
 * websocket log subscriptions and emits 'trade' (LeaderTrade) for every swap
 * they make: which token, which side, how much SOL.
 */
export class CopyTrader extends EventEmitter {
  /** Subscription id per watched leader address. */
  private subscriptions = new Map<string, number>();
  private seen = new Set<string>();

  constructor(
    private readonly rpc: Rpc,
    private readonly cfg: BotConfig['copy'],
  ) {
    super();
  }

  start(): void {
    for (const leader of this.cfg.wallets) this.addLeader(leader.address, leader.label);
    log.ok(`copy trading: watching ${this.subscriptions.size} configured leader wallet(s)`);
  }

  get watchedCount(): number {
    return this.subscriptions.size;
  }

  /** Start copying a wallet (configured or discovered). Returns false if invalid or already watched. */
  addLeader(address: string, label?: string): boolean {
    if (this.subscriptions.has(address)) return false;
    let pubkey: PublicKey;
    try {
      pubkey = new PublicKey(address);
    } catch {
      log.error(`copy: invalid leader wallet address ${address} — skipped`);
      return false;
    }
    const leader = { address, label };
    const id = this.rpc.connection.onLogs(
      pubkey,
      (entry) => {
        if (entry.err || this.seen.has(entry.signature)) return;
        this.seen.add(entry.signature);
        if (this.seen.size > 20_000) this.seen.clear();
        this.handle(leader, pubkey, entry.signature).catch((err) =>
          log.warn(`copy: could not read ${short(entry.signature)}: ${(err as Error).message}`),
        );
      },
      'confirmed',
    );
    this.subscriptions.set(address, id);
    return true;
  }

  async removeLeader(address: string): Promise<void> {
    const id = this.subscriptions.get(address);
    if (id === undefined) return;
    this.subscriptions.delete(address);
    await this.rpc.connection.removeOnLogsListener(id).catch(() => {});
  }

  async stop(): Promise<void> {
    for (const address of [...this.subscriptions.keys()]) await this.removeLeader(address);
  }

  private async handle(
    leader: { address: string; label?: string },
    pubkey: PublicKey,
    signature: string,
  ): Promise<void> {
    // The transaction can take a moment to be readable after the log fires.
    let tx: ParsedTransactionWithMeta | null = null;
    for (let attempt = 0; attempt < 6 && !tx; attempt++) {
      tx = await this.rpc.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      });
      if (!tx) await sleep(400);
    }
    if (!tx?.meta) return;
    const delaySeconds = tx.blockTime ? Math.max(0, Date.now() / 1000 - tx.blockTime) : 0;
    for (const trade of parseLeaderSwap(tx, pubkey.toBase58())) {
      this.emit('trade', {
        ...trade, leader: leader.address, label: leader.label ?? short(leader.address), signature, delaySeconds,
      });
    }
  }
}

/**
 * Token balance changes of `owner` in one transaction, as buys/sells against
 * SOL. Exported for tests.
 */
export function parseLeaderSwap(
  tx: ParsedTransactionWithMeta,
  owner: string,
): Array<Omit<LeaderTrade, 'leader' | 'label' | 'signature' | 'delaySeconds'>> {
  const meta = tx.meta;
  if (!meta) return [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
  const ownerIndex = keys.indexOf(owner);
  const solDelta = ownerIndex >= 0
    ? (meta.postBalances[ownerIndex] - meta.preBalances[ownerIndex]) / 1e9
    : 0;

  // Sum raw token amounts per mint for accounts owned by the leader.
  const sum = (balances: typeof meta.preTokenBalances) => {
    const out = new Map<string, number>();
    for (const b of balances ?? []) {
      if (b.owner !== owner || IGNORED_MINTS.has(b.mint)) continue;
      out.set(b.mint, (out.get(b.mint) ?? 0) + Number(b.uiTokenAmount.uiAmount ?? 0));
    }
    return out;
  };
  const pre = sum(meta.preTokenBalances);
  const post = sum(meta.postTokenBalances);

  // Wrapped SOL moving in or out of the leader also counts as SOL.
  const wsol = (balances: typeof meta.preTokenBalances) =>
    (balances ?? []).filter((b) => b.owner === owner && b.mint === WSOL_MINT)
      .reduce((s, b) => s + Number(b.uiTokenAmount.uiAmount ?? 0), 0);
  const totalSolDelta = solDelta + (wsol(meta.postTokenBalances) - wsol(meta.preTokenBalances));

  const trades: Array<Omit<LeaderTrade, 'leader' | 'label' | 'signature' | 'delaySeconds'>> = [];
  for (const mint of new Set([...pre.keys(), ...post.keys()])) {
    const before = pre.get(mint) ?? 0;
    const after = post.get(mint) ?? 0;
    if (after > before && totalSolDelta < 0) {
      trades.push({ side: 'buy', mint, sol: -totalSolDelta, soldPct: 0, tokens: after - before });
    } else if (after < before && totalSolDelta > 0) {
      const soldPct = before > 0 ? ((before - after) / before) * 100 : 100;
      trades.push({ side: 'sell', mint, sol: totalSolDelta, soldPct, tokens: before - after });
    }
  }
  // A swap moves one token against SOL; anything else (multi-token routes,
  // transfers, LP actions) is ambiguous and not copied.
  return trades.length === 1 ? trades : [];
}

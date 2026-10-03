import { randomUUID } from 'node:crypto';
import type { BotConfig } from './config.js';
import type { Rpc } from './rpc.js';
import type { WalletManager, ManagedWallet } from './wallets.js';
import type { PumpPortalEngine } from './swap/pumpportal.js';
import type { JupiterEngine } from './swap/jupiter.js';
import type { PositionStore } from './positions.js';
import type { ExitReason, Position, TokenCandidate } from './types.js';
import { log, recordTrade } from './logger.js';
import { fmtSol, rawToUi, short, sleep } from './utils.js';

/** Routes buys/sells to the right engine and keeps the position store honest. */
export class Trader {
  constructor(
    private readonly rpc: Rpc,
    private readonly wallets: WalletManager,
    private readonly pump: PumpPortalEngine,
    private readonly jupiter: JupiterEngine,
    private readonly store: PositionStore,
    private readonly config: BotConfig,
  ) {}

  /**
   * Open a position in `candidate`. Confirms the buy on-chain, measures the
   * actual fill from the wallet's token balance delta, and persists it.
   * Returns the position, or null if the buy could not be completed.
   */
  async buy(candidate: TokenCandidate, decimals: number): Promise<Position | null> {
    const entry = this.config.entry;
    const wallet = await this.pickFundedWallet(entry.buyAmountSol);
    if (!wallet) {
      log.warn(`skipping ${candidate.symbol}: no wallet has ${fmtSol(entry.buyAmountSol)} free`);
      return null;
    }

    const balanceBefore = await this.rpc.getTokenBalanceRaw(wallet.pubkey, candidate.mint);

    let signature: string;
    try {
      signature = await this.executeBuy(wallet, candidate);
    } catch (err) {
      log.error(`buy failed for ${candidate.symbol} (${short(candidate.mint)}): ${(err as Error).message}`);
      return null;
    }

    // Measure the real fill: poll for the token balance delta post-confirmation.
    let tokensRaw = 0n;
    for (let i = 0; i < 10; i++) {
      const after = await this.rpc.getTokenBalanceRaw(wallet.pubkey, candidate.mint);
      tokensRaw = after - balanceBefore;
      if (tokensRaw > 0n) break;
      await sleep(1_000);
    }
    if (tokensRaw <= 0n) {
      log.error(`buy confirmed but no tokens received for ${candidate.symbol} — check tx ${signature}`);
      return null;
    }

    const tokensUi = rawToUi(tokensRaw, decimals);
    const position: Position = {
      id: randomUUID(),
      mint: candidate.mint,
      symbol: candidate.symbol,
      source: candidate.source,
      venue: candidate.venue,
      wallet: wallet.pubkey.toBase58(),
      creator: candidate.creator,
      tokenDecimals: decimals,
      tokensRawInitial: tokensRaw.toString(),
      tokensRawRemaining: tokensRaw.toString(),
      solSpent: entry.buyAmountSol,
      solReceived: 0,
      entryPrice: entry.buyAmountSol / tokensUi,
      peakPrice: entry.buyAmountSol / tokensUi,
      takeProfitsFilled: [],
      trailingActive: false,
      openedAt: Date.now(),
      status: 'open',
      buySignature: signature,
    };
    this.store.add(position);

    log.trade(
      `BOUGHT ${candidate.symbol} (${short(candidate.mint)}) — ${fmtSol(entry.buyAmountSol)} for ${tokensUi.toLocaleString()} tokens via ${wallet.name}`,
    );
    recordTrade({
      type: 'buy',
      mint: candidate.mint,
      symbol: candidate.symbol,
      source: candidate.source,
      wallet: wallet.pubkey.toBase58(),
      solIn: entry.buyAmountSol,
      tokensOut: tokensUi,
      price: position.entryPrice,
      signature,
    });
    return position;
  }

  /**
   * Sell `pct` percent of the remaining position (100 = full close).
   * Returns true when the sell landed.
   */
  async sell(position: Position, pct: number, reason: ExitReason | 'take-profit'): Promise<boolean> {
    const wallet = this.wallets.byPubkey(position.wallet);
    if (!wallet) {
      log.error(`wallet ${short(position.wallet)} for ${position.symbol} not in wallets.json — cannot sell`);
      return false;
    }

    const remaining = BigInt(position.tokensRawRemaining);
    if (remaining <= 0n) return false;
    const sellRaw = pct >= 100 ? remaining : (remaining * BigInt(Math.floor(pct * 100))) / 10_000n;
    if (sellRaw <= 0n) return false;

    // Capture the wallet balance before execution. A wallet may have tokens of
    // this mint that are not owned by this tracked position.
    const balanceBefore = await this.rpc.getTokenBalanceRaw(wallet.pubkey, position.mint);

    let signature: string;
    try {
      // sendAndConfirm already re-broadcasts the same signed transaction. Do
      // not rebuild a sell after an ambiguous confirmation timeout: the first
      // transaction may have landed and a retry could sell twice.
      signature = await this.executeSell(wallet, position, sellRaw);
    } catch (err) {
      log.error(`sell failed for ${position.symbol} (${reason}): ${(err as Error).message}`);
      return false;
    }

    // Poll because a confirmed RPC response can still briefly serve a stale
    // token-account balance from another backend node.
    let balanceAfter = balanceBefore;
    for (let i = 0; i < 10; i++) {
      balanceAfter = await this.rpc.getTokenBalanceRaw(wallet.pubkey, position.mint);
      if (balanceAfter < balanceBefore) break;
      await sleep(500);
    }
    const actualSold = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0n;
    if (actualSold <= 0n) {
      log.error(`sell confirmed but token balance did not decrease for ${position.symbol} — check tx ${signature}`);
      return false;
    }
    const trackedRemaining = actualSold >= remaining ? 0n : remaining - actualSold;
    position.tokensRawRemaining = trackedRemaining.toString();
    const solDelta = await this.rpc.getSolBalanceDelta(signature, wallet.pubkey);
    const actualReceived = solDelta !== null && solDelta > 0 ? solDelta : 0;
    position.solReceived += actualReceived;

    const soldUi = rawToUi(actualSold, position.tokenDecimals);
    log.trade(
      `SOLD ${pct.toFixed(0)}% of ${position.symbol} (${reason}) — ~${fmtSol(actualReceived)} back`,
    );
    recordTrade({
      type: 'sell',
      mint: position.mint,
      symbol: position.symbol,
      wallet: position.wallet,
      tokensIn: soldUi,
      estSolOut: actualReceived,
      pctOfPosition: pct,
      reason,
      signature,
    });

    if (trackedRemaining <= 0n) {
      this.finalize(position, reason as ExitReason);
    } else {
      this.store.update(position);
    }
    return true;
  }

  /** Close the book on a position and log realized PnL. */
  finalize(position: Position, reason: ExitReason): void {
    position.exitReason = reason;
    const pnl = position.solReceived - position.solSpent;
    const pnlPct = (pnl / position.solSpent) * 100;
    this.store.close(position);
    log.trade(
      `CLOSED ${position.symbol} (${reason}) — PnL ~${fmtSol(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    );
    recordTrade({
      type: 'close',
      mint: position.mint,
      symbol: position.symbol,
      reason,
      solSpent: position.solSpent,
      solReceived: position.solReceived,
      pnlSol: pnl,
      holdSeconds: Math.round((Date.now() - position.openedAt) / 1000),
    });
  }

  private async executeBuy(wallet: ManagedWallet, candidate: TokenCandidate): Promise<string> {
    const entry = this.config.entry;
    if (candidate.venue === 'pump') {
      return this.pump.buy(wallet, candidate.mint, entry.buyAmountSol, entry);
    }

    // AMM route: Jupiter may take a short while to index a brand-new pool,
    // so retry the quote until routeTimeoutSeconds runs out.
    const deadline = Date.now() + entry.routeTimeoutSeconds * 1_000;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        return await this.jupiter.buy(wallet, candidate.mint, entry.buyAmountSol, entry);
      } catch (err) {
        lastErr = err as Error;
        await sleep(3_000);
      }
    }
    throw new Error(`no route within ${entry.routeTimeoutSeconds}s: ${lastErr?.message ?? 'unknown'}`);
  }

  private async executeSell(
    wallet: ManagedWallet,
    position: Position,
    sellRaw: bigint,
  ): Promise<string> {
    const entry = this.config.entry;
    if (position.venue === 'pump') {
      // Always sell the tracked raw amount. PumpPortal's "100%" would sweep
      // unrelated pre-existing holdings of this mint from the wallet.
      const amount = rawToUi(sellRaw, position.tokenDecimals);
      return this.pump.sell(wallet, position.mint, amount, entry);
    }
    return this.jupiter.sell(wallet, position.mint, sellRaw, entry);
  }

  /** Round-robin/random rotation, skipping wallets that can't fund the buy. */
  private async pickFundedWallet(amountSol: number): Promise<ManagedWallet | null> {
    const needed = amountSol + this.config.entry.priorityFeeSol + this.config.wallets.minSolReserve;
    for (let i = 0; i < this.wallets.count; i++) {
      const w = this.wallets.next();
      if (await this.checkBalance(w, needed)) return w;
    }
    return null;
  }

  private balanceCache = new Map<string, { sol: number; at: number }>();

  private async checkBalance(wallet: ManagedWallet, needed: number): Promise<boolean> {
    const key = wallet.pubkey.toBase58();
    const cached = this.balanceCache.get(key);
    if (cached && Date.now() - cached.at < 15_000) return cached.sol >= needed;
    try {
      const sol = await this.rpc.getSolBalance(wallet.pubkey);
      this.balanceCache.set(key, { sol, at: Date.now() });
      return sol >= needed;
    } catch (err) {
      log.warn(`could not read SOL balance for ${wallet.name}: ${(err as Error).message}`);
      return false;
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { BotConfig } from './config.js';
import type { Rpc } from './rpc.js';
import type { WalletManager, ManagedWallet } from './wallets.js';
import type { PumpPortalEngine } from './swap/pumpportal.js';
import type { JupiterEngine } from './swap/jupiter.js';
import type { PositionStore } from './positions.js';
import type { PumpFunStream } from './discovery/pumpfun.js';
import type { ExitReason, Position, TokenCandidate } from './types.js';
import { curveBuyTokens, curveSellSol, type PaperAccount } from './paper.js';
import { log, recordTrade } from './logger.js';
import { dexPrice, dexPriceSol } from './dexprice.js';
import { WSOL_MINT, fmtSol, rawToUi, short, sleep, solToLamports } from './utils.js';

/** Base network fee per signature, added to simulated fills. */
const BASE_TX_FEE_SOL = 0.000005;

/** Paper-mode dependencies. Present only when LIVE_TRADING=false. */
export interface PaperContext {
  account: PaperAccount;
  stream: PumpFunStream;
}

interface Fill {
  wallet: string;
  walletName: string;
  tokensRaw: bigint;
  solSpent: number;
  signature: string;
}

/**
 * Routes buys/sells to the right engine and keeps the position store honest.
 *
 * Live mode signs real transactions. Paper mode simulates fills against the
 * latest bonding-curve reserves (pump) or a Jupiter quote (AMM), charging
 * venue fees, extra latency slippage and network fees, and books them to a
 * virtual balance. Both modes produce identical Position records so the exit
 * monitor and trade logs behave the same.
 */
export class Trader {
  constructor(
    private readonly rpc: Rpc,
    private readonly wallets: WalletManager,
    private readonly pump: PumpPortalEngine,
    private readonly jupiter: JupiterEngine,
    private readonly store: PositionStore,
    private readonly config: BotConfig,
    private readonly paper: PaperContext | null,
  ) {}

  get isPaper(): boolean {
    return this.paper !== null;
  }

  /**
   * Open a position in `candidate`. Confirms the buy, measures the actual
   * token fill and SOL cash outflow, then persists it.
   */
  async buy(candidate: TokenCandidate, decimals: number): Promise<Position | null> {
    let fill: Fill | null;
    try {
      fill = this.paper
        ? await this.paperBuy(this.paper, candidate, decimals)
        : await this.liveBuy(candidate);
    } catch (err) {
      log.error(`buy failed for ${candidate.symbol} (${short(candidate.mint)}): ${(err as Error).message}`);
      return null;
    }
    if (!fill) return null;

    const tokensUi = rawToUi(fill.tokensRaw, decimals);
    const entryPrice = fill.solSpent / tokensUi;
    const position: Position = {
      id: randomUUID(),
      mint: candidate.mint,
      symbol: candidate.symbol,
      source: candidate.source,
      venue: candidate.venue,
      wallet: fill.wallet,
      creator: candidate.creator,
      tokenDecimals: decimals,
      tokensRawInitial: fill.tokensRaw.toString(),
      tokensRawRemaining: fill.tokensRaw.toString(),
      solSpent: fill.solSpent,
      solReceived: 0,
      entryPrice,
      peakPrice: entryPrice,
      takeProfitsFilled: [],
      trailingActive: false,
      openedAt: Date.now(),
      status: 'open',
      buySignature: fill.signature,
      chain: candidate.chain,
    };
    this.store.add(position);

    log.trade(
      `${this.tag}BOUGHT ${candidate.symbol} (${short(candidate.mint)}) — ${fmtSol(fill.solSpent)} for ${tokensUi.toLocaleString()} tokens via ${fill.walletName}`,
    );
    recordTrade({
      type: 'buy',
      mode: this.mode,
      mint: candidate.mint,
      symbol: candidate.symbol,
      source: candidate.source,
      wallet: fill.wallet,
      solIn: fill.solSpent,
      tokensOut: tokensUi,
      price: position.entryPrice,
      signature: fill.signature,
    });
    return position;
  }

  /** Sell `pct` percent of the remaining position (100 = full close). */
  async sell(position: Position, pct: number, reason: ExitReason): Promise<boolean> {
    const remaining = BigInt(position.tokensRawRemaining);
    if (remaining <= 0n) return false;
    const sellRaw = pct >= 100 ? remaining : (remaining * BigInt(Math.floor(pct * 100))) / 10_000n;
    if (sellRaw <= 0n) return false;

    let result: { soldRaw: bigint; solReceived: number | null; signature: string } | null;
    try {
      result = this.paper
        ? await this.paperSell(this.paper, position, sellRaw)
        : await this.liveSell(position, sellRaw);
    } catch (err) {
      log.error(`sell failed for ${position.symbol} (${reason}): ${(err as Error).message}`);
      return false;
    }
    if (!result) return false;

    const { soldRaw, solReceived, signature } = result;
    const trackedRemaining = soldRaw >= remaining ? 0n : remaining - soldRaw;
    position.tokensRawRemaining = trackedRemaining.toString();

    if (solReceived === null) {
      // The tokens are gone but the proceeds could not be read back. Do not
      // invent a number; close the book if nothing is left so a dead position
      // cannot occupy a slot forever.
      log.error(
        `sell landed but exact SOL proceeds were not recoverable for ${position.symbol} — check tx ${signature}`,
      );
    } else {
      position.solReceived += solReceived;
      log.trade(
        `${this.tag}SOLD ${pct.toFixed(0)}% of ${position.symbol} (${reason}) — ~${fmtSol(solReceived)} net back`,
      );
    }
    recordTrade({
      type: 'sell',
      mode: this.mode,
      mint: position.mint,
      symbol: position.symbol,
      wallet: position.wallet,
      tokensIn: rawToUi(soldRaw, position.tokenDecimals),
      solOut: solReceived,
      pctOfPosition: pct,
      reason,
      signature,
    });

    if (trackedRemaining <= 0n) {
      this.finalize(position, reason);
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
      `${this.tag}CLOSED ${position.symbol} (${reason}) — PnL ~${fmtSol(pnl)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)`,
    );
    recordTrade({
      type: 'close',
      mode: this.mode,
      chain: position.chain ?? 'solana',
      mint: position.mint,
      symbol: position.symbol,
      source: position.source,
      reason,
      solSpent: position.solSpent,
      solReceived: position.solReceived,
      pnlSol: pnl,
      pnlPct,
      peakMultiple: position.peakPrice / position.entryPrice,
      holdSeconds: Math.round((Date.now() - position.openedAt) / 1000),
    });
  }

  /** DexScreener chain id for a configured scanner chain name. */
  private dexChainId(chainName: string): string {
    return this.config.scanner.chains.find((c) => c.name === chainName)?.dexscreener ?? chainName;
  }

  private get mode(): 'paper' | 'live' {
    return this.paper ? 'paper' : 'live';
  }

  private get tag(): string {
    return this.paper ? '[PAPER] ' : '';
  }

  /** Position size from a balance: reserve first, then a share of the rest. */
  private allocation(balanceSol: number, walletKey: string): number | null {
    const { reservePct, positionPctOfOperatingCapital, priorityFeeSol, maxPositionSol } = this.config.entry;
    // Size from total capital (free SOL + cost of this wallet's open
    // positions) so the 2nd and 3rd position are as large as the 1st.
    const invested = this.store.open
      .filter((p) => p.wallet === walletKey)
      .reduce((sum, p) => sum + p.solSpent, 0);
    const capital = balanceSol + invested;
    const operatingCapital = capital * (1 - reservePct / 100);
    const amountSol = Math.min(maxPositionSol, operatingCapital * (positionPctOfOperatingCapital / 100));
    // Never dip into the reserve or the minimum SOL kept for fees.
    const reserve = capital * (reservePct / 100);
    const needed = amountSol + priorityFeeSol + Math.max(reserve, this.config.wallets.minSolReserve);
    return amountSol > 0 && balanceSol >= needed ? amountSol : null;
  }


  // ------------------------------------------------------------------- live

  private async liveBuy(candidate: TokenCandidate): Promise<Fill | null> {
    const allocation = await this.pickFundedWallet();
    if (!allocation) {
      log.warn(`skipping ${candidate.symbol}: no wallet can fund the configured percentage allocation`);
      return null;
    }
    const { wallet, amountSol } = allocation;

    const balanceBefore = await this.rpc.getTokenBalanceRaw(wallet.pubkey, candidate.mint);
    const signature = await this.executeBuy(wallet, candidate, amountSol);

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

    // Use the confirmed transaction's wallet cash-flow delta so network and
    // priority fees are included in the realized cost.
    const solDelta = await this.rpc.getSolBalanceDelta(signature, wallet.pubkey);
    let solSpent: number;
    if (solDelta !== null && solDelta < 0) {
      solSpent = -solDelta;
    } else {
      solSpent = amountSol;
      log.warn(
        `could not recover exact SOL cash outflow for buy ${short(signature)} — using calculated allocation ${fmtSol(solSpent)}`,
      );
    }

    return {
      wallet: wallet.pubkey.toBase58(),
      walletName: wallet.name,
      tokensRaw,
      solSpent,
      signature,
    };
  }

  private async liveSell(
    position: Position,
    sellRaw: bigint,
  ): Promise<{ soldRaw: bigint; solReceived: number | null; signature: string } | null> {
    const wallet = this.wallets.byPubkey(position.wallet);
    if (!wallet) {
      log.error(`wallet ${short(position.wallet)} for ${position.symbol} not in wallets.json — cannot sell`);
      return null;
    }

    const balanceBefore = await this.rpc.getTokenBalanceRaw(wallet.pubkey, position.mint);

    // sendAndConfirm re-broadcasts the same signed transaction. Do not
    // rebuild a sell after an ambiguous confirmation timeout.
    const signature = await this.executeSell(wallet, position, sellRaw);

    let balanceAfter = balanceBefore;
    for (let i = 0; i < 10; i++) {
      balanceAfter = await this.rpc.getTokenBalanceRaw(wallet.pubkey, position.mint);
      if (balanceAfter < balanceBefore) break;
      await sleep(500);
    }

    const soldRaw = balanceBefore > balanceAfter ? balanceBefore - balanceAfter : 0n;
    if (soldRaw <= 0n) {
      log.error(`sell confirmed but token balance did not decrease for ${position.symbol} — check tx ${signature}`);
      return null;
    }

    const solDelta = await this.rpc.getSolBalanceDelta(signature, wallet.pubkey);
    return { soldRaw, solReceived: solDelta, signature };
  }

  private async executeBuy(
    wallet: ManagedWallet,
    candidate: TokenCandidate,
    amountSol: number,
  ): Promise<string> {
    const entry = this.config.entry;
    if (candidate.venue === 'pump') {
      return this.pump.buy(wallet, candidate.mint, amountSol, entry);
    }

    const deadline = Date.now() + entry.routeTimeoutSeconds * 1_000;
    let lastErr: Error | null = null;
    while (Date.now() < deadline) {
      try {
        return await this.jupiter.buy(wallet, candidate.mint, amountSol, entry);
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
      // A full exit sweeps the balance; a float UI amount can round above it.
      const amount = sellRaw >= BigInt(position.tokensRawRemaining)
        ? '100%' as const
        : rawToUi(sellRaw, position.tokenDecimals);
      return this.pump.sell(wallet, position.mint, amount, entry);
    }
    return this.jupiter.sell(wallet, position.mint, sellRaw, entry);
  }

  /** First wallet (by rotation) whose balance funds the configured allocation. */
  private async pickFundedWallet(): Promise<{ wallet: ManagedWallet; amountSol: number } | null> {
    for (let i = 0; i < this.wallets.count; i++) {
      const wallet = this.wallets.next();
      try {
        const amountSol = this.allocation(await this.rpc.getSolBalance(wallet.pubkey), wallet.pubkey.toBase58());
        if (amountSol !== null) return { wallet, amountSol };
      } catch (err) {
        log.warn(`could not read SOL balance for ${wallet.name}: ${(err as Error).message}`);
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ paper

  private async paperBuy(paper: PaperContext, candidate: TokenCandidate, decimals: number): Promise<Fill | null> {
    const amountSol = this.allocation(paper.account.balanceSol, 'paper');
    if (amountSol === null) {
      log.warn(
        `skipping ${candidate.symbol}: paper balance ${fmtSol(paper.account.balanceSol)} cannot fund the allocation`,
      );
      return null;
    }
    const { feePct, extraSlippagePct } = this.config.paper;

    let tokensRaw: bigint;
    if (candidate.chain && candidate.chain !== 'solana') {
      // Other chains: price from the pool in USD. The position's "SOL"
      // amounts are the accounting unit, so returns stay exact in %.
      const chainId = this.dexChainId(candidate.chain);
      const dex = await dexPrice(candidate.mint, chainId);
      if (!dex || dex.priceUsd <= 0) throw new Error(`no ${candidate.chain} pool price for paper fill`);
      const tokensUi = (amountSol * (1 - feePct / 100) * (1 - extraSlippagePct / 100)) / dex.priceUsd;
      tokensRaw = BigInt(Math.floor(tokensUi * 10 ** decimals));
    } else if (candidate.venue === 'pump') {
      const curve = paper.stream.getCurve(candidate.mint);
      if (!curve) throw new Error('no bonding-curve reserves seen yet for paper fill');
      const tokensUi = curveBuyTokens(curve, amountSol, feePct) * (1 - extraSlippagePct / 100);
      tokensRaw = BigInt(Math.floor(tokensUi * 10 ** decimals));
    } else {
      const quote = await this.jupiter.quote(
        WSOL_MINT,
        candidate.mint,
        BigInt(solToLamports(amountSol)),
        this.config.entry.slippageBps,
      );
      tokensRaw = (BigInt(quote.outAmount) * BigInt(Math.round((100 - extraSlippagePct) * 100))) / 10_000n;
    }
    if (tokensRaw <= 0n) throw new Error('simulated fill returned no tokens');

    const solSpent = amountSol + this.config.entry.priorityFeeSol + BASE_TX_FEE_SOL;
    paper.account.debit(solSpent);
    return {
      wallet: 'paper',
      walletName: `paper (${fmtSol(paper.account.balanceSol)} left)`,
      tokensRaw,
      solSpent,
      signature: `paper-${randomUUID()}`,
    };
  }

  private async paperSell(
    paper: PaperContext,
    position: Position,
    sellRaw: bigint,
  ): Promise<{ soldRaw: bigint; solReceived: number; signature: string } | null> {
    const { feePct, extraSlippagePct } = this.config.paper;
    let grossSol: number;
    if (position.chain && position.chain !== 'solana') {
      const dex = await dexPrice(position.mint, this.dexChainId(position.chain));
      if (!dex || dex.priceUsd <= 0) throw new Error(`no ${position.chain} pool price for paper sell`);
      grossSol = dex.priceUsd * rawToUi(sellRaw, position.tokenDecimals) * (1 - feePct / 100);
    } else if (position.venue === 'pump') {
      const curve = paper.stream.getCurve(position.mint);
      if (!curve) throw new Error('no bonding-curve reserves available for paper sell');
      grossSol = curveSellSol(curve, rawToUi(sellRaw, position.tokenDecimals), feePct);
    } else {
      const value = await this.jupiter.sellValueSol(position.mint, sellRaw, this.config.entry.slippageBps);
      if (value !== null) {
        grossSol = value;
      } else {
        // Same fallback as the monitor: price from the pool, minus venue fee.
        const dex = await dexPriceSol(position.mint);
        if (!dex) throw new Error(`no price for paper sell (Jupiter: ${this.jupiter.lastQuoteError ?? 'unknown'})`);
        grossSol = dex.priceSol * rawToUi(sellRaw, position.tokenDecimals) * (1 - feePct / 100);
      }
    }
    const solReceived = grossSol * (1 - extraSlippagePct / 100)
      - this.config.entry.priorityFeeSol - BASE_TX_FEE_SOL;
    paper.account.credit(solReceived);
    return { soldRaw: sellRaw, solReceived, signature: `paper-${randomUUID()}` };
  }
}

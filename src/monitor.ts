import type { BotConfig } from './config.js';
import type { PositionStore } from './positions.js';
import type { Trader } from './trader.js';
import type { JupiterEngine } from './swap/jupiter.js';
import type { PumpFunStream } from './discovery/pumpfun.js';
import type { ExitReason, Position, PumpTradeEvent } from './types.js';
import { log } from './logger.js';
import { dexPrice, dexPriceSol } from './dexprice.js';
import { fmtPct, rawToUi, short } from './utils.js';

/** A pool below this much liquidity is treated as pulled. */
const RUG_LIQUIDITY_USD = 1_000;

/**
 * Consecutive failed price reads on an AMM position before we assume a rug.
 * High enough (about a minute of polling) that API rate limits are not
 * mistaken for a pulled pool.
 */
const MAX_PRICE_FAILURES = 15;

/**
 * Watches every open position and applies the exit rules in priority order:
 * stop loss, trailing stop, then the optional take-profit ladder.
 *
 * Pricing:
 *  - pump venue: pushed in real time from bonding-curve trade events
 *  - amm venue: pulled by quoting a full liquidation via Jupiter
 */
export class ExitMonitor {
  private lastPumpPrice = new Map<string, number>();
  private priceFailures = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  /** Positions with a sell currently in flight — prevents double-firing rules. */
  private selling = new Set<string>();

  constructor(
    private readonly store: PositionStore,
    private readonly trader: Trader,
    private readonly jupiter: JupiterEngine,
    private readonly pumpStream: PumpFunStream,
    private readonly config: BotConfig,
  ) {}

  start(): void {
    this.pumpStream.on('trade', (event: PumpTradeEvent) => this.onPumpTrade(event));
    this.pumpStream.on('migration', (mint: string) => this.onMigration(mint));

    // Resume price feeds for positions restored from disk.
    for (const p of this.store.open) {
      if (p.venue === 'pump') this.pumpStream.watchToken(p.mint);
    }

    this.timer = setInterval(() => {
      if (this.ticking) return;
      this.ticking = true;
      this.tick()
        .catch((err) => log.warn(`monitor tick error: ${(err as Error).message}`))
        .finally(() => { this.ticking = false; });
    }, this.config.exit.priceCheckIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Called by the orchestrator right after a buy fills. */
  track(position: Position): void {
    if (position.venue === 'pump') this.pumpStream.watchToken(position.mint);
  }

  // ---------------------------------------------------------------- pricing

  private onPumpTrade(event: PumpTradeEvent): void {
    this.lastPumpPrice.set(event.mint, event.price);

    // Dev-sell exit: creator dumping is the strongest rug signal on pump.fun.
    if (!this.config.exit.exitOnDevSell || event.txType !== 'sell') return;
    for (const p of this.store.open) {
      if (p.mint === event.mint && p.creator && p.creator === event.trader) {
        log.warn(`dev sell detected on ${p.symbol} — exiting immediately`);
        void this.exit(p, 'dev-sell');
      }
    }
  }

  private onMigration(mint: string): void {
    for (const p of this.store.open) {
      if (p.mint !== mint) continue;
      if (this.config.exit.sellOnMigration) {
        log.info(`${p.symbol} migrated — selling per config`);
        void this.exit(p, 'migration');
      } else {
        // Keep the position; switch pricing + execution to the AMM path.
        log.info(`${p.symbol} migrated — now managed via Jupiter`);
        p.venue = 'amm';
        this.store.update(p);
        this.pumpStream.unwatchToken(mint);
      }
    }
  }

  private async currentPrice(position: Position): Promise<number | null> {
    if (position.venue === 'pump') {
      return this.lastPumpPrice.get(position.mint) ?? null;
    }
    const remaining = BigInt(position.tokensRawRemaining);
    const ui = rawToUi(remaining, position.tokenDecimals);
    if (ui <= 0) return null;
    if (position.chain && position.chain !== 'solana') {
      // Paper-only chains: the pool's USD price is the position's price unit.
      const chainId = this.config.scanner.chains.find((c) => c.name === position.chain)?.dexscreener ?? position.chain;
      const dex = await dexPrice(position.mint, chainId);
      if (!dex || dex.priceUsd <= 0) return null;
      if (dex.liquidityUsd < RUG_LIQUIDITY_USD) {
        this.pulledLiquidity.add(position.id);
        return null;
      }
      return dex.priceUsd;
    }
    const value = await this.jupiter.sellValueSol(
      position.mint,
      remaining,
      this.config.entry.slippageBps,
    );
    if (value !== null) return value / ui;

    // Jupiter failing (rate limit, outage) is not a rug. Fall back to the
    // pool price and only call it rugged when the liquidity is really gone.
    const dex = await dexPriceSol(position.mint);
    const now = Date.now();
    if (now - (this.quoteWarnedAt.get(position.id) ?? 0) > 60_000) {
      this.quoteWarnedAt.set(position.id, now);
      log.warn(
        `${position.symbol}: Jupiter quote failed (${this.jupiter.lastQuoteError ?? 'unknown'}) — ` +
        (dex ? `using DexScreener price, liquidity $${Math.round(dex.liquidityUsd).toLocaleString()}` : 'no DexScreener price either'),
      );
    }
    if (!dex) return null;
    if (dex.liquidityUsd < RUG_LIQUIDITY_USD) {
      this.pulledLiquidity.add(position.id);
      return null;
    }
    return dex.priceSol;
  }

  private quoteWarnedAt = new Map<string, number>();
  /** Positions whose pool liquidity was seen below RUG_LIQUIDITY_USD. */
  private pulledLiquidity = new Set<string>();

  // ------------------------------------------------------------- rule engine

  private async tick(): Promise<void> {
    for (const position of this.store.open) {
      if (this.selling.has(position.id)) continue;
      try {
        await this.evaluate(position);
      } catch (err) {
        log.warn(`evaluate ${position.symbol}: ${(err as Error).message}`);
      }
    }
  }

  private async evaluate(position: Position): Promise<void> {
    const exit = this.config.exit;

    // Time stop fires even when we cannot price the token.
    const ageSec = (Date.now() - position.openedAt) / 1000;
    if (exit.maxHoldSeconds > 0 && ageSec > exit.maxHoldSeconds) {
      log.info(`${position.symbol}: max hold time reached (${Math.round(ageSec)}s)`);
      return this.exit(position, 'max-hold');
    }

    const price = await this.currentPrice(position);
    if (price === null) {
      // AMM positions that repeatedly fail to quote have likely lost their
      // liquidity — try to salvage whatever is left, then close the book.
      if (position.venue === 'amm') {
        const fails = (this.priceFailures.get(position.id) ?? 0) + 1;
        this.priceFailures.set(position.id, fails);
        if (this.pulledLiquidity.has(position.id) || fails >= MAX_PRICE_FAILURES) {
          log.warn(`${position.symbol}: no route ${fails}x — treating as rugged`);
          return this.exit(position, 'rugged');
        }
      }
      return;
    }
    this.priceFailures.delete(position.id);

    const multiple = price / position.entryPrice;
    if (price > position.peakPrice) {
      position.peakPrice = price;
      this.store.update(position);
    }

    // 1. Stop loss.
    if (multiple <= 1 - exit.stopLossPct / 100) {
      log.info(`${position.symbol}: stop loss hit at ${fmtPct((multiple - 1) * 100)}`);
      return this.exit(position, 'stop-loss');
    }

    // 2. Trailing stop (activates once, then follows the peak).
    if (exit.trailingStop.enabled) {
      if (!position.trailingActive && multiple >= exit.trailingStop.activateAtMultiple) {
        position.trailingActive = true;
        this.store.update(position);
        log.info(`${position.symbol}: trailing stop armed at ${multiple.toFixed(2)}x`);
      }
      if (position.trailingActive) {
        const trigger = position.peakPrice * (1 - exit.trailingStop.trailPct / 100);
        if (price <= trigger) {
          log.info(
            `${position.symbol}: trailing stop hit (peak ${(position.peakPrice / position.entryPrice).toFixed(2)}x → now ${multiple.toFixed(2)}x)`,
          );
          return this.exit(position, 'trailing-stop');
        }
      }
    }

    // 3. Take-profit ladder: partial sells of the remaining position. An empty
    //    ladder keeps the whole position on for the trailing stop.
    for (const [i, rung] of exit.takeProfits.entries()) {
      if (position.takeProfitsFilled.includes(i) || multiple < rung.multiple) continue;
      log.info(`${position.symbol}: take-profit ${rung.multiple}x hit — selling ${rung.sellPct}%`);
      await this.partialExit(position, i, rung.sellPct);
      return;
    }
  }

  /** Sell part of a position for take-profit rung `rungIndex`. */
  private async partialExit(position: Position, rungIndex: number, pct: number): Promise<void> {
    if (this.selling.has(position.id)) return;
    this.selling.add(position.id);
    try {
      const sold = await this.trader.sell(position, pct, 'take-profit');
      if (sold && position.status === 'open') {
        position.takeProfitsFilled.push(rungIndex);
        this.store.update(position);
      }
      if (position.status !== 'open' && position.venue === 'pump') {
        this.pumpStream.unwatchToken(position.mint);
      }
    } finally {
      this.selling.delete(position.id);
    }
  }

  /** Full exit requested from outside the rule engine (e.g. a copied leader sold). */
  async exitNow(position: Position, reason: ExitReason): Promise<void> {
    return this.exit(position, reason);
  }

  /** Full exit — sells 100% and closes the position. */
  private async exit(position: Position, reason: ExitReason): Promise<void> {
    if (this.selling.has(position.id)) return;
    this.selling.add(position.id);
    try {
      const sold = await this.trader.sell(position, 100, reason);
      if (!sold && reason === 'rugged') {
        // Nothing sellable left — close the book at whatever was realized.
        this.trader.finalize(position, 'rugged');
      }
      if (position.status !== 'open' && position.venue === 'pump') {
        this.pumpStream.unwatchToken(position.mint);
      }
    } finally {
      this.selling.delete(position.id);
    }
  }
}

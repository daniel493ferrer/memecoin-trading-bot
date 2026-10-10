import { EventEmitter } from 'node:events';
import type { BotConfig } from '../config.js';
import { log } from '../logger.js';
import { fetchJson, short, sleep } from '../utils.js';
import { toMetrics, type ScanMetrics } from './scanner.js';

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  liquidity?: { usd?: number };
  [key: string]: unknown;
}

/** Most liquid Solana pair of `mint` as scanner metrics, or null. */
async function snapshot(mint: string): Promise<{ metrics: ScanMetrics; symbol: string } | null> {
  try {
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    let best: DexPair | null = null;
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      if (pair.chainId !== 'solana' || pair.baseToken?.address !== mint) continue;
      if (!best || (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = pair;
    }
    if (!best) return null;
    return { metrics: toMetrics(best as never, 'solana'), symbol: best.baseToken?.symbol ?? short(mint) };
  } catch {
    return null;
  }
}

/**
 * Why a graduated token should not be bought after the wait, or null to buy.
 * Exported for tests.
 */
export function graduationReject(
  baselinePrice: number,
  now: ScanMetrics,
  cfg: BotConfig['graduation'],
): string | null {
  if (baselinePrice <= 0 || now.priceUsd <= 0) return 'no price';
  const changePct = (now.priceUsd / baselinePrice - 1) * 100;
  if (changePct < -cfg.maxDropFromGraduationPct) return `dumped ${changePct.toFixed(0)}% since graduating`;
  if (now.liquidityUsd < cfg.minLiquidityUsd) return 'liquidity too low';
  if (now.volume5mUsd < cfg.minVolume5mUsd) return '5m volume too low';
  if (now.buys5m < cfg.minBuySellRatio5m * Math.max(1, now.sells5m)) return 'sellers in control';
  if (now.priceChange5mPct < 0) return 'falling right now';
  return null;
}

/**
 * Graduation strategy: when a pump.fun token completes its bonding curve
 * and moves to PumpSwap, don't buy the graduation spike (early holders sell
 * into it). Take a baseline price shortly after, wait a few minutes, and buy
 * only if the token held its price with buyers still in control.
 *
 * Emits 'signal' (mint, symbol, reason).
 */
export class GraduationWatcher extends EventEmitter {
  private pending = new Set<string>();

  constructor(private readonly cfg: BotConfig['graduation']) {
    super();
  }

  onGraduation(mint: string): void {
    if (this.pending.has(mint) || this.pending.size >= this.cfg.maxConcurrent) return;
    this.pending.add(mint);
    void this.follow(mint)
      .catch((err) => log.warn(`graduation ${short(mint)}: ${(err as Error).message}`))
      .finally(() => this.pending.delete(mint));
  }

  private async follow(mint: string): Promise<void> {
    // DexScreener needs a moment to index the new PumpSwap pool.
    await sleep(this.cfg.baselineDelaySeconds * 1_000);
    const base = await snapshot(mint);
    if (!base || base.metrics.priceUsd <= 0) return;
    log.info(
      `graduation: ${base.symbol} (${short(mint)}) graduated — $${Math.round(base.metrics.marketCapUsd).toLocaleString()} MC, ` +
      `checking again in ${this.cfg.waitMinutes} min`,
    );

    await sleep(this.cfg.waitMinutes * 60_000);
    const now = await snapshot(mint);
    if (!now) return;
    const reason = graduationReject(base.metrics.priceUsd, now.metrics, this.cfg);
    const changePct = (now.metrics.priceUsd / base.metrics.priceUsd - 1) * 100;
    if (reason) {
      log.info(`graduation: skip ${now.symbol} — ${reason}`);
      return;
    }
    this.emit(
      'signal',
      mint,
      now.symbol,
      `graduated and held ${changePct >= 0 ? '+' : ''}${changePct.toFixed(0)}% after ${this.cfg.waitMinutes} min, ` +
      `${now.metrics.buys5m}/${now.metrics.sells5m} buys/sells, $${Math.round(now.metrics.volume5mUsd).toLocaleString()} vol 5m`,
    );
  }
}

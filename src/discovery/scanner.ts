import { EventEmitter } from 'node:events';
import type { BotConfig } from '../config.js';
import { log } from '../logger.js';
import { fetchJson, short } from '../utils.js';
import type { TokenCandidate } from '../types.js';

/** Market snapshot of one token's most liquid Solana pair (DexScreener). */
export interface ScanMetrics {
  pairAddress: string;
  dexId: string;
  priceUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  ageMinutes: number;
  priceChange5mPct: number;
  priceChange1hPct: number;
  buys5m: number;
  sells5m: number;
  volume5mUsd: number;
  volume1hUsd: number;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  priceUsd?: string;
  txns?: Record<string, { buys?: number; sells?: number } | undefined>;
  volume?: Record<string, number | undefined>;
  priceChange?: Record<string, number | undefined>;
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

const GECKO = 'https://api.geckoterminal.com/api/v2/networks/solana';
const DEXSCREENER = 'https://api.dexscreener.com';
const GECKO_FEEDS: Array<[string, string]> = [
  ['gecko-trending-5m', 'trending_pools?duration=5m'],
  ['gecko-trending-1h', 'trending_pools?duration=1h'],
  ['gecko-new', 'new_pools'],
];
/** How long a GeckoTerminal-listed token stays in the scan set. */
const GECKO_CACHE_MS = 3 * 60_000;
/** DexScreener accepts up to 30 token addresses per lookup. */
const BATCH = 30;
const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * Finds Solana tokens that are pumping right now, whatever their age.
 *
 * Every cycle it gathers addresses from free public feeds (GeckoTerminal
 * trending and new pools, DexScreener latest profiles and boosts), looks all
 * of them up on DexScreener for uniform 5m/1h metrics, and emits
 * 'signal' (candidate, metrics) for tokens that meet the configured rules.
 * Tokens that do not qualify yet are re-checked on later cycles.
 */
export class MarketScanner extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private warnedAt = new Map<string, number>();
  private geckoTurn = 0;
  private geckoPausedUntil = 0;
  /** GeckoTerminal addresses by last time a list included them. */
  private geckoCache = new Map<string, number>();

  constructor(private readonly cfg: BotConfig['scanner']) {
    super();
  }

  start(): void {
    log.ok(`market scanner started — every ${this.cfg.intervalSeconds}s`);
    const run = () => {
      if (this.running) return;
      this.running = true;
      this.scan()
        .catch((err) => log.warn(`scanner cycle failed: ${(err as Error).message}`))
        .finally(() => { this.running = false; });
    };
    run();
    this.timer = setInterval(run, this.cfg.intervalSeconds * 1_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async scan(): Promise<void> {
    const addresses = await this.collectAddresses();
    if (addresses.length === 0) {
      log.warn('scanner: no feed returned any token this cycle — check the internet connection');
      return;
    }

    let passed = 0;
    for (let i = 0; i < addresses.length; i += BATCH) {
      const batch = addresses.slice(i, i + BATCH);
      let pairs: DexPair[];
      try {
        pairs = await fetchJson<DexPair[]>(`${DEXSCREENER}/tokens/v1/solana/${batch.join(',')}`);
      } catch (err) {
        this.warnThrottled('dexscreener', `DexScreener lookup failed: ${(err as Error).message}`);
        continue;
      }
      if (!Array.isArray(pairs)) {
        this.warnThrottled('dexscreener-shape', 'DexScreener returned an unexpected response shape');
        continue;
      }

      for (const [mint, pair] of this.bestPairs(pairs)) {
        const metrics = toMetrics(pair);
        const reason = this.rejectReason(metrics);
        if (reason) continue;
        passed++;
        const candidate: TokenCandidate = {
          mint,
          symbol: pair.baseToken?.symbol ?? short(mint),
          name: pair.baseToken?.name ?? '?',
          source: 'scanner',
          venue: 'amm',
          discoveredAt: Date.now(),
        };
        this.emit('signal', candidate, metrics);
      }
    }
    log.info(`scanner: ${addresses.length} tokens checked, ${passed} pumping per rules`);
  }

  /**
   * Unique token addresses from all discovery feeds; a failing feed is
   * skipped. GeckoTerminal's free tier allows only a few calls per minute,
   * so one of its lists is fetched per cycle in rotation and its addresses
   * are remembered for a few minutes; a 429 pauses it for a minute.
   */
  private async collectAddresses(): Promise<string[]> {
    const found = new Set<string>();
    const feeds: Array<[string, () => Promise<string[]>]> = [
      ['dex-profiles', () => this.dexList(`${DEXSCREENER}/token-profiles/latest/v1`)],
      ['dex-boosts', () => this.dexList(`${DEXSCREENER}/token-boosts/latest/v1`)],
    ];
    if (Date.now() >= this.geckoPausedUntil) {
      const [name, path] = GECKO_FEEDS[this.geckoTurn++ % GECKO_FEEDS.length];
      feeds.push([name, async () => {
        const list = await this.geckoPools(`${GECKO}/${path}`);
        for (const a of list) this.geckoCache.set(a, Date.now());
        return list;
      }]);
    }
    const results = await Promise.allSettled(feeds.map(([, fn]) => fn()));
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        for (const a of result.value) if (!SOL_MINTS.has(a)) found.add(a);
      } else {
        const message = String(result.reason);
        if (feeds[i][0].startsWith('gecko') && message.includes('HTTP 429')) {
          this.geckoPausedUntil = Date.now() + 60_000;
          this.warnThrottled('gecko-429', 'GeckoTerminal rate limit hit — pausing it for 60s');
          return;
        }
        this.warnThrottled(feeds[i][0], `scanner feed ${feeds[i][0]} failed: ${message.slice(0, 160)}`);
      }
    });
    for (const [address, seenAt] of this.geckoCache) {
      if (Date.now() - seenAt > GECKO_CACHE_MS) this.geckoCache.delete(address);
      else if (!SOL_MINTS.has(address)) found.add(address);
    }
    return [...found];
  }

  private async geckoPools(url: string): Promise<string[]> {
    const body = await fetchJson<{ data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> }>(
      url,
      { headers: { accept: 'application/json' } },
    );
    // Token ids look like "solana_<mint>".
    return (body.data ?? [])
      .map((pool) => pool.relationships?.base_token?.data?.id ?? '')
      .filter((id) => id.startsWith('solana_'))
      .map((id) => id.slice('solana_'.length));
  }

  private async dexList(url: string): Promise<string[]> {
    const body = await fetchJson<Array<{ chainId?: string; tokenAddress?: string }>>(url);
    return (Array.isArray(body) ? body : [])
      .filter((t) => t.chainId === 'solana' && t.tokenAddress)
      .map((t) => t.tokenAddress as string);
  }

  /** The most liquid Solana pair per base token. */
  private bestPairs(pairs: DexPair[]): Map<string, DexPair> {
    const best = new Map<string, DexPair>();
    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (pair.chainId !== 'solana' || !mint || SOL_MINTS.has(mint)) continue;
      const current = best.get(mint);
      if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(mint, pair);
    }
    return best;
  }

  /** Why a token does not qualify, or null when it is pumping per the rules. */
  rejectReason(m: ScanMetrics): string | null {
    const c = this.cfg;
    if (m.liquidityUsd < c.minLiquidityUsd) return 'liquidity too low';
    if (m.priceChange5mPct < c.minPriceChange5mPct) return '5m change too small';
    if (m.priceChange1hPct < c.minPriceChange1hPct) return '1h change too small';
    if (m.volume5mUsd < c.minVolume5mUsd) return '5m volume too low';
    if (m.buys5m < c.minBuys5m) return 'too few buys';
    if (m.buys5m < c.minBuySellRatio5m * Math.max(1, m.sells5m)) return 'sellers too strong';
    if (c.maxAgeHours > 0 && m.ageMinutes > c.maxAgeHours * 60) return 'token too old';
    if (c.maxMarketCapUsd > 0 && m.marketCapUsd > c.maxMarketCapUsd) return 'market cap too high';
    return null;
  }

  /** Warn at most once every 10 minutes per source. */
  private warnThrottled(key: string, message: string): void {
    const last = this.warnedAt.get(key) ?? 0;
    if (Date.now() - last < 10 * 60_000) return;
    this.warnedAt.set(key, Date.now());
    log.warn(message);
  }
}

export function toMetrics(pair: DexPair): ScanMetrics {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    pairAddress: pair.pairAddress ?? '',
    dexId: pair.dexId ?? '?',
    priceUsd: num(pair.priceUsd),
    liquidityUsd: num(pair.liquidity?.usd),
    marketCapUsd: num(pair.marketCap ?? pair.fdv),
    ageMinutes: pair.pairCreatedAt ? (Date.now() - pair.pairCreatedAt) / 60_000 : 0,
    priceChange5mPct: num(pair.priceChange?.m5),
    priceChange1hPct: num(pair.priceChange?.h1),
    buys5m: num(pair.txns?.m5?.buys),
    sells5m: num(pair.txns?.m5?.sells),
    volume5mUsd: num(pair.volume?.m5),
    volume1hUsd: num(pair.volume?.h1),
  };
}

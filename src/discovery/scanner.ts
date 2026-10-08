import { EventEmitter } from 'node:events';
import type { BotConfig } from '../config.js';
import { log } from '../logger.js';
import { fetchJson, short } from '../utils.js';
import type { TokenCandidate } from '../types.js';

/** Market snapshot of one token's most liquid pair (DexScreener). */
export interface ScanMetrics {
  chain: string;
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

const GECKO = 'https://api.geckoterminal.com/api/v2/networks';
const DEXSCREENER = 'https://api.dexscreener.com';
const GECKO_FEEDS: Array<[string, string]> = [
  ['gecko-trending-5m', 'trending_pools?duration=5m'],
  ['gecko-trending-1h', 'trending_pools?duration=1h'],
  ['gecko-new', 'new_pools'],
];
/** How long a GeckoTerminal-listed token stays in the scan set. */
const GECKO_CACHE_MS = 5 * 60_000;
/** Quote/stable assets that are never the token we want to trade. */
const BASE_ASSET_SYMBOLS = new Set(['SOL', 'WSOL', 'ETH', 'WETH', 'BNB', 'WBNB', 'USDC', 'USDT', 'DAI', 'USD1', 'USDE', 'FDUSD']);
/** DexScreener accepts up to 30 token addresses per lookup. */
const BATCH = 30;
const SOL_MINTS = new Set([
  'So11111111111111111111111111111111111111112',
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
]);

/**
 * Finds tokens that are pumping right now, whatever their age, on every
 * configured chain (Solana, Base, BNB Chain, Robinhood Chain, ...).
 *
 * Every cycle it gathers addresses from free public feeds (GeckoTerminal
 * trending and new pools, DexScreener latest profiles and boosts), looks all
 * of them up on DexScreener for uniform 5m/1h metrics, and emits
 * 'signal' (candidate, metrics) for tokens that meet the configured rules.
 * Tokens that do not qualify yet are re-checked on later cycles.
 */
type Chain = BotConfig['scanner']['chains'][number];

export class MarketScanner extends EventEmitter {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private warnedAt = new Map<string, number>();
  private geckoTurn = 0;
  private geckoPausedUntil = 0;
  /** "chain:address" keys by last time a GeckoTerminal list included them. */
  private geckoCache = new Map<string, number>();
  private loggedChains = false;

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
    const byChain = await this.collectAddresses();
    const total = [...byChain.values()].reduce((n, set) => n + set.size, 0);
    if (total === 0) {
      log.warn('scanner: no feed returned any token this cycle — check the internet connection');
      return;
    }

    let passed = 0;
    const perChain: string[] = [];
    for (const chain of this.cfg.chains) {
      const addresses = [...(byChain.get(chain.dexscreener) ?? [])];
      perChain.push(`${chain.name} ${addresses.length}`);
      for (let i = 0; i < addresses.length; i += BATCH) {
        const batch = addresses.slice(i, i + BATCH);
        let pairs: DexPair[];
        try {
          pairs = await fetchJson<DexPair[]>(`${DEXSCREENER}/tokens/v1/${chain.dexscreener}/${batch.join(',')}`);
        } catch (err) {
          this.warnThrottled(`dexscreener-${chain.name}`, `DexScreener lookup failed on ${chain.name}: ${(err as Error).message}`);
          continue;
        }
        if (!Array.isArray(pairs)) {
          this.warnThrottled('dexscreener-shape', 'DexScreener returned an unexpected response shape');
          continue;
        }

        for (const [mint, pair] of this.bestPairs(pairs, chain.dexscreener)) {
          const metrics = toMetrics(pair, chain.name);
          if (this.rejectReason(metrics)) continue;
          passed++;
          const candidate: TokenCandidate = {
            mint,
            symbol: pair.baseToken?.symbol ?? short(mint),
            name: pair.baseToken?.name ?? '?',
            source: 'scanner',
            venue: 'amm',
            chain: chain.name,
            discoveredAt: Date.now(),
          };
          this.emit('signal', candidate, metrics);
        }
      }
    }
    log.info(`scanner: ${total} tokens checked (${perChain.join(', ')}), ${passed} pumping per rules`);
  }

  /**
   * Token addresses per DexScreener chain id from all discovery feeds; a
   * failing feed is skipped. GeckoTerminal's free tier allows only a few
   * calls per minute, so one (chain, list) pair is fetched per cycle in
   * rotation and its addresses are remembered for a few minutes; a 429
   * pauses it for a minute.
   */
  private async collectAddresses(): Promise<Map<string, Set<string>>> {
    const wanted = new Set(this.cfg.chains.map((c) => c.dexscreener));
    const found = new Map<string, Set<string>>();
    const add = (chainId: string, address: string) => {
      if (!wanted.has(chainId) || !address || SOL_MINTS.has(address)) return;
      if (!found.has(chainId)) found.set(chainId, new Set());
      found.get(chainId)!.add(address);
    };

    const feeds: Array<[string, () => Promise<void>]> = [
      ['dex-profiles', () => this.dexList(`${DEXSCREENER}/token-profiles/latest/v1`, add)],
      ['dex-boosts', () => this.dexList(`${DEXSCREENER}/token-boosts/latest/v1`, add)],
    ];
    const geckoChains = this.cfg.chains.filter((c) => c.gecko);
    if (geckoChains.length > 0 && Date.now() >= this.geckoPausedUntil) {
      const turn = this.geckoTurn++;
      const chain = geckoChains[turn % geckoChains.length];
      const [name, path] = GECKO_FEEDS[Math.floor(turn / geckoChains.length) % GECKO_FEEDS.length];
      feeds.push([`${name}-${chain.name}`, async () => {
        for (const a of await this.geckoPools(`${GECKO}/${chain.gecko}/${path}`)) {
          this.geckoCache.set(`${chain.dexscreener}:${a}`, Date.now());
        }
      }]);
    }
    const results = await Promise.allSettled(feeds.map(([, fn]) => fn()));
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') return;
      const message = String(result.reason);
      if (feeds[i][0].startsWith('gecko') && message.includes('HTTP 429')) {
        this.geckoPausedUntil = Date.now() + 60_000;
        this.warnThrottled('gecko-429', 'GeckoTerminal rate limit hit — pausing it for 60s');
        return;
      }
      this.warnThrottled(feeds[i][0], `scanner feed ${feeds[i][0]} failed: ${message.slice(0, 160)}`);
    });
    for (const [key, seenAt] of this.geckoCache) {
      if (Date.now() - seenAt > GECKO_CACHE_MS) {
        this.geckoCache.delete(key);
        continue;
      }
      const sep = key.indexOf(':');
      add(key.slice(0, sep), key.slice(sep + 1));
    }
    return found;
  }

  private async geckoPools(url: string): Promise<string[]> {
    const body = await fetchJson<{ data?: Array<{ relationships?: { base_token?: { data?: { id?: string } } } }> }>(
      url,
      { headers: { accept: 'application/json' } },
    );
    // Token ids look like "<network>_<address>", e.g. "solana_<mint>".
    return (body.data ?? [])
      .map((pool) => pool.relationships?.base_token?.data?.id ?? '')
      .filter((id) => id.includes('_'))
      .map((id) => id.slice(id.indexOf('_') + 1));
  }

  private async dexList(url: string, add: (chainId: string, address: string) => void): Promise<void> {
    const body = await fetchJson<Array<{ chainId?: string; tokenAddress?: string }>>(url);
    const rows = Array.isArray(body) ? body : [];
    if (!this.loggedChains && rows.length > 0) {
      // Shows the exact DexScreener chain ids in use, to configure new chains.
      this.loggedChains = true;
      const ids = [...new Set(rows.map((t) => t.chainId).filter(Boolean))].sort();
      log.info(`DexScreener chain ids seen in latest listings: ${ids.join(', ')}`);
    }
    for (const t of rows) {
      if (t.chainId && t.tokenAddress) add(t.chainId, t.tokenAddress);
    }
  }

  /** The most liquid pair per base token on one chain. */
  private bestPairs(pairs: DexPair[], chainId: string): Map<string, DexPair> {
    const best = new Map<string, DexPair>();
    for (const pair of pairs) {
      const mint = pair.baseToken?.address;
      if (pair.chainId !== chainId || !mint || SOL_MINTS.has(mint)) continue;
      if (BASE_ASSET_SYMBOLS.has((pair.baseToken?.symbol ?? '').toUpperCase())) continue;
      const current = best.get(mint);
      if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(mint, pair);
    }
    return best;
  }

  /** Why a token does not qualify, or null when it is pumping per the rules. */
  rejectReason(m: ScanMetrics): string | null {
    const c = this.cfg;
    if (m.liquidityUsd < c.minLiquidityUsd) return 'liquidity too low';
    // Survivors only: most launches die in their first hour.
    if (m.ageMinutes < c.minAgeMinutes) return 'token too young';
    if (c.maxAgeHours > 0 && m.ageMinutes > c.maxAgeHours * 60) return 'token too old';
    if (c.maxMarketCapUsd > 0 && m.marketCapUsd > c.maxMarketCapUsd) return 'market cap too high';
    // Trend confirmed over the hour...
    if (m.priceChange1hPct < c.minPriceChange1hPct) return '1h change too small';
    if (m.volume1hUsd < c.minVolume1hUsd) return '1h volume too low';
    // ...still rising now, but not a vertical spike that buys the top.
    if (m.priceChange5mPct < c.minPriceChange5mPct) return '5m change too small';
    if (c.maxPriceChange5mPct > 0 && m.priceChange5mPct > c.maxPriceChange5mPct) return '5m spike too steep (late entry)';
    if (m.volume5mUsd < c.minVolume5mUsd) return '5m volume too low';
    // Interest accelerating: the last 5 minutes trade above the hourly pace.
    if (c.requireVolumeAcceleration && m.volume5mUsd * 12 < m.volume1hUsd) return 'volume fading';
    if (m.buys5m < c.minBuys5m) return 'too few buys';
    if (m.buys5m < c.minBuySellRatio5m * Math.max(1, m.sells5m)) return 'sellers too strong';
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

export function toMetrics(pair: DexPair, chain = 'solana'): ScanMetrics {
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v) || 0);
  return {
    chain,
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

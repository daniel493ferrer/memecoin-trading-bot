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
  private warned = new Set<string>();

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
        this.warnOnce('dexscreener', `DexScreener lookup failed: ${(err as Error).message}`);
        continue;
      }
      if (!Array.isArray(pairs)) {
        this.warnOnce('dexscreener-shape', 'DexScreener returned an unexpected response shape');
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

  /** Unique token addresses from all discovery feeds; a failing feed is skipped. */
  private async collectAddresses(): Promise<string[]> {
    const found = new Set<string>();
    const feeds: Array<[string, () => Promise<string[]>]> = [
      ['gecko-trending', () => this.geckoPools(`${GECKO}/trending_pools?duration=5m`)],
      ['gecko-trending-1h', () => this.geckoPools(`${GECKO}/trending_pools?duration=1h`)],
      ['gecko-new', () => this.geckoPools(`${GECKO}/new_pools`)],
      ['dex-profiles', () => this.dexList(`${DEXSCREENER}/token-profiles/latest/v1`)],
      ['dex-boosts', () => this.dexList(`${DEXSCREENER}/token-boosts/latest/v1`)],
    ];
    const results = await Promise.allSettled(feeds.map(([, fn]) => fn()));
    results.forEach((result, i) => {
      if (result.status === 'fulfilled') {
        for (const a of result.value) if (!SOL_MINTS.has(a)) found.add(a);
      } else {
        this.warnOnce(feeds[i][0], `scanner feed ${feeds[i][0]} failed: ${String(result.reason).slice(0, 160)}`);
      }
    });
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

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    log.warn(`${message} (further errors from this source are silenced)`);
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

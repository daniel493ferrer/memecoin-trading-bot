import { WSOL_MINT, fetchJson } from './utils.js';

export interface DexPrice {
  /** SOL per token on the most liquid SOL pair (Solana only, else 0). */
  priceSol: number;
  /** USD per token on the most liquid pair. */
  priceUsd: number;
  liquidityUsd: number;
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceNative?: string;
  priceUsd?: string;
  liquidity?: { usd?: number };
}

const cache = new Map<string, { at: number; price: DexPrice | null }>();
const CACHE_MS = 3_000;

/**
 * Pool price from DexScreener: the second price source for Solana AMM tokens
 * when Jupiter cannot quote, and the only source for paper trades on other
 * chains. Returns null when the token has no usable pair or the API fails.
 */
export async function dexPrice(mint: string, chain = 'solana'): Promise<DexPrice | null> {
  const key = `${chain}:${mint}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.price;
  let price: DexPrice | null = null;
  try {
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/${chain}/${mint}`);
    let best: DexPair | null = null;
    let bestSol: DexPair | null = null;
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      if (pair.chainId !== chain || pair.baseToken?.address?.toLowerCase() !== mint.toLowerCase()) continue;
      if (!best || (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = pair;
      if (pair.quoteToken?.address === WSOL_MINT &&
          (!bestSol || (pair.liquidity?.usd ?? 0) > (bestSol.liquidity?.usd ?? 0))) bestSol = pair;
    }
    const priceUsd = Number(best?.priceUsd) || 0;
    const priceSol = Number(bestSol?.priceNative) || 0;
    if (best && (priceUsd > 0 || priceSol > 0)) {
      price = { priceSol, priceUsd, liquidityUsd: best.liquidity?.usd ?? 0 };
    }
  } catch {
    price = null;
  }
  cache.set(key, { at: Date.now(), price });
  return price;
}

/** Solana-only shortcut kept for the AMM fallback: null without a SOL pair. */
export async function dexPriceSol(mint: string): Promise<DexPrice | null> {
  const price = await dexPrice(mint, 'solana');
  return price && price.priceSol > 0 ? price : null;
}

export interface MarketSnapshot {
  /** SOL per token on the most liquid SOL pair (0 if none). */
  priceSol: number;
  priceUsd: number;
  liquidityUsd: number;
  volume5mUsd: number;
}

/**
 * Prices, liquidity and 5-minute volume for many Solana tokens in one
 * DexScreener request (up to 30 per call), for second-by-second monitoring
 * without hitting rate limits.
 */
export async function batchSnapshots(mints: string[]): Promise<Map<string, MarketSnapshot>> {
  const out = new Map<string, MarketSnapshot>();
  for (let i = 0; i < mints.length; i += 30) {
    const batch = mints.slice(i, i + 30);
    let pairs: Array<DexPair & { volume?: { m5?: number } }>;
    try {
      pairs = await fetchJson(`https://api.dexscreener.com/tokens/v1/solana/${batch.join(',')}`, undefined, 5_000);
    } catch {
      continue;
    }
    const best = new Map<string, DexPair & { volume?: { m5?: number } }>();
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      const mint = pair.baseToken?.address;
      if (pair.chainId !== 'solana' || !mint || !batch.includes(mint)) continue;
      if (pair.quoteToken?.address !== WSOL_MINT) continue;
      const current = best.get(mint);
      if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) best.set(mint, pair);
    }
    for (const [mint, pair] of best) {
      const priceSol = Number(pair.priceNative) || 0;
      if (priceSol <= 0) continue;
      out.set(mint, {
        priceSol,
        priceUsd: Number(pair.priceUsd) || 0,
        liquidityUsd: pair.liquidity?.usd ?? 0,
        volume5mUsd: pair.volume?.m5 ?? 0,
      });
    }
  }
  return out;
}

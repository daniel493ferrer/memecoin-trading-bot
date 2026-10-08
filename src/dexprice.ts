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

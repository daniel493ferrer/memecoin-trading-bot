import { WSOL_MINT, fetchJson } from './utils.js';

export interface DexPrice {
  /** SOL per token (UI units) on the most liquid SOL pair. */
  priceSol: number;
  liquidityUsd: number;
}

interface DexPair {
  chainId?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  priceNative?: string;
  liquidity?: { usd?: number };
}

const cache = new Map<string, { at: number; price: DexPrice | null }>();
const CACHE_MS = 3_000;

/**
 * Second price source for AMM tokens (DexScreener), used when Jupiter cannot
 * quote. Returns null when the token has no SOL pair or the API fails.
 */
export async function dexPriceSol(mint: string): Promise<DexPrice | null> {
  const hit = cache.get(mint);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.price;
  let price: DexPrice | null = null;
  try {
    const pairs = await fetchJson<DexPair[]>(`https://api.dexscreener.com/tokens/v1/solana/${mint}`);
    let best: DexPair | null = null;
    for (const pair of Array.isArray(pairs) ? pairs : []) {
      if (pair.chainId !== 'solana' || pair.baseToken?.address !== mint) continue;
      if (pair.quoteToken?.address !== WSOL_MINT) continue;
      if (!best || (pair.liquidity?.usd ?? 0) > (best.liquidity?.usd ?? 0)) best = pair;
    }
    const priceSol = Number(best?.priceNative);
    if (best && Number.isFinite(priceSol) && priceSol > 0) {
      price = { priceSol, liquidityUsd: best.liquidity?.usd ?? 0 };
    }
  } catch {
    price = null;
  }
  cache.set(mint, { at: Date.now(), price });
  return price;
}

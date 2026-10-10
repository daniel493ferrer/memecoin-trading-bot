import { fetchJson } from '../utils.js';

interface GeckoPool {
  data?: { attributes?: { transactions?: Record<string, { buyers?: number; buys?: number } | undefined> } };
}

/**
 * Unique buyers in the last 5 minutes vs the 5 minutes before, from
 * GeckoTerminal's pool stats (m5 and m15 windows). Null when unavailable.
 */
export async function uniqueBuyersGrowth(pairAddress: string): Promise<{ now: number; before: number } | null> {
  try {
    const body = await fetchJson<GeckoPool>(
      `https://api.geckoterminal.com/api/v2/networks/solana/pools/${pairAddress}`,
      { headers: { accept: 'application/json' } },
      5_000,
    );
    const tx = body.data?.attributes?.transactions;
    const m5 = tx?.m5?.buyers;
    const m15 = tx?.m15?.buyers;
    if (typeof m5 !== 'number' || typeof m15 !== 'number') return null;
    // m15 covers 15 minutes; the average 5-minute slice before now:
    return { now: m5, before: Math.max(0, m15 - m5) / 2 };
  } catch {
    return null;
  }
}

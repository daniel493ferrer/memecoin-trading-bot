export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const LAMPORTS_PER_SOL = 1_000_000_000;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const lamportsToSol = (lamports: number | bigint) => Number(lamports) / LAMPORTS_PER_SOL;

export const solToLamports = (sol: number) => Math.round(sol * LAMPORTS_PER_SOL);

/** Raw token amount -> human-readable UI amount. */
export const rawToUi = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

export const short = (addr: string) => `${addr.slice(0, 4)}..${addr.slice(-4)}`;

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Retry an async fn with linear backoff. Throws the last error. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  attempts = 3,
  delayMs = 500,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs * (i + 1));
    }
  }
  throw lastErr;
}

/** fetch that throws on non-2xx and returns parsed JSON. */
export async function fetchJson<T = unknown>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${url} ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export const fmtSol = (sol: number) => `${sol.toFixed(4)} SOL`;

export const fmtPct = (pct: number) => `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;

import { PublicKey } from '@solana/web3.js';
import type { BotConfig } from './config.js';
import type { Rpc } from './rpc.js';
import type { SafetyReport, TokenCandidate } from './types.js';
import { sleep } from './utils.js';

interface ParsedMintInfo {
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  supply: string;
}

/**
 * On-chain rug checks that run between discovery and buy. Fast by design —
 * two RPC calls, both against Helius.
 */
export class SafetyChecker {
  constructor(
    private readonly rpc: Rpc,
    private readonly filters: BotConfig['filters'],
  ) {}

  async check(candidate: TokenCandidate): Promise<SafetyReport> {
    const reasons: string[] = [];
    let mintPk: PublicKey;

    try {
      mintPk = new PublicKey(candidate.mint);
    } catch {
      return {
        ok: false,
        reasons: ['invalid mint public key'],
        decimals: 0,
      };
    }

    const parsed = await this.fetchMintInfo(mintPk);
    if (!parsed) {
      return {
        ok: false,
        reasons: ['mint account unavailable after RPC retries'],
        decimals: 0,
      };
    }

    if (this.filters.requireMintAuthorityRevoked && parsed.mintAuthority) {
      reasons.push('mint authority not revoked (supply can be inflated)');
    }
    if (this.filters.requireFreezeAuthorityRevoked && parsed.freezeAuthority) {
      reasons.push('freeze authority not revoked (transfers can be frozen)');
    }

    if (candidate.venue === 'amm' && this.filters.maxTop10HolderPct < 100) {
      try {
        const largest = await this.rpc.connection.getTokenLargestAccounts(mintPk);
        const supply = Number(parsed.supply);
        if (supply > 0 && largest.value.length > 1) {
          const holders = largest.value.slice(1, 11);
          const heldPct =
            (holders.reduce((sum, a) => sum + Number(a.amount), 0) / supply) * 100;
          if (heldPct > this.filters.maxTop10HolderPct) {
            reasons.push(
              `top holders control ${heldPct.toFixed(1)}% of supply (max ${this.filters.maxTop10HolderPct}%)`,
            );
          }
        }
      } catch {
        reasons.push('holder distribution check failed');
      }
    }

    return { ok: reasons.length === 0, reasons, decimals: parsed.decimals };
  }

  private async fetchMintInfo(mintPk: PublicKey): Promise<ParsedMintInfo | null> {
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const info = await this.rpc.connection.getParsedAccountInfo(
          mintPk,
          'processed',
        );
        const data = info.value?.data;

        if (data && 'parsed' in data) {
          return data.parsed.info as ParsedMintInfo;
        }

        // The account may not have propagated yet. Keep polling.
      } catch (error: unknown) {
        lastError = error;
      }

      if (attempt < 7) await sleep(750);
    }

    // Do not expose RPC implementation details to the strategy layer, but
    // distinguish an unavailable RPC response from a valid non-mint account.
    // A null result is conservatively rejected by the caller.
    void lastError;
    return null;
  }

  /** Cheap, purely-local filters. Runs before any RPC is spent on a candidate. */
  prefilter(candidate: TokenCandidate): string | null {
    const f = this.filters;
    const symbol = candidate.symbol.toLowerCase();
    const name = candidate.name.toLowerCase();

    if (f.symbolWhitelist.length > 0) {
      const hit = f.symbolWhitelist.some(
        (w) => symbol.includes(w.toLowerCase()) || name.includes(w.toLowerCase()),
      );
      if (!hit) return 'not on whitelist';
    }
    for (const banned of f.symbolBlacklist) {
      const b = banned.toLowerCase();
      if (symbol.includes(b) || name.includes(b)) return `blacklisted term "${banned}"`;
    }

    if (candidate.source === 'pumpfun') {
      const dev = candidate.devBuySol ?? 0;
      if (dev < f.minDevBuySol) return `dev buy ${dev.toFixed(3)} SOL below min ${f.minDevBuySol}`;
      if (dev > f.maxDevBuySol) return `dev buy ${dev.toFixed(3)} SOL above max ${f.maxDevBuySol}`;
    }

    if (candidate.source === 'raydium') {
      const liq = candidate.initialLiquiditySol ?? 0;
      if (liq < f.minInitialLiquiditySol) {
        return `initial liquidity ${liq.toFixed(2)} SOL below min ${f.minInitialLiquiditySol}`;
      }
    }

    return null;
  }
}

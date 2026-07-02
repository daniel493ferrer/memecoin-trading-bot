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
    const mintPk = new PublicKey(candidate.mint);

    // --- mint account: decimals + authority flags ---
    // Seconds-old mints often aren't visible at `confirmed` yet, so poll at
    // `processed` commitment for a few seconds before giving up.
    const parsed = await this.fetchMintInfo(mintPk);
    if (!parsed) {
      return { ok: false, reasons: ['mint account not found or not a token mint'], decimals: 0 };
    }

    if (this.filters.requireMintAuthorityRevoked && parsed.mintAuthority) {
      reasons.push('mint authority not revoked (supply can be inflated)');
    }
    if (this.filters.requireFreezeAuthorityRevoked && parsed.freezeAuthority) {
      reasons.push('freeze authority not revoked (transfers can be frozen)');
    }

    // --- holder concentration (AMM candidates only) ---
    // Pump.fun launches always fail this naively: the bonding curve holds
    // nearly the full supply. Their risk is filtered via dev-buy size instead.
    if (candidate.venue === 'amm' && this.filters.maxTop10HolderPct < 100) {
      try {
        const largest = await this.rpc.connection.getTokenLargestAccounts(mintPk);
        const supply = Number(parsed.supply);
        if (supply > 0 && largest.value.length > 1) {
          // Skip the single largest account — on a fresh pool that is the LP vault.
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
    for (let attempt = 0; attempt < 8; attempt++) {
      const info = await this.rpc.connection
        .getParsedAccountInfo(mintPk, 'processed')
        .catch(() => null);
      const data = info?.value?.data;
      if (data && 'parsed' in data) return data.parsed.info as ParsedMintInfo;
      await sleep(750);
    }
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

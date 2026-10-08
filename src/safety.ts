import { PublicKey } from '@solana/web3.js';
import type { BotConfig } from './config.js';
import type { Rpc } from './rpc.js';
import type { SafetyReport, TokenCandidate } from './types.js';
import { sleep } from './utils.js';
import { evmTokenSafety } from './evmsafety.js';

const PUMP_FUN_DECIMALS = 6;

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
    private readonly chains: BotConfig['scanner']['chains'] = [],
  ) {}

  async check(candidate: TokenCandidate): Promise<SafetyReport> {
    if (candidate.chain && candidate.chain !== 'solana') {
      return this.checkEvm(candidate);
    }

    // Tokens created through the pump.fun program always have their mint and
    // freeze authority revoked and use 6 decimals; the program enforces it.
    // Re-checking over RPC only adds seconds of entry latency and a point of
    // failure while the account is still propagating.
    if (candidate.source === 'pumpfun' && candidate.venue === 'pump') {
      return { ok: true, reasons: [], decimals: PUMP_FUN_DECIMALS };
    }

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

    const fetched = await this.fetchMintInfo(mintPk);
    if ('error' in fetched) {
      return {
        ok: false,
        reasons: [`mint account unavailable after RPC retries (${fetched.error})`],
        decimals: 0,
      };
    }
    const parsed = fetched.info;

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

  private async fetchMintInfo(
    mintPk: PublicKey,
  ): Promise<{ info: ParsedMintInfo } | { error: string }> {
    let lastError = 'account not found';

    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        const info = await this.rpc.connection.getParsedAccountInfo(
          mintPk,
          'processed',
        );
        const data = info.value?.data;

        if (data && 'parsed' in data) {
          return { info: data.parsed.info as ParsedMintInfo };
        }
        lastError = info.value ? 'account is not a parsed token mint' : 'account not found';
        // The account may not have propagated yet. Keep polling.
      } catch (error: unknown) {
        // Surface the RPC failure (bad API key, rate limit, network) so it
        // can be fixed instead of looking like a token problem.
        lastError = (error instanceof Error ? error.message : String(error)).slice(0, 160);
      }

      if (attempt < 7) await sleep(750);
    }

    return { error: lastError };
  }

  /**
   * EVM chains (paper only): honeypot and tax check through GoPlus when the
   * chain has a GoPlus id. Tokens GoPlus cannot assess are allowed in paper
   * mode so the chain can still be measured; the reason is logged.
   */
  private async checkEvm(candidate: TokenCandidate): Promise<SafetyReport> {
    const chain = this.chains.find((c) => c.name === candidate.chain);
    if (!chain?.goplusChainId) return { ok: true, reasons: [], decimals: PUMP_FUN_DECIMALS };
    const result = await evmTokenSafety(chain.goplusChainId, candidate.mint);
    return { ok: result.reasons.length === 0, reasons: result.reasons, decimals: PUMP_FUN_DECIMALS };
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

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
  /** Token-2022 extensions, when the mint uses that program. */
  extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
}

/** Highest Token-2022 transfer fee accepted, in basis points. */
const MAX_TRANSFER_FEE_BPS = 1_000;

/**
 * Token-2022 extensions that can stop or tax a sale. Exported for tests.
 */
export function dangerousExtensions(info: ParsedMintInfo): string[] {
  const reasons: string[] = [];
  for (const ext of info.extensions ?? []) {
    switch (ext.extension) {
      case 'transferHook': {
        const program = (ext.state as { programId?: string | null } | undefined)?.programId;
        if (program) reasons.push('transfer hook can block sells');
        break;
      }
      case 'permanentDelegate':
        if ((ext.state as { delegate?: string | null } | undefined)?.delegate) {
          reasons.push('permanent delegate can take tokens from holders');
        }
        break;
      case 'nonTransferable':
        reasons.push('token is non-transferable');
        break;
      case 'pausableConfig':
        reasons.push('transfers can be paused');
        break;
      case 'transferFeeConfig': {
        const state = ext.state as { newerTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
        const bps = Number(state?.newerTransferFee?.transferFeeBasisPoints ?? 0);
        if (bps > MAX_TRANSFER_FEE_BPS) reasons.push(`transfer fee ${(bps / 100).toFixed(1)}%`);
        break;
      }
      default:
        break;
    }
  }
  return reasons;
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

  /**
   * Sell simulation (anti-honeypot) for Solana AMM tokens: returns a reason
   * to reject, or null when a buy-then-sell round trip quotes fine. Set by
   * the orchestrator because it needs the swap engine.
   */
  sellSimulation: ((mint: string) => Promise<string | null>) | null = null;

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
    reasons.push(...dangerousExtensions(parsed));

    if (candidate.venue === 'amm' && this.filters.maxTop10HolderPct < 100) {
      try {
        const heldPct = await this.top10HolderPct(mintPk, Number(parsed.supply));
        if (heldPct > this.filters.maxTop10HolderPct) {
          reasons.push(
            `top holders control ${heldPct.toFixed(1)}% of supply (max ${this.filters.maxTop10HolderPct}%)`,
          );
        }
      } catch {
        reasons.push('holder distribution check failed');
      }
    }

    // Only spend the swap quotes when everything else passed.
    if (reasons.length === 0 && candidate.venue === 'amm' && this.sellSimulation) {
      const failure = await this.sellSimulation(candidate.mint);
      if (failure) reasons.push(`sell simulation failed: ${failure}`);
    }

    return { ok: reasons.length === 0, reasons, decimals: parsed.decimals };
  }

  /**
   * Share of supply in the 10 largest holders, not counting liquidity pools.
   * Pools and vaults are owned by program-derived addresses, which are off
   * the ed25519 curve; real holders are ordinary wallets, which are on it.
   */
  private async top10HolderPct(mintPk: PublicKey, supply: number): Promise<number> {
    if (supply <= 0) return 0;
    const largest = await this.rpc.connection.getTokenLargestAccounts(mintPk);
    const accounts = largest.value.slice(0, 20);
    const infos = await this.rpc.connection.getMultipleParsedAccounts(accounts.map((a) => a.address));
    let held = 0;
    let counted = 0;
    accounts.forEach((account, i) => {
      if (counted >= 10) return;
      const data = infos.value[i]?.data;
      const owner = data && 'parsed' in data ? (data.parsed.info?.owner as string | undefined) : undefined;
      if (owner && !PublicKey.isOnCurve(new PublicKey(owner).toBytes())) return; // pool / program vault
      held += Number(account.amount);
      counted++;
    });
    return (held / supply) * 100;
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

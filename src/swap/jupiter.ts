import { VersionedTransaction } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import type { Rpc } from '../rpc.js';
import type { ManagedWallet } from '../wallets.js';
import { WSOL_MINT, fetchJson, solToLamports } from '../utils.js';

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  [key: string]: unknown;
}

interface SwapResponse {
  swapTransaction: string;
}

/**
 * Execution engine for tokens trading on AMMs (Raydium, PumpSwap, Meteora, …)
 * via the Jupiter aggregator. Uses the free lite-api tier — no key required.
 */
export class JupiterEngine {
  constructor(
    private readonly rpc: Rpc,
    private readonly baseUrl: string,
  ) {}

  async quote(
    inputMint: string,
    outputMint: string,
    amountRaw: bigint,
    slippageBps: number,
  ): Promise<QuoteResponse> {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amountRaw.toString(),
      slippageBps: slippageBps.toString(),
    });
    return fetchJson<QuoteResponse>(`${this.baseUrl}/swap/v1/quote?${params}`);
  }

  /**
   * Current liquidation value of a token holding, in SOL. Returns null when
   * no route exists (token not yet indexed, or liquidity pulled).
   */
  async sellValueSol(mint: string, amountRaw: bigint, slippageBps: number): Promise<number | null> {
    if (amountRaw <= 0n) return 0;
    try {
      const q = await this.quote(mint, WSOL_MINT, amountRaw, slippageBps);
      this.lastQuoteError = null;
      return Number(q.outAmount) / 1e9;
    } catch (err) {
      this.lastQuoteError = (err as Error).message.slice(0, 160);
      return null;
    }
  }

  /**
   * Sell simulation: quote buying `testLamports` of `mint` and selling the
   * result straight back. Returns why it fails, or null when the round trip
   * loses at most `maxLossPct` (fees and price impact only).
   */
  async sellSimulation(mint: string, testLamports: bigint, maxLossPct: number, slippageBps: number): Promise<string | null> {
    let bought: bigint;
    try {
      bought = BigInt((await this.quote(WSOL_MINT, mint, testLamports, slippageBps)).outAmount);
    } catch (err) {
      return `no buy route (${(err as Error).message.slice(0, 80)})`;
    }
    if (bought <= 0n) return 'buy quote returned no tokens';
    let back: bigint;
    try {
      back = BigInt((await this.quote(mint, WSOL_MINT, bought, slippageBps)).outAmount);
    } catch (err) {
      return `no sell route (${(err as Error).message.slice(0, 80)})`;
    }
    const lossPct = (1 - Number(back) / Number(testLamports)) * 100;
    return lossPct > maxLossPct ? `buy+sell round trip loses ${lossPct.toFixed(0)}%` : null;
  }

  /** Why the most recent sellValueSol returned null, for diagnostics. */
  lastQuoteError: string | null = null;

  /** Swap SOL -> token. Returns the confirmed signature. */
  async buy(
    wallet: ManagedWallet,
    mint: string,
    amountSol: number,
    entry: BotConfig['entry'],
  ): Promise<string> {
    const quote = await this.quote(
      WSOL_MINT,
      mint,
      BigInt(solToLamports(amountSol)),
      entry.slippageBps,
    );
    return this.executeSwap(wallet, quote, entry);
  }

  /** Swap token -> SOL. Returns the confirmed signature. */
  async sell(
    wallet: ManagedWallet,
    mint: string,
    amountRaw: bigint,
    entry: BotConfig['entry'],
  ): Promise<string> {
    const quote = await this.quote(mint, WSOL_MINT, amountRaw, entry.slippageBps);
    return this.executeSwap(wallet, quote, entry);
  }

  private async executeSwap(
    wallet: ManagedWallet,
    quote: QuoteResponse,
    entry: BotConfig['entry'],
  ): Promise<string> {
    const swap = await fetchJson<SwapResponse>(`${this.baseUrl}/swap/v1/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: wallet.pubkey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: {
          priorityLevelWithMaxLamports: {
            maxLamports: Math.max(solToLamports(entry.priorityFeeSol), 10_000),
            priorityLevel: 'veryHigh',
          },
        },
      }),
    });

    const tx = VersionedTransaction.deserialize(Buffer.from(swap.swapTransaction, 'base64'));
    tx.sign([wallet.keypair]);
    return this.rpc.sendAndConfirm(tx);
  }
}

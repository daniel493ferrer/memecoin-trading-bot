import { VersionedTransaction } from '@solana/web3.js';
import type { BotConfig } from '../config.js';
import type { Rpc } from '../rpc.js';
import type { ManagedWallet } from '../wallets.js';

/**
 * Execution engine for pump.fun bonding-curve tokens via the PumpPortal
 * local-trade API. The API builds an unsigned transaction; we sign locally
 * (keys never leave the machine) and broadcast through Helius ourselves.
 *
 * `pool: "auto"` lets PumpPortal route to the right venue (bonding curve,
 * PumpSwap, Raydium) even if the token migrated between discovery and fill.
 */
export class PumpPortalEngine {
  constructor(
    private readonly rpc: Rpc,
    private readonly endpoint: string,
  ) {}

  /** Buy `amountSol` worth of `mint`. Returns the confirmed signature. */
  async buy(
    wallet: ManagedWallet,
    mint: string,
    amountSol: number,
    entry: BotConfig['entry'],
  ): Promise<string> {
    const tx = await this.buildTx(wallet, {
      action: 'buy',
      mint,
      amount: amountSol,
      denominatedInSol: 'true',
      slippage: entry.slippageBps / 100,
      priorityFee: entry.priorityFeeSol,
      pool: 'auto',
    });
    return this.rpc.sendAndConfirm(tx);
  }

  /**
   * Sell tokens. `amount` is a UI token amount, or the string "100%" to sweep
   * the full balance (avoids dust from rounding).
   */
  async sell(
    wallet: ManagedWallet,
    mint: string,
    amount: number | '100%',
    entry: BotConfig['entry'],
  ): Promise<string> {
    const tx = await this.buildTx(wallet, {
      action: 'sell',
      mint,
      amount,
      denominatedInSol: 'false',
      slippage: entry.slippageBps / 100,
      priorityFee: entry.priorityFeeSol,
      pool: 'auto',
    });
    return this.rpc.sendAndConfirm(tx);
  }

  private async buildTx(
    wallet: ManagedWallet,
    body: Record<string, unknown>,
  ): Promise<VersionedTransaction> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: wallet.pubkey.toBase58(), ...body }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PumpPortal trade-local ${res.status}: ${text.slice(0, 300)}`);
    }
    const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
    tx.sign([wallet.keypair]);
    return tx;
  }
}

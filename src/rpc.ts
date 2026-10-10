import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { log } from './logger.js';
import { short, sleep, MAX_TX_VERSION } from './utils.js';

/** Helius RPC wrapper: connection factory + reliable transaction landing. */
export class Rpc {
  readonly connection: Connection;
  private readonly httpUrl: string;
  private readonly httpFetch: typeof fetch;

  constructor(heliusApiKey: string, maxRequestsPerSecond = 8) {
    const httpUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    // Space HTTP requests evenly so the plan's rate limit (free: 10/s) is
    // never hit; bursts would otherwise come back as 429 retries.
    const spacingMs = 1_000 / maxRequestsPerSecond;
    let nextSlot = 0;
    const throttledFetch: typeof fetch = async (input, init) => {
      const now = Date.now();
      const wait = Math.max(0, nextSlot - now);
      nextSlot = Math.max(now, nextSlot) + spacingMs;
      if (wait > 0) await sleep(wait);
      return fetch(input, init);
    };
    this.httpUrl = httpUrl;
    this.httpFetch = throttledFetch;
    this.connection = new Connection(httpUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
      fetch: throttledFetch as never,
    });
  }

  /**
   * Send a signed transaction and poll for confirmation, re-broadcasting every
   * ~2s until it lands or the timeout expires.
   */
  async sendAndConfirm(tx: VersionedTransaction, timeoutMs = 45_000): Promise<string> {
    const raw = Buffer.from(tx.serialize());
    const signature = bs58.encode(tx.signatures[0]);
    const start = Date.now();
    let lastSend = 0;

    while (Date.now() - start < timeoutMs) {
      if (Date.now() - lastSend >= 2_000) {
        lastSend = Date.now();
        try {
          await this.connection.sendRawTransaction(raw, {
            skipPreflight: true,
            maxRetries: 0,
          });
        } catch (err) {
          const msg = (err as Error).message ?? '';
          if (!msg.includes('already been processed')) {
            log.warn(`broadcast error for ${short(signature)}: ${msg.slice(0, 160)}`);
          }
        }
      }

      let status;
      try {
        status = (
          await this.connection.getSignatureStatuses([signature], {
            searchTransactionHistory: true,
          })
        ).value[0];
      } catch (err) {
        log.warn(
          `confirmation poll error for ${short(signature)}: ${(err as Error).message.slice(0, 160)}`,
        );
        await sleep(700);
        continue;
      }

      if (status?.err) {
        throw new Error(
          `transaction ${short(signature)} failed on-chain: ${JSON.stringify(status.err)}`,
        );
      }
      if (
        status?.confirmationStatus === 'confirmed' ||
        status?.confirmationStatus === 'finalized'
      ) {
        return signature;
      }
      await sleep(700);
    }

    throw new Error(
      `transaction ${short(signature)} not confirmed within ${timeoutMs / 1000}s`,
    );
  }

  /**
   * Net SOL cash-flow delta for the owner in a confirmed transaction.
   * Negative = SOL left the wallet; positive = SOL entered the wallet.
   * This includes the transaction fee because it is derived from pre/post
   * lamport balances.
   */
  async getSolBalanceDelta(signature: string, owner: PublicKey): Promise<number | null> {
    for (let attempt = 0; attempt < 15; attempt++) {
      const tx = await this.connection
        .getParsedTransaction(signature, {
          maxSupportedTransactionVersion: MAX_TX_VERSION,
          commitment: 'confirmed',
        })
        .catch(() => null);

      if (tx?.meta) {
        const index = tx.transaction.message.accountKeys.findIndex(
          (account) => account.pubkey.equals(owner),
        );
        if (index >= 0) {
          return (tx.meta.postBalances[index] - tx.meta.preBalances[index]) / 1e9;
        }
      }

      await sleep(500);
    }

    return null;
  }

  /** Sum of all token accounts the owner holds for a mint, in raw units. */
  async getTokenBalanceRaw(owner: PublicKey, mint: string): Promise<bigint> {
    let accounts;
    try {
      accounts = await this.connection.getParsedTokenAccountsByOwner(owner, {
        mint: new PublicKey(mint),
      });
    } catch (err) {
      if ((err as Error).message?.includes('could not find mint')) return 0n;
      throw err;
    }

    let total = 0n;
    for (const { account } of accounts.value) {
      total += BigInt(account.data.parsed.info.tokenAmount.amount as string);
    }
    return total;
  }

  /**
   * Number of wallets holding `mint` (Helius DAS getTokenAccounts, one page
   * of up to 1000). Returns 1000 for "1000 or more", or null if unavailable.
   */
  async countHolders(mint: string): Promise<number | null> {
    try {
      const res = await this.httpFetch(this.httpUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 'holders', method: 'getTokenAccounts',
          params: { mint, limit: 1000, options: { showZeroBalance: false } },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json() as { result?: { total?: number; token_accounts?: unknown[] } };
      return body.result?.total ?? body.result?.token_accounts?.length ?? null;
    } catch {
      return null;
    }
  }

  async getSolBalance(owner: PublicKey): Promise<number> {
    return (await this.connection.getBalance(owner)) / 1e9;
  }
}

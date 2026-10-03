import {
  Connection,
  PublicKey,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { log } from './logger.js';
import { short, sleep } from './utils.js';

/** Helius RPC wrapper: connection factory + reliable transaction landing. */
export class Rpc {
  readonly connection: Connection;

  constructor(heliusApiKey: string) {
    const httpUrl = `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    const wsUrl = `wss://mainnet.helius-rpc.com/?api-key=${heliusApiKey}`;
    this.connection = new Connection(httpUrl, {
      commitment: 'confirmed',
      wsEndpoint: wsUrl,
    });
  }

  /**
   * Send a signed transaction and poll for confirmation, re-broadcasting every
   * ~2s until it lands or the timeout expires. Re-broadcasting the same signed
   * tx is safe (identical signature) and dramatically improves land rates
   * during congestion.
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
          // "already processed" means an earlier broadcast landed — keep polling.
          if (!msg.includes('already been processed')) {
            log.warn(`broadcast error for ${short(signature)}: ${msg.slice(0, 160)}`);
          }
        }
      }

      let status;
      try {
        status = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      } catch (err) {
        log.warn(`confirmation poll error for ${short(signature)}: ${(err as Error).message.slice(0, 160)}`);
        await sleep(700);
        continue;
      }
      if (status?.err) {
        throw new Error(`transaction ${short(signature)} failed on-chain: ${JSON.stringify(status.err)}`);
      }
      if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
        return signature;
      }
      await sleep(700);
    }

    throw new Error(`transaction ${short(signature)} not confirmed within ${timeoutMs / 1000}s`);
  }

  /** Net SOL balance delta for the owner in a confirmed transaction. */
  async getSolBalanceDelta(signature: string, owner: PublicKey): Promise<number | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }).catch(() => null);

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

  /** Net SOL balance delta for the owner in a confirmed transaction. */
  async getSolBalanceDelta(signature: string, owner: PublicKey): Promise<number | null> {
    for (let attempt = 0; attempt < 6; attempt++) {
      const tx = await this.connection.getParsedTransaction(signature, {
        maxSupportedTransactionVersion: 0,
        commitment: 'confirmed',
      }).catch(() => null);

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
      // Mints only seconds old can be unknown to the RPC at this commitment —
      // the owner cannot hold a token that does not exist yet.
      if ((err as Error).message?.includes('could not find mint')) return 0n;
      throw err;
    }
    let total = 0n;
    for (const { account } of accounts.value) {
      total += BigInt(account.data.parsed.info.tokenAmount.amount as string);
    }
    return total;
  }

  async getSolBalance(owner: PublicKey): Promise<number> {
    return (await this.connection.getBalance(owner)) / 1e9;
  }
}

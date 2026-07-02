import { EventEmitter } from 'node:events';
import { PublicKey } from '@solana/web3.js';
import type { Rpc } from '../rpc.js';
import { log } from '../logger.js';
import { WSOL_MINT, lamportsToSol, short, withRetry } from '../utils.js';
import type { TokenCandidate } from '../types.js';

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');

// Account indices inside the AMM v4 `initialize2` instruction.
const IDX_COIN_MINT = 8;
const IDX_PC_MINT = 9;

/**
 * Detects brand-new Raydium AMM v4 pools by streaming program logs from the
 * Helius websocket and parsing the `initialize2` log line, which conveniently
 * includes the initial deposit amounts.
 *
 * Emits: 'newPool' (candidate: TokenCandidate)
 */
export class RaydiumListener extends EventEmitter {
  private subscriptionId: number | null = null;

  constructor(private readonly rpc: Rpc) {
    super();
  }

  start(): void {
    this.subscriptionId = this.rpc.connection.onLogs(
      RAYDIUM_AMM_V4,
      (entry) => {
        if (entry.err) return;
        const initLog = entry.logs.find((l) => l.includes('init_pc_amount'));
        if (!initLog) return;
        this.handleNewPool(entry.signature, initLog).catch((err) =>
          log.warn(`raydium pool parse failed for ${short(entry.signature)}: ${(err as Error).message}`),
        );
      },
      'confirmed',
    );
    log.ok('raydium pool listener started');
  }

  async stop(): Promise<void> {
    if (this.subscriptionId !== null) {
      await this.rpc.connection.removeOnLogsListener(this.subscriptionId).catch(() => {});
      this.subscriptionId = null;
    }
  }

  private async handleNewPool(signature: string, initLog: string): Promise<void> {
    const pcAmount = BigInt(/init_pc_amount:\s*(\d+)/.exec(initLog)?.[1] ?? '0');
    const coinAmount = BigInt(/init_coin_amount:\s*(\d+)/.exec(initLog)?.[1] ?? '0');

    const tx = await withRetry(
      () =>
        this.rpc.connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 0,
          commitment: 'confirmed',
        }),
      4,
      1_500,
    );
    if (!tx) throw new Error('transaction not found');

    // Find the initialize2 instruction and read the coin/pc mints from its accounts.
    const ix = tx.transaction.message.instructions.find(
      (i) => i.programId.equals(RAYDIUM_AMM_V4) && 'accounts' in i && i.accounts.length > IDX_PC_MINT,
    );
    if (!ix || !('accounts' in ix)) throw new Error('initialize2 instruction not found');

    const coinMint = ix.accounts[IDX_COIN_MINT].toBase58();
    const pcMint = ix.accounts[IDX_PC_MINT].toBase58();

    // One side must be wrapped SOL; the other is the token we care about.
    let tokenMint: string;
    let solLiquidity: number;
    if (pcMint === WSOL_MINT) {
      tokenMint = coinMint;
      solLiquidity = lamportsToSol(pcAmount);
    } else if (coinMint === WSOL_MINT) {
      tokenMint = pcMint;
      solLiquidity = lamportsToSol(coinAmount);
    } else {
      return; // non-SOL pair (USDC pools etc.) — out of scope
    }

    const candidate: TokenCandidate = {
      mint: tokenMint,
      symbol: short(tokenMint),
      name: 'raydium pool',
      source: 'raydium',
      venue: 'amm',
      initialLiquiditySol: solLiquidity,
      discoveredAt: Date.now(),
    };
    this.emit('newPool', candidate);
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

/** Virtual reserves of a pump.fun bonding curve (SOL and UI token units). */
export interface CurveState {
  vSol: number;
  vTokens: number;
  updatedAt: number;
}

/**
 * Tokens received for spending `solIn` on a constant-product bonding curve.
 * `feePct` is charged on the SOL side before the swap, like pump.fun.
 */
export function curveBuyTokens(curve: CurveState, solIn: number, feePct: number): number {
  const net = solIn * (1 - feePct / 100);
  if (net <= 0) return 0;
  const k = curve.vSol * curve.vTokens;
  return curve.vTokens - k / (curve.vSol + net);
}

/** SOL received for selling `tokensIn` on a constant-product bonding curve, net of fees. */
export function curveSellSol(curve: CurveState, tokensIn: number, feePct: number): number {
  if (tokensIn <= 0) return 0;
  const k = curve.vSol * curve.vTokens;
  const gross = curve.vSol - k / (curve.vTokens + tokensIn);
  return gross * (1 - feePct / 100);
}

/**
 * Virtual SOL balance for dry-run mode. Persisted so paper results accumulate
 * across restarts like a real wallet would.
 */
export class PaperAccount {
  private balance: number;
  private readonly file: string;

  constructor(startingBalanceSol: number, file = 'paper-state.json') {
    this.file = path.resolve(file);
    this.balance = startingBalanceSol;
    if (fs.existsSync(this.file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { balanceSol?: unknown };
        if (typeof raw.balanceSol === 'number' && Number.isFinite(raw.balanceSol)) {
          this.balance = raw.balanceSol;
        }
      } catch (err) {
        log.warn(`could not read ${path.basename(this.file)}: ${(err as Error).message}`);
      }
    }
  }

  get balanceSol(): number {
    return this.balance;
  }

  debit(sol: number): void {
    this.balance -= sol;
    this.save();
  }

  credit(sol: number): void {
    this.balance += sol;
    this.save();
  }

  private save(): void {
    fs.writeFileSync(this.file, JSON.stringify({ balanceSol: this.balance }, null, 2));
  }
}

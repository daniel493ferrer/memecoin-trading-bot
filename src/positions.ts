import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Position } from './types.js';
import { log } from './logger.js';

const PositionSchema = z.object({
  id: z.string().min(1),
  mint: z.string().min(1),
  symbol: z.string(),
  source: z.enum(['pumpfun', 'pumpfun-migration', 'raydium', 'scanner']),
  venue: z.enum(['pump', 'amm']),
  wallet: z.string().min(1),
  creator: z.string().optional(),
  tokenDecimals: z.number().int().min(0),
  tokensRawInitial: z.string().regex(/^\d+$/),
  tokensRawRemaining: z.string().regex(/^\d+$/),
  solSpent: z.number().positive(),
  solReceived: z.number().nonnegative(),
  entryPrice: z.number().positive(),
  peakPrice: z.number().positive(),
  takeProfitsFilled: z.array(z.number().int().nonnegative()),
  trailingActive: z.boolean(),
  openedAt: z.number().int().positive(),
  closedAt: z.number().int().positive().optional(),
  status: z.enum(['open', 'closed']),
  exitReason: z.enum([
    'take-profit', 'stop-loss', 'trailing-stop', 'max-hold',
    'dev-sell', 'migration', 'rugged', 'shutdown',
  ]).optional(),
  buySignature: z.string().min(1),
});

/**
 * Crash-safe position store. Open positions persist to positions.json so a
 * restart picks them back up and keeps managing their exits.
 */
export class PositionStore {
  private positions = new Map<string, Position>();
  private readonly file: string;

  constructor(file = 'positions.json') {
    this.file = path.resolve(file);
  }

  load(): void {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as unknown;
      const parsed = z.array(PositionSchema).parse(raw) as Position[];
      for (const p of parsed) {
        if (p.status === 'open') this.positions.set(p.id, p);
      }
      if (this.positions.size > 0) {
        log.info(`restored ${this.positions.size} open position(s) from ${path.basename(this.file)}`);
      }
    } catch (err) {
      throw new Error(`could not safely restore ${path.basename(this.file)}: ${(err as Error).message}`);
    }
  }

  save(): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.positions.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }

  add(position: Position): void {
    this.positions.set(position.id, position);
    this.save();
  }

  update(position: Position): void {
    this.positions.set(position.id, position);
    this.save();
  }

  close(position: Position): void {
    position.status = 'closed';
    position.closedAt = Date.now();
    this.positions.delete(position.id);
    this.save();
  }

  get open(): Position[] {
    return [...this.positions.values()];
  }

  get openCount(): number {
    return this.positions.size;
  }

  hasMint(mint: string): boolean {
    return this.open.some((p) => p.mint === mint);
  }
}

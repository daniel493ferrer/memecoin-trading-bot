import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger.js';

export interface LeaderRecord {
  address: string;
  /** Winning tokens this wallet bought early (cheap) in. */
  hits: string[];
  firstSeen: number;
  promotedAt?: number;
  /** Results of positions copied from this wallet. */
  copiedTrades: number;
  copiedWins: number;
  copiedPnlSol: number;
  copiedSpentSol: number;
  disabled?: string;
}

/**
 * Persistent book of discovered wallets: promotes a wallet to "leader" once
 * it bought early in enough different winners, and disables leaders whose
 * copied trades lose money. Stored in data/leaders.json.
 */
export class LeaderBook {
  private records = new Map<string, LeaderRecord>();
  private readonly file: string;

  constructor(
    private readonly cfg: { minHits: number; maxLeaders: number; pruneAfterTrades: number },
    file = 'data/leaders.json',
  ) {
    this.file = path.resolve(file);
    if (fs.existsSync(this.file)) {
      try {
        for (const r of JSON.parse(fs.readFileSync(this.file, 'utf8')) as LeaderRecord[]) {
          this.records.set(r.address, r);
        }
      } catch (err) {
        log.warn(`could not read ${path.basename(this.file)}: ${(err as Error).message}`);
      }
    }
  }

  /** Active (promoted, not disabled) leaders, best copied return first. */
  get active(): LeaderRecord[] {
    return [...this.records.values()]
      .filter((r) => r.promotedAt && !r.disabled)
      .sort((a, b) => b.copiedPnlSol - a.copiedPnlSol || b.hits.length - a.hits.length);
  }

  /** True when copying this wallet was found to lose money. */
  isDisabled(address: string): boolean {
    return Boolean(this.records.get(address)?.disabled);
  }

  get(address: string): LeaderRecord | undefined {
    return this.records.get(address);
  }

  /**
   * Note that `address` bought early in winning token `mint`. Returns true
   * when this promotes the wallet to an active leader.
   */
  recordHit(address: string, mint: string): boolean {
    const r = this.records.get(address) ?? {
      address, hits: [], firstSeen: Date.now(),
      copiedTrades: 0, copiedWins: 0, copiedPnlSol: 0, copiedSpentSol: 0,
    };
    if (!r.hits.includes(mint)) r.hits.push(mint);
    this.records.set(address, r);
    let promoted = false;
    if (!r.promotedAt && !r.disabled && r.hits.length >= this.cfg.minHits &&
        this.active.length < this.cfg.maxLeaders) {
      r.promotedAt = Date.now();
      promoted = true;
    }
    this.save();
    return promoted;
  }

  /**
   * Book the result of a copied position. Returns true when the leader is
   * disabled because copying it loses money.
   */
  recordResult(address: string, pnlSol: number, spentSol: number): boolean {
    // Manually configured leaders get a record on their first copied trade.
    const r = this.records.get(address) ?? {
      address, hits: [], firstSeen: Date.now(),
      copiedTrades: 0, copiedWins: 0, copiedPnlSol: 0, copiedSpentSol: 0,
    };
    this.records.set(address, r);
    r.copiedTrades++;
    if (pnlSol > 0) r.copiedWins++;
    r.copiedPnlSol += pnlSol;
    r.copiedSpentSol += spentSol;
    let disabled = false;
    if (!r.disabled && r.copiedTrades >= this.cfg.pruneAfterTrades && r.copiedPnlSol < 0) {
      r.disabled = `copied ${r.copiedTrades} trades, net ${r.copiedPnlSol.toFixed(4)} SOL`;
      disabled = true;
    }
    this.save();
    return disabled;
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify([...this.records.values()], null, 2));
    fs.renameSync(tmp, this.file);
  }
}

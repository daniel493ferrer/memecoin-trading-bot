/**
 * Summarizes what the bot recorded: candidate decisions, what happened to
 * bought vs. rejected tokens afterwards, and realized paper/live PnL.
 *
 *   npm run report
 */
import fs from 'node:fs';

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const rows: T[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Skip partial lines from an interrupted write.
    }
  }
  return rows;
}

const median = (values: number[]): number => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '—');
const num = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');

/** Collapse "8 trades below min 5" and "9 trades below min 5" into one bucket. */
const bucket = (reason: string) => reason.split(';')[0].replace(/[-+]?\d+(\.\d+)?/g, 'N').trim();

interface CandidateRow { decision: 'buy' | 'reject'; decisionReason: string }
interface OutcomeRow {
  decision?: 'buy' | 'reject';
  reason?: string;
  maxGainPct: number;
  maxDrawdownPct: number;
  finalChangePct: number;
}
interface CloseRow { type: string; reason: string; pnlSol: number; pnlPct?: number; solSpent: number }

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

const candidates = readJsonl<CandidateRow>('data/candidates.jsonl');
section(`Candidates (${candidates.length})`);
if (candidates.length > 0) {
  const buys = candidates.filter((c) => c.decision === 'buy').length;
  console.log(`buy decisions: ${buys} (${pct(buys, candidates.length)})`);
  const reasons = new Map<string, number>();
  for (const c of candidates) {
    if (c.decision !== 'reject') continue;
    const key = bucket(c.decisionReason);
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  console.log('top reject reasons:');
  for (const [reason, count] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }
}

const outcomes = readJsonl<OutcomeRow>('data/outcomes.jsonl');
section(`Outcomes after decision (${outcomes.length})`);
for (const decision of ['buy', 'reject'] as const) {
  const rows = outcomes.filter((o) => o.decision === decision);
  if (rows.length === 0) continue;
  const gains = rows.map((o) => o.maxGainPct);
  console.log(
    `${decision.padEnd(6)} n=${rows.length}  ` +
    `median max gain ${num(median(gains))}%  ` +
    `hit +50% ${pct(gains.filter((g) => g >= 50).length, rows.length)}  ` +
    `hit +100% ${pct(gains.filter((g) => g >= 100).length, rows.length)}  ` +
    `median final ${num(median(rows.map((o) => o.finalChangePct)))}%  ` +
    `median drawdown ${num(median(rows.map((o) => o.maxDrawdownPct)))}%`,
  );
}

// Grouped by why the bot passed: "safety rejected" and "max open positions"
// rows are candidates the strategy wanted, so they show what buys would do.
const byReason = new Map<string, number[]>();
for (const o of outcomes) {
  if (!o.reason) continue;
  const key = `${o.decision}: ${bucket(o.reason)}`;
  byReason.set(key, [...(byReason.get(key) ?? []), o.maxGainPct]);
}
if (byReason.size > 0) {
  console.log('by reason (n, median max gain, hit +100%):');
  for (const [reason, gains] of [...byReason].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
    console.log(
      `  ${String(gains.length).padStart(5)}  ${num(median(gains)).padStart(7)}%  ` +
      `${pct(gains.filter((g) => g >= 100).length, gains.length).padStart(6)}  ${reason}`,
    );
  }
}

for (const [label, file] of [['Paper trades', 'logs/paper-trades.jsonl'], ['Live trades', 'logs/trades.jsonl']]) {
  const closes = readJsonl<CloseRow>(file).filter((r) => r.type === 'close');
  if (closes.length === 0) continue;
  section(`${label} (${closes.length} closed)`);
  const wins = closes.filter((c) => c.pnlSol > 0).length;
  const total = closes.reduce((sum, c) => sum + c.pnlSol, 0);
  const spent = closes.reduce((sum, c) => sum + c.solSpent, 0);
  console.log(`win rate ${pct(wins, closes.length)}  total PnL ${num(total, 4)} SOL  return on capital deployed ${pct(total, spent)}`);
  const pnlPcts = closes.map((c) => c.pnlPct ?? (c.pnlSol / c.solSpent) * 100);
  console.log(`median trade ${num(median(pnlPcts))}%  best ${num(Math.max(...pnlPcts))}%  worst ${num(Math.min(...pnlPcts))}%`);
  const byReason = new Map<string, CloseRow[]>();
  for (const c of closes) byReason.set(c.reason, [...(byReason.get(c.reason) ?? []), c]);
  for (const [reason, rows] of byReason) {
    const sum = rows.reduce((s, r) => s + r.pnlSol, 0);
    console.log(`  ${reason.padEnd(14)} n=${String(rows.length).padStart(4)}  PnL ${num(sum, 4)} SOL`);
  }
}

if (fs.existsSync('paper-state.json')) {
  const state = JSON.parse(fs.readFileSync('paper-state.json', 'utf8')) as { balanceSol: number };
  section('Paper account');
  console.log(`balance ${num(state.balanceSol, 4)} SOL`);
}

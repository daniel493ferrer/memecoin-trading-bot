import fs from 'node:fs';
import path from 'node:path';

export interface DaySummary {
  date: string;
  trades: number;
  wins: number;
  winRatePct: number;
  avgWinPct: number;
  avgLossPct: number;
  pnlSol: number;
}

/** Minimal CSV line parser (handles quoted cells). */
function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { cells.push(cell); cell = ''; }
    else cell += ch;
  }
  cells.push(cell);
  return cells;
}

/** Summary of positions closed on `date` (UTC, YYYY-MM-DD) from a trades CSV. */
export function summarizeDay(file: string, date: string): DaySummary {
  const empty = { date, trades: 0, wins: 0, winRatePct: 0, avgWinPct: 0, avgLossPct: 0, pnlSol: 0 };
  if (!fs.existsSync(file)) return empty;
  const [header, ...lines] = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  if (!header) return empty;
  const cols = parseCsvLine(header);
  const exitTime = cols.indexOf('exit_time');
  const pnlSol = cols.indexOf('pnl_sol');
  const pnlPct = cols.indexOf('pnl_pct');
  const rows = lines.map(parseCsvLine).filter((r) => r[exitTime]?.startsWith(date));
  const pcts = rows.map((r) => Number(r[pnlPct]));
  const wins = pcts.filter((p) => p > 0);
  const losses = pcts.filter((p) => p <= 0);
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return {
    date,
    trades: rows.length,
    wins: wins.length,
    winRatePct: rows.length ? (wins.length / rows.length) * 100 : 0,
    avgWinPct: avg(wins),
    avgLossPct: avg(losses),
    pnlSol: rows.reduce((s, r) => s + Number(r[pnlSol]), 0),
  };
}

export function formatSummary(s: DaySummary): string {
  return `${s.date}: ${s.trades} trades, win rate ${s.winRatePct.toFixed(1)}%, ` +
    `avg win ${s.avgWinPct >= 0 ? '+' : ''}${s.avgWinPct.toFixed(1)}%, avg loss ${s.avgLossPct.toFixed(1)}%, ` +
    `PnL ${s.pnlSol >= 0 ? '+' : ''}${s.pnlSol.toFixed(4)} SOL`;
}

/** Append a day's summary to data/daily-summary.csv. */
export function appendDailySummary(s: DaySummary, file = path.resolve('data', 'daily-summary.csv')): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, 'date,trades,win_rate_pct,avg_win_pct,avg_loss_pct,pnl_sol\n');
  fs.appendFileSync(file, [s.date, s.trades, s.winRatePct.toFixed(1), s.avgWinPct.toFixed(2),
    s.avgLossPct.toFixed(2), s.pnlSol.toFixed(6)].join(',') + '\n');
}

/**
 * Capital at the start of the UTC day, persisted so a restart keeps the same
 * baseline for the daily loss limit.
 */
export function dayStartCapital(currentCapital: number, file = path.resolve('data', 'risk-day.json')): number {
  const today = new Date().toISOString().slice(0, 10);
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { date?: string; capital?: number };
    if (saved.date === today && typeof saved.capital === 'number' && saved.capital > 0) return saved.capital;
  } catch {
    // First run of the day.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ date: today, capital: currentCapital }));
  return currentCapital;
}

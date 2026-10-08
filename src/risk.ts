import fs from 'node:fs';
import path from 'node:path';

/**
 * Realized PnL (SOL) of positions closed today (UTC), read from the trade log
 * the trader appends to. Stateless so restarts cannot reset the daily limit.
 */
export function realizedPnlToday(mode: 'paper' | 'live'): number {
  const file = path.resolve('logs', mode === 'paper' ? 'paper-trades.jsonl' : 'trades.jsonl');
  if (!fs.existsSync(file)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  let pnl = 0;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.includes('"close"') || !line.includes(today)) continue;
    try {
      const row = JSON.parse(line) as { ts?: string; type?: string; pnlSol?: number };
      if (row.type === 'close' && row.ts?.startsWith(today) && typeof row.pnlSol === 'number') {
        pnl += row.pnlSol;
      }
    } catch {
      // Skip a partial line from an interrupted write.
    }
  }
  return pnl;
}

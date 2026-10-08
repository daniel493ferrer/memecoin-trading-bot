/**
 * Starts a fresh paper account: archives paper trades (so the daily loss
 * limit starts from zero) and removes the virtual balance and positions.
 *
 *   npm run reset-paper
 */
import fs from 'node:fs';

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (fs.existsSync('logs/paper-trades.jsonl')) {
  fs.renameSync('logs/paper-trades.jsonl', `logs/paper-trades-${stamp}.jsonl`);
  console.log(`archived old paper trades to logs/paper-trades-${stamp}.jsonl`);
}
for (const file of ['paper-state.json', 'paper-positions.json']) {
  if (fs.existsSync(file)) fs.rmSync(file);
}
console.log('paper account reset — next start begins with the configured startingBalanceSol');

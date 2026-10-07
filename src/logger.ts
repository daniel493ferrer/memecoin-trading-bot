import fs from 'node:fs';
import path from 'node:path';

const COLORS = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
} as const;

const LOG_DIR = 'logs';

function ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function line(color: string, tag: string, msg: string) {
  console.log(`${COLORS.dim}${ts()}${COLORS.reset} ${color}${tag}${COLORS.reset} ${msg}`);
}

export const log = {
  info: (msg: string) => line(COLORS.cyan, 'INFO ', msg),
  ok: (msg: string) => line(COLORS.green, 'OK   ', msg),
  warn: (msg: string) => line(COLORS.yellow, 'WARN ', msg),
  error: (msg: string) => line(COLORS.red, 'ERROR', msg),
  trade: (msg: string) => line(COLORS.magenta, 'TRADE', msg),
};

/**
 * Append a structured trade record for later analysis. Paper fills go to
 * logs/paper-trades.jsonl so they never mix with real trades.
 */
export function recordTrade(record: Record<string, unknown>): void {
  try {
    const dir = path.resolve(LOG_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, record.mode === 'paper' ? 'paper-trades.jsonl' : 'trades.jsonl');
    fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (err) {
    log.warn(`failed to write trade log: ${(err as Error).message}`);
  }
}

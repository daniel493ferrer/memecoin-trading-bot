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

const LOG_DIR = path.resolve('logs');
const TRADE_LOG = path.join(LOG_DIR, 'trades.jsonl');

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

/** Append a structured trade record to logs/trades.jsonl for later analysis. */
export function recordTrade(record: Record<string, unknown>): void {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(TRADE_LOG, JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n');
  } catch (err) {
    log.warn(`failed to write trade log: ${(err as Error).message}`);
  }
}

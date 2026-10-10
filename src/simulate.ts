/**
 * Accelerated market simulation: invents memecoins with typical life
 * stories (runners, pump-and-dumps, rugs, honeypots, slow bleeders, creator
 * dumps) and runs them through the bot's real scanner rules, safety checks,
 * paper trader and exit monitor on a virtual clock — a day in seconds.
 *
 * It tests that the bot behaves as configured. It does NOT predict real
 * profits: results depend on how the fake market is drawn.
 *
 *   npm run simulate -- --hours 24 --tokens-per-hour 40 --seed 7
 */
import fs from 'node:fs';
import path from 'node:path';
import { ConfigSchema, type BotConfig } from './config.js';
import { MarketScanner, type ScanMetrics } from './discovery/scanner.js';
import { PumpFunStream } from './discovery/pumpfun.js';
import { ExitMonitor } from './monitor.js';
import { PaperAccount } from './paper.js';
import { PositionStore } from './positions.js';
import { Rpc } from './rpc.js';
import { dangerousExtensions } from './safety.js';
import { JupiterEngine } from './swap/jupiter.js';
import { PumpPortalEngine } from './swap/pumpportal.js';
import { Trader } from './trader.js';
import { WalletManager } from './wallets.js';
import { uniqueBuyersGrowth } from './discovery/gecko.js';
import { summarizeDay, formatSummary } from './summary.js';
import type { TokenCandidate } from './types.js';
import { log } from './logger.js';

// ------------------------------------------------------------------ options

const args = process.argv.slice(2);
const arg = (name: string, fallback: number) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const HOURS = arg('hours', 24);
const TOKENS_PER_HOUR = arg('tokens-per-hour', 40);
const SEED = arg('seed', 1);
const QUIET = args.includes('--quiet');

// Seeded randomness so a run can be repeated.
let rngState = SEED >>> 0 || 1;
const rand = () => {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const between = (a: number, b: number) => a + rand() * (b - a);
const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());

// ------------------------------------------------------------ virtual clock

const START = Date.UTC(2026, 0, 1, 0, 0, 0);
let now = START;
Date.now = () => now;

// ------------------------------------------------------------- fake market

const SOL_USD = 150;
const SUPPLY = 1_000_000_000;
const STEP = 10; // seconds per price point
const LIFE = 3 * 3600; // seconds a token is tracked
const WSOL = 'So11111111111111111111111111111111111111112';

type Kind = 'runner' | 'pump-dump' | 'rug' | 'slow' | 'creator-dump' | 'honeypot';
const KINDS: Array<[Kind, number]> = [
  ['runner', 0.15], ['pump-dump', 0.3], ['rug', 0.2], ['slow', 0.2], ['creator-dump', 0.1], ['honeypot', 0.05],
];

interface FakeToken {
  mint: string;
  symbol: string;
  kind: Kind;
  born: number;
  /** Price (SOL per token) every STEP seconds from birth. */
  price: number[];
  /** Volume (USD) traded during each STEP. */
  volume: number[];
  buys: number[];
  sells: number[];
  /** Liquidity collapses to ~0 from this step on (rugs). */
  rugStep?: number;
  /** The creator sells at this step (creator dumps). */
  creatorSellStep?: number;
  flags: { mintAuthority: boolean; freezeAuthority: boolean; top10Pct: number; transferHook: boolean };
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const fakeAddress = () => Array.from({ length: 44 }, () => B58[Math.floor(rand() * 58)]).join('');

function pickKind(): Kind {
  let r = rand();
  for (const [kind, p] of KINDS) {
    if ((r -= p) <= 0) return kind;
  }
  return 'slow';
}

/** Target price multiple (vs launch) over the token's life, by kind. */
function shape(kind: Kind, t: number, p: Record<string, number>): number {
  const min = t / 60;
  const rise = (to: number, over: number) => 1 + (to - 1) * Math.min(1, min / over);
  switch (kind) {
    case 'runner': {
      if (min < p.peakAt) return rise(p.peak, p.peakAt) ** 1;
      return p.peak * Math.max(0.15, 1 - 0.7 * ((min - p.peakAt) / 90));
    }
    case 'pump-dump':
    case 'creator-dump':
    case 'honeypot': {
      if (min < p.peakAt) return rise(p.peak, p.peakAt);
      return p.peak * Math.max(0.1, 1 - 0.85 * ((min - p.peakAt) / 30));
    }
    case 'rug':
      return min < p.peakAt ? rise(p.peak, p.peakAt) : p.peak * 0.98;
    case 'slow':
    default:
      return min < 6 ? rise(p.peak, 6) : p.peak * (1 - 0.3 * Math.min(1, (min - 6) / 120));
  }
}

function makeToken(born: number): FakeToken {
  const kind = pickKind();
  const params: Record<string, number> = {
    runner: { peak: Math.exp(between(Math.log(2), Math.log(25))), peakAt: between(15, 90) },
    'pump-dump': { peak: between(1.5, 3), peakAt: between(4, 12) },
    'creator-dump': { peak: between(1.5, 3), peakAt: between(4, 12) },
    honeypot: { peak: between(2, 6), peakAt: between(5, 20) },
    rug: { peak: between(1.4, 4), peakAt: between(4, 25) },
    slow: { peak: between(1.4, 1.8), peakAt: 6 },
  }[kind];
  const p0 = between(20_000, 45_000) / (SUPPLY * SOL_USD); // $20-45K launch market cap
  const steps = LIFE / STEP;
  const price: number[] = [];
  const volume: number[] = [];
  const buys: number[] = [];
  const sells: number[] = [];
  let noise = 1;
  for (let i = 0; i < steps; i++) {
    noise *= Math.exp(gauss() * 0.012);
    noise = Math.min(1.25, Math.max(0.8, noise));
    price.push(p0 * shape(kind, i * STEP, params) * noise);
    const prev = price[i - 1] ?? price[i];
    const move = price[i] / prev - 1;
    const interest = Math.exp(-(i * STEP) / 3600) * (kind === 'runner' ? 2 : 1);
    const vol = Math.max(50, (800 + 40_000 * Math.abs(move)) * interest * between(0.6, 1.4));
    volume.push(vol);
    const trades = Math.max(1, Math.round(vol / 150));
    const buyShare = Math.min(0.85, Math.max(0.15, 0.5 + move * 8));
    buys.push(Math.round(trades * buyShare));
    sells.push(trades - Math.round(trades * buyShare));
  }
  const symbol = `${kind.slice(0, 3).toUpperCase()}${Math.floor(rand() * 900 + 100)}`;
  return {
    mint: fakeAddress(),
    symbol,
    kind,
    born,
    price,
    volume,
    buys,
    sells,
    rugStep: kind === 'rug' ? Math.round((params.peakAt * 60 + between(60, 900)) / STEP) : undefined,
    creatorSellStep: kind === 'creator-dump' ? Math.round((params.peakAt * 60 + between(30, 300)) / STEP) : undefined,
    flags: {
      mintAuthority: rand() < 0.05,
      freezeAuthority: rand() < 0.03,
      top10Pct: between(8, 55),
      transferHook: rand() < 0.02,
    },
  };
}

const tokens = new Map<string, FakeToken>();
const stepOf = (tok: FakeToken) => Math.floor((now - tok.born) / 1000 / STEP);
const alive = (tok: FakeToken) => now >= tok.born && stepOf(tok) < tok.price.length;

function priceAt(tok: FakeToken, step = stepOf(tok)): number {
  const s = Math.max(0, Math.min(step, tok.price.length - 1));
  const rugged = tok.rugStep !== undefined && s >= tok.rugStep;
  const dumped = tok.creatorSellStep !== undefined && s >= tok.creatorSellStep;
  return tok.price[s] * (rugged ? 0.03 : dumped ? 0.4 : 1);
}
function windowSum(arr: number[], tok: FakeToken, seconds: number): number {
  const s = stepOf(tok);
  let total = 0;
  for (let i = Math.max(0, s - seconds / STEP + 1); i <= s; i++) total += arr[i] ?? 0;
  return total;
}
function liquidityUsd(tok: FakeToken): number {
  if (tok.rugStep !== undefined && stepOf(tok) >= tok.rugStep) return 400;
  const mc = priceAt(tok) * SUPPLY * SOL_USD;
  return 12_000 + 0.12 * mc;
}

function dexPair(tok: FakeToken) {
  const p = priceAt(tok);
  const change = (sec: number) => (p / priceAt(tok, stepOf(tok) - sec / STEP) - 1) * 100;
  return {
    chainId: 'solana', dexId: 'pumpswap', pairAddress: `pool-${tok.mint}`,
    baseToken: { address: tok.mint, symbol: tok.symbol, name: tok.symbol }, quoteToken: { address: WSOL },
    priceNative: String(p), priceUsd: String(p * SOL_USD),
    txns: { m5: { buys: windowSum(tok.buys, tok, 300), sells: windowSum(tok.sells, tok, 300) },
      h1: { buys: windowSum(tok.buys, tok, 3600), sells: windowSum(tok.sells, tok, 3600) } },
    volume: { m5: windowSum(tok.volume, tok, 300), h1: windowSum(tok.volume, tok, 3600) },
    priceChange: { m5: change(300), h1: change(3600), h6: change(3600) },
    liquidity: { usd: liquidityUsd(tok) },
    marketCap: p * SUPPLY * SOL_USD,
    pairCreatedAt: tok.born,
  };
}

/** Constant-product quote against the fake pool. */
function quote(tok: FakeToken, inputIsSol: boolean, amount: number): number | null {
  const p = priceAt(tok);
  const solReserve = liquidityUsd(tok) / 2 / SOL_USD;
  if (inputIsSol) {
    const sol = amount / 1e9;
    return Math.floor(((sol / p) * solReserve / (solReserve + sol)) * 1e6);
  }
  if (tok.kind === 'honeypot') return null;
  const tokensIn = amount / 1e6;
  const tokenReserve = solReserve / p;
  return Math.floor((tokensIn * p * tokenReserve / (tokenReserve + tokensIn)) * 1e9);
}

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.includes('/token-profiles/') || url.includes('/token-boosts/')) {
    return json([...tokens.values()].filter(alive).map((t) => ({ chainId: 'solana', tokenAddress: t.mint })));
  }
  if (url.includes('geckoterminal') && url.includes('/pools/pool-')) {
    const tok = tokens.get(url.split('/pools/pool-')[1]);
    if (!tok) return json({}, 404);
    const buyers = (sec: number) => Math.round(windowSum(tok.buys, tok, sec) * 0.7);
    return json({ data: { attributes: { transactions: { m5: { buyers: buyers(300) }, m15: { buyers: buyers(900) } } } } });
  }
  if (url.includes('geckoterminal')) return json({ data: [] });
  if (url.includes('/tokens/v1/solana/')) {
    const mints = url.split('/tokens/v1/solana/')[1].split(',');
    return json(mints.map((m) => tokens.get(m)).filter((t): t is FakeToken => Boolean(t && alive(t))).map(dexPair));
  }
  if (url.includes('/swap/v1/quote')) {
    const q = new URL(url).searchParams;
    const inputIsSol = q.get('inputMint') === WSOL;
    const tok = tokens.get(inputIsSol ? q.get('outputMint')! : q.get('inputMint')!);
    const out = tok && alive(tok) ? quote(tok, inputIsSol, Number(q.get('amount'))) : null;
    return out === null ? json({ error: 'no route' }, 400) : json({ outAmount: String(out) });
  }
  return json({ error: 'not simulated' }, 404);
}) as typeof fetch;

// ---------------------------------------------------------------- the bot

const outDir = path.resolve('simulation');
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
const config: BotConfig = ConfigSchema.parse(JSON.parse(fs.readFileSync('config.json', 'utf8')));
process.chdir(outDir);
if (QUIET) {
  for (const k of ['info', 'ok', 'trade'] as const) log[k] = () => {};
}

const rpc = new Rpc('simulated', 1000);
const jupiter = new JupiterEngine(rpc, config.endpoints.jupiterBase);
const stream = new PumpFunStream('wss://simulated.invalid', { newTokens: false, migrations: false, apiKey: '' });
const store = new PositionStore('paper-positions.json');
const account = new PaperAccount(config.paper.startingBalanceSol, 'paper-state.json');
const trader = new Trader(
  rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
  jupiter, store, config, { account, stream },
);
const monitor = new ExitMonitor(store, trader, jupiter, stream, config);
const scanner = new MarketScanner({ ...config.scanner, chains: [{ name: 'solana', dexscreener: 'solana' }] });

const stats = { signals: 0, bought: new Map<Kind, number>(), rejected: new Map<string, number>() };
const bump = <K>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
const seen = new Set<string>();
const startCapital = config.paper.startingBalanceSol;
// Realized PnL of the current virtual day, for the daily loss limit.
let realized = 0;
let realizedDay = 0;
trader.onClose = (_p, pnl) => {
  const day = Math.floor((now - START) / 86_400_000);
  if (day !== realizedDay) { realized = 0; realizedDay = day; }
  realized += pnl;
};
let lastBuyAt = 0;

/** The same entry gates as the live bot, run synchronously on the virtual clock. */
async function tryEnter(candidate: TokenCandidate, metrics: ScanMetrics): Promise<void> {
  const tok = tokens.get(candidate.mint)!;
  const reject = (why: string): void => { bump(stats.rejected, why); };
  if (store.hasMint(candidate.mint)) return;
  if (store.openCount >= config.entry.maxOpenPositions) return reject('max open positions');
  if (Math.floor((now - START) / 86_400_000) !== realizedDay) { realized = 0; realizedDay = Math.floor((now - START) / 86_400_000); }
  if (config.risk.maxDailyLossPct > 0 && realized <= -startCapital * config.risk.maxDailyLossPct / 100) {
    return reject('daily loss limit');
  }
  if (lastBuyAt && now - lastBuyAt < config.entry.buyCooldownSeconds * 1000) return reject('cooldown');
  if (config.scanner.mode === 'launch' && config.scanner.launch.requireBuyerGrowth) {
    const buyers = await uniqueBuyersGrowth(metrics.pairAddress);
    if (buyers && buyers.now <= buyers.before) return reject('unique buyers not growing');
  }
  // Safety: the same rules, with the fake token's on-chain facts.
  if (config.filters.requireMintAuthorityRevoked && tok.flags.mintAuthority) return reject('safety: mint authority');
  if (config.filters.requireFreezeAuthorityRevoked && tok.flags.freezeAuthority) return reject('safety: freeze authority');
  if (dangerousExtensions({ decimals: 6, mintAuthority: null, freezeAuthority: null, supply: '1',
    extensions: tok.flags.transferHook ? [{ extension: 'transferHook', state: { programId: 'x' } }] : [] }).length) {
    return reject('safety: token-2022 trap');
  }
  if (tok.flags.top10Pct > config.filters.maxTop10HolderPct) return reject('safety: top 10 holders');
  const sim = await jupiter.sellSimulation(candidate.mint, 10_000_000n, config.filters.maxRoundTripLossPct, config.entry.slippageBps);
  if (sim) return reject('safety: sell simulation');

  candidate.liquidityUsd = metrics.liquidityUsd;
  candidate.holders = Math.round(between(50, 900));
  const position = await trader.buy(candidate, 6);
  if (position) {
    lastBuyAt = now;
    bump(stats.bought, tok.kind);
  }
}

scanner.on('signal', (candidate: TokenCandidate, metrics: ScanMetrics) => {
  if (seen.has(candidate.mint)) return;
  seen.add(candidate.mint);
  stats.signals++;
  pending.push(tryEnter(candidate, metrics));
});
const pending: Array<Promise<void>> = [];

// ------------------------------------------------------------------- run

const END = START + HOURS * 3600 * 1000;
let nextSpawn = START;
const scanEvery = config.scanner.intervalSeconds * 1000;
const tickEvery = config.exit.priceCheckIntervalMs;
let nextScan = START;
let nextProgress = START;
const realStart = performance.now();

console.log(`simulating ${HOURS}h, ~${TOKENS_PER_HOUR} graduated tokens/hour, seed ${SEED}, strategy '${config.scanner.mode}'...`);
while (now < END + LIFE * 1000 && (now < END || store.openCount > 0)) {
  while (now < END && nextSpawn <= now) {
    const tok = makeToken(nextSpawn);
    tokens.set(tok.mint, tok);
    nextSpawn += (-Math.log(rand() + 1e-12) / TOKENS_PER_HOUR) * 3600 * 1000;
  }
  if (now < END && now >= nextScan) {
    await (scanner as unknown as { scan(): Promise<void> }).scan();
    await Promise.all(pending.splice(0));
    nextScan += scanEvery;
  }
  // Creator dumps: the creator watch would fire the emergency exit.
  for (const p of store.open) {
    const tok = tokens.get(p.mint);
    if (tok?.creatorSellStep !== undefined && stepOf(tok) === tok.creatorSellStep) {
      await monitor.exitNow(p, 'dev-sell', true);
    }
  }
  if (store.openCount > 0) await (monitor as unknown as { tick(): Promise<void> }).tick();
  if (now >= nextProgress && !QUIET) {
    process.stdout.write(`  ${((now - START) / 3600_000).toFixed(1)}h simulated, ${store.openCount} open\r`);
    nextProgress += 3600_000;
  }
  now += tickEvery;
}

// ------------------------------------------------------------------ report

const csv = path.join(outDir, 'data', 'paper-trades.csv');
const rows = fs.existsSync(csv) ? fs.readFileSync(csv, 'utf8').trim().split('\n').slice(1) : [];
const byReason = new Map<string, { n: number; pnl: number }>();
for (const r of rows) {
  const cols = r.split(',');
  const e = byReason.get(cols[7]) ?? { n: 0, pnl: 0 };
  e.n++;
  e.pnl += Number(cols[8]);
  byReason.set(cols[7], e);
}
const summary = summarizeDay(csv, '');
console.log(`\n=== Simulation (${((performance.now() - realStart) / 1000).toFixed(1)}s real time) ===`);
console.log(`tokens created: ${tokens.size}  scanner signals: ${stats.signals}  bought: ${[...stats.bought.values()].reduce((a, b) => a + b, 0)}`);
console.log(`bought by kind: ${[...stats.bought].map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
console.log(`rejected: ${[...stats.rejected].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
console.log(`trades: ${formatSummary({ ...summary, date: 'all' })}`);
for (const [reason, e] of [...byReason].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${reason.padEnd(15)} n=${String(e.n).padStart(4)}  PnL ${e.pnl >= 0 ? '+' : ''}${e.pnl.toFixed(4)} SOL`);
}
console.log(`paper balance: ${account.balanceSol.toFixed(4)} SOL (started ${startCapital})`);
console.log(`trades CSV: ${csv}`);
console.log('Note: a synthetic market checks the mechanics, not real-world profitability.');
process.exit(0);

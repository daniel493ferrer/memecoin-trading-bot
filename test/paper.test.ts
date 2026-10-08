import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigSchema, type BotConfig } from '../src/config.js';
import { PumpFunStream } from '../src/discovery/pumpfun.js';
import { ExitMonitor } from '../src/monitor.js';
import { PaperAccount, curveBuyTokens, curveSellSol } from '../src/paper.js';
import { PositionStore } from '../src/positions.js';
import { CandidateRecorder } from '../src/recorder.js';
import { Rpc } from '../src/rpc.js';
import { JupiterEngine } from '../src/swap/jupiter.js';
import { PumpPortalEngine } from '../src/swap/pumpportal.js';
import { Trader } from '../src/trader.js';
import { WalletManager } from '../src/wallets.js';
import type { TokenCandidate } from '../src/types.js';

const repoConfig = JSON.parse(fs.readFileSync(path.resolve('config.json'), 'utf8')) as Record<string, unknown>;

function makeConfig(overrides: (c: BotConfig) => void = () => {}): BotConfig {
  const config = ConfigSchema.parse(structuredClone(repoConfig));
  overrides(config);
  return config;
}

function inTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bot-test-'));
  return dir;
}

/** Feed a raw PumpPortal frame through the stream's real parser. */
function feed(stream: PumpFunStream, msg: Record<string, unknown>): void {
  (stream as unknown as { handleMessage(m: Record<string, unknown>): void }).handleMessage(msg);
}

test('bonding-curve round trip loses roughly two fees', () => {
  const curve = { vSol: 30, vTokens: 1_073_000_000, updatedAt: 0 };
  const tokens = curveBuyTokens(curve, 1, 1.25);
  assert.ok(tokens > 0);
  const after = { vSol: curve.vSol + 1 * (1 - 0.0125), vTokens: curve.vTokens - tokens, updatedAt: 0 };
  const back = curveSellSol(after, tokens, 1.25);
  assert.ok(back < 1 && back > 0.97, `round trip returned ${back}`);
});

test('recorder writes one JSON object per line', async () => {
  const dir = inTempDir();
  const file = path.join(dir, 'candidates.jsonl');
  const recorder = new CandidateRecorder(file);
  const candidate: TokenCandidate = {
    mint: 'M', symbol: 'S', name: 'N', source: 'pumpfun', venue: 'pump', discoveredAt: 1,
  };
  await recorder.recordPrefilterReject(candidate, 'a');
  await recorder.recordPrefilterReject(candidate, 'b');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) JSON.parse(line);
});

test('paper trade: buy on the curve, ride the move, exit on the trailing stop', async () => {
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const config = makeConfig((c) => {
      c.entry.reservePct = 20;
      c.entry.positionPctOfOperatingCapital = 10;
      c.entry.maxPositionSol = 1;
      c.entry.maxOpenPositions = 3;
      c.exit.takeProfits = [{ multiple: 2, sellPct: 50 }];
      c.exit.trailingStop = { enabled: true, activateAtMultiple: 1.5, trailPct: 20 };
    });
    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const rpc = new Rpc('test-key');
    const jupiter = new JupiterEngine(rpc, config.endpoints.jupiterBase);
    const store = new PositionStore('paper-positions.json');
    const account = new PaperAccount(1);
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      jupiter, store, config, { account, stream },
    );
    const monitor = new ExitMonitor(store, trader, jupiter, stream, config);
    monitor.start();
    monitor.stop(); // drive ticks by hand
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();

    const mint = 'MintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    let vSol = 30;
    let vTokens = 1_073_000_000;
    const trade = (txType: 'buy' | 'sell', sol: number, trader = 'someone') => {
      const k = vSol * vTokens;
      vSol += txType === 'buy' ? sol : -sol;
      vTokens = k / vSol;
      feed(stream, { txType, mint, traderPublicKey: trader, solAmount: sol, tokenAmount: 1,
        vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens });
    };

    let candidate: TokenCandidate | null = null;
    stream.on('newToken', (c: TokenCandidate) => { candidate = c; stream.watchToken(c.mint); });
    feed(stream, { txType: 'create', mint, symbol: 'TEST', name: 'Test', traderPublicKey: 'dev',
      solAmount: 1, vSolInBondingCurve: vSol, vTokensInBondingCurve: vTokens });
    assert.ok(candidate, 'create frame must emit a candidate');
    assert.ok(stream.getCurve(mint), 'watched launch keeps its curve');

    trade('buy', 2);
    const position = await trader.buy(candidate!, 6);
    assert.ok(position, 'paper buy should fill');
    monitor.track(position!);
    assert.ok(Math.abs(position!.solSpent - 0.08 - config.entry.priorityFeeSol - 0.000005) < 1e-9);
    assert.ok(account.balanceSol < 1);

    // Price runs: trailing stop arms past 1.5x, take-profit fires at 2x.
    for (let i = 0; i < 12; i++) { trade('buy', 3); await tick(); }
    const open = store.open[0];
    assert.ok(open.trailingActive, 'trailing stop should be armed');
    assert.deepEqual(open.takeProfitsFilled, [0], 'first take-profit rung should have fired');

    // Dump: price falls more than 20% from the peak.
    for (let i = 0; i < 8 && store.openCount > 0; i++) { trade('sell', 6); await tick(); }
    assert.equal(store.openCount, 0, 'position should be closed by the trailing stop');

    const closes = fs.readFileSync('logs/paper-trades.jsonl', 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l)).filter((r) => r.type === 'close');
    assert.equal(closes.length, 1);
    assert.equal(closes[0].reason, 'trailing-stop');
    assert.ok(closes[0].pnlSol > 0, `expected a profitable paper trade, got ${closes[0].pnlSol}`);
    assert.ok(Math.abs(account.balanceSol - (1 + closes[0].pnlSol)) < 1e-9, 'paper balance matches realized PnL');
  } finally {
    process.chdir(cwd);
  }
});

test('dev sell closes a paper position immediately', async () => {
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const config = makeConfig();
    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const rpc = new Rpc('test-key');
    const jupiter = new JupiterEngine(rpc, config.endpoints.jupiterBase);
    const store = new PositionStore('paper-positions.json');
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      jupiter, store, config, { account: new PaperAccount(1), stream },
    );
    const monitor = new ExitMonitor(store, trader, jupiter, stream, config);
    monitor.start();
    monitor.stop();

    const mint = 'MintBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    stream.on('newToken', (c: TokenCandidate) => stream.watchToken(c.mint));
    let candidate: TokenCandidate | null = null;
    stream.once('newToken', (c: TokenCandidate) => { candidate = c; });
    feed(stream, { txType: 'create', mint, symbol: 'DEV', name: 'Dev', traderPublicKey: 'creator',
      solAmount: 1, vSolInBondingCurve: 31, vTokensInBondingCurve: 1_038_000_000 });
    const position = await trader.buy(candidate!, 6);
    monitor.track(position!);
    feed(stream, { txType: 'sell', mint, traderPublicKey: 'creator', solAmount: 0.9, tokenAmount: 1,
      vSolInBondingCurve: 30.1, vTokensInBondingCurve: 1_069_000_000 });
    for (let i = 0; i < 20 && store.openCount > 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(store.openCount, 0);
  } finally {
    process.chdir(cwd);
  }
});

test('unfunded PumpPortal key is reported instead of silently observing nothing', () => {
  const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
  const denied: string[] = [];
  stream.on('tradeAccessDenied', (m: string) => denied.push(m));
  feed(stream, { message: "Subscribed to 'migration' events." });
  feed(stream, { message: "'subscribeTokenTrade' and 'subscribeAccountTrade' methods are only available when connecting with an API key funded with at least 0.02 SOL." });
  assert.equal(denied.length, 1);
});

test('pump.fun launches skip the RPC mint check and use 6 decimals', async () => {
  const { SafetyChecker } = await import('../src/safety.js');
  const config = makeConfig();
  const safety = new SafetyChecker(new Rpc('test-key'), config.filters);
  const report = await safety.check({
    mint: 'MintCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', symbol: 'X', name: 'X',
    source: 'pumpfun', venue: 'pump', discoveredAt: 0,
  });
  assert.deepEqual(report, { ok: true, reasons: [], decimals: 6 });
});

test('position size never exceeds maxPositionSol', async () => {
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const config = makeConfig((c) => { c.entry.positionPctOfOperatingCapital = 100; c.entry.maxPositionSol = 0.05; });
    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const rpc = new Rpc('test-key');
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      new JupiterEngine(rpc, config.endpoints.jupiterBase), new PositionStore('p.json'), config,
      { account: new PaperAccount(10), stream },
    );
    const mint = 'MintDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    let candidate: TokenCandidate | null = null;
    stream.on('newToken', (c: TokenCandidate) => { candidate = c; stream.watchToken(c.mint); });
    feed(stream, { txType: 'create', mint, symbol: 'CAP', name: 'Cap', traderPublicKey: 'dev',
      solAmount: 1, vSolInBondingCurve: 31, vTokensInBondingCurve: 1_038_000_000 });
    const position = await trader.buy(candidate!, 6);
    assert.ok(position!.solSpent < 0.051 + config.entry.priorityFeeSol);
  } finally {
    process.chdir(cwd);
  }
});

test('daily loss counts only today\'s closes for the matching mode', async () => {
  const { realizedPnlToday } = await import('../src/risk.js');
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    fs.mkdirSync('logs');
    const today = new Date().toISOString();
    fs.writeFileSync('logs/trades.jsonl', [
      { ts: today, type: 'close', pnlSol: -0.04 },
      { ts: today, type: 'close', pnlSol: -0.03 },
      { ts: '2020-01-01T00:00:00.000Z', type: 'close', pnlSol: -5 },
      { ts: today, type: 'buy', solIn: 1 },
    ].map((r) => JSON.stringify(r)).join('\n') + '\n');
    assert.ok(Math.abs(realizedPnlToday('live') - -0.07) < 1e-9);
    assert.equal(realizedPnlToday('paper'), 0);
  } finally {
    process.chdir(cwd);
  }
});

test('three positions of 25% each keep a 25% reserve', async () => {
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const config = makeConfig((c) => {
      c.entry.reservePct = 25; c.entry.positionPctOfOperatingCapital = 33.33;
      c.entry.maxPositionSol = 1000; c.entry.maxOpenPositions = 3; c.entry.priorityFeeSol = 0;
    });
    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const rpc = new Rpc('test-key');
    const account = new PaperAccount(1);
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      new JupiterEngine(rpc, config.endpoints.jupiterBase), new PositionStore('p.json'), config,
      { account, stream },
    );
    stream.on('newToken', (c: TokenCandidate) => stream.watchToken(c.mint));
    const spent: number[] = [];
    for (const m of ['E', 'F', 'G', 'H']) {
      const mint = `Mint${m.repeat(40)}`;
      let candidate: TokenCandidate | null = null;
      stream.once('newToken', (c: TokenCandidate) => { candidate = c; });
      feed(stream, { txType: 'create', mint, symbol: m, name: m, traderPublicKey: 'dev',
        solAmount: 1, vSolInBondingCurve: 31, vTokensInBondingCurve: 1_038_000_000 });
      const position = await trader.buy(candidate!, 6);
      if (position) spent.push(position.solSpent);
    }
    assert.equal(spent.length, 3, 'a fourth buy would dip into the reserve');
    for (const s of spent) assert.ok(Math.abs(s - 0.25) < 0.001, `position cost ${s}`);
    assert.ok(account.balanceSol >= 0.249);
  } finally {
    process.chdir(cwd);
  }
});

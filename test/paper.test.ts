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

test('scanner flags only tokens pumping per the rules', async () => {
  const { MarketScanner } = await import('../src/discovery/scanner.js');
  const config = makeConfig((c) => { c.scanner.mode = 'momentum'; c.scanner.minAgeMinutes = 20; });
  const PUMP = 'PumpMint1111111111111111111111111111111111';
  const FLAT = 'FlatMint1111111111111111111111111111111111';
  const SPIKE = 'SpikeMint111111111111111111111111111111111';
  const pair = (mint: string, m5: number, buys: number, sells: number) => ({
    chainId: 'solana', dexId: 'pumpswap', pairAddress: `pair-${mint}`,
    baseToken: { address: mint, name: mint, symbol: mint.slice(0, 4) },
    priceUsd: '0.001', txns: { m5: { buys, sells } }, volume: { m5: 50_000, h1: 200_000 },
    priceChange: { m5, h1: m5 * 2 }, liquidity: { usd: 40_000 }, marketCap: 500_000,
    pairCreatedAt: Date.now() - 2 * 3_600_000,
  });
  const urls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    let body: unknown = [];
    if (url.includes('geckoterminal')) {
      body = { data: [{ relationships: { base_token: { data: { id: `solana_${PUMP}` } } } },
        { relationships: { base_token: { data: { id: `solana_${FLAT}` } } } },
        { relationships: { base_token: { data: { id: `solana_${SPIKE}` } } } }] };
    } else if (url.includes('/tokens/v1/solana/')) {
      body = [pair(PUMP, 25, 120, 60), pair(FLAT, 3, 120, 60), pair(SPIKE, 300, 120, 60)];
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    const scanner = new MarketScanner(config.scanner);
    const signals: string[] = [];
    scanner.on('signal', (c: TokenCandidate) => signals.push(c.mint));
    await (scanner as unknown as { scan(): Promise<void> }).scan();
    assert.deepEqual(signals, [PUMP]);
    assert.ok(urls.some((u) => u.includes('/tokens/v1/solana/') && u.includes(PUMP) && u.includes(SPIKE)));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('Jupiter outages fall back to DexScreener instead of booking a fake rug', async () => {
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  const realFetch = globalThis.fetch;
  const MINT = 'AmmMint11111111111111111111111111111111111';
  let jupiterUp = true;
  let liquidityUsd = 50_000;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes('/swap/v1/quote')) {
      if (!jupiterUp) return new Response('rate limited', { status: 429 });
      const amount = BigInt(new URL(url).searchParams.get('amount')!);
      const out = url.includes(`inputMint=${MINT}`) ? amount / 1000n : amount * 1000n;
      return new Response(JSON.stringify({ outAmount: out.toString() }), { status: 200 });
    }
    if (url.includes('dexscreener')) {
      return new Response(JSON.stringify([{ chainId: 'solana', baseToken: { address: MINT },
        quoteToken: { address: 'So11111111111111111111111111111111111111112' },
        priceNative: '0.000001', liquidity: { usd: liquidityUsd } }]), { status: 200 });
    }
    return new Response('[]', { status: 200 });
  }) as typeof fetch;
  try {
    const config = makeConfig((c) => { c.entry.maxPositionSol = 1; });
    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const rpc = new Rpc('test-key');
    const jupiter = new JupiterEngine(rpc, config.endpoints.jupiterBase);
    const store = new PositionStore('p.json');
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      jupiter, store, config, { account: new PaperAccount(1), stream },
    );
    const monitor = new ExitMonitor(store, trader, jupiter, stream, config);
    const tick = () => (monitor as unknown as { tick(): Promise<void> }).tick();
    const position = await trader.buy(
      { mint: MINT, symbol: 'AMM', name: 'Amm', source: 'scanner', venue: 'amm', discoveredAt: 0 }, 6,
    );
    assert.ok(position);

    jupiterUp = false;
    for (let i = 0; i < 20; i++) await tick();
    assert.equal(store.openCount, 1, 'a Jupiter outage alone must not close the position');

    liquidityUsd = 100;
    await new Promise((r) => setTimeout(r, 3_100)); // let the DexScreener cache expire
    await tick();
    assert.equal(store.openCount, 0, 'pulled liquidity is a real rug');
  } finally {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
  }
});

test('other chains: scanner signal, GoPlus honeypot block, paper trade in USD terms', async () => {
  const { MarketScanner } = await import('../src/discovery/scanner.js');
  const { SafetyChecker } = await import('../src/safety.js');
  const dir = inTempDir();
  const cwd = process.cwd();
  process.chdir(dir);
  const realFetch = globalThis.fetch;
  const TOKEN = '0xAbCdEf0000000000000000000000000000000001';
  const HONEY = '0xAbCdEf0000000000000000000000000000000002';
  let priceUsd = 0.01;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
    if (url.includes('token-profiles')) return json([{ chainId: 'base', tokenAddress: TOKEN }, { chainId: 'base', tokenAddress: HONEY }]);
    if (url.includes('gopluslabs')) {
      const addr = new URL(url).searchParams.get('contract_addresses')!.toLowerCase();
      return json({ code: 1, result: { [addr]: { is_honeypot: addr === HONEY.toLowerCase() ? '1' : '0', buy_tax: '0', sell_tax: '0' } } });
    }
    if (url.includes('/tokens/v1/base/')) {
      return json([TOKEN, HONEY].filter((a) => url.includes(a)).map((a) => ({
        chainId: 'base', dexId: 'uniswap', pairAddress: `p-${a}`,
        baseToken: { address: a, name: 'Tok', symbol: 'TOK' }, quoteToken: { address: '0xweth' },
        priceUsd: String(priceUsd), txns: { m5: { buys: 120, sells: 60 } }, volume: { m5: 50_000, h1: 200_000 },
        priceChange: { m5: 20, h1: 80 }, liquidity: { usd: 60_000 }, marketCap: 900_000,
        pairCreatedAt: Date.now() - 2 * 3_600_000,
      })));
    }
    return json([]);
  }) as typeof fetch;
  try {
    const config = makeConfig((c) => {
      c.scanner.chains = [{ name: 'base', dexscreener: 'base', goplusChainId: '8453' }];
      c.scanner.mode = 'momentum';
      c.scanner.minAgeMinutes = 20;
      c.entry.maxPositionSol = 1;
    });
    const scanner = new MarketScanner(config.scanner);
    const signals: TokenCandidate[] = [];
    scanner.on('signal', (c: TokenCandidate) => signals.push(c));
    await (scanner as unknown as { scan(): Promise<void> }).scan();
    assert.deepEqual(signals.map((c) => [c.chain, c.mint]).sort(), [['base', HONEY], ['base', TOKEN]].sort());

    const rpc = new Rpc('test-key');
    const safety = new SafetyChecker(rpc, config.filters, config.scanner.chains);
    const honey = await safety.check(signals.find((c) => c.mint === HONEY)!);
    assert.equal(honey.ok, false);
    assert.match(honey.reasons.join(), /honeypot/);
    const good = await safety.check(signals.find((c) => c.mint === TOKEN)!);
    assert.equal(good.ok, true);

    const stream = new PumpFunStream('wss://example.invalid', { newTokens: true, migrations: true, apiKey: 'x' });
    const jupiter = new JupiterEngine(rpc, config.endpoints.jupiterBase);
    const store = new PositionStore('p.json');
    const account = new PaperAccount(1);
    const trader = new Trader(
      rpc, new WalletManager(config.wallets), new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade),
      jupiter, store, config, { account, stream },
    );
    const position = await trader.buy(signals.find((c) => c.mint === TOKEN)!, good.decimals);
    assert.ok(position);
    assert.equal(position!.chain, 'base');
    priceUsd = 0.03; // 3x
    await new Promise((r) => setTimeout(r, 3_100)); // DexScreener price cache
    assert.ok(await trader.sell(position!, 100, 'trailing-stop'));
    assert.equal(store.openCount, 0);
    assert.ok(account.balanceSol > 1.3, `3x on a 0.25 SOL position should leave ~1.45 SOL, got ${account.balanceSol}`);
  } finally {
    globalThis.fetch = realFetch;
    process.chdir(cwd);
  }
});

test('pullback mode buys the bounce of a runner, not spikes or dumps', async () => {
  const { MarketScanner, toMetrics } = await import('../src/discovery/scanner.js');
  const config = makeConfig((c) => { c.scanner.mode = 'pullback'; c.scanner.minAgeMinutes = 120; });
  const scanner = new MarketScanner(config.scanner);
  const metrics = (h6: number, h1: number, m5: number) => toMetrics({
    chainId: 'solana', baseToken: { address: 'x' }, priceUsd: '1', txns: { m5: { buys: 100, sells: 50 } },
    volume: { m5: 30_000, h1: 300_000 }, priceChange: { m5, h1, h6 }, liquidity: { usd: 80_000 },
    marketCap: 2_000_000, pairCreatedAt: Date.now() - 5 * 3_600_000,
  });
  assert.equal(scanner.rejectReason(metrics(300, -25, 8)), null);
  assert.match(scanner.rejectReason(metrics(300, 40, 30))!, /no pullback/);
  assert.match(scanner.rejectReason(metrics(300, -70, 5))!, /dump/);
  assert.match(scanner.rejectReason(metrics(300, -25, -3))!, /no bounce/);
  assert.match(scanner.rejectReason(metrics(30, -25, 8))!, /6h run/);
});

test('copy trading reads a leader buy and sell from a parsed transaction', async () => {
  const { parseLeaderSwap } = await import('../src/discovery/copytrader.js');
  const { PublicKey } = await import('@solana/web3.js');
  const LEADER = 'H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG';
  const MINT = 'MemeMint111111111111111111111111111111pump';
  const tx = (solPre: number, solPost: number, tokPre: number, tokPost: number) => ({
    transaction: { message: { accountKeys: [{ pubkey: new PublicKey(LEADER) }] } },
    meta: {
      preBalances: [solPre * 1e9], postBalances: [solPost * 1e9],
      preTokenBalances: tokPre ? [{ owner: LEADER, mint: MINT, uiTokenAmount: { uiAmount: tokPre } }] : [],
      postTokenBalances: tokPost ? [{ owner: LEADER, mint: MINT, uiTokenAmount: { uiAmount: tokPost } }] : [],
    },
  }) as never;
  const buys = parseLeaderSwap(tx(10, 8.99, 0, 5_000_000), LEADER);
  assert.equal(buys.length, 1);
  assert.equal(buys[0].side, 'buy');
  assert.equal(buys[0].mint, MINT);
  assert.ok(Math.abs(buys[0].sol - 1.01) < 1e-9);
  const sell = parseLeaderSwap(tx(9, 11, 5_000_000, 1_000_000), LEADER)[0];
  assert.equal(sell.side, 'sell');
  assert.ok(Math.abs(sell.soldPct - 80) < 1e-9);
  assert.ok(Math.abs(sell.sol - 2) < 1e-9);
  // A plain SOL transfer with no token change is not a trade.
  assert.deepEqual(parseLeaderSwap(tx(10, 9, 0, 0), LEADER), []);
});

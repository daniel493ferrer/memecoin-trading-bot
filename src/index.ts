import { loadConfig } from './config.js';
import { log } from './logger.js';
import { Rpc } from './rpc.js';
import { WalletManager } from './wallets.js';
import { PumpPortalEngine } from './swap/pumpportal.js';
import { JupiterEngine } from './swap/jupiter.js';
import { PumpFunStream } from './discovery/pumpfun.js';
import { RaydiumListener } from './discovery/raydium.js';
import { SafetyChecker } from './safety.js';
import { PositionStore } from './positions.js';
import { Trader } from './trader.js';
import { ExitMonitor } from './monitor.js';
import { CandidateObserver } from './observation.js';
import { CandidateOutcomeTracker } from './outcomes.js';
import { createStrategy } from './strategies/index.js';
import { CandidateRecorder } from './recorder.js';
import { PaperAccount } from './paper.js';
import { realizedPnlToday } from './risk.js';
import type { ObservationReport } from './observation.js';
import type { TokenCandidate } from './types.js';
import { fmtSol, short, sleep } from './utils.js';

const BANNER = `
  ┌─────────────────────────────────────────────┐
  │  Memecoin Trading Bot                       │
  └─────────────────────────────────────────────┘`;

async function main(): Promise<void> {
  console.log(BANNER);

  const { config, env } = loadConfig();
  const live = env.liveTrading;

  // Paper mode never signs anything, so it does not need private keys.
  const wallets = new WalletManager(config.wallets);
  if (live) wallets.load();

  const rpc = new Rpc(env.heliusApiKey);

  if (live) {
    // Real orders depend on Helius for broadcasting, confirmation and fill
    // accounting. Refuse to start rather than discover a broken key mid-trade.
    let totalSol = 0;
    for (const wallet of wallets.all) {
      let balance: number;
      try {
        balance = await rpc.getSolBalance(wallet.pubkey);
      } catch (err) {
        throw new Error(
          `Helius RPC is not working (${(err as Error).message.slice(0, 160)}). ` +
          'Check HELIUS_API_KEY before trading live.',
        );
      }
      totalSol += balance;
      log.info(`wallet ${wallet.name} (${short(wallet.pubkey.toBase58())}): ${fmtSol(balance)}`);
    }
    if (totalSol <= config.wallets.minSolReserve) {
      throw new Error('trading wallets hold no usable SOL — fund wallets.json addresses first.');
    }
    log.warn(
      `LIVE MODE — real SOL. Max ${fmtSol(config.entry.maxPositionSol)} per position, ` +
      `${config.entry.maxOpenPositions} open at most, buying stops after ${fmtSol(config.risk.maxDailyLossSol)} ` +
      'realized loss per day. Starting in 10s — Ctrl+C to abort.',
    );
    await sleep(10_000);
  }
  const pumpEngine = new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade);
  const jupiterEngine = new JupiterEngine(rpc, config.endpoints.jupiterBase);
  const safety = new SafetyChecker(rpc, config.filters);

  // Paper positions live in their own file so they never mix with real ones.
  const store = new PositionStore(live ? 'positions.json' : 'paper-positions.json');
  store.load();

  // Migration events stay subscribed regardless of sniping settings: any open
  // pump.fun position needs them to switch its pricing/execution to the AMM.
  const pumpStream = new PumpFunStream(config.endpoints.pumpPortalWs, {
    newTokens: config.discovery.pumpfun.enabled && config.discovery.pumpfun.snipeNewTokens,
    migrations: true,
    apiKey: env.pumpPortalApiKey,
  });

  const paperAccount = live ? null : new PaperAccount(config.paper.startingBalanceSol);
  const trader = new Trader(
    rpc,
    wallets,
    pumpEngine,
    jupiterEngine,
    store,
    config,
    paperAccount ? { account: paperAccount, stream: pumpStream } : null,
  );
  const raydium = new RaydiumListener(rpc);
  const monitor = new ExitMonitor(store, trader, jupiterEngine, pumpStream, config);
  const observer = new CandidateObserver(pumpStream, config.observation);
  const strategy = createStrategy(config.strategy.name);
  const recorder = new CandidateRecorder('data/candidates.jsonl');
  const outcomeTracker = new CandidateOutcomeTracker(
    pumpStream,
    'data/outcomes.jsonl',
    config.recording.maxConcurrentOutcomes,
  );

  // ------------------------------------------------------------- buy pipeline

  const seenMints = new Set<string>();
  let lastBuyAt = 0;
  let buying = false;

  /** Follow the candidate's price after the decision, for later research. */
  function trackOutcome(
    candidate: TokenCandidate,
    observation: ObservationReport,
    decision: 'buy' | 'reject',
    reason: string,
  ): void {
    if (candidate.venue !== 'pump' || observation.lastPrice <= 0) return;
    void outcomeTracker
      .track(candidate.mint, observation.lastPrice, config.recording.outcomeSeconds, {
        symbol: candidate.symbol,
        decision,
        reason,
        score: observation.score,
      })
      .catch((error: unknown) => {
        log.warn(
          `outcome tracking failed for ${candidate.symbol} (${short(candidate.mint)}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }

  async function onCandidate(candidate: TokenCandidate): Promise<void> {
    if (seenMints.has(candidate.mint)) return;
    if (store.hasMint(candidate.mint)) return;
    seenMints.add(candidate.mint);
    if (seenMints.size > 10_000) {
      const oldest = seenMints.values().next().value;
      if (oldest) seenMints.delete(oldest);
    }

    // Local filters run before any trade subscription: PumpPortal bills
    // per-token trade data, so rejected launches must never be subscribed.
    const rejected = safety.prefilter(candidate);
    if (rejected) {
      await recorder.recordPrefilterReject(candidate, `prefilter rejected: ${rejected}`);
      log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${rejected}`);
      return;
    }

    // Start trade capture right after the cheap filters so the first seconds
    // are not lost. Every later consumer
    // (observer, outcome tracker, exit monitor) holds its own reference, so
    // this one is always released when the pipeline returns.
    const earlyTradeWatch = candidate.venue === 'pump';
    if (earlyTradeWatch) pumpStream.watchToken(candidate.mint);
    try {
      await evaluateCandidate(candidate);
    } catch (err) {
      log.error(`candidate pipeline error for ${candidate.symbol}: ${(err as Error).message}`);
    } finally {
      if (earlyTradeWatch) pumpStream.unwatchToken(candidate.mint);
    }
  }

  async function evaluateCandidate(candidate: TokenCandidate): Promise<void> {
    // Observe first. Safety RPC checks are intentionally deferred until the
    // candidate proves it has enough live activity and the strategy wants it.
    const observation = await observer.observe(candidate);

    if (!observation.ok) {
      const reason = `observation rejected: ${observation.reasons.join('; ')}`;
      await recorder.record(candidate, observation, 'reject', reason);
      // A sample of rejects is followed too; without it there is no way to
      // tell whether the filters throw away winners.
      if (Math.random() < config.recording.rejectedOutcomeSampleRate) {
        trackOutcome(candidate, observation, 'reject', reason);
      }
      log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${reason}`);
      return;
    }
    log.info(
      `${candidate.symbol}: observation passed ${observation.score}/100 — ` +
      `${observation.trades} trades, ${observation.uniqueBuyers} buyers, ` +
      `${observation.buyVolumeSol.toFixed(3)} SOL buy volume, ` +
      `${observation.priceChangePct >= 0 ? '+' : ''}${observation.priceChangePct.toFixed(1)}% price`,
    );

    const decision = await strategy.evaluate({ candidate, observation });
    if (!decision.buy) {
      const reason = `strategy ${strategy.name}: ${decision.reason}`;
      await recorder.record(candidate, observation, 'reject', reason);
      trackOutcome(candidate, observation, 'reject', reason);
      log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${reason}`);
      return;
    }

    // Multiple candidates may finish observation together. Wait for the current
    // buy instead of silently discarding a validated opportunity.
    while (buying) {
      await sleep(100);
    }
    buying = true;
    try {
      if (store.openCount >= config.entry.maxOpenPositions) {
        const reason = `max open positions (${config.entry.maxOpenPositions}) reached`;
        await recorder.record(candidate, observation, 'reject', reason);
        trackOutcome(candidate, observation, 'reject', reason);
        log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${reason}`);
        return;
      }
      if (store.hasMint(candidate.mint)) return;

      const pnlToday = realizedPnlToday(live ? 'live' : 'paper');
      if (pnlToday <= -config.risk.maxDailyLossSol) {
        const reason = `daily loss limit reached (${fmtSol(pnlToday)} today)`;
        await recorder.record(candidate, observation, 'reject', reason);
        log.warn(`skip ${candidate.symbol} (${short(candidate.mint)}): ${reason} — exits keep running`);
        return;
      }

      const cooldownMs =
        config.entry.buyCooldownSeconds * 1_000 - (Date.now() - lastBuyAt);
      if (lastBuyAt > 0 && cooldownMs > 0) {
        await sleep(cooldownMs);
      }

      // On-chain safety runs once, immediately before the order.
      const report = await safety.check(candidate);
      if (!report.ok) {
        const reason = `safety rejected: ${report.reasons.join('; ')}`;
        await recorder.record(candidate, observation, 'reject', reason);
        trackOutcome(candidate, observation, 'reject', reason);
        log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${reason}`);
        return;
      }

      const reason = `strategy ${strategy.name}: ${decision.reason}`;
      await recorder.record(candidate, observation, 'buy', reason);
      trackOutcome(candidate, observation, 'buy', reason);

      log.info(`entering ${candidate.symbol} (${short(candidate.mint)}) from ${candidate.source}`);
      const position = await trader.buy(candidate, report.decimals);
      if (position) {
        lastBuyAt = Date.now();
        monitor.track(position);
      }
    } finally {
      buying = false;
    }
  }

  pumpStream.on('newToken', (c: TokenCandidate) => {
    if (config.discovery.pumpfun.snipeNewTokens) void onCandidate(c);
  });

  pumpStream.on('migration', (mint: string) => {
    // Migration sniping: buy tokens that just graduated (proven demand),
    // unless we already hold them — the monitor handles that case.
    if (!config.discovery.pumpfun.snipeMigrations || store.hasMint(mint)) return;
    void onCandidate({
      mint,
      symbol: short(mint),
      name: 'pump.fun migration',
      source: 'pumpfun-migration',
      venue: 'amm',
      discoveredAt: Date.now(),
    });
  });

  pumpStream.once('tradeAccessDenied', (message: string) => {
    log.error(`PumpPortal refused per-token trade data: ${message}`);
    log.error(
      'Without trade data every candidate is observed with 0 trades and rejected. ' +
      'Deposit at least 0.02 SOL to the wallet linked to your PUMPPORTAL_API_KEY ' +
      '(shown when the key was generated at pumpportal.fun), then restart.',
    );
    void shutdown();
  });

  raydium.on('newPool', (c: TokenCandidate) => void onCandidate(c));

  // ------------------------------------------------------------------ startup

  if (
    config.discovery.pumpfun.enabled ||
    (config.observation.enabled && config.discovery.raydium.enabled) ||
    store.open.some((p) => p.venue === 'pump')
  ) {
    pumpStream.start();
  }
  if (config.discovery.raydium.enabled) {
    raydium.start();
  }
  monitor.start();

  log.ok(
    `bot running — ${live ? `${wallets.count} wallet(s)` : `paper balance ${fmtSol(paperAccount!.balanceSol)}`}, reserve ${config.entry.reservePct}%, ` +
      `position ${config.entry.positionPctOfOperatingCapital}% of operating capital (max ${fmtSol(config.entry.maxPositionSol)}), ` +
      `max ${config.entry.maxOpenPositions} open position(s), ` +
      `mode ${live ? 'LIVE' : 'PAPER (simulated fills, no transactions sent)'}`,
  );

  // PumpPortal bills trade data per message; make the usage visible.
  setInterval(() => {
    const { messages, watched } = pumpStream.takeTradeMessageStats();
    log.info(`PumpPortal usage: ${messages} trade messages in the last 10 min, ${watched} token(s) subscribed now`);
  }, 10 * 60_000);

  // Periodic status line so long sessions stay legible.
  setInterval(() => {
    const open = store.open;
    if (open.length === 0) return;
    const summary = open
      .map((p) => `${p.symbol}@${((Date.now() - p.openedAt) / 1000).toFixed(0)}s`)
      .join(', ');
    log.info(`open positions (${open.length}): ${summary}`);
  }, 60_000);

  // ------------------------------------------------------------- shutdown

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutting down — open positions are saved and will resume on restart');
    monitor.stop();
    pumpStream.stop();
    await raydium.stop();
    store.save();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error((err as Error).message);
  process.exit(1);
});

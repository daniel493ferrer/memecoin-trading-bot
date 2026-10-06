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
import type { TokenCandidate } from './types.js';
import { fmtSol, short, sleep } from './utils.js';

const BANNER = `
  ┌─────────────────────────────────────────────┐
  │  Memecoin Trading Bot                       │
  └─────────────────────────────────────────────┘`;

async function main(): Promise<void> {
  console.log(BANNER);

  const { config, env } = loadConfig();

  const wallets = new WalletManager(config.wallets);
  wallets.load();

  const rpc = new Rpc(env.heliusApiKey);
  const pumpEngine = new PumpPortalEngine(rpc, config.endpoints.pumpPortalTrade);
  const jupiterEngine = new JupiterEngine(rpc, config.endpoints.jupiterBase);
  const safety = new SafetyChecker(rpc, config.filters);

  const store = new PositionStore();
  store.load();

  const trader = new Trader(rpc, wallets, pumpEngine, jupiterEngine, store, config, env.liveTrading);

  // Migration events stay subscribed regardless of sniping settings: any open
  // pump.fun position needs them to switch its pricing/execution to the AMM.
  const pumpStream = new PumpFunStream(config.endpoints.pumpPortalWs, {
    newTokens: config.discovery.pumpfun.enabled && config.discovery.pumpfun.snipeNewTokens,
    migrations: true,
    apiKey: env.pumpPortalApiKey,
  });
  const raydium = new RaydiumListener(rpc);
  const monitor = new ExitMonitor(store, trader, jupiterEngine, pumpStream, config);
  const observer = new CandidateObserver(pumpStream, config.observation);
  const strategy = createStrategy(config.strategy.name);
  const recorder = new CandidateRecorder('data/candidates.jsonl');
  const outcomeTracker = new CandidateOutcomeTracker(
    pumpStream,
    'data/outcomes.jsonl',
  );

  // ------------------------------------------------------------- buy pipeline

  const seenMints = new Set<string>();
  let lastBuyAt = 0;
  let buying = false;

  async function onCandidate(candidate: TokenCandidate): Promise<void> {
    if (seenMints.has(candidate.mint)) return;

    // Gate cheap checks first, in order of cost.
    if (store.openCount >= config.entry.maxOpenPositions) return;
    if (store.hasMint(candidate.mint)) return;
    seenMints.add(candidate.mint);
    if (seenMints.size > 10_000) {
      const oldest = seenMints.values().next().value;
      if (oldest) seenMints.delete(oldest);
    }

    const rejected = safety.prefilter(candidate);
    if (rejected) {
      await recorder.recordPrefilterReject(candidate, `prefilter rejected: ${rejected}`);
      log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${rejected}`);
      return;
    }

    // Observe first. Safety RPC checks are intentionally deferred until the
    // candidate proves it has enough live activity. This prevents a flood of
    // seconds-old mint RPC lookups from competing with the trade stream.
    const observation = await observer.observe(candidate);

    if (!observation.ok) {
      await recorder.record(
        candidate,
        observation,
        'reject',
        `observation rejected: ${observation.reasons.join('; ')}`,
      );

      log.info(
        `skip ${candidate.symbol} (${short(candidate.mint)}): observation rejected — ${observation.reasons.join('; ')}`,
      );
      return;
    }
    log.info(
      `${candidate.symbol}: observation passed ${observation.score}/100 — ` +
      `${observation.trades} trades, ${observation.uniqueBuyers} buyers, ` +
      `${observation.buyVolumeSol.toFixed(3)} SOL buy volume, ` +
      `${observation.priceChangePct >= 0 ? '+' : ''}${observation.priceChangePct.toFixed(1)}% price`,
    );

    // Start outcome tracking before safety so strong candidates rejected by a
    // transient/on-chain safety check still produce future-performance data.
    if (candidate.venue === 'pump' && observation.lastPrice > 0) {
      void outcomeTracker.track(candidate.mint, observation.lastPrice, 300).catch((error: unknown) => {
        log.warn(
          `outcome tracking failed for ${candidate.symbol} (${short(candidate.mint)}): ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    }

    const safetyReport = await safety.check(candidate);
    if (!safetyReport.ok) {
      await recorder.record(
        candidate,
        observation,
        'reject',
        `safety rejected: ${safetyReport.reasons.join('; ')}`,
      );
      log.info(
        `skip ${candidate.symbol} (${short(candidate.mint)}): ${safetyReport.reasons.join('; ')}`,
      );
      return;
    }

    const decision = await strategy.evaluate({ candidate, observation });
    if (!decision.buy) {
      await recorder.record(
        candidate,
        observation,
        'reject',
        `strategy ${strategy.name}: ${decision.reason}`,
      );

      log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): strategy ${strategy.name} — ${decision.reason}`);
      return;
    }

    // Multiple candidates may finish observation together. Wait for the current
    // buy instead of silently discarding a validated opportunity.
    while (buying) {
      await sleep(100);
    }

    if (store.openCount >= config.entry.maxOpenPositions) return;
    if (store.hasMint(candidate.mint)) return;

    const cooldownMs =
      config.entry.buyCooldownSeconds * 1_000 - (Date.now() - lastBuyAt);
    if (lastBuyAt > 0 && cooldownMs > 0) {
      await sleep(cooldownMs);
    }

    // Re-check mutable portfolio gates after waiting for the entry lock/cooldown.
    if (store.openCount >= config.entry.maxOpenPositions) return;
    if (store.hasMint(candidate.mint)) return;

    await recorder.record(
      candidate,
      observation,
      'buy',
      `strategy ${strategy.name}: ${decision.reason}`,
    );

    buying = true;
    try {
      // Final safety re-check immediately before signing the transaction.
      const report = await safety.check(candidate);
      if (!report.ok) {
        log.info(`skip ${candidate.symbol} (${short(candidate.mint)}): ${report.reasons.join('; ')}`);
        return;
      }

      log.info(
        `entering ${candidate.symbol} (${short(candidate.mint)}) from ${candidate.source} — capital allocation is percentage-based`,
      );
      const position = await trader.buy(candidate, report.decimals);
      if (position) {
        lastBuyAt = Date.now();
        monitor.track(position);
      }
    } catch (err) {
      log.error(`candidate pipeline error for ${candidate.symbol}: ${(err as Error).message}`);
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
    `bot running — ${wallets.count} wallet(s), reserve ${config.entry.reservePct}%, ` +
      `position ${config.entry.positionPctOfOperatingCapital}% of operating capital, ` +
      `max ${config.entry.maxOpenPositions} open position(s), ` +
      `mode ${env.liveTrading ? 'LIVE' : 'DRY-RUN'}`,
  );

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

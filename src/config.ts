import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { z } from 'zod';

const TakeProfitSchema = z.object({
  /** Price multiple vs entry at which this rung fires (e.g. 2 = +100%). */
  multiple: z.number().gt(1),
  /** Percent of the *remaining* position to sell when it fires. */
  sellPct: z.number().gt(0).max(100),
});

export const ConfigSchema = z.object({
  discovery: z.object({
    pumpfun: z.object({
      enabled: z.boolean(),
      snipeNewTokens: z.boolean(),
      snipeMigrations: z.boolean(),
    }),
    raydium: z.object({
      enabled: z.boolean(),
    }),
  }),
  /** Copy trading: mirror buys and sells of proven Solana wallets. */
  copy: z.object({
    enabled: z.boolean().default(false),
    wallets: z.array(z.object({
      address: z.string().min(32),
      label: z.string().optional(),
    })).default([]),
    /** Ignore leader buys smaller than this (tests, dust, fee-farming). */
    minLeaderBuySol: z.number().min(0).default(0.3),
    /** Sell when a leader sells at least this share of their position. */
    followSellPct: z.number().gt(0).max(100).default(50),
    /** Skip a leader buy if we would enter more than this many seconds late. */
    maxDelaySeconds: z.number().min(1).default(20),
    /**
     * Consensus ("cluster") signal: buy only once this many different leaders
     * bought the same token within consensusWindowSeconds. 1 copies every
     * leader buy on its own.
     */
    minLeadersAgree: z.number().int().min(1).default(1),
    consensusWindowSeconds: z.number().int().min(10).default(300),
  }).default({}),
  /** Influencer signals: token addresses posted in Telegram channels. */
  influencers: z.object({
    enabled: z.boolean().default(false),
    /** Channel usernames (e.g. "somecallschannel") or invite links you joined. */
    channels: z.array(z.string().min(1)).default([]),
    /**
     * A mention counts as one consensus vote; require at least one leader
     * wallet buying too, so the bot never buys on a call alone.
     */
    requireWalletVote: z.boolean().default(true),
    sessionFile: z.string().default('data/telegram.session'),
  }).default({}),
  /** Finds copy-trading leaders automatically from on-chain data. */
  hunter: z.object({
    enabled: z.boolean().default(false),
    /** A Solana token up this much over 6 hours is analysed as a winner. */
    minRun6hPct: z.number().default(300),
    minLiquidityUsd: z.number().min(0).default(30_000),
    /** Early buyers must have paid at least this many times less than now. */
    minMultiple: z.number().gt(1).default(3),
    /** Oldest pool transactions read per winner. */
    sampleSize: z.number().int().min(20).max(1000).default(200),
    /** Signature pages (1000 each) walked back per pool. */
    maxPages: z.number().int().min(1).max(100).default(15),
    /** Different winners a wallet must have bought early in to be copied. */
    minHits: z.number().int().min(1).default(2),
    maxLeaders: z.number().int().min(1).default(15),
    /** Stop copying a leader once this many copied trades net a loss. */
    pruneAfterTrades: z.number().int().min(1).default(4),
  }).default({}),
  /** Market scanner: buys tokens that are pumping now, at any age. */
  scanner: z.object({
    enabled: z.boolean().default(false),
    intervalSeconds: z.number().int().min(10).default(20),
    /**
     * momentum: buy tokens rising now (the 5m/1h rules below).
     * pullback: buy the bounce of a strong multi-hour runner after a dip.
     */
    mode: z.enum(['momentum', 'pullback']).default('momentum'),
    pullback: z.object({
      /** Required run over the last 6 hours. */
      minRun6hPct: z.number().default(100),
      /** Last-hour change must sit between these (a dip, not a dump). */
      minDip1hPct: z.number().default(-40),
      maxDip1hPct: z.number().default(-10),
      /** Last-5-minute bounce window. */
      minBounce5mPct: z.number().default(2),
      maxBounce5mPct: z.number().default(25),
    }).default({}),
    /**
     * Chains to scan. Only Solana can trade live; other chains run in paper
     * mode to measure where the strategy works before building execution.
     */
    chains: z.array(z.object({
      name: z.string().min(1),
      /** DexScreener chain id, e.g. "solana", "base", "bsc". */
      dexscreener: z.string().min(1),
      /** GeckoTerminal network id; omit to skip GeckoTerminal for this chain. */
      gecko: z.string().optional(),
      /** GoPlus numeric chain id for honeypot/tax checks on EVM chains. */
      goplusChainId: z.string().optional(),
    })).min(1).default([{ name: 'solana', dexscreener: 'solana', gecko: 'solana' }]),
    minPriceChange5mPct: z.number().default(30),
    /** 0 disables. Above this the 5m move is a spike: buying it buys the top. */
    maxPriceChange5mPct: z.number().min(0).default(0),
    minPriceChange1hPct: z.number().default(0),
    minVolume5mUsd: z.number().min(0).default(10_000),
    minVolume1hUsd: z.number().min(0).default(0),
    /** Require the last 5 minutes to trade above the hour's average pace. */
    requireVolumeAcceleration: z.boolean().default(false),
    minAgeMinutes: z.number().min(0).default(0),
    minBuys5m: z.number().int().min(0).default(40),
    /** Required buys per sell over the last 5 minutes. */
    minBuySellRatio5m: z.number().min(0).default(1.2),
    minLiquidityUsd: z.number().min(0).default(15_000),
    /** 0 disables. */
    maxAgeHours: z.number().min(0).default(0),
    /** 0 disables. */
    maxMarketCapUsd: z.number().min(0).default(0),
  }).default({}),
  filters: z.object({
    symbolBlacklist: z.array(z.string()),
    symbolWhitelist: z.array(z.string()),
    minDevBuySol: z.number().min(0),
    maxDevBuySol: z.number().gt(0),
    minInitialLiquiditySol: z.number().min(0),
    requireMintAuthorityRevoked: z.boolean(),
    requireFreezeAuthorityRevoked: z.boolean(),
    maxTop10HolderPct: z.number().gt(0).max(100),
  }).refine((filters) => filters.minDevBuySol <= filters.maxDevBuySol, {
    message: 'minDevBuySol must be less than or equal to maxDevBuySol',
    path: ['minDevBuySol'],
  }),
  observation: z.object({
    enabled: z.boolean(),
    durationSeconds: z.number().int().min(5).max(300),
    minObservationSeconds: z.number().min(1),
    checkpointsSeconds: z.array(z.number().int().min(1)).min(1),
    evaluationIntervalMs: z.number().int().min(250),
    maxConcurrentCandidates: z.number().int().min(1).max(500),
    minTrades: z.number().int().min(1),
    minUniqueBuyers: z.number().int().min(1),
    minBuyVolumeSol: z.number().min(0),
    minBuySellRatio: z.number().min(0),
    maxSingleBuyerPct: z.number().gt(0).max(100),
    minPriceChangePct: z.number().min(-100),
    minScore: z.number().min(0).max(100),
  }),
  strategy: z.object({
    name: z.string().min(1),
  }),
  entry: z.object({
    reservePct: z.number().min(0).max(90),
    positionPctOfOperatingCapital: z.number().gt(0).max(100),
    /** Hard cap on SOL committed to one position, whatever the balance. */
    maxPositionSol: z.number().gt(0).default(0.05),
    slippageBps: z.number().int().min(50).max(10_000),
    priorityFeeSol: z.number().min(0),
    maxOpenPositions: z.number().int().min(1),
    buyCooldownSeconds: z.number().min(0),
    routeTimeoutSeconds: z.number().min(5),
  }),
  exit: z.object({
    takeProfits: z.array(TakeProfitSchema),
    stopLossPct: z.number().gt(0).lt(100),
    trailingStop: z.object({
      enabled: z.boolean(),
      activateAtMultiple: z.number().gt(1),
      trailPct: z.number().gt(0).lt(100),
    }),
    maxHoldSeconds: z.number().int().min(0),
    exitOnDevSell: z.boolean(),
    sellOnMigration: z.boolean(),
    priceCheckIntervalMs: z.number().int().min(500),
  }),
  wallets: z.object({
    file: z.string(),
    rotation: z.enum(['round-robin', 'random']),
    minSolReserve: z.number().min(0),
  }),
  /** Portfolio-level brakes. */
  risk: z.object({
    /** Stop opening positions for the rest of the UTC day after this realized loss. */
    maxDailyLossSol: z.number().gt(0).default(0.1),
  }).default({}),
  rpc: z.object({
    /** Helius HTTP requests per second (free plan allows 10). */
    maxRequestsPerSecond: z.number().gt(0).default(8),
  }).default({}),
  /** Dry-run (LIVE_TRADING=false) simulation settings. */
  paper: z.object({
    startingBalanceSol: z.number().gt(0).default(1),
    /** Venue fee charged on each simulated fill (pump.fun bonding curve ≈ 1.25%). */
    feePct: z.number().min(0).max(10).default(1.25),
    /** Extra adverse price movement applied to every fill to model latency. */
    extraSlippagePct: z.number().min(0).max(50).default(3),
  }).default({}),
  /** What the bot records for later research. */
  recording: z.object({
    /** How long to follow a candidate's price after its decision. */
    outcomeSeconds: z.number().int().min(10).default(180),
    /** Fraction of observation-rejected candidates whose outcome is also tracked. */
    rejectedOutcomeSampleRate: z.number().min(0).max(1).default(0.05),
    maxConcurrentOutcomes: z.number().int().min(1).default(20),
  }).default({}),
  endpoints: z.object({
    jupiterBase: z.string().url(),
    pumpPortalWs: z.string().url(),
    pumpPortalTrade: z.string().url(),
  }),
});

export type BotConfig = z.infer<typeof ConfigSchema>;

export interface Env {
  heliusApiKey: string;
  /** Empty when pump.fun discovery is off. */
  pumpPortalApiKey: string;
  liveTrading: boolean;
}

/** Load and validate config.json + .env. Exits with a clear message on any problem. */
export function loadConfig(): { config: BotConfig; env: Env } {
  const configPath = path.resolve('config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`config.json not found at ${configPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (err) {
    throw new Error(`config.json is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`config.json failed validation:\n${issues}`);
  }

  if (parsed.data.observation.checkpointsSeconds.some(
    (seconds) => seconds > parsed.data.observation.durationSeconds,
  )) {
    throw new Error('observation.checkpointsSeconds cannot exceed durationSeconds.');
  }
  parsed.data.observation.checkpointsSeconds = [
    ...new Set(parsed.data.observation.checkpointsSeconds),
  ].sort((a, b) => a - b);

  // Take-profit rungs must be sorted ascending so the monitor can fire them in order.
  parsed.data.exit.takeProfits.sort((a, b) => a.multiple - b.multiple);

  const heliusApiKey = process.env.HELIUS_API_KEY?.trim();
  if (!heliusApiKey) {
    throw new Error('HELIUS_API_KEY is missing. Copy .env.example to .env and add your key.');
  }

  const liveTradingRaw = process.env.LIVE_TRADING?.trim().toLowerCase() ?? 'false';
  if (liveTradingRaw !== 'true' && liveTradingRaw !== 'false') {
    throw new Error('LIVE_TRADING must be true or false.');
  }
  const liveTrading = liveTradingRaw === 'true';

  const pumpPortalApiKey = process.env.PUMPPORTAL_API_KEY?.trim() ?? '';
  if (!pumpPortalApiKey && parsed.data.discovery.pumpfun.enabled) {
    throw new Error(
      'PUMPPORTAL_API_KEY is missing. PumpPortal subscribeTokenTrade requires an API key for live trade observation.',
    );
  }

  return { config: parsed.data, env: { heliusApiKey, pumpPortalApiKey, liveTrading } };
}

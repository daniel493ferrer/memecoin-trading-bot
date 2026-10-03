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

const ConfigSchema = z.object({
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
    buyAmountSol: z.number().gt(0),
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
  endpoints: z.object({
    jupiterBase: z.string().url(),
    pumpPortalWs: z.string().url(),
    pumpPortalTrade: z.string().url(),
  }),
});

export type BotConfig = z.infer<typeof ConfigSchema>;

export interface Env {
  heliusApiKey: string;
  pumpPortalApiKey: string;
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

  // Take-profit rungs must be sorted ascending so the monitor can fire them in order.
  parsed.data.exit.takeProfits.sort((a, b) => a.multiple - b.multiple);

  const heliusApiKey = process.env.HELIUS_API_KEY?.trim();
  if (!heliusApiKey) {
    throw new Error('HELIUS_API_KEY is missing. Copy .env.example to .env and add your key.');
  }

  const pumpPortalApiKey = process.env.PUMPPORTAL_API_KEY?.trim();
  if (!pumpPortalApiKey) {
    throw new Error(
      'PUMPPORTAL_API_KEY is missing. PumpPortal subscribeTokenTrade requires an API key for live trade observation.',
    );
  }

  return { config: parsed.data, env: { heliusApiKey, pumpPortalApiKey } };
}

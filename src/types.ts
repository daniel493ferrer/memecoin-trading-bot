/** Where a token currently trades. Determines which execution engine we use. */
export type Venue = 'pump' | 'amm';

export type CandidateSource = 'pumpfun' | 'pumpfun-migration' | 'raydium';

/** A freshly discovered token that passed (or is about to pass) filtering. */
export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  source: CandidateSource;
  venue: Venue;
  /** Token creator (pump.fun launches only) — used for dev-sell detection. */
  creator?: string;
  /** Size of the creator's initial buy in SOL (pump.fun launches only). */
  devBuySol?: number;
  /** Initial SOL-side liquidity (Raydium pools only). */
  initialLiquiditySol?: number;
  discoveredAt: number;
}

export type PositionStatus = 'open' | 'closed';

export type ExitReason =
  | 'take-profit'
  | 'stop-loss'
  | 'trailing-stop'
  | 'max-hold'
  | 'dev-sell'
  | 'migration'
  | 'rugged'
  | 'shutdown';

export interface Position {
  id: string;
  mint: string;
  symbol: string;
  source: CandidateSource;
  venue: Venue;
  /** Base58 pubkey of the wallet holding this position. */
  wallet: string;
  creator?: string;
  tokenDecimals: number;
  /** Raw token amount originally bought (string — JSON-safe bigint). */
  tokensRawInitial: string;
  /** Raw token amount still held. */
  tokensRawRemaining: string;
  /** Actual SOL cash outflow to open the position, including transaction fees when recovered. */
  solSpent: number;
  /** Actual net SOL cash received from confirmed sells so far. */
  solReceived: number;
  /** Entry price in SOL per token (UI units). */
  entryPrice: number;
  /** Highest observed price since entry — drives the trailing stop. */
  peakPrice: number;
  /** Indices into config.exit.takeProfits that have already fired. */
  takeProfitsFilled: number[];
  trailingActive: boolean;
  openedAt: number;
  closedAt?: number;
  status: PositionStatus;
  exitReason?: ExitReason;
  buySignature: string;
}

/** Real-time trade event from the pump.fun data stream. */
export interface PumpTradeEvent {
  mint: string;
  txType: 'buy' | 'sell';
  trader: string;
  solAmount: number;
  tokenAmount: number;
  /** SOL per token derived from the bonding curve reserves after this trade. */
  price: number;
}

export interface SafetyReport {
  ok: boolean;
  reasons: string[];
  decimals: number;
}

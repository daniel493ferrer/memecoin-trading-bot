/** Where a token currently trades. Determines which execution engine we use. */
export type Venue = 'pump' | 'amm';

export type CandidateSource = 'pumpfun' | 'pumpfun-migration' | 'raydium' | 'fomo';

export interface TokenCandidate {
  mint: string;
  symbol: string;
  name: string;
  source: CandidateSource;
  venue: Venue;
  creator?: string;
  devBuySol?: number;
  initialLiquiditySol?: number;
  discoveredAt: number;
}

export interface FomoAlert {
  eventId: string;
  alertType: 'buy' | 'sell';
  trader: string;
  token: string;
  tokenAddress: string;
  chain: string;
  usdValue: number;
  timestamp: number;
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
  wallet: string;
  creator?: string;
  tokenDecimals: number;
  tokensRawInitial: string;
  tokensRawRemaining: string;
  solSpent: number;
  solReceived: number;
  entryPrice: number;
  peakPrice: number;
  takeProfitsFilled: number[];
  trailingActive: boolean;
  openedAt: number;
  closedAt?: number;
  status: PositionStatus;
  exitReason?: ExitReason;
  buySignature: string;
}

export interface PumpTradeEvent {
  mint: string;
  txType: 'buy' | 'sell';
  trader: string;
  solAmount: number;
  tokenAmount: number;
  price: number;
  timestamp: number;
}

export interface SafetyReport {
  ok: boolean;
  reasons: string[];
  decimals: number;
}

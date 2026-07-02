import type { ObservationReport } from '../observation.js';
import type { TokenCandidate } from '../types.js';

export interface StrategyContext {
  candidate: TokenCandidate;
  observation: ObservationReport;
}

export interface StrategyDecision {
  buy: boolean;
  reason: string;
}

/** A strategy makes the final buy/skip decision after observation. */
export interface TradingStrategy {
  readonly name: string;
  evaluate(context: StrategyContext): StrategyDecision | Promise<StrategyDecision>;
}

import type { TradingStrategy } from '../types.js';

/** Preserves the standard pipeline: observation and safety checks decide eligibility. */
export const defaultStrategy: TradingStrategy = {
  name: 'default',
  evaluate: () => ({ buy: true, reason: 'passed default strategy' }),
};

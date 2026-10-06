import { defaultStrategy } from './default/index.js';
import { momentumStrategy } from './momentum/index.js';
import { fomoFlowStrategy } from './fomo-flow/index.js';
import type { TradingStrategy } from './types.js';

const strategies = new Map<string, TradingStrategy>([
  [defaultStrategy.name, defaultStrategy],
  [momentumStrategy.name, momentumStrategy],
  [fomoFlowStrategy.name, fomoFlowStrategy],
]);

export function createStrategy(name: string): TradingStrategy {
  const strategy = strategies.get(name);
  if (!strategy) {
    throw new Error(
      `unknown strategy "${name}". Available strategies: ${[...strategies.keys()].join(', ')}`,
    );
  }
  return strategy;
}

export type { StrategyContext, StrategyDecision, TradingStrategy } from './types.js';

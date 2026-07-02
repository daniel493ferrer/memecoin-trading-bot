import { defaultStrategy } from './default/index.js';
import { momentumStrategy } from './momentum/index.js';
import type { TradingStrategy } from './types.js';

const strategies = new Map<string, TradingStrategy>([
  [defaultStrategy.name, defaultStrategy],
  [momentumStrategy.name, momentumStrategy],
]);

/**
 * Add custom strategies to the registry above, then select one through
 * config.json. Keeping registration explicit catches misspelled names before
 * the bot connects to any trading feeds.
 */
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

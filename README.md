# Memecoin Trading Bot

Memecoin Trading Bot is a strategy-first, configurable trading bot for newly
launched Solana memecoins. Its core advantage is a deliberately simple plug-in
strategy system: users can add their own entry logic in an isolated strategy
folder and select it from `config.json`, without changing discovery, wallet,
execution, safety, position, or exit-management code.

Out of the box, the bot discovers pump.fun launches, pump.fun migrations, and
new Raydium SOL pools; observes early trading activity; applies local and
on-chain safety checks; delegates the final buy decision to the selected
strategy; and manages open positions automatically.

The bot is designed around one live command (`npm start`), one main configuration
file (`config.json`), and isolated strategy modules that users can extend without
changing wallet, discovery, execution, or position-management code.

> Memecoin trading is extremely risky. Test with smaller amounts and review 
> configured threshold/strategies before using a fully funded wallet.

## How a trade is selected

The bot does not buy every discovered token. Every candidate follows this
pipeline:

```text
pump.fun / Raydium discovery
          │
          ▼
local prefilters (symbol, dev buy, initial liquidity)
          │
          ▼
short observation window (trades, buyers, volume, pressure, concentration, price)
          │
          ▼
selected strategy (default, momentum, or user-defined)
          │
          ▼
on-chain safety checks (mint/freeze authority and holder concentration)
          │
          ▼
portfolio gates (cooldown, wallet funds, maximum open positions)
          │
          ▼
buy → persistent position → automated exit management
```

Candidates must pass every enabled stage. Rejection reasons and observation
metrics are written to the console so strategy behavior can be audited.

## Features

- Real-time pump.fun token, migration, and trade events
- New Raydium SOL-pool discovery through Helius program logs
- Concurrent candidate observation before entry
- Configurable activity and concentration thresholds
- **Plug-in trading strategies** with an isolated interface, per-strategy folders,
  explicit registration, and config-based selection
- Mint authority, freeze authority, and holder-distribution checks
- PumpPortal bonding-curve execution and Jupiter AMM execution
- Take-profit ladder, stop loss, trailing stop, maximum hold, and dev-sell exits
- Round-robin or random multi-wallet allocation
- Persistent positions that resume management after restart
- Re-broadcasting of signed transactions until confirmation
- Structured trade history in `logs/trades.jsonl`
- **Paper trading** (default): simulated fills on the real bonding curve with
  fees and latency slippage, a virtual balance, and the same exit management
- Candidate and post-decision outcome recording for research (`npm run report`)

## Quick start

Requires Node.js 20 or newer.

```bash
git clone https://github.com/daniel493ferrer/memecoin-trading-bot.git
cd memecoin-trading-bot
npm install

cp .env.example .env
# Add your Helius and PumpPortal API keys to .env (LIVE_TRADING stays false)

npm start          # paper trading: real market data, simulated fills
npm run report     # what was recorded and how the paper trades went
```

With `LIVE_TRADING=false` (the default) the bot runs the full pipeline against
live market data but never signs a transaction. Buys and sells are simulated
against the latest bonding-curve reserves (or a Jupiter quote for AMM tokens),
charging `paper.feePct`, `paper.extraSlippagePct` and network fees, and booked
to a virtual balance in `paper-state.json`. Paper positions are stored in
`paper-positions.json` and paper trades in `logs/paper-trades.jsonl`. Delete
those files to restart the paper account.

Live trading needs private keys and `LIVE_TRADING=true`:

```bash
cp wallets.example.json wallets.json
# Add one or more base58 private keys to wallets.json
```

Wallet files may contain private-key strings:

```json
["base58key1", "base58key2"]
```

or named wallet objects:

```json
[
  { "name": "main", "privateKey": "base58key1" },
  { "name": "alt-1", "privateKey": "base58key2" }
]
```

The `.env`, `wallets.json`, position state, and logs are excluded by `.gitignore`.

## Trading strategies

Strategies make the final buy-or-skip decision after a candidate completes the
observation stage. They receive normalized candidate metadata and the complete
observation report. Strategies do not submit transactions directly.

Included strategies:

- `default`: accepts candidates that passed observation and leaves the remaining
  decision to the common safety pipeline.
- `momentum`: additionally requires an observation score of 80, at least five
  unique buyers, a buy/sell ratio of 2, and price growth of 5%.

Select a strategy in `config.json`:

```json
{
  "strategy": {
    "name": "momentum"
  }
}
```

### Creating a custom strategy

Create one folder per strategy beneath `src/strategies/`:

```text
src/strategies/
  types.ts
  index.ts
  default/
    index.ts
  momentum/
    index.ts
  my-strategy/
    index.ts
```

Implement the `TradingStrategy` contract in the new folder:

```ts
import type { TradingStrategy } from '../types.js';

export const myStrategy: TradingStrategy = {
  name: 'my-strategy',

  evaluate: ({ candidate, observation }) => {
    if (candidate.source !== 'pumpfun') {
      return { buy: false, reason: 'pump.fun launches only' };
    }
    if (observation.uniqueBuyers < 10) {
      return { buy: false, reason: 'not enough independent buyers' };
    }
    if (observation.largestBuyerPct > 25) {
      return { buy: false, reason: 'buy volume is too concentrated' };
    }
    return { buy: true, reason: 'custom entry rules passed' };
  },
};
```

Strategies may return a decision immediately or perform asynchronous checks and
return a promise. Available context includes the source, venue, mint, symbol,
creator and launch data, plus trade count, unique buyers, buy/sell volumes,
buy/sell ratio, largest-buyer percentage, price change, and observation score.

Register the strategy in `src/strategies/index.ts`:

```ts
import { myStrategy } from './my-strategy/index.js';

const strategies = new Map<string, TradingStrategy>([
  // existing strategies...
  [myStrategy.name, myStrategy],
]);
```

Finally, set `strategy.name` to `my-strategy` in `config.json`. An unknown name
causes startup to fail with the list of registered strategies.

## Configuration

All runtime tuning is validated from `config.json` before the bot starts.

### `discovery`

| Key | Purpose |
|---|---|
| `pumpfun.enabled` | Enable the pump.fun data stream |
| `pumpfun.snipeNewTokens` | Discover new bonding-curve launches |
| `pumpfun.snipeMigrations` | Discover tokens graduating to an AMM |
| `raydium.enabled` | Discover new Raydium SOL pools |

### `filters`

| Key | Purpose |
|---|---|
| `symbolBlacklist` | Reject matching names or symbols |
| `symbolWhitelist` | When populated, allow only matching names or symbols |
| `minDevBuySol` / `maxDevBuySol` | Accepted pump.fun creator-buy range |
| `minInitialLiquiditySol` | Required SOL liquidity for Raydium candidates |
| `requireMintAuthorityRevoked` | Reject tokens whose supply can still be inflated |
| `requireFreezeAuthorityRevoked` | Reject tokens whose transfers can be frozen |
| `maxTop10HolderPct` | Maximum accepted top-holder concentration for AMM tokens |

### `observation`

| Key | Purpose |
|---|---|
| `enabled` | Enable or bypass observation |
| `durationSeconds` | Candidate observation duration |
| `maxConcurrentCandidates` | Maximum simultaneous observations |
| `minTrades` | Required buy and sell event count |
| `minUniqueBuyers` | Required distinct buying wallets |
| `minBuyVolumeSol` | Required total SOL buy volume |
| `minBuySellRatio` | Required buy-volume to sell-volume ratio |
| `maxSingleBuyerPct` | Maximum volume contribution from one buyer |
| `minPriceChangePct` | Required price movement during observation |
| `minScore` | Required combined observation score from 0 to 100 |

### `entry`

| Key | Purpose |
|---|---|
| `reservePct` | Share of the wallet balance never used for positions |
| `positionPctOfOperatingCapital` | Position size as a share of the balance left after the reserve |
| `slippageBps` | Maximum entry and exit slippage in basis points |
| `priorityFeeSol` | Transaction priority-fee budget |
| `maxOpenPositions` | Portfolio-wide concurrent position limit |
| `buyCooldownSeconds` | Minimum interval between completed buys |
| `routeTimeoutSeconds` | Time allowed for Jupiter to find a new route |

### `exit`

| Key | Purpose |
|---|---|
| `takeProfits` | Ordered `{ multiple, sellPct }` partial-exit levels |
| `stopLossPct` | Full-exit loss threshold |
| `trailingStop` | Activation multiple and percentage below peak |
| `maxHoldSeconds` | Maximum position lifetime; zero disables it |
| `exitOnDevSell` | Exit when the recorded pump.fun creator sells |
| `sellOnMigration` | Exit at migration instead of moving management to Jupiter |
| `priceCheckIntervalMs` | AMM price-monitoring interval |

### `paper`

| Key | Purpose |
|---|---|
| `startingBalanceSol` | Virtual balance of a fresh paper account |
| `feePct` | Venue fee charged on each simulated fill |
| `extraSlippagePct` | Extra adverse movement per fill, modelling latency against other bots |

### `recording`

| Key | Purpose |
|---|---|
| `outcomeSeconds` | How long a candidate's price is followed after the decision |
| `rejectedOutcomeSampleRate` | Share of observation-rejected candidates also followed |
| `maxConcurrentOutcomes` | Upper bound on simultaneously followed candidates |

Every candidate is written to `data/candidates.jsonl` with its observation
metrics and decision; followed candidates are written to `data/outcomes.jsonl`
with their maximum gain, drawdown and final change. Comparing outcomes of bought
and rejected candidates is how filters and strategies should be judged.

### `wallets` and `endpoints`

Wallet settings control the key file, allocation method, and minimum SOL reserve.
Endpoint settings allow the Jupiter and PumpPortal URLs to be replaced without
changing source code.

## Position management

Pump positions use real-time bonding-curve prices. Migrated and Raydium positions
use Jupiter liquidation quotes. Open positions are written to `positions.json`
after every state change and restored on startup. Trades and realized estimates
are appended to `logs/trades.jsonl`.

## Project layout

```text
src/
  index.ts                 application orchestration and candidate pipeline
  paper.ts                 bonding-curve fill math and virtual paper balance
  recorder.ts              candidate decision log (data/candidates.jsonl)
  outcomes.ts              post-decision price tracking (data/outcomes.jsonl)
  report.ts                summary of recorded data and trades
  config.ts                validated configuration loading
  observation.ts           candidate activity collection and scoring
  safety.ts                local and on-chain entry checks
  trader.ts                buy/sell routing and fill accounting
  monitor.ts               take-profit, stop, timeout, and migration handling
  positions.ts             persistent open-position store
  wallets.ts               wallet loading and allocation
  rpc.ts                   Helius RPC and transaction confirmation
  strategies/
    types.ts               public custom-strategy contract
    index.ts               strategy registry
    default/index.ts       standard strategy
    momentum/index.ts      stricter momentum example
  discovery/
    pumpfun.ts             pump.fun launch, migration, and trade stream
    raydium.ts             Raydium pool discovery
  swap/
    pumpportal.ts          pump.fun transaction construction
    jupiter.ts             AMM quotes and swaps
```

## Verification

```bash
npm run typecheck
npm test
```

## Third-party services

- Helius provides Solana RPC and websocket access.
- PumpPortal provides pump.fun data and locally signed transaction construction.
- Jupiter provides AMM quotes and swap transaction construction.

## License

MIT. You are responsible for wallet security, configuration, and trading losses.

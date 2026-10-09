/** Voter ids for influencer mentions start with this prefix. */
export const TELEGRAM_VOTER = 'tg:';

/**
 * Tracks which signal sources (leader wallets, influencer channels) pointed
 * at each token recently, for the consensus ("cluster") entry signal.
 */
export class ClusterTracker {
  private buys = new Map<string, Map<string, number>>();

  constructor(private readonly windowMs: number, private readonly maxTokens = 5_000) {}

  /** Record a vote for `mint`; returns every voter within the window. */
  add(mint: string, voter: string, now = Date.now()): string[] {
    const voters = this.buys.get(mint) ?? new Map<string, number>();
    voters.set(voter, now);
    for (const [id, at] of voters) if (now - at > this.windowMs) voters.delete(id);
    this.buys.delete(mint);
    this.buys.set(mint, voters); // re-insert so the oldest token is evicted first
    if (this.buys.size > this.maxTokens) {
      const oldest = this.buys.keys().next().value;
      if (oldest) this.buys.delete(oldest);
    }
    return [...voters.keys()];
  }
}

/** Whether a token's voters justify a buy, and the wallet to follow out. */
export function clusterDecision(
  voters: string[],
  opts: { minVotes: number; requireWalletVote: boolean },
): { buy: boolean; wallets: string[]; channels: string[] } {
  const channels = voters.filter((v) => v.startsWith(TELEGRAM_VOTER)).map((v) => v.slice(TELEGRAM_VOTER.length));
  const wallets = voters.filter((v) => !v.startsWith(TELEGRAM_VOTER));
  const buy = voters.length >= opts.minVotes && (!opts.requireWalletVote || wallets.length > 0);
  return { buy, wallets, channels };
}

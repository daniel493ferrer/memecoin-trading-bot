/**
 * Tracks which leader wallets bought each token recently, for the copy
 * trading consensus ("cluster") signal.
 */
export class ClusterTracker {
  private buys = new Map<string, Map<string, number>>();

  constructor(private readonly windowMs: number, private readonly maxTokens = 5_000) {}

  /** Record `leader` buying `mint`; returns the leaders that bought it within the window. */
  add(mint: string, leader: string, now = Date.now()): string[] {
    const buyers = this.buys.get(mint) ?? new Map<string, number>();
    buyers.set(leader, now);
    for (const [address, at] of buyers) if (now - at > this.windowMs) buyers.delete(address);
    this.buys.delete(mint);
    this.buys.set(mint, buyers); // re-insert so the oldest token is evicted first
    if (this.buys.size > this.maxTokens) {
      const oldest = this.buys.keys().next().value;
      if (oldest) this.buys.delete(oldest);
    }
    return [...buyers.keys()];
  }
}

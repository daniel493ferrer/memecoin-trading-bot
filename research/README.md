# Pump.fun Research Engine

Goal: identify early-life features that predict large forward moves, then validate entry/hold/exit rules out-of-sample.

Historical corpus: Slinky21/Pumpfun_Memecoin_Corpus (Jun-Jul 2026): 798,430 launches, 33.58M trades, 26.9M bonding-curve snapshots. Read KNOWN_ISSUES before analysis.

Workflow:
1. Reconstruct token timelines.
2. Build feature snapshots at 5/10/15/20/30/45/60 seconds.
3. Label forward maximum return and time-to-peak.
4. Measure predictors of +100/+300/+600/+1000% and graduation.
5. Compare entry timestamps including fees/slippage.
6. Walk-forward train/validation/test; no future leakage.
7. Reject rules that only work in-sample.
8. Export winning rules/metrics for bot integration.

Data rules:
- Exclude suspect SOL-denominated trades documented by KNOWN_ISSUES.
- Exclude System Program from wallet-derived features.
- Keep missing-price tokens separate; do not fabricate prices.
- Treat Jun-Jul 2026 as one historical regime, not proof of future performance.

Live trading remains disabled during research.

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


## Ejecutar

Con DuckDB instalado:

```bash
pip install duckdb
python research/pumpfun_research.py
```

El motor consulta directamente los Parquet públicos de Hugging Face; no necesitas descargar los 6.7 GB.

Para inspeccionar primero el esquema real:

```bash
python research/pumpfun_research.py --describe
```

Genera:
- `research/results/early_move_summary.json`
- `research/results/early_move_features.parquet`

La primera pasada mide, por checkpoint de 5–60 s, la probabilidad histórica de alcanzar +100/+300/+600/+1000% dentro de 1/5/15/60 minutos. Después de esta pasada se construye la validación walk-forward y las reglas de entrada/salida.


## Siguiente fase: descubrimiento de estados

Sin volver a escanear los 33.58M trades:

```bash
python research/state_discovery.py
```

Genera:

- `research/results/state_discovery.json`

El análisis separa cronológicamente 70% entrenamiento / 30% OOS por token, aprende terciles solo con train y busca estados de una o dos variables en 5–60s para +100/+300/+600/+1000% a 5/15/60 min. El OOS solo evalúa; no selecciona.

No convertir ningún estado en regla del bot todavía. Falta validación con costes, slippage, drawdown y calidad de salida.

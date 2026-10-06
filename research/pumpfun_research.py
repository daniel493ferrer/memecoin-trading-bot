#!/usr/bin/env python3
"""
Pump.fun early-life research engine.

Runs locally against the public Slinky21/Pumpfun_Memecoin_Corpus parquet files.
No dataset download is required: DuckDB can scan the public parquet URLs directly.

Primary objective:
  determine whether 5/10/15/20/30/45/60s observations contain enough
  information to predict large forward moves (+100/+300/+600/+1000%).

This is research only. It does not alter live trading configuration.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Iterable

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main"

CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60)
FORWARD_WINDOWS = (60, 300, 900, 3600)

# The corpus has changed schema during development. Keep detection explicit
# instead of silently assuming column names.
TIME_ALIASES = (
    "bucket_seconds",
    "seconds_since_launch",
    "seconds_from_launch",
    "elapsed_seconds",
    "seconds",
)
PRICE_ALIASES = (
    "price_close",
    "price_high",
    "price_sol_eob",
    "price_sol",
    "price",
    "market_price_sol",
    "mcap_price_sol",
)
MINT_ALIASES = ("mint",)
BUY_PRESSURE_ALIASES = ("buy_pressure", "buy_pressure_pct", "buy_ratio")
TRADE_RATE_ALIASES = ("trade_velocity", "trade_rate", "trades_per_second")
CURVE_ALIASES = ("curve_pct_depleted_eob", "curve_pct_depleted")
BUY_VOL_ALIASES = ("buy_volume_sol", "buy_vol_sol", "volume_buy_sol")
SELL_VOL_ALIASES = ("sell_volume_sol", "sell_vol_sol", "volume_sell_sol")
TRADES_ALIASES = ("trade_count", "trades", "trades_eob", "num_trades")


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def remote(name: str) -> str:
    return f"{BASE_URL}/{name}"


def columns(con: duckdb.DuckDBPyConnection, file_name: str) -> list[str]:
    rows = con.execute(
        "SELECT column_name FROM (DESCRIBE SELECT * FROM read_parquet(?))",
        [remote(file_name)],
    ).fetchall()
    return [str(r[0]) for r in rows]


def choose(cols: Iterable[str], aliases: Iterable[str]) -> str | None:
    lower = {c.lower(): c for c in cols}
    for alias in aliases:
        if alias.lower() in lower:
            return lower[alias.lower()]
    return None


def require(name: str, value: str | None) -> str:
    if value is None:
        raise RuntimeError(
            f"Required snapshot column not found for {name}. "
            f"Run this script once with --describe to inspect the live schema."
        )
    return value


def finite(x: object) -> bool:
    try:
        return math.isfinite(float(x))
    except (TypeError, ValueError):
        return False


def describe(con: duckdb.DuckDBPyConnection) -> None:
    for file_name in ("snapshots.parquet", "tokens.parquet", "postgard_outcomes.parquet"):
        print(f"\n=== {file_name} ===")
        rows = con.execute(
            "SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet(?))",
            [remote(file_name)],
        ).fetchall()
        for name, typ in rows:
            print(f"{name}\t{typ}")


def build_query(
    mint: str,
    time_col: str,
    price_col: str,
    feature_cols: dict[str, str | None],
) -> str:
    """
    Build a bounded early-life query.

    The previous implementation cross-joined every snapshot row with seven
    checkpoints and materialized the full result in Python. On the full corpus
    that can explode into hundreds of millions of intermediate rows.

    The live corpus exposes bucket_seconds as elapsed time from launch. We only
    need rows through checkpoint + maximum forward horizon (60 + 3600 = 3660s),
    and the corpus has checkpoint buckets matching the requested seconds.
    """
    feature_select = []
    for alias, col in feature_cols.items():
        if col:
            feature_select.append(f"{ident(col)} AS {alias}")
        else:
            feature_select.append(f"NULL::DOUBLE AS {alias}")

    feature_sql = ",\n        ".join(feature_select)
    checkpoint_values = ",".join(str(x) for x in CHECKPOINTS)
    max_time = max(CHECKPOINTS) + max(FORWARD_WINDOWS)

    forward_select = []
    for seconds in FORWARD_WINDOWS:
        forward_select.append(
            f"""MAX(price) OVER (
                PARTITION BY mint
                ORDER BY t
                RANGE BETWEEN CURRENT ROW AND {seconds} FOLLOWING
            ) AS future_max_{seconds}s"""
        )
    forward_sql = ",\n        ".join(forward_select)

    return f"""
WITH raw AS (
    SELECT
        {ident(mint)} AS mint,
        TRY_CAST({ident(time_col)} AS DOUBLE) AS t,
        TRY_CAST({ident(price_col)} AS DOUBLE) AS price,
        {feature_sql}
    FROM read_parquet('{remote("snapshots.parquet")}')
    WHERE {ident(time_col)} BETWEEN 0 AND {max_time}
),
clean AS (
    SELECT *
    FROM raw
    WHERE mint IS NOT NULL
      AND t IS NOT NULL
      AND price IS NOT NULL
      AND price > 0
),
with_future AS (
    SELECT
        *,
        {forward_sql}
    FROM clean
),
picked AS (
    SELECT
        *,
        CAST(t AS BIGINT) AS checkpoint_s
    FROM with_future
    WHERE t IN ({checkpoint_values})
)
SELECT
    mint,
    checkpoint_s,
    t,
    price,
    {", ".join(feature_cols.keys())},
    future_max_60s,
    future_max_300s,
    future_max_900s,
    future_max_3600s,
    100.0 * (future_max_60s / price - 1.0) AS forward_max_pct_60s,
    100.0 * (future_max_300s / price - 1.0) AS forward_max_pct_300s,
    100.0 * (future_max_900s / price - 1.0) AS forward_max_pct_900s,
    100.0 * (future_max_3600s / price - 1.0) AS forward_max_pct_3600s
FROM picked
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="research/results")
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()

    con = duckdb.connect()
    con.execute("SET enable_progress_bar=true")
    # Allow DuckDB to spill intermediate state instead of letting the OS kill
    # the process when the local machine has limited RAM.
    con.execute("SET memory_limit='2GB'")
    con.execute("SET temp_directory='research/results/.duckdb_tmp'")

    if args.describe:
        describe(con)
        return 0

    snapshot_cols = columns(con, "snapshots.parquet")
    mint = choose(snapshot_cols, MINT_ALIASES)
    time_col = choose(snapshot_cols, TIME_ALIASES)
    price_col = choose(snapshot_cols, PRICE_ALIASES)

    print("Dataset:", DATASET)
    print("Snapshot columns:", len(snapshot_cols))
    print("Using bounded early-life scan: 0-3660s")
    print("mint:", mint)
    print("time:", time_col)
    print("price:", price_col)

    require("mint", mint)
    require("time", time_col)
    require("price", price_col)

    feature_cols = {
        "buy_pressure": choose(snapshot_cols, BUY_PRESSURE_ALIASES),
        "trade_rate": choose(snapshot_cols, TRADE_RATE_ALIASES),
        "curve_pct": choose(snapshot_cols, CURVE_ALIASES),
        "buy_volume_sol": choose(snapshot_cols, BUY_VOL_ALIASES),
        "sell_volume_sol": choose(snapshot_cols, SELL_VOL_ALIASES),
        "trade_count": choose(snapshot_cols, TRADES_ALIASES),
    }

    print("Features:")
    for k, v in feature_cols.items():
        print(f"  {k}: {v}")

    query = build_query(mint, time_col, price_col, feature_cols)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Aggregate in DuckDB; do not fetch millions of rows into Python.
    summary_query = f"""
    WITH data AS ({query})
    SELECT
        checkpoint_s,
        COUNT(*) AS samples,
        {", ".join(
            f"SUM(CASE WHEN forward_max_pct_{h}s >= {target} THEN 1 ELSE 0 END) * 100.0 / NULLIF(COUNT(*), 0) AS hit_{h}s_{target}"
            for h in FORWARD_WINDOWS
            for target in (100, 300, 600, 1000)
        )}
    FROM data
    GROUP BY checkpoint_s
    ORDER BY checkpoint_s
    """
    summary_rows = con.execute(summary_query).fetchall()
    summary_columns = [d[0] for d in con.description]

    summary: dict[str, object] = {
        "dataset": DATASET,
        "checkpoints_seconds": CHECKPOINTS,
        "forward_windows_seconds": FORWARD_WINDOWS,
        "targets_pct": [100, 300, 600, 1000],
        "checkpoints": {},
        "note": (
            "Exploratory full-corpus early-life snapshot analysis. "
            "This is not OOS trading validation or profitability evidence."
        ),
    }

    for row in summary_rows:
        values = dict(zip(summary_columns, row))
        cp = str(int(values["checkpoint_s"]))
        item: dict[str, object] = {"samples": int(values["samples"])}
        for h in FORWARD_WINDOWS:
            item[f"hit_{h}s"] = {
                f"+{target}%": round(float(values[f"hit_{h}s_{target}"]), 4)
                if values[f"hit_{h}s_{target}"] is not None
                else None
                for target in (100, 300, 600, 1000)
            }
        summary["checkpoints"][cp] = item

    (out_dir / "early_move_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )

    print("Writing row-level research features...")
    con.execute(
        "COPY (" + query + ") TO ? (FORMAT PARQUET, COMPRESSION ZSTD)",
        [str(out_dir / "early_move_features.parquet")],
    )

    print(json.dumps(summary, indent=2))
    print(f"\nWrote: {out_dir / 'early_move_summary.json'}")
    print(f"Wrote: {out_dir / 'early_move_features.parquet'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

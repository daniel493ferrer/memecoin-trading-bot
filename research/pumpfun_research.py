#!/usr/bin/env python3
"""
Pump.fun early-life research engine.

Runs locally against the public Slinky21/Pumpfun_Memecoin_Corpus parquet files.
No dataset download is required: DuckDB can scan the public parquet URLs directly.

Primary objective:
  discover which early-life states contain predictive information about
  unusually large forward moves, without hard-coding a return threshold.

This is research only. It does not alter live trading configuration.
"""

from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from typing import Iterable

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main"

CHECKPOINTS = (15, 30, 45, 60)
FORWARD_WINDOWS = (60, 300, 900, 3600)

# The corpus has changed schema during development. Keep detection explicit
# instead of silently assuming column names.
TIME_ALIASES = (
    "bucket_start",
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
    """Build a leak-safe early-life query using actual elapsed time."""
    feature_select = []
    for alias, col in feature_cols.items():
        if col:
            feature_select.append(f"s.{ident(col)} AS {alias}")
        else:
            feature_select.append(f"NULL::DOUBLE AS {alias}")
    feature_sql = ",\n        ".join(feature_select)
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

    checkpoint_aggs = [
        "        arg_max(t, t) FILTER (WHERE t <= {0}) AS t_{0}".format(cp)
        for cp in CHECKPOINTS
    ]
    for cp in CHECKPOINTS:
        for alias in list(feature_cols.keys()) + ["price"]:
            checkpoint_aggs.append(
                "        arg_max({0}, t) FILTER (WHERE t <= {1}) AS {0}_{1}".format(alias, cp)
            )
        for seconds in FORWARD_WINDOWS:
            checkpoint_aggs.append(
                "        arg_max(future_max_{0}s, t) FILTER (WHERE t <= {1}) AS future_max_{0}s_{1}".format(seconds, cp)
            )
    checkpoint_sql = ",\n".join(checkpoint_aggs)

    union_parts = []
    for cp in CHECKPOINTS:
        feature_names = [
            "    {0}_{1} AS {0}".format(alias, cp)
            for alias in list(feature_cols.keys()) + ["price"]
        ]
        future_names = [
            "    future_max_{0}s_{1} AS future_max_{0}s".format(seconds, cp)
            for seconds in FORWARD_WINDOWS
        ]
        select_list = ["    mint", "    {0} AS checkpoint_s".format(cp), "    t_{0} AS t".format(cp)]
        select_list += feature_names + future_names
        for seconds in FORWARD_WINDOWS:
            select_list.append(
                "    100.0 * (future_max_{0}s_{1} / price_{1} - 1.0) AS forward_max_pct_{0}s".format(seconds, cp)
            )
        union_parts.append(
            "SELECT\n" + ",\n".join(select_list) + "\nFROM wide\nWHERE t_{0} IS NOT NULL".format(cp)
        )
    union_sql = "\nUNION ALL\n".join(union_parts)

    if time_col == "bucket_start":
        time_expr = "EXTRACT(EPOCH FROM (s.bucket_start - tok.detected_at))"
        time_filter = "s.bucket_start >= tok.detected_at AND s.bucket_start <= tok.detected_at + INTERVAL '{0} seconds'".format(max_time)
        source_sql = """FROM read_parquet('{0}') s
    JOIN read_parquet('{1}') tok ON s.mint = tok.mint
    WHERE {2}""".format(remote("snapshots.parquet"), remote("tokens.parquet"), time_filter)
    else:
        time_expr = "TRY_CAST(s.{0} AS DOUBLE)".format(ident(time_col))
        source_sql = """FROM read_parquet('{0}') s
    WHERE {1} BETWEEN 0 AND {2}""".format(remote("snapshots.parquet"), ident(time_col), max_time)

    return """WITH raw AS (
    SELECT
        s.{mint} AS mint,
        TRY_CAST({time_expr} AS DOUBLE) AS t,
        TRY_CAST(s.{price} AS DOUBLE) AS price,
        {features}
    {source}
),
clean AS (
    SELECT *
    FROM raw
    WHERE mint IS NOT NULL
      AND t IS NOT NULL
      AND t BETWEEN 0 AND {max_time}
      AND price IS NOT NULL
      AND price > 0
),
with_future AS (
    SELECT *, {forward}
    FROM clean
),
wide AS (
    SELECT
        mint,
        {checkpoint_aggs}
    FROM with_future
    GROUP BY mint
)
{union_sql}
""".format(
        mint=ident(mint),
        time_expr=time_expr,
        price=ident(price_col),
        features=feature_sql,
        source=source_sql,
        max_time=max_time,
        forward=forward_sql,
        checkpoint_aggs=checkpoint_sql,
        union_sql=union_sql,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="research/results")
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute("SET enable_progress_bar=true")
    con.execute("SET memory_limit='2GB'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET temp_directory=?", [str(out_dir / ".duckdb_tmp")])

    cpu_count = os.cpu_count() or 4
    con.execute("SET threads=?", [min(16, max(4, cpu_count))])

    if args.describe:
        describe(con)
        return 0

    snapshot_cols = columns(con, "snapshots.parquet")
    mint = choose(snapshot_cols, MINT_ALIASES)
    time_col = choose(snapshot_cols, TIME_ALIASES)
    price_col = choose(snapshot_cols, PRICE_ALIASES)

    print("Dataset:", DATASET)
    print("Snapshot columns:", len(snapshot_cols))
    print(f"Using snapshot checkpoints: {CHECKPOINTS}s")
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
    features_path = out_dir / "early_move_features.parquet"
    summary_path = out_dir / "early_move_summary.json"

    print("Building row-level research features (single remote scan)...")
    con.execute(
        "COPY (" + query + ") TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)",
        [str(features_path)],
    )

    print("Computing distribution summary from local parquet...")
    stats = []
    for h in FORWARD_WINDOWS:
        stats.extend([
            f"quantile_cont(forward_max_pct_{h}s, 0.50) AS p50_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.75) AS p75_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.90) AS p90_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.95) AS p95_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.99) AS p99_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.995) AS p995_{h}s",
            f"quantile_cont(forward_max_pct_{h}s, 0.999) AS p999_{h}s",
            f"MAX(forward_max_pct_{h}s) AS max_{h}s",
        ])

    summary_query = f"""
    SELECT
        checkpoint_s,
        COUNT(*) AS samples,
        {", ".join(stats)}
    FROM read_parquet(?)
    GROUP BY checkpoint_s
    ORDER BY checkpoint_s
    """
    summary_rows = con.execute(summary_query, [str(features_path)]).fetchall()
    summary_columns = [d[0] for d in con.description]

    summary: dict[str, object] = {
        "dataset": DATASET,
        "checkpoints_seconds": list(CHECKPOINTS),
        "forward_windows_seconds": list(FORWARD_WINDOWS),
        "objective": (
            "Discover predictive early-life states and naturally occurring "
            "exceptional forward-move regimes from the empirical distribution."
        ),
        "checkpoints": {},
        "note": (
            "Exploratory full-corpus analysis. Return thresholds are not "
            "hard-coded trading rules. OOS validation, costs, slippage and "
            "walk-forward testing are still required."
        ),
    }

    for row in summary_rows:
        values = dict(zip(summary_columns, row))
        cp = str(int(values["checkpoint_s"]))
        item: dict[str, object] = {"samples": int(values["samples"])}
        for h in FORWARD_WINDOWS:
            item[f"forward_{h}s_pct"] = {
                "p50": round(float(values[f"p50_{h}s"]), 4),
                "p75": round(float(values[f"p75_{h}s"]), 4),
                "p90": round(float(values[f"p90_{h}s"]), 4),
                "p95": round(float(values[f"p95_{h}s"]), 4),
                "p99": round(float(values[f"p99_{h}s"]), 4),
                "p99_5": round(float(values[f"p995_{h}s"]), 4),
                "p99_9": round(float(values[f"p999_{h}s"]), 4),
                "max": round(float(values[f"max_{h}s"]), 4),
            }
        summary["checkpoints"][cp] = item

    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote: {summary_path}")
    print(f"Wrote: {features_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

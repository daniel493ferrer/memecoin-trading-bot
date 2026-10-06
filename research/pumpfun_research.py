#!/usr/bin/env python3
"""
Pump.fun early-life research engine.

Discovery-first research:
- uses trade-level data for true early-life timing;
- does not hard-code a "large move" percentage;
- measures the empirical forward-return distribution;
- keeps research separate from live trading.

The corpus documents second-by-second trade data and 15-second snapshots.
Trade-level data is therefore the correct source for 5/10/15/20/30/45/60s
entry-timing research. Snapshots can be used later as complementary features.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main"

CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60)
FORWARD_WINDOWS = (60, 300, 900, 3600)
ELAPSED_ALIASES = ("seconds_since_launch",)

TIME_ALIASES = (
    "event_time",
    "timestamp",
    "timestamp_ms",
    "timestamp_seconds",
    "trade_timestamp",
    "trade_timestamp_ms",
    "trade_time",
    "block_time",
    "block_timestamp",
    "block_timestamp_ms",
    "created_at",
    "time",
    "ts",
    "ts_ms",
    "unix_timestamp",
)
PRICE_ALIASES = (
    "price_sol",
    "price",
    "market_price_sol",
    "price_close",
)
SIDE_ALIASES = ("tx_type", "side", "trade_type", "type", "is_buy")
TRADER_ALIASES = (
    "trader_public_key",
    "trader",
    "wallet",
    "user",
    "user_public_key",
    "buyer",
    "user_wallet",
)


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def remote(name: str) -> str:
    return f"{BASE_URL}/{name}"


def dataset_file_urls(path: str) -> list[str]:
    """Resolve dataset files through the HF tree API."""
    import urllib.request

    api = (
        "https://huggingface.co/api/datasets/"
        f"{DATASET}/tree/main/{path}?recursive=true&expand=false"
    )
    with urllib.request.urlopen(api, timeout=30) as response:
        entries = json.load(response)

    files = [
        entry["path"]
        for entry in entries
        if entry.get("type") == "file" and entry["path"].endswith(".parquet")
    ]
    if not files:
        raise RuntimeError(f"No parquet files found under dataset path: {path}")
    return [remote(path) if path.endswith(".parquet") else remote(path) for path in files]


def schema(con: duckdb.DuckDBPyConnection, file_urls: list[str]) -> dict[str, tuple[str, str]]:
    rows = con.execute(
        "SELECT column_name, column_type "
        "FROM (DESCRIBE SELECT * FROM read_parquet(?, union_by_name=true))",
        [file_urls],
    ).fetchall()
    return {str(name).lower(): (str(name), str(typ)) for name, typ in rows}


def choose(cols: dict[str, str], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        if alias.lower() in cols:
            return cols[alias.lower()][0] if isinstance(cols[alias.lower()], tuple) else alias
    return None


def require(name: str, value: str | None, available: dict | None = None) -> str:
    if value is None:
        cols = ", ".join(sorted(available or {}))
        raise RuntimeError(f"Required trade column not found for {name}. Available columns: {cols}")
    return value


def describe(con: duckdb.DuckDBPyConnection) -> None:
    for file_name in ("trades.parquet", "snapshots.parquet", "tokens.parquet"):
        print(f"\n=== {file_name} ===")
        for name, typ in schema(con, file_name).items():
            print(f"{name}\t{typ}")


def time_expr(col: str, typ: str) -> str:
    t = typ.upper()
    ref = f"tr.{ident(col)}"
    if "TIMESTAMP" in t or t.startswith("DATE"):
        return f"TRY_CAST({ref} AS TIMESTAMP)"
    if any(x in t for x in ("INT", "DECIMAL", "DOUBLE", "FLOAT", "REAL")):
        return f"to_timestamp(TRY_CAST({ref} AS DOUBLE))"
    return (
        f"COALESCE(TRY_CAST({ref} AS TIMESTAMP), "
        f"to_timestamp(TRY_CAST({ref} AS DOUBLE)))"
    )


def side_expr(col: str, typ: str) -> str:
    ref = f"tr.{ident(col)}"
    if col.lower() == "is_buy":
        return f"TRY_CAST({ref} AS BOOLEAN)"
    return f"LOWER(CAST({ref} AS VARCHAR)) IN ('buy', 'b')"


def build_trade_query(
    mint_col: str,
    elapsed_col: str,
    price_col: str,
    side_col: str,
    trader_col: str | None,
    trade_urls: list[str],
) -> str:
    max_time = max(CHECKPOINTS) + max(FORWARD_WINDOWS)
    side = side_expr(side_col, "")
    trader = (
        f"CAST(tr.{ident(trader_col)} AS VARCHAR)"
        if trader_col
        else "NULL::VARCHAR"
    )

    aggs: list[str] = []
    for cp in CHECKPOINTS:
        aggs.extend(
            [
                f"arg_max(t, t) FILTER (WHERE t <= {cp}) AS t_{cp}",
                f"arg_max(price, t) FILTER (WHERE t <= {cp}) AS price_{cp}",
                f"COUNT(*) FILTER (WHERE t <= {cp}) AS trade_count_{cp}",
                f"COUNT(DISTINCT trader) FILTER (WHERE t <= {cp}) AS unique_traders_{cp}",
                f"COUNT(*) FILTER (WHERE t <= {cp} AND is_buy) AS buy_count_{cp}",
                f"COUNT(*) FILTER (WHERE t <= {cp} AND NOT is_buy) AS sell_count_{cp}",
                f"MAX(price) FILTER (WHERE t <= {cp}) AS peak_price_{cp}",
            ]
        )
        for h in FORWARD_WINDOWS:
            aggs.append(
                f"MAX(price) FILTER (WHERE t > {cp} AND t <= {cp + h}) "
                f"AS future_max_{h}s_{cp}"
            )

    union_parts: list[str] = []
    for cp in CHECKPOINTS:
        select = [
            "mint",
            f"{cp} AS checkpoint_s",
            f"t_{cp} AS t",
            f"price_{cp} AS price",
            f"trade_count_{cp} AS trade_count",
            f"unique_traders_{cp} AS unique_traders",
            f"buy_count_{cp} AS buy_count",
            f"sell_count_{cp} AS sell_count",
            f"peak_price_{cp} AS peak_price",
        ]
        for h in FORWARD_WINDOWS:
            select.extend(
                [
                    f"future_max_{h}s_{cp} AS future_max_{h}s",
                    f"100.0 * (future_max_{h}s_{cp} / price_{cp} - 1.0) "
                    f"AS forward_max_pct_{h}s",
                ]
            )
        union_parts.append(
            "SELECT\n    "
            + ",\n    ".join(select)
            + f"\nFROM wide\nWHERE t_{cp} IS NOT NULL AND price_{cp} > 0"
        )

    return f"""
WITH raw AS (
    SELECT
        tr.{ident(mint_col)} AS mint,
        TRY_CAST(tr.{ident(elapsed_col)} AS DOUBLE) AS t,
        TRY_CAST(tr.{ident(price_col)} AS DOUBLE) AS price,
        {side} AS is_buy,
        {trader} AS trader
    FROM read_parquet({json.dumps(trade_urls)}) tr
    JOIN read_parquet('{remote("tokens.parquet")}') tok
      ON tr.{ident(mint_col)} = tok.mint
    WHERE TRY_CAST(tr.{ident(elapsed_col)} AS DOUBLE) BETWEEN 0 AND {max_time}
),
clean AS (
    SELECT *
    FROM raw
    WHERE mint IS NOT NULL
      AND t BETWEEN 0 AND {max_time}
      AND price IS NOT NULL
      AND price > 0
),
wide AS (
    SELECT
        mint,
        {", ".join(aggs)}
    FROM clean
    GROUP BY mint
)
{" UNION ALL ".join(union_parts)}
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="research/results")
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute("SET enable_progress_bar=true")
    con.execute("SET memory_limit='4GB'")
    con.execute("SET preserve_insertion_order=false")
    temp_dir = str(out_dir / ".duckdb_tmp").replace("'", "''")
    con.execute(f"SET temp_directory='{temp_dir}'")
    threads = min(4, max(1, os.cpu_count() or 1))
    con.execute(f"SET threads={threads}")

    if args.describe:
        describe(con)
        return 0

    trade_urls = dataset_file_urls("trades")
    trade_schema = schema(con, trade_urls)
    mint_col = choose(trade_schema, ("mint",))
    elapsed_col = choose(trade_schema, ELAPSED_ALIASES)
    price_col = choose(trade_schema, PRICE_ALIASES)
    side_col = choose(trade_schema, SIDE_ALIASES)
    trader_col = choose(trade_schema, TRADER_ALIASES)

    require("mint", mint_col, trade_schema)
    require("elapsed", elapsed_col, trade_schema)
    require("price", price_col, trade_schema)
    require("side", side_col, trade_schema)

    print("Dataset:", DATASET)
    print(f"Source: {len(trade_urls)} trade shards + tokens.parquet")
    print("Checkpoints:", CHECKPOINTS)
    print("Forward windows:", FORWARD_WINDOWS)
    print("mint:", mint_col)
    print("elapsed:", elapsed_col, trade_schema[elapsed_col.lower()])
    print("price:", price_col)
    print("side:", side_col)
    print("trader:", trader_col)

    query = build_trade_query(
        mint_col,
        elapsed_col,
        price_col,
        side_col,
        trader_col,
        trade_urls,
    )

    features_path = out_dir / "early_move_features.parquet"
    summary_path = out_dir / "early_move_summary.json"

    print("Building trade-level research features (single remote scan, memory-tuned)...")
    con.execute(
        "COPY (" + query + ") TO ? "
        "(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)",
        [str(features_path)],
    )

    print("Computing distribution summary from local parquet...")
    stats: list[str] = []
    for h in FORWARD_WINDOWS:
        for p, alias in (
            (0.50, "p50"),
            (0.75, "p75"),
            (0.90, "p90"),
            (0.95, "p95"),
            (0.99, "p99"),
            (0.995, "p995"),
            (0.999, "p999"),
        ):
            stats.append(
                f"quantile_cont(forward_max_pct_{h}s, {p}) AS {alias}_{h}s"
            )
        stats.append(f"MAX(forward_max_pct_{h}s) AS max_{h}s")

    rows = con.execute(
        f"""
        SELECT checkpoint_s, COUNT(*) AS samples, {", ".join(stats)}
        FROM read_parquet(?)
        GROUP BY checkpoint_s
        ORDER BY checkpoint_s
        """,
        [str(features_path)],
    ).fetchall()
    columns = [d[0] for d in con.description]

    summary: dict[str, object] = {
        "dataset": DATASET,
        "source": "trade-level",
        "checkpoints_seconds": list(CHECKPOINTS),
        "forward_windows_seconds": list(FORWARD_WINDOWS),
        "objective": (
            "Discover predictive early-life states and naturally occurring "
            "exceptional forward-move regimes from the empirical distribution."
        ),
        "checkpoints": {},
        "note": (
            "Exploratory analysis only. No return threshold is a trading rule. "
            "Next stages must discover feature combinations, entry timing, "
            "exit behavior and validate them walk-forward out-of-sample."
        ),
    }

    for row in rows:
        v = dict(zip(columns, row))
        cp = str(int(v["checkpoint_s"]))
        item: dict[str, object] = {
            "samples": int(v["samples"]),
        }
        for h in FORWARD_WINDOWS:
            item[f"forward_{h}s_pct"] = {
                "p50": round(float(v[f"p50_{h}s"]), 4),
                "p75": round(float(v[f"p75_{h}s"]), 4),
                "p90": round(float(v[f"p90_{h}s"]), 4),
                "p95": round(float(v[f"p95_{h}s"]), 4),
                "p99": round(float(v[f"p99_{h}s"]), 4),
                "p99_5": round(float(v[f"p995_{h}s"]), 4),
                "p99_9": round(float(v[f"p999_{h}s"]), 4),
                "max": round(float(v[f"max_{h}s"]), 4),
            }
        summary["checkpoints"][cp] = item

    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))
    print(f"\nWrote: {summary_path}")
    print(f"Wrote: {features_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

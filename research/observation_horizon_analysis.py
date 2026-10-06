#!/usr/bin/env python3
"""
Unbounded observation-horizon research for Pump.fun.

Goal:
- Do NOT impose a 60s research cutoff.
- Follow each token through all available trades.
- Measure how much future upside remains as observation time increases.
- Separately measure token lifetime and time-to-peak.
- Produce an empirical horizon profile that can later inform the bot's
  observation policy.

This is research only. It does not create trading rules.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main"
TIME_BUCKET_SECONDS = 5
SUMMARY_BUCKETS = (
    5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900,
    1200, 1800, 2400, 3600, 5400, 7200,
)


def remote(name: str) -> str:
    return f"{BASE_URL}/{name}"


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def dataset_file_urls(path: str) -> list[str]:
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
        raise RuntimeError(f"No parquet files under {path}")
    return [remote(p) for p in files]


def schema(con: duckdb.DuckDBPyConnection, urls: list[str]) -> dict[str, tuple[str, str]]:
    rows = con.execute(
        "SELECT column_name, column_type "
        "FROM (DESCRIBE SELECT * FROM read_parquet(?, union_by_name=true))",
        [urls],
    ).fetchall()
    return {str(n).lower(): (str(n), str(t)) for n, t in rows}


def choose(cols: dict[str, tuple[str, str]], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        if alias in cols:
            return cols[alias][0]
    return None


def require(name: str, value: str | None, cols: dict[str, tuple[str, str]]) -> str:
    if value is None:
        raise RuntimeError(
            f"Missing {name}. Available columns: {', '.join(sorted(cols))}"
        )
    return value


def build_query(
    mint_col: str,
    elapsed_col: str,
    price_col: str,
    trade_urls: list[str],
) -> str:
    # Every trade remains in the research population. There is no max elapsed
    # time in the raw CTE.
    return f"""
WITH raw AS (
    SELECT
        tr.{ident(mint_col)} AS mint,
        TRY_CAST(tr.{ident(elapsed_col)} AS DOUBLE) AS t,
        TRY_CAST(tr.{ident(price_col)} AS DOUBLE) AS price
    FROM read_parquet({json.dumps(trade_urls)}) tr
),
clean AS (
    SELECT mint, t, price
    FROM raw
    WHERE mint IS NOT NULL
      AND t IS NOT NULL
      AND t >= 0
      AND price IS NOT NULL
      AND price > 0
),
ordered AS (
    SELECT
        mint,
        t,
        price,
        MAX(price) OVER (
            PARTITION BY mint
            ORDER BY t
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
        ) AS future_max_price,
        MAX(price) OVER (PARTITION BY mint) AS lifetime_peak_price,
        MAX(t) OVER (PARTITION BY mint) AS lifetime_last_trade_s,
        MIN(t) OVER (PARTITION BY mint) AS lifetime_first_trade_s
    FROM clean
),
events AS (
    SELECT
        mint,
        t,
        price,
        future_max_price,
        lifetime_peak_price,
        lifetime_last_trade_s,
        lifetime_first_trade_s,
        CASE
            WHEN lifetime_peak_price > 0
            THEN 100.0 * (lifetime_peak_price / price - 1.0)
            ELSE NULL
        END AS remaining_lifetime_upside_pct,
        CASE
            WHEN future_max_price > 0
            THEN 100.0 * (future_max_price / price - 1.0)
            ELSE NULL
        END AS remaining_future_upside_pct,
        CASE
            WHEN lifetime_last_trade_s >= lifetime_first_trade_s
            THEN lifetime_last_trade_s - lifetime_first_trade_s
            ELSE NULL
        END AS lifetime_seconds
    FROM ordered
)
SELECT * FROM events
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="research/results")
    parser.add_argument("--bucket", type=int, default=TIME_BUCKET_SECONDS)
    parser.add_argument("--memory", default="4GB")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    temp_dir = out_dir / ".duckdb_horizon_tmp"
    temp_dir.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    con.execute("SET preserve_insertion_order=false")
    con.execute(f"SET threads={min(8, max(1, os.cpu_count() or 1))}")
    con.execute(f"SET temp_directory='{str(temp_dir).replace(chr(39), chr(39)*2)}'")

    trade_urls = dataset_file_urls("trades")
    trade_schema = schema(con, trade_urls)

    mint_col = require("mint", choose(trade_schema, ("mint",)), trade_schema)
    elapsed_col = require(
        "seconds_since_launch",
        choose(trade_schema, ("seconds_since_launch",)),
        trade_schema,
    )
    price_col = require(
        "price",
        choose(trade_schema, ("price_sol", "price", "market_price_sol")),
        trade_schema,
    )

    print(f"Dataset: {DATASET}")
    print(f"Trade shards: {len(trade_urls)}")
    print(f"mint: {mint_col}")
    print(f"elapsed: {elapsed_col}")
    print(f"price: {price_col}")
    print("Research horizon: FULL AVAILABLE TOKEN LIFETIME")
    print(f"Time bucket: {args.bucket}s")

    query = build_query(mint_col, elapsed_col, price_col, trade_urls)
    events_path = out_dir / "observation_horizon_events.parquet"

    print("Scanning complete trade history and computing future/lifetime paths...")
    con.execute(
        "COPY (" + query + ") TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)",
        [str(events_path)],
    )

    # Token-level lifetime summary: no cutoff.
    lifetime_rows = con.execute(
        """
        SELECT
            COUNT(*) AS trade_rows,
            COUNT(DISTINCT mint) AS tokens,
            quantile_cont(lifetime_seconds, 0.50) AS p50_lifetime_s,
            quantile_cont(lifetime_seconds, 0.75) AS p75_lifetime_s,
            quantile_cont(lifetime_seconds, 0.90) AS p90_lifetime_s,
            quantile_cont(lifetime_seconds, 0.95) AS p95_lifetime_s,
            quantile_cont(lifetime_seconds, 0.99) AS p99_lifetime_s,
            MAX(lifetime_seconds) AS max_lifetime_s
        FROM read_parquet(?)
        """,
        [str(events_path)],
    ).fetchone()

    # Horizon profile: at each elapsed-time bucket, compare remaining upside.
    profile = con.execute(
        """
        WITH bucketed AS (
            SELECT
                CAST(FLOOR(t / ?) * ? AS BIGINT) AS elapsed_bucket_s,
                mint,
                remaining_future_upside_pct,
                remaining_lifetime_upside_pct
            FROM read_parquet(?)
            WHERE t >= 0
        )
        SELECT
            elapsed_bucket_s,
            COUNT(*) AS trade_observations,
            COUNT(DISTINCT mint) AS active_tokens,
            quantile_cont(remaining_future_upside_pct, 0.50) AS future_p50,
            quantile_cont(remaining_future_upside_pct, 0.75) AS future_p75,
            quantile_cont(remaining_future_upside_pct, 0.90) AS future_p90,
            quantile_cont(remaining_future_upside_pct, 0.95) AS future_p95,
            quantile_cont(remaining_future_upside_pct, 0.99) AS future_p99,
            quantile_cont(remaining_lifetime_upside_pct, 0.50) AS lifetime_p50,
            quantile_cont(remaining_lifetime_upside_pct, 0.90) AS lifetime_p90
        FROM bucketed
        GROUP BY elapsed_bucket_s
        ORDER BY elapsed_bucket_s
        """,
        [args.bucket, args.bucket, str(events_path)],
    ).fetchall()

    # Exact requested checkpoints, derived from the 5s bucket profile.
    # This avoids a checkpoint x 33M-event cross join.
    checkpoint_rows = con.execute(
        """
        WITH bucketed AS (
            SELECT
                CAST(FLOOR(t / ?) * ? AS BIGINT) AS elapsed_bucket_s,
                mint,
                remaining_future_upside_pct,
                remaining_lifetime_upside_pct
            FROM read_parquet(?)
            WHERE t >= 0
        )
        SELECT
            elapsed_bucket_s,
            COUNT(DISTINCT mint) AS tokens_with_observation,
            quantile_cont(remaining_future_upside_pct, 0.50) AS future_p50,
            quantile_cont(remaining_future_upside_pct, 0.75) AS future_p75,
            quantile_cont(remaining_future_upside_pct, 0.90) AS future_p90,
            quantile_cont(remaining_future_upside_pct, 0.95) AS future_p95,
            quantile_cont(remaining_future_upside_pct, 0.99) AS future_p99,
            quantile_cont(remaining_lifetime_upside_pct, 0.50) AS lifetime_p50
        FROM bucketed
        WHERE elapsed_bucket_s IN (
            5,10,15,20,30,45,60,90,120,180,300,600,900,
            1200,1800,2400,3600,5400,7200
        )
        GROUP BY elapsed_bucket_s
        ORDER BY elapsed_bucket_s
        """,
        [args.bucket, args.bucket, str(events_path)],
    ).fetchall()

    lifetime = dict(
        zip(
            [
                "trade_rows",
                "tokens",
                "p50_lifetime_s",
                "p75_lifetime_s",
                "p90_lifetime_s",
                "p95_lifetime_s",
                "p99_lifetime_s",
                "max_lifetime_s",
            ],
            lifetime_rows,
        )
    )

    def clean(v):
        if v is None:
            return None
        return round(float(v), 4) if isinstance(v, (int, float)) else v

    result = {
        "dataset": DATASET,
        "research_policy": {
            "observation_cutoff": None,
            "description": "Full available token lifetime; no 60s research cutoff.",
            "bucket_seconds": args.bucket,
        },
        "lifetime": {k: clean(v) for k, v in lifetime.items()},
        "horizon_profile": [
            {
                "elapsed_bucket_s": int(r[0]),
                "trade_observations": int(r[1]),
                "active_tokens": int(r[2]),
                "future_p50_pct": clean(r[3]),
                "future_p75_pct": clean(r[4]),
                "future_p90_pct": clean(r[5]),
                "future_p95_pct": clean(r[6]),
                "future_p99_pct": clean(r[7]),
                "lifetime_p50_pct": clean(r[8]),
                "lifetime_p90_pct": clean(r[9]),
            }
            for r in profile
        ],
        "checkpoints": [
            {
                "checkpoint_s": int(r[0]),
                "tokens_with_observation": int(r[1]),
                "future_p50_pct": clean(r[2]),
                "future_p75_pct": clean(r[3]),
                "future_p90_pct": clean(r[4]),
                "future_p95_pct": clean(r[5]),
                "future_p99_pct": clean(r[6]),
                "lifetime_p50_pct": clean(r[7]),
            }
            for r in checkpoint_rows
        ],
        "warning": (
            "This measures time/horizon behavior only. It does not prove "
            "profitability, and no checkpoint is a trading rule."
        ),
    }

    out = out_dir / "observation_horizon_analysis.json"
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print("\n=== TOKEN LIFETIME ===")
    print(json.dumps(result["lifetime"], indent=2))
    print("\n=== CHECKPOINT PROFILE ===")
    for row in result["checkpoints"]:
        print(
            f'{row["checkpoint_s"]:>5}s '
            f'n={row["tokens_with_observation"]:<8} '
            f'p50={row["future_p50_pct"]} '
            f'p90={row["future_p90_pct"]} '
            f'p99={row["future_p99_pct"]}'
        )

    print(f"\nWrote: {events_path}")
    print(f"Wrote: {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

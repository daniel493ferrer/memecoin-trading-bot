#!/usr/bin/env python3
"""Historical observation-horizon analysis for Pump.fun.

Research only. No trading rules. Uses the full available token lifetime and
one representative observation per token at/near each checkpoint.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
BASE_URL = f"https://huggingface.co/datasets/{DATASET}/resolve/main"
CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60, 90, 120, 180, 300, 600, 900, 1200, 1800, 2400, 3600, 5400, 7200)


def remote(name: str) -> str:
    return f"{BASE_URL}/{name}"


def ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def dataset_file_urls(path: str) -> list[str]:
    import urllib.request
    api = f"https://huggingface.co/api/datasets/{DATASET}/tree/main/{path}?recursive=true&expand=false"
    with urllib.request.urlopen(api, timeout=30) as response:
        entries = json.load(response)
    files = [e["path"] for e in entries if e.get("type") == "file" and e["path"].endswith(".parquet")]
    if not files:
        raise RuntimeError(f"No parquet files under {path}")
    return [remote(p) for p in files]


def schema(con: duckdb.DuckDBPyConnection, urls: list[str]) -> dict[str, tuple[str, str]]:
    rows = con.execute(
        "SELECT column_name, column_type FROM (DESCRIBE SELECT * FROM read_parquet(?, union_by_name=true))",
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
        raise RuntimeError(f"Missing {name}. Available columns: {', '.join(sorted(cols))}")
    return value


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default="research/results")
    parser.add_argument("--memory", default="4GB")
    args = parser.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    temp = out / ".duckdb_horizon_tmp"
    temp.mkdir(parents=True, exist_ok=True)

    con = duckdb.connect()
    con.execute(f"SET memory_limit='{args.memory}'")
    con.execute("SET preserve_insertion_order=false")
    con.execute(f"SET threads={min(8, max(1, os.cpu_count() or 1))}")
    con.execute(f"SET temp_directory='{str(temp).replace(chr(39), chr(39)*2)}'")

    urls = dataset_file_urls("trades")
    cols = schema(con, urls)
    mint = require("mint", choose(cols, ("mint",)), cols)
    elapsed = require("seconds_since_launch", choose(cols, ("seconds_since_launch",)), cols)
    price = require("price", choose(cols, ("price_sol", "price", "market_price_sol")), cols)

    print(f"Dataset: {DATASET}")
    print(f"Trade shards: {len(urls)}")
    print(f"Columns: mint={mint}, elapsed={elapsed}, price={price}")
    print("Research horizon: FULL AVAILABLE TOKEN LIFETIME")
    print("Checkpoints:", ", ".join(f"{x}s" for x in CHECKPOINTS))

    raw_path = out / "observation_horizon_events.parquet"
    sql = f"""
    COPY (
      WITH raw AS (
        SELECT
          tr.{ident(mint)} AS mint,
          TRY_CAST(tr.{ident(elapsed)} AS DOUBLE) AS t,
          TRY_CAST(tr.{ident(price)} AS DOUBLE) AS price
        FROM read_parquet({json.dumps(urls)}) tr
      ),
      clean AS (
        SELECT mint, t, price
        FROM raw
        WHERE mint IS NOT NULL AND t IS NOT NULL AND t >= 0
          AND price IS NOT NULL AND price > 0
      ),
      ordered AS (
        SELECT *,
          MAX(price) OVER (
            PARTITION BY mint ORDER BY t
            ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING
          ) AS future_max_price,
          MAX(price) OVER (PARTITION BY mint) AS lifetime_peak_price,
          MAX(t) OVER (PARTITION BY mint) AS lifetime_last_trade_s,
          MIN(t) OVER (PARTITION BY mint) AS lifetime_first_trade_s
        FROM clean
      )
      SELECT *,
        CASE WHEN future_max_price > 0 THEN 100.0 * (future_max_price / price - 1.0) END AS remaining_future_upside_pct,
        CASE WHEN lifetime_peak_price > 0 THEN 100.0 * (lifetime_peak_price / price - 1.0) END AS remaining_lifetime_upside_pct,
        lifetime_last_trade_s - lifetime_first_trade_s AS lifetime_seconds
      FROM ordered
    ) TO ? (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 250000)
    """
    print("Scanning complete historical trade paths...")
    con.execute(sql, [str(raw_path)])

    summary = con.execute("""
      WITH base AS (SELECT DISTINCT mint, lifetime_seconds, lifetime_peak_price FROM read_parquet(?)),
      peak AS (
        SELECT mint, MIN(t) AS peak_time_s
        FROM read_parquet(?)
        WHERE price = lifetime_peak_price
        GROUP BY mint
      )
      SELECT
        COUNT(*) AS tokens,
        quantile_cont(lifetime_seconds, .50) AS p50_lifetime_s,
        quantile_cont(lifetime_seconds, .75) AS p75_lifetime_s,
        quantile_cont(lifetime_seconds, .90) AS p90_lifetime_s,
        quantile_cont(lifetime_seconds, .95) AS p95_lifetime_s,
        quantile_cont(lifetime_seconds, .99) AS p99_lifetime_s,
        MAX(lifetime_seconds) AS max_lifetime_s,
        quantile_cont(peak_time_s, .50) AS p50_peak_time_s,
        quantile_cont(peak_time_s, .75) AS p75_peak_time_s,
        quantile_cont(peak_time_s, .90) AS p90_peak_time_s,
        quantile_cont(peak_time_s, .95) AS p95_peak_time_s
      FROM base JOIN peak USING (mint)
    """, [str(raw_path), str(raw_path)]).fetchone()

    # Build one 5-second representative observation per token: latest trade in
    # each bucket. Then select the latest available bucket at or before each
    # checkpoint. This prevents high-frequency tokens from dominating.
    checkpoints_sql = f"""
      WITH bucketed AS (
        SELECT
          mint,
          CAST(FLOOR(t / 5.0) * 5 AS BIGINT) AS bucket_s,
          arg_max(price, t) AS price,
          max(t) AS observed_t,
          arg_max(remaining_future_upside_pct, t) AS future_upside,
          arg_max(remaining_lifetime_upside_pct, t) AS lifetime_upside,
          max(lifetime_seconds) AS lifetime_seconds
        FROM read_parquet(?)
        GROUP BY mint, bucket_s
      ),
      checkpoints(checkpoint_s) AS (
        SELECT * FROM UNNEST([{",".join(str(x) for x in CHECKPOINTS)}])
      ),
      eligible AS (
        SELECT c.checkpoint_s, b.*
        FROM checkpoints c
        JOIN bucketed b ON b.bucket_s <= c.checkpoint_s
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY c.checkpoint_s, b.mint
          ORDER BY b.bucket_s DESC, b.observed_t DESC
        ) = 1
      )
      SELECT
        checkpoint_s,
        COUNT(*) AS tokens_with_observation,
        COUNT(*) FILTER (WHERE lifetime_seconds >= checkpoint_s) AS tokens_alive_at_checkpoint,
        quantile_cont(future_upside, .50) AS future_p50,
        quantile_cont(future_upside, .75) AS future_p75,
        quantile_cont(future_upside, .90) AS future_p90,
        quantile_cont(future_upside, .95) AS future_p95,
        quantile_cont(future_upside, .99) AS future_p99,
        quantile_cont(lifetime_upside, .50) AS lifetime_p50,
        quantile_cont(lifetime_upside, .90) AS lifetime_p90
      FROM eligible
      GROUP BY checkpoint_s
      ORDER BY checkpoint_s
    """
    rows = con.execute(checkpoints_sql, [str(raw_path)]).fetchall()

    def clean(v):
        return None if v is None else round(float(v), 4)

    lifetime = {
      "tokens": int(summary[0]),
      "p50_lifetime_s": clean(summary[1]),
      "p75_lifetime_s": clean(summary[2]),
      "p90_lifetime_s": clean(summary[3]),
      "p95_lifetime_s": clean(summary[4]),
      "p99_lifetime_s": clean(summary[5]),
      "max_lifetime_s": clean(summary[6]),
      "p50_peak_time_s": clean(summary[7]),
      "p75_peak_time_s": clean(summary[8]),
      "p90_peak_time_s": clean(summary[9]),
      "p95_peak_time_s": clean(summary[10]),
    }

    result = {
      "dataset": DATASET,
      "research_policy": {
        "observation_cutoff": None,
        "description": "Full available token lifetime; no artificial 60s cutoff.",
        "checkpoint_method": "One latest trade per token per 5s bucket, then latest bucket at or before checkpoint.",
      },
      "lifetime": lifetime,
      "checkpoints": [
        {
          "checkpoint_s": int(r[0]),
          "tokens_with_observation": int(r[1]),
          "tokens_alive_at_checkpoint": int(r[2]),
          "future_p50_pct": clean(r[3]),
          "future_p75_pct": clean(r[4]),
          "future_p90_pct": clean(r[5]),
          "future_p95_pct": clean(r[6]),
          "future_p99_pct": clean(r[7]),
          "lifetime_p50_pct": clean(r[8]),
          "lifetime_p90_pct": clean(r[9]),
        }
        for r in rows
      ],
      "warning": "Descriptive horizon analysis only. It does not prove profitability or define a trading rule.",
    }

    result_path = out / "observation_horizon_analysis.json"
    result_path.write_text(json.dumps(result, indent=2), encoding="utf-8")

    print("\n=== TOKEN LIFETIME / PEAK ===")
    print(json.dumps(lifetime, indent=2))
    print("\n=== CHECKPOINT PROFILE ===")
    for r in result["checkpoints"]:
        print(
          f'{r["checkpoint_s"]:>5}s '
          f'n={r["tokens_with_observation"]:<8} '
          f'alive={r["tokens_alive_at_checkpoint"]:<8} '
          f'p50={r["future_p50_pct"]} '
          f'p90={r["future_p90_pct"]} '
          f'p99={r["future_p99_pct"]}'
        )
    print(f"\nWrote: {raw_path}")
    print(f"Wrote: {result_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

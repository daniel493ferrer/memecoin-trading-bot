#!/usr/bin/env python3
"""Discover early-life patterns preceding empirically extreme Pump.fun moves."""

from __future__ import annotations

import argparse
import itertools
import json
import math
from pathlib import Path

import duckdb

CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60)
HORIZONS = (300, 900, 3600)
EXTREME_QUANTILES = (0.95, 0.98, 0.99, 0.995)
MIN_TRAIN_N = 500
MIN_COVERAGE = 0.005
MAX_RESULTS = 30

LEAKY = {
    "graduated_at", "seconds_to_graduation", "peak_market_cap_sol",
    "peak_market_cap_at", "data_quality_score", "is_training_ready",
    "is_zombie", "entry_price_usd", "entry_price_20s_usd",
    "entry_price_30s_usd", "entry_price_1m_usd", "launch_snipe_delta_sol",
    "first_trade_price_sol", "supply_bug_corrected", "top10_pct_suspect",
}
SAFE_TOKEN_NUMERIC = {
    "creator_past_tokens", "creator_past_rugs", "initial_buy_tokens",
    "initial_buy_sol", "v_tokens_bonding_curve", "v_sol_bonding_curve",
    "initial_market_cap_sol", "initial_price_sol", "dev_buy_pct",
    "initial_holder_count", "initial_top1_pct", "initial_top5_pct",
    "initial_top10_pct", "initial_gini", "initial_top1_pct_corrected",
    "initial_top5_pct_corrected", "initial_top10_pct_corrected",
    "dev_buy_pct_corrected",
}


def qlit(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def qident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def discover_numeric(con: duckdb.DuckDBPyConnection, path: Path) -> list[str]:
    rows = con.execute(
        "DESCRIBE SELECT * FROM read_parquet(" + qlit(path) + ")"
    ).fetchall()
    out = []
    for name, typ, *_ in rows:
        typ = str(typ).upper()
        if name in LEAKY or name.startswith("forward_") or "peak_" in name:
            continue
        if any(x in typ for x in ("DOUBLE", "FLOAT", "DECIMAL", "INTEGER", "BIGINT")):
            out.append(name)
    return out


def train_bins(con, features, checkpoint):
    out = {}
    for feature in features:
        row = con.execute(
            "SELECT quantile_cont(" + qident(feature) + ",0.20), "
            "quantile_cont(" + qident(feature) + ",0.80) "
            "FROM split_base WHERE split='train' AND checkpoint_s=? "
            "AND " + qident(feature) + " IS NOT NULL",
            [checkpoint],
        ).fetchone()
        if row[0] is not None and row[1] is not None and float(row[0]) < float(row[1]):
            out[feature] = (float(row[0]), float(row[1]))
    return out


def state_expr(feature, lo, hi):
    return (
        "(CASE WHEN " + qident(feature) + " < " + format(lo, ".17g") +
        " THEN 'L' WHEN " + qident(feature) + " <= " + format(hi, ".17g") +
        " THEN 'M' ELSE 'H' END)"
    )


def threshold(con, horizon, q):
    col = qident("forward_max_pct_" + str(horizon) + "s")
    row = con.execute(
        "SELECT quantile_cont(" + col + ",?) FROM split_base "
        "WHERE split='train' AND " + col + " IS NOT NULL",
        [q],
    ).fetchone()
    return float(row[0]) if row[0] is not None and math.isfinite(float(row[0])) else None


def discover_states(con, features, checkpoint, horizon, cutoff):
    label = qident("forward_max_pct_" + str(horizon) + "s")
    base = con.execute(
        "SELECT COUNT(*), AVG(CASE WHEN " + label + ">=? THEN 1.0 ELSE 0.0 END) "
        "FROM split_base WHERE split='train' AND checkpoint_s=?",
        [cutoff, checkpoint],
    ).fetchone()
    base_n, base_p = int(base[0] or 0), float(base[1] or 0)
    if base_n < MIN_TRAIN_N or base_p <= 0:
        return []

    bins = train_bins(con, features, checkpoint)
    candidates = []

    for width in (1, 2, 3):
        for combo in itertools.combinations(bins, width):
            exprs = [state_expr(f, *bins[f]) for f in combo]
            aliases = ", ".join("(" + e + ") AS b" + str(i) for i, e in enumerate(exprs))
            group = ", ".join("(" + e + ")" for e in exprs)
            rows = con.execute(
                "SELECT " + aliases + ", COUNT(*) AS n, "
                "AVG(CASE WHEN " + label + ">=? THEN 1.0 ELSE 0.0 END) AS p "
                "FROM split_base WHERE split='train' AND checkpoint_s=? "
                "AND " + label + " IS NOT NULL "
                "GROUP BY " + group + " HAVING COUNT(*)>=?",
                [cutoff, checkpoint, max(MIN_TRAIN_N, int(base_n * MIN_COVERAGE))],
            ).fetchall()
            for row in rows:
                levels = list(row[:width])
                n = int(row[width])
                p = float(row[width + 1] or 0)
                coverage = n / base_n
                lift = p / base_p if base_p else 0
                candidates.append({
                    "features": list(combo),
                    "levels": levels,
                    "train_n": n,
                    "train_precision": p,
                    "train_coverage": coverage,
                    "train_lift": lift,
                    "train_score": lift * math.sqrt(coverage),
                    "threshold_pct": cutoff,
                })

    candidates.sort(
        key=lambda x: (x["train_score"], x["train_precision"], x["train_n"]),
        reverse=True,
    )
    return candidates[:MAX_RESULTS]


def eval_oos(con, candidates, checkpoint, horizon, cutoff):
    if not candidates:
        return []
    label = qident("forward_max_pct_" + str(horizon) + "s")
    base = con.execute(
        "SELECT COUNT(*), AVG(CASE WHEN " + label + ">=? THEN 1.0 ELSE 0.0 END) "
        "FROM split_base WHERE split='oos' AND checkpoint_s=?",
        [cutoff, checkpoint],
    ).fetchone()
    base_n, base_p = int(base[0] or 0), float(base[1] or 0)
    out = []
    bins = train_bins(con, sorted({f for c in candidates for f in c["features"]}), checkpoint)

    for c in candidates:
        conditions = []
        for feature, level in zip(c["features"], c["levels"]):
            conditions.append("(" + state_expr(feature, *bins[feature]) + ")='" + str(level) + "'")
        condition = " AND ".join(conditions)
        row = con.execute(
            "SELECT COUNT(*), AVG(CASE WHEN " + label + ">=? THEN 1.0 ELSE 0.0 END) "
            "FROM split_base WHERE split='oos' AND checkpoint_s=? AND " + condition,
            [cutoff, checkpoint],
        ).fetchone()
        n, p = int(row[0] or 0), float(row[1] or 0)
        item = dict(c)
        item.update({
            "oos_n": n,
            "oos_precision": p,
            "oos_coverage": n / base_n if base_n else 0,
            "oos_lift": p / base_p if base_p else None,
            "baseline_oos_precision": base_p,
        })
        out.append(item)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", default="research/results/early_move_features.parquet")
    parser.add_argument("--tokens-url", default="https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus/resolve/main/tokens.parquet")
    parser.add_argument("--out", default="research/results/extreme_pattern_discovery.json")
    args = parser.parse_args()

    features = Path(args.features)
    if not features.exists():
        raise SystemExit("Missing " + str(features))

    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET threads=4")

    print("Inspecting feature schema...")
    feature_cols = discover_numeric(con, features)
    print("Numeric candidate columns:", len(feature_cols))

    token_rows = con.execute(
        "DESCRIBE SELECT * FROM read_parquet(" + qlit(args.tokens_url) + ")"
    ).fetchall()
    token_cols = {str(r[0]) for r in token_rows}
    safe = [c for c in SAFE_TOKEN_NUMERIC if c in token_cols]

    feature_sql = ", ".join("f." + qident(c) for c in feature_cols)
    token_sql = ", ".join("t." + qident(c) + " AS token_" + c for c in safe)
    if token_sql:
        token_sql = ", " + token_sql

    print("Building one materialized research table...")
    con.execute(
        "CREATE OR REPLACE TEMP TABLE split_base AS "
        "SELECT f.mint, f.checkpoint_s, f.forward_max_pct_300s, "
        "f.forward_max_pct_900s, f.forward_max_pct_3600s, " + feature_sql +
        token_sql + ", t.detected_at, "
        "CASE WHEN epoch(t.detected_at) <= ("
        "SELECT quantile_cont(epoch(detected_at),0.70) "
        "FROM read_parquet(" + qlit(args.tokens_url) + ")"
        ") THEN 'train' ELSE 'oos' END AS split "
        "FROM read_parquet(" + qlit(features) + ") f "
        "JOIN read_parquet(" + qlit(args.tokens_url) + ") t ON f.mint=t.mint "
        "WHERE f.checkpoint_s IN (" + ",".join(map(str, CHECKPOINTS)) + ")"
    )

    usable = feature_cols + ["token_" + c for c in safe]
    valid = []
    for c in usable:
        row = con.execute(
            "SELECT COUNT(*), COUNT(DISTINCT " + qident(c) + "), STDDEV_SAMP(" +
            qident(c) + ") FROM split_base WHERE split='train' AND " +
            qident(c) + " IS NOT NULL"
        ).fetchone()
        if int(row[0] or 0) >= MIN_TRAIN_N and int(row[1] or 0) >= 5 and row[2] and float(row[2]) > 0:
            valid.append(c)
    print("Usable predictors:", len(valid))

    results = []
    for checkpoint in CHECKPOINTS:
        print("Checkpoint", checkpoint, "s")
        for horizon in HORIZONS:
            for q in EXTREME_QUANTILES:
                cutoff = threshold(con, horizon, q)
                if cutoff is None:
                    continue
                candidates = discover_states(con, valid, checkpoint, horizon, cutoff)
                evaluated = eval_oos(con, candidates, checkpoint, horizon, cutoff)
                for item in evaluated:
                    item.update({
                        "checkpoint_s": checkpoint,
                        "horizon_s": horizon,
                        "extreme_quantile": q,
                    })
                results.extend(evaluated)

    results.sort(
        key=lambda x: (
            x["oos_lift"] if x["oos_lift"] is not None else -1,
            x["oos_precision"],
            x["oos_n"],
        ),
        reverse=True,
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "objective": "discover patterns preceding empirically extreme forward moves",
        "extreme_quantiles": list(EXTREME_QUANTILES),
        "checkpoints_s": list(CHECKPOINTS),
        "horizons_s": list(HORIZONS),
        "split": "chronological 70% train / 30% OOS",
        "predictors": valid,
        "results": results,
        "warning": "Research candidates only; no automatic bot rule.",
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print("Wrote:", out)
    print("Top OOS patterns:")
    for r in results[:20]:
        print(
            str(r["checkpoint_s"]).rjust(2) + "s " +
            str(r["horizon_s"]).rjust(4) + "s q=" +
            str(r["extreme_quantile"]) + " " +
            "+".join(r["features"]) + "=" + ",".join(r["levels"]) +
            " lift=" + str(r["oos_lift"]) +
            " p=" + str(round(r["oos_precision"], 4)) +
            " cov=" + str(round(r["oos_coverage"], 4)) +
            " n=" + str(r["oos_n"])
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

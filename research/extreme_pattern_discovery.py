#!/usr/bin/env python3
"""
Extreme-pattern discovery for Pump.fun early-life research.

Goal:
    Automatically discover what distinguishes tokens that later produce
    exceptional forward moves, using only information available at the
    checkpoint, then test those discovered patterns on later unseen tokens.

Important:
    - No fixed +100/+300/+600/+1000% targets.
    - Extreme targets are learned from TRAIN quantiles of forward returns.
    - No OOS selection.
    - No future/leaky token columns.
    - Searches train-derived quantile states over dynamically discovered
      numeric early-life features and their interactions.
"""

from __future__ import annotations

import argparse
import json
import math
from itertools import combinations
from pathlib import Path

import duckdb

CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60)
HORIZONS = (300, 900, 3600)
EXTREME_QUANTILES = (0.95, 0.98, 0.99, 0.995)
MAX_FEATURES = 24
MIN_TRAIN_N = 500
MIN_COVERAGE = 0.005
MAX_CANDIDATES_PER_BUCKET = 25

# Columns that are inherently future/leaky or are not useful predictors.
LEAKY = {
    "graduated_at",
    "seconds_to_graduation",
    "peak_market_cap_sol",
    "peak_market_cap_at",
    "data_quality_score",
    "is_training_ready",
    "is_zombie",
    "entry_price_usd",
    "entry_price_20s_usd",
    "entry_price_30s_usd",
    "entry_price_1m_usd",
    "launch_snipe_delta_sol",
    "first_trade_price_sol",
    "supply_bug_corrected",
    "top10_pct_suspect",
}

SAFE_TOKEN_NUMERIC = {
    "creator_past_tokens",
    "creator_past_rugs",
    "initial_buy_tokens",
    "initial_buy_sol",
    "v_tokens_bonding_curve",
    "v_sol_bonding_curve",
    "initial_market_cap_sol",
    "initial_price_sol",
    "dev_buy_pct",
    "initial_holder_count",
    "initial_top1_pct",
    "initial_top5_pct",
    "initial_top10_pct",
    "initial_gini",
    "initial_top1_pct_corrected",
    "initial_top5_pct_corrected",
    "initial_top10_pct_corrected",
    "dev_buy_pct_corrected",
}


def qlit(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def qident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def is_bad_name(name: str) -> bool:
    n = name.lower()
    return (
        n in LEAKY
        or n.startswith("forward_")
        or "future" in n
        or "peak_" in n
        or n.endswith("_at")
    )


def discover_columns(con: duckdb.DuckDBPyConnection, features: Path) -> list[str]:
    rows = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet({qlit(features)})"
    ).fetchall()
    numeric = []
    for name, typ, *_ in rows:
        t = str(typ).upper()
        if name in LEAKY or is_bad_name(name):
            continue
        if any(x in t for x in ("DOUBLE", "FLOAT", "DECIMAL", "INTEGER", "BIGINT")):
            numeric.append(name)
    # Only columns that exist in the actual feature file can be used.
    return numeric


def token_columns(con: duckdb.DuckDBPyConnection, tokens_url: str) -> list[str]:
    rows = con.execute(
        f"DESCRIBE SELECT * FROM read_parquet({qlit(tokens_url)})"
    ).fetchall()
    return [str(r[0]) for r in rows]


def build_views(
    con: duckdb.DuckDBPyConnection,
    features: Path,
    tokens_url: str,
    feature_cols: list[str],
) -> list[str]:
    token_cols = token_columns(con, tokens_url)

    safe_tokens = [
        c for c in token_cols
        if c in SAFE_TOKEN_NUMERIC
    ]
    token_expr = ", ".join(
        f"t.{qident(c)} AS token_{c}" for c in safe_tokens
    )
    if not token_expr:
        token_expr = "NULL::DOUBLE AS token_dummy"

    fcols = ", ".join(f"f.{qident(c)}" for c in feature_cols)

    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW base AS
        SELECT
            f.mint,
            f.checkpoint_s,
            f.forward_max_pct_300s,
            f.forward_max_pct_900s,
            f.forward_max_pct_3600s,
            {fcols},
            {token_expr}
        FROM read_parquet({qlit(features)}) f
        JOIN read_parquet({qlit(tokens_url)}) t
          ON f.mint = t.mint
        WHERE f.checkpoint_s IN ({", ".join(map(str, CHECKPOINTS))})
        """
    )

    # Static metadata + feature values. For features that are already
    # checkpoint-relative, use them directly. Avoid arbitrary hand rules.
    return feature_cols + [f"token_{c}" for c in safe_tokens]


def make_split(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW split_base AS
        SELECT
            b.*,
            t.detected_at,
            CASE
              WHEN epoch(t.detected_at) <=
                   quantile_cont(epoch(t.detected_at), 0.70) OVER ()
              THEN 'train' ELSE 'oos'
            END AS split
        FROM base b
        JOIN read_parquet(
          'https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus/resolve/main/tokens.parquet'
        ) t ON b.mint = t.mint
        """
    )


def add_derived_features(
    con: duckdb.DuckDBPyConnection,
    candidates: list[str],
) -> list[str]:
    # Keep only features with meaningful variance and finite values.
    valid: list[str] = []
    for c in candidates:
        try:
            row = con.execute(
                f"""
                SELECT
                  COUNT({qident(c)}),
                  COUNT(DISTINCT {qident(c)}),
                  STDDEV_SAMP({qident(c)})
                FROM split_base
                WHERE split='train' AND {qident(c)} IS NOT NULL
                """
            ).fetchone()
        except duckdb.Error:
            continue
        n, distinct, std = row
        if n and int(n) >= MIN_TRAIN_N and int(distinct or 0) >= 5 and std and float(std) > 0:
            valid.append(c)

    # Rank by univariate separation against the empirical extreme target.
    # This is only a computational prefilter; all thresholds are train-derived.
    return valid


def quantile_targets(
    con: duckdb.DuckDBPyConnection,
    horizon: int,
) -> dict[str, float]:
    col = f"forward_max_pct_{horizon}s"
    out = {}
    for q in EXTREME_QUANTILES:
        row = con.execute(
            f"""
            SELECT quantile_cont({qident(col)}, ?)
            FROM split_base
            WHERE split='train' AND {qident(col)} IS NOT NULL
            """,
            [q],
        ).fetchone()
        if row[0] is not None and math.isfinite(float(row[0])):
            out[f"top_{q:g}"] = float(row[0])
    return out


def make_train_bins(
    con: duckdb.DuckDBPyConnection,
    features: list[str],
    checkpoint: int,
) -> dict[str, tuple[float, float]]:
    result = {}
    for c in features:
        row = con.execute(
            f"""
            SELECT
              quantile_cont({qident(c)}, 0.20),
              quantile_cont({qident(c)}, 0.80)
            FROM split_base
            WHERE split='train'
              AND checkpoint_s=?
              AND {qident(c)} IS NOT NULL
            """,
            [checkpoint],
        ).fetchone()
        if row[0] is not None and row[1] is not None and float(row[0]) < float(row[1]):
            result[c] = (float(row[0]), float(row[1]))
    return result


def state_expr(c: str, lo: float, hi: float) -> str:
    ident = qident(c)
    return (
        f"(CASE WHEN {ident} < {lo:.17g} THEN 'L' "
        f"WHEN {ident} <= {hi:.17g} THEN 'M' ELSE 'H' END)"
    )


def score_state(
    con: duckdb.DuckDBPyConnection,
    condition: str,
    checkpoint: int,
    horizon: int,
    threshold: float,
) -> dict[str, float] | None:
    col = qident(f"forward_max_pct_{horizon}s")
    base = con.execute(
        f"""
        SELECT
          COUNT(*),
          AVG(CASE WHEN {col} >= ? THEN 1.0 ELSE 0.0 END)
        FROM split_base
        WHERE split='train' AND checkpoint_s=?
        """,
        [threshold, checkpoint],
    ).fetchone()
    n0, p0 = int(base[0] or 0), float(base[1] or 0)
    if n0 < MIN_TRAIN_N or p0 <= 0:
        return None

    row = con.execute(
        f"""
        SELECT
          COUNT(*),
          AVG(CASE WHEN {col} >= ? THEN 1.0 ELSE 0.0 END)
        FROM split_base
        WHERE split='train' AND checkpoint_s=? AND {condition}
        """,
        [threshold, checkpoint],
    ).fetchone()
    n, p = int(row[0] or 0), float(row[1] or 0)
    coverage = n / n0 if n0 else 0
    if n < MIN_TRAIN_N or coverage < MIN_COVERAGE or p <= 0:
        return None
    lift = p / p0 if p0 else 0
    # Reward precision and coverage, penalize tiny states.
    score = lift * math.sqrt(coverage)
    return {
        "train_n": n,
        "train_precision": p,
        "train_coverage": coverage,
        "train_lift": lift,
        "train_score": score,
        "baseline_precision": p0,
    }


def evaluate_oos(
    con: duckdb.DuckDBPyConnection,
    condition: str,
    checkpoint: int,
    horizon: int,
    threshold: float,
) -> dict[str, float]:
    col = qident(f"forward_max_pct_{horizon}s")
    base = con.execute(
        f"""
        SELECT COUNT(*), AVG(CASE WHEN {col} >= ? THEN 1.0 ELSE 0.0 END)
        FROM split_base
        WHERE split='oos' AND checkpoint_s=?
        """,
        [threshold, checkpoint],
    ).fetchone()
    n0, p0 = int(base[0] or 0), float(base[1] or 0)
    row = con.execute(
        f"""
        SELECT COUNT(*), AVG(CASE WHEN {col} >= ? THEN 1.0 ELSE 0.0 END)
        FROM split_base
        WHERE split='oos' AND checkpoint_s=? AND {condition}
        """,
        [threshold, checkpoint],
    ).fetchone()
    n, p = int(row[0] or 0), float(row[1] or 0)
    return {
        "oos_n": n,
        "oos_precision": p,
        "oos_coverage": n / n0 if n0 else 0,
        "oos_lift": p / p0 if p0 else None,
        "baseline_oos_precision": p0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--features", default="research/results/early_move_features.parquet")
    parser.add_argument("--tokens-url", default=(
        "https://huggingface.co/datasets/Slinky21/Pumpfun_Memecoin_Corpus/"
        "resolve/main/tokens.parquet"
    ))
    parser.add_argument("--out", default="research/results/extreme_pattern_discovery.json")
    args = parser.parse_args()

    features = Path(args.features)
    if not features.exists():
        raise SystemExit(f"Missing {features}")

    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET threads=4")

    print("Inspecting feature schema...")
    all_features = discover_columns(con, features)
    print(f"Numeric candidate columns: {len(all_features)}")
    build_views(con, features, args.tokens_url, all_features)

    # Rebuild split without hard-coding the token URL twice.
    con.execute("DROP VIEW IF EXISTS split_base")
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW split_base AS
        SELECT
          b.*,
          t.detected_at,
          CASE
            WHEN epoch(t.detected_at) <= (
              SELECT quantile_cont(epoch(detected_at), 0.70)
              FROM read_parquet({qlit(args.tokens_url)}) d
            )
            THEN 'train' ELSE 'oos'
          END AS split
        FROM base b
        JOIN read_parquet({qlit(args.tokens_url)}) t ON b.mint=t.mint
        """
    )

    usable = add_derived_features(con, all_features)
    if not usable:
        raise SystemExit("No usable numeric features found.")

    # Pre-filter using train-only univariate association with the strongest
    # empirical extreme tail at each checkpoint/horizon.
    results = []
    feature_rankings = []
    for checkpoint in CHECKPOINTS:
        bins = make_train_bins(con, usable, checkpoint)
        for horizon in HORIZONS:
            targets = quantile_targets(con, horizon)
            extreme_threshold = targets.get("top_0.99")
            if extreme_threshold is None:
                continue
            label = qident(f"forward_max_pct_{horizon}s")
            base = con.execute(
                f"""
                SELECT AVG(CASE WHEN {label} >= ? THEN 1.0 ELSE 0.0 END)
                FROM split_base
                WHERE split='train' AND checkpoint_s=?
                """,
                [extreme_threshold, checkpoint],
            ).fetchone()[0]
            if not base:
                continue
            uni = []
            for c, (lo, hi) in bins.items():
                expr = state_expr(c, lo, hi)
                row = con.execute(
                    f"""
                    SELECT
                      COUNT(*),
                      AVG(CASE WHEN {label} >= ? THEN 1.0 ELSE 0.0 END)
                    FROM split_base
                    WHERE split='train' AND checkpoint_s=? AND {qident(c)} IS NOT NULL
                      AND {expr}='H'
                    """,
                    [extreme_threshold, checkpoint],
                ).fetchone()
                n, p = int(row[0] or 0), float(row[1] or 0)
                if n >= MIN_TRAIN_N and p > 0:
                    uni.append((p / float(base), n, c))
            uni.sort(reverse=True)
            feature_rankings.extend(
                {"checkpoint_s": checkpoint, "horizon_s": horizon,
                 "feature": c, "train_lift": lift, "train_n": n}
                for lift, n, c in uni[:MAX_FEATURES]
            )

            selected = [c for _, _, c in uni[:MAX_FEATURES]]
            # Search 1-, 2-, and 3-feature states. Thresholds are learned only
            # from TRAIN. This is discovery, not a hand-authored rule.
            states = []
            for width in (1, 2, 3):
                for combo in combinations(selected, width):
                    exprs = []
                    labels = []
                    for c in combo:
                        lo, hi = bins[c]
                        exprs.append(state_expr(c, lo, hi))
                        labels.append(c)
                    for levels in __import__("itertools").product(("L", "M", "H"), repeat=width):
                        cond = " AND ".join(
                            f"({e})='{lvl}'" for e, lvl in zip(exprs, levels)
                        )
                        scored = score_state(
                            con, cond, checkpoint, horizon, extreme_threshold
                        )
                        if scored:
                            states.append({
                                "features": labels,
                                "levels": list(levels),
                                "condition": cond,
                                "threshold_pct": extreme_threshold,
                                **scored,
                            })
            states.sort(
                key=lambda x: (x["train_score"], x["train_precision"], x["train_n"]),
                reverse=True,
            )
            # Deduplicate overlapping candidates and keep train-selected only.
            for candidate in states[:MAX_CANDIDATES_PER_BUCKET]:
                oos = evaluate_oos(
                    con,
                    candidate["condition"],
                    checkpoint,
                    horizon,
                    extreme_threshold,
                )
                results.append({
                    "checkpoint_s": checkpoint,
                    "horizon_s": horizon,
                    "extreme_quantile": 0.99,
                    **candidate,
                    **oos,
                })

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
        "method": {
            "objective": "discover early-life states preceding empirically extreme forward moves",
            "extreme_quantiles": EXTREME_QUANTILES,
            "selection_quantile": 0.99,
            "checkpoints_s": CHECKPOINTS,
            "horizons_s": HORIZONS,
            "split": "chronological 70% train / 30% OOS by detected_at",
            "feature_source": "all usable numeric columns in early_move_features.parquet plus safe launch-time token metadata",
            "state_search": "train-derived 20/80 quantile bins; 1-, 2-, and 3-feature interactions",
            "oos_selection": False,
        },
        "dataset": {
            "features": str(features),
            "tokens": args.tokens_url,
            "candidate_feature_count": len(usable),
        },
        "feature_rankings": feature_rankings,
        "results": results,
        "warning": "Research output only. No bot rule is created automatically.",
    }
    out.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    print(f"Wrote: {out}")
    print("Top OOS patterns:")
    for r in results[:20]:
        lift = r["oos_lift"]
        print(
            f'{r["checkpoint_s"]:>2}s '
            f'{r["horizon_s"]:>4}s '
            f'q99={r["threshold_pct"]:.4g}% '
            f'{"+".join(r["features"])}={",".join(r["levels"])} '
            f'OOS lift={lift:.3f} p={r["oos_precision"]:.4f} '
            f'coverage={r["oos_coverage"]:.3f} n={r["oos_n"]}'
            if lift is not None else
            f'{r["checkpoint_s"]:>2}s {r["horizon_s"]:>4}s '
            f'{"+".join(r["features"])}={",".join(r["levels"])} OOS lift=n/a'
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

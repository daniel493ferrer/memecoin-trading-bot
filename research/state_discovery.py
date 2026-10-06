#!/usr/bin/env python3
"""
Discover early-life states that separate large forward moves.

This stage reuses research/results/early_move_features.parquet and the public
tokens.parquet. It does NOT rescan trades.parquet.

Method:
- token-level chronological split: earliest 70% train, latest 30% OOS;
- derive only information available at each checkpoint;
- define large-move labels at +100/+300/+600/+1000%;
- learn train-only quantile bins for early features;
- test single-feature and two-feature states OOS;
- rank candidates by train precision/uplift while requiring useful coverage;
- report OOS precision, coverage and lift without selecting on OOS results.

This is hypothesis discovery, not a live trading rule.
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
TARGETS = (100.0, 300.0, 600.0, 1000.0)
FEATURES = (
    "trade_rate",
    "buy_share",
    "unique_share",
    "sell_share",
    "peak_premium",
)


def qlit(value: str | Path) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def qident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def percentile_label(q: float) -> str:
    return f"q{int(q * 100)}"


def safe_div(num: str, den: str) -> str:
    return f"CASE WHEN {den} > 0 THEN {num} / {den} ELSE NULL END"


def build_feature_exprs() -> list[str]:
    return [
        f"{safe_div('trade_count', 'checkpoint_s')} AS trade_rate",
        f"{safe_div('buy_count', 'trade_count')} AS buy_share",
        f"{safe_div('unique_traders', 'trade_count')} AS unique_share",
        f"{safe_div('sell_count', 'trade_count')} AS sell_share",
        f"{safe_div('peak_price - price', 'price')} AS peak_premium",
    ]


def make_base_view(con: duckdb.DuckDBPyConnection, features: Path, tokens_url: str) -> None:
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW base AS
        SELECT
            f.mint,
            f.checkpoint_s,
            f.forward_max_pct_300s,
            f.forward_max_pct_900s,
            f.forward_max_pct_3600s,
            f.trade_count,
            f.unique_traders,
            f.buy_count,
            f.sell_count,
            f.price,
            f.peak_price,
            t.detected_at
        FROM read_parquet({qlit(features)}) f
        JOIN read_parquet({qlit(tokens_url)}) t
          ON f.mint = t.mint
        WHERE f.checkpoint_s IN ({", ".join(map(str, CHECKPOINTS))})
          AND f.price > 0
          AND f.trade_count > 0
        """
    )
    exprs = ",\n            ".join(build_feature_exprs())
    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW data AS
        SELECT *, {exprs}
        FROM base
        """
    )


def make_split(con: duckdb.DuckDBPyConnection) -> None:
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW token_dates AS
        SELECT mint, MIN(detected_at) AS detected_at
        FROM data
        GROUP BY mint
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW split_point AS
        SELECT quantile_cont(epoch(detected_at), 0.70) AS cutoff
        FROM token_dates
        """
    )
    con.execute(
        """
        CREATE OR REPLACE TEMP VIEW split_data AS
        SELECT
            d.*,
            CASE
                WHEN epoch(d.detected_at) <= s.cutoff THEN 'train'
                ELSE 'oos'
            END AS split
        FROM data d
        CROSS JOIN split_point s
        """
    )


def thresholds(con: duckdb.DuckDBPyConnection, checkpoint: int) -> dict[str, tuple[float, float]]:
    rows = con.execute(
        f"""
        SELECT
            {", ".join(
                f"quantile_cont({qident(f)}, 0.3333333333) AS {f}_q33, "
                f"quantile_cont({qident(f)}, 0.6666666667) AS {f}_q67"
                for f in FEATURES
            )}
        FROM split_data
        WHERE split = 'train'
          AND checkpoint_s = ?
        """,
        [checkpoint],
    ).fetchone()
    names = [x for f in FEATURES for x in (f"{f}_q33", f"{f}_q67")]
    return {
        name.rsplit("_", 1)[0]: (
            float(rows[i]),
            float(rows[i + 1]),
        )
        for i, name in enumerate(names)
        if rows[i] is not None and rows[i + 1] is not None
    }


def bin_expr(feature: str, lo: float, hi: float) -> str:
    return (
        f"CASE WHEN {qident(feature)} < {lo:.17g} THEN 'low' "
        f"WHEN {qident(feature)} < {hi:.17g} THEN 'mid' ELSE 'high' END"
    )


def build_candidates(
    con: duckdb.DuckDBPyConnection,
    checkpoint: int,
    horizon: int,
    target: float,
) -> list[dict[str, object]]:
    qs = thresholds(con, checkpoint)
    if len(qs) != len(FEATURES):
        return []

    label = f"forward_max_pct_{horizon}s"
    train_conditions: list[tuple[str, str]] = []

    for feature in FEATURES:
        lo, hi = qs[feature]
        b = bin_expr(feature, lo, hi)
        for level in ("low", "mid", "high"):
            train_conditions.append(
                (f"{feature}={level}", f"({b}) = '{level}'")
            )

    for a, b in combinations(FEATURES, 2):
        alo, ahi = qs[a]
        blo, bhi = qs[b]
        ab = bin_expr(a, alo, ahi)
        bb = bin_expr(b, blo, bhi)
        for al in ("low", "mid", "high"):
            for bl in ("low", "mid", "high"):
                train_conditions.append(
                    (
                        f"{a}={al}&{b}={bl}",
                        f"({ab}) = '{al}' AND ({bb}) = '{bl}'",
                    )
                )

    baseline = con.execute(
        f"""
        SELECT
            COUNT(*) AS n,
            AVG(CASE WHEN {qident(label)} >= ? THEN 1.0 ELSE 0.0 END) AS p
        FROM split_data
        WHERE split = 'train' AND checkpoint_s = ?
        """,
        [target, checkpoint],
    ).fetchone()
    base_n = int(baseline[0] or 0)
    base_p = float(baseline[1] or 0.0)

    candidates: list[dict[str, object]] = []
    for state, condition in train_conditions:
        row = con.execute(
            f"""
            SELECT
                COUNT(*) AS n,
                AVG(CASE WHEN {qident(label)} >= ? THEN 1.0 ELSE 0.0 END) AS p
            FROM split_data
            WHERE split = 'train' AND checkpoint_s = ? AND {condition}
            """,
            [target, checkpoint],
        ).fetchone()
        n = int(row[0] or 0)
        p = float(row[1] or 0.0)
        if n < max(250, int(base_n * 0.01)) or base_p <= 0:
            continue
        coverage = n / base_n if base_n else 0.0
        lift = p / base_p if base_p else 0.0
        score = lift * math.sqrt(coverage)
        candidates.append(
            {
                "state": state,
                "condition": condition,
                "train_n": n,
                "train_precision": round(p, 6),
                "train_coverage": round(coverage, 6),
                "train_lift": round(lift, 6),
                "train_score": round(score, 6),
                "baseline_train_precision": round(base_p, 6),
            }
        )

    candidates.sort(key=lambda x: (x["train_score"], x["train_precision"]), reverse=True)
    return candidates[:12]


def evaluate_oos(
    con: duckdb.DuckDBPyConnection,
    candidates: list[dict[str, object]],
    checkpoint: int,
    horizon: int,
    target: float,
) -> list[dict[str, object]]:
    label = f"forward_max_pct_{horizon}s"
    baseline = con.execute(
        f"""
        SELECT
            COUNT(*) AS n,
            AVG(CASE WHEN {qident(label)} >= ? THEN 1.0 ELSE 0.0 END) AS p
        FROM split_data
        WHERE split = 'oos' AND checkpoint_s = ?
        """,
        [target, checkpoint],
    ).fetchone()
    base_n = int(baseline[0] or 0)
    base_p = float(baseline[1] or 0.0)

    out: list[dict[str, object]] = []
    for candidate in candidates:
        row = con.execute(
            f"""
            SELECT
                COUNT(*) AS n,
                AVG(CASE WHEN {qident(label)} >= ? THEN 1.0 ELSE 0.0 END) AS p
            FROM split_data
            WHERE split = 'oos' AND checkpoint_s = ? AND {candidate["condition"]}
            """,
            [target, checkpoint],
        ).fetchone()
        n = int(row[0] or 0)
        p = float(row[1] or 0.0)
        coverage = n / base_n if base_n else 0.0
        lift = p / base_p if base_p else None
        item = dict(candidate)
        item.update(
            {
                "oos_n": n,
                "oos_precision": round(p, 6),
                "oos_coverage": round(coverage, 6),
                "oos_lift": round(lift, 6) if lift is not None else None,
                "baseline_oos_precision": round(base_p, 6),
            }
        )
        out.append(item)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--features",
        default="research/results/early_move_features.parquet",
    )
    parser.add_argument(
        "--tokens-url",
        default=(
            "https://huggingface.co/datasets/"
            "Slinky21/Pumpfun_Memecoin_Corpus/resolve/main/tokens.parquet"
        ),
    )
    parser.add_argument(
        "--out",
        default="research/results/state_discovery.json",
    )
    args = parser.parse_args()

    features = Path(args.features)
    if not features.exists():
        raise SystemExit(f"Missing {features}. Run the research scan first.")

    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET threads=4")

    print("Loading existing feature parquet:", features)
    make_base_view(con, features, args.tokens_url)
    make_split(con)

    split = con.execute(
        """
        SELECT
            MIN(detected_at) AS first_date,
            MAX(detected_at) AS last_date,
            MAX(CASE WHEN split='train' THEN detected_at END) AS train_end,
            MIN(CASE WHEN split='oos' THEN detected_at END) AS oos_start,
            COUNT(DISTINCT mint) AS tokens
        FROM split_data
        """
    ).fetchone()

    results: list[dict[str, object]] = []
    for checkpoint in CHECKPOINTS:
        print(f"Checkpoint {checkpoint}s")
        for horizon in HORIZONS:
            for target in TARGETS:
                candidates = build_candidates(con, checkpoint, horizon, target)
                evaluated = evaluate_oos(
                    con, candidates, checkpoint, horizon, target
                )
                for row in evaluated:
                    results.append(
                        {
                            "checkpoint_s": checkpoint,
                            "horizon_s": horizon,
                            "target_pct": target,
                            **row,
                        }
                    )

    results.sort(
        key=lambda x: (
            x["oos_lift"] if x["oos_lift"] is not None else -1.0,
            x["oos_precision"],
            x["oos_n"],
        ),
        reverse=True,
    )

    summary = {
        "method": {
            "split": "chronological 70% train / 30% OOS by token detected_at",
            "features": list(FEATURES),
            "targets_pct": list(TARGETS),
            "horizons_s": list(HORIZONS),
            "checkpoints_s": list(CHECKPOINTS),
            "state_search": "single feature and two-feature combinations using train-only terciles",
            "selection": "top 12 states per checkpoint/horizon/target by train lift * sqrt(coverage)",
            "oos_rule": "OOS is evaluation only; no OOS selection",
        },
        "dataset": "Slinky21/Pumpfun_Memecoin_Corpus",
        "input": str(features),
        "split_dates": {
            "first": str(split[0]) if split[0] is not None else None,
            "last": str(split[1]) if split[1] is not None else None,
            "train_end": str(split[2]) if split[2] is not None else None,
            "oos_start": str(split[3]) if split[3] is not None else None,
        },
        "tokens": int(split[4] or 0),
        "results": results,
        "warning": (
            "These states are research candidates, not validated trading rules. "
            "The current feature set does not include execution slippage, fees, "
            "forward drawdown or exit quality. A state must survive additional "
            "cost-aware and exit-aware validation before bot integration."
        ),
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    print(f"\nWrote: {out}")
    print("Top OOS candidates:")
    for row in results[:15]:
        print(
            f'{row["checkpoint_s"]:>2}s '
            f'+{row["target_pct"]:.0f}%/{row["horizon_s"]}s '
            f'{row["state"]:<45} '
            f'OOS p={row["oos_precision"]:.4f} '
            f'base={row["baseline_oos_precision"]:.4f} '
            f'lift={row["oos_lift"] if row["oos_lift"] is not None else "n/a"} '
            f'n={row["oos_n"]}'
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

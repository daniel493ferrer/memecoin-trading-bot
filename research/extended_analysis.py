#!/usr/bin/env python3
"""
Extended analysis over the already-generated early_move_features.parquet.

This script intentionally does NOT rescan trades.parquet.

It joins the local trade-derived feature file with tokens.parquet and studies:
- token/name/symbol/metadata structure when those columns exist;
- early-life market structure already present in early_move_features;
- forward-move distributions and exceptional-move rates;
- graduation fields when available.

No trading rule is generated. Results are exploratory and intended to identify
hypotheses worth validating walk-forward.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import duckdb

DATASET = "Slinky21/Pumpfun_Memecoin_Corpus"
TOKENS_URL = (
    "https://huggingface.co/datasets/"
    f"{DATASET}/resolve/main/tokens.parquet"
)
CHECKPOINTS = (5, 10, 15, 20, 30, 45, 60)
FORWARD_WINDOWS = (60, 300, 900, 3600)

NAME_ALIASES = ("name", "token_name", "tokenname", "title")
SYMBOL_ALIASES = ("symbol", "ticker", "token_symbol", "tokensymbol")
URI_ALIASES = ("uri", "metadata_uri", "metadata_url")
DESCRIPTION_ALIASES = ("description", "token_description")
IMAGE_ALIASES = ("image", "image_url", "image_uri", "logo", "logo_url")
GRAD_ALIASES = (
    "graduated",
    "is_graduated",
    "graduation_status",
    "graduation",
    "migrated",
)


def qident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def find_col(columns: dict[str, tuple[str, str]], aliases: tuple[str, ...]) -> str | None:
    for alias in aliases:
        if alias in columns:
            return columns[alias][0]
    return None


def describe(con: duckdb.DuckDBPyConnection, source: str) -> dict[str, tuple[str, str]]:
    rows = con.execute(
        "SELECT column_name, column_type "
        "FROM (DESCRIBE SELECT * FROM read_parquet(?))",
        [source],
    ).fetchall()
    return {str(n).lower(): (str(n), str(t)) for n, t in rows}


def safe_text(expr: str) -> str:
    return f"COALESCE(CAST({expr} AS VARCHAR), '')"


def text_feature_sql(expr: str, prefix: str) -> list[str]:
    text = safe_text(expr)
    return [
        f"LENGTH(TRIM({text})) AS {prefix}_len",
        f"CASE WHEN LENGTH(TRIM({text})) = 0 THEN 0 ELSE "
        f"LENGTH(REGEXP_REPLACE({text}, '[^A-Z]', '', 'g'))::DOUBLE / "
        f"LENGTH(TRIM({text})) END AS {prefix}_upper_ratio",
        f"CASE WHEN LENGTH(TRIM({text})) = 0 THEN 0 ELSE "
        f"LENGTH(REGEXP_REPLACE({text}, '[^0-9]', '', 'g'))::DOUBLE / "
        f"LENGTH(TRIM({text})) END AS {prefix}_digit_ratio",
        f"CASE WHEN LENGTH(TRIM({text})) = 0 THEN 0 ELSE "
        f"LENGTH(REGEXP_REPLACE({text}, '[A-Za-z0-9 ]', '', 'g'))::DOUBLE / "
        f"LENGTH(TRIM({text})) END AS {prefix}_special_ratio",
    ]


def add_category_stats(
    con: duckdb.DuckDBPyConnection,
    features: Path,
    tokens: str,
    name_col: str | None,
    symbol_col: str | None,
    uri_col: str | None,
    desc_col: str | None,
    image_col: str | None,
    grad_col: str | None,
) -> dict[str, object]:
    joins = f"FROM read_parquet(?) f JOIN read_parquet(?) t ON f.mint = t.mint"

    feature_exprs: list[str] = []
    if name_col:
        feature_exprs += text_feature_sql(f"t.{qident(name_col)}", "name")
    if symbol_col:
        feature_exprs += text_feature_sql(f"t.{qident(symbol_col)}", "symbol")

    if name_col:
        name = safe_text(f"t.{qident(name_col)}")
        feature_exprs += [
            f"CASE WHEN LENGTH(TRIM({name})) = 0 THEN 'empty' "
            f"WHEN LENGTH(TRIM({name})) <= 4 THEN 'short' "
            f"WHEN LENGTH(TRIM({name})) <= 10 THEN 'medium' ELSE 'long' END AS name_len_class",
            f"CASE WHEN REGEXP_MATCHES(LOWER({name}), "
            f"'^(test|testcoin|scam|rug|moon|doge|pepe|cat|dog|inu|ai|coin|token|pump|elon)$') "
            f"THEN 'generic_common' ELSE 'other' END AS common_name_flag",
        ]

    if symbol_col:
        symbol = safe_text(f"t.{qident(symbol_col)}")
        feature_exprs += [
            f"CASE WHEN LENGTH(TRIM({symbol})) = 0 THEN 'empty' "
            f"WHEN LENGTH(TRIM({symbol})) <= 4 THEN 'short' "
            f"WHEN LENGTH(TRIM({symbol})) <= 8 THEN 'medium' ELSE 'long' END AS symbol_len_class",
        ]

    if uri_col:
        feature_exprs.append(
            f"CASE WHEN LENGTH(TRIM({safe_text(f't.{qident(uri_col)}')})) > 0 "
            f"THEN 1 ELSE 0 END AS has_uri"
        )
    if desc_col:
        feature_exprs.append(
            f"CASE WHEN LENGTH(TRIM({safe_text(f't.{qident(desc_col)}')})) > 0 "
            f"THEN 1 ELSE 0 END AS has_description"
        )
    if image_col:
        feature_exprs.append(
            f"CASE WHEN LENGTH(TRIM({safe_text(f't.{qident(image_col)}')})) > 0 "
            f"THEN 1 ELSE 0 END AS has_image"
        )
    if not feature_exprs:
        return {"status": "no_branding_or_metadata_columns_found"}

    # Use the existing checkpoint rows; no trade-level source is touched.
    select = [
        "f.checkpoint_s",
        "f.forward_max_pct_60s",
        "f.forward_max_pct_300s",
        "f.forward_max_pct_900s",
        "f.forward_max_pct_3600s",
    ]
    select += feature_exprs
    grad_select = (
        f", t.{qident(grad_col)} AS graduation_raw" if grad_col else ""
    )

    con.execute(
        f"""
        CREATE OR REPLACE TEMP VIEW x AS
        SELECT {", ".join(select)}{grad_select}
        {joins}
        """,
        [str(features), tokens],
    )

    result: dict[str, object] = {
        "status": "ok",
        "columns": {
            "name": name_col,
            "symbol": symbol_col,
            "uri": uri_col,
            "description": desc_col,
            "image": image_col,
            "graduation": grad_col,
        },
        "checkpoint_stats": {},
    }

    categories = [
        "name_len_class",
        "common_name_flag",
        "symbol_len_class",
        "has_uri",
        "has_description",
        "has_image",
    ]
    if grad_col:
        categories.append("graduation_raw")

    for category in categories:
        try:
            rows = con.execute(
                f"""
                SELECT checkpoint_s, CAST({category} AS VARCHAR) AS category,
                       COUNT(*) AS samples,
                       AVG(forward_max_pct_60s) AS avg_60s,
                       quantile_cont(forward_max_pct_60s, 0.5) AS p50_60s,
                       quantile_cont(forward_max_pct_60s, 0.9) AS p90_60s,
                       quantile_cont(forward_max_pct_60s, 0.99) AS p99_60s,
                       AVG(forward_max_pct_300s) AS avg_300s,
                       quantile_cont(forward_max_pct_300s, 0.9) AS p90_300s,
                       quantile_cont(forward_max_pct_900s, 0.9) AS p90_900s,
                       quantile_cont(forward_max_pct_3600s, 0.9) AS p90_3600s
                FROM x
                GROUP BY checkpoint_s, category
                ORDER BY checkpoint_s, category
                """
            ).fetchall()
        except Exception:
            continue

        result["checkpoint_stats"][category] = [
            {
                "checkpoint_s": int(r[0]),
                "category": r[1],
                "samples": int(r[2]),
                "avg_60s_pct": round(float(r[3]), 4) if r[3] is not None else None,
                "p50_60s_pct": round(float(r[4]), 4) if r[4] is not None else None,
                "p90_60s_pct": round(float(r[5]), 4) if r[5] is not None else None,
                "p99_60s_pct": round(float(r[6]), 4) if r[6] is not None else None,
                "avg_300s_pct": round(float(r[7]), 4) if r[7] is not None else None,
                "p90_300s_pct": round(float(r[8]), 4) if r[8] is not None else None,
                "p90_900s_pct": round(float(r[9]), 4) if r[9] is not None else None,
                "p90_3600s_pct": round(float(r[10]), 4) if r[10] is not None else None,
            }
            for r in rows
        ]

    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--features",
        default="research/results/early_move_features.parquet",
    )
    parser.add_argument(
        "--out",
        default="research/results/extended_analysis.json",
    )
    parser.add_argument("--describe", action="store_true")
    args = parser.parse_args()

    features = Path(args.features)
    if not features.exists():
        raise SystemExit(
            f"Missing {features}. Run pumpfun_research.py once first."
        )

    con = duckdb.connect()
    con.execute("SET memory_limit='4GB'")
    con.execute("SET preserve_insertion_order=false")
    con.execute("SET threads=4")

    print("Local features:", features)
    print("Token source:", TOKENS_URL)

    token_cols = describe(con, TOKENS_URL)
    print("\nToken columns:")
    for key, (_, typ) in token_cols.items():
        print(f"  {key}: {typ}")

    if args.describe:
        return 0

    name_col = find_col(token_cols, NAME_ALIASES)
    symbol_col = find_col(token_cols, SYMBOL_ALIASES)
    uri_col = find_col(token_cols, URI_ALIASES)
    desc_col = find_col(token_cols, DESCRIPTION_ALIASES)
    image_col = find_col(token_cols, IMAGE_ALIASES)
    grad_col = find_col(token_cols, GRAD_ALIASES)

    result = add_category_stats(
        con,
        features,
        TOKENS_URL,
        name_col,
        symbol_col,
        uri_col,
        desc_col,
        image_col,
        grad_col,
    )

    result["dataset"] = DATASET
    result["input"] = str(features)
    result["note"] = (
        "This analysis is descriptive/hypothesis-generating. "
        "The common-name flag is only a transparent structural baseline; "
        "it is not a brand detector and is not a trading rule. "
        "Known-brand/logo recognition requires a separate validated metadata/image study."
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(f"\nWrote: {out}")

    # Compact human-readable highlights.
    for category, rows in result.get("checkpoint_stats", {}).items():
        print(f"\n=== {category} ===")
        for row in rows:
            if row["checkpoint_s"] in (5, 10, 20, 60):
                print(
                    row["checkpoint_s"],
                    row["category"],
                    "n=", row["samples"],
                    "p90_300s=", row["p90_300s_pct"],
                    "p90_900s=", row["p90_900s_pct"],
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

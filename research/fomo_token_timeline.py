import json
from collections import defaultdict, Counter
from pathlib import Path
from statistics import mean

INPUT = Path("research/results/fomo_feed_2026-10-06T17-57-16-643Z.jsonl")
OUTPUT = Path("research/results/fomo_token_timeline.json")

events = []

with INPUT.open() as f:
    for line in f:
        try:
            x = json.loads(line)
        except json.JSONDecodeError:
            continue

        if x.get("type") != "alert":
            continue

        events.append(x)

tokens = defaultdict(list)

for e in events:
    key = e.get("tokenAddress") or e.get("token") or "UNKNOWN"
    tokens[key].append(e)

results = []

for address, evs in tokens.items():
    evs.sort(key=lambda x: x.get("ts", 0))

    buys = [e for e in evs if e.get("alertType") == "buy"]
    sells = [e for e in evs if e.get("alertType") == "sell"]
    thesis = [e for e in evs if e.get("alertType") == "thesis"]

    traders = {e.get("trader") for e in evs if e.get("trader")}
    buyers = [e.get("trader") for e in buys if e.get("trader")]
    unique_buyers = set(buyers)
    repeats = len(buyers) - len(unique_buyers)

    buy_volume = sum(float(e.get("usdValue") or 0) for e in buys)
    sell_abs = sum(abs(float(e.get("usdValue") or 0)) for e in sells)

    largest_buy = max(
        buys,
        key=lambda e: float(e.get("usdValue") or 0),
        default=None,
    )

    trader_buy_volume = Counter()
    for e in buys:
        trader = e.get("trader") or "UNKNOWN"
        trader_buy_volume[trader] += float(e.get("usdValue") or 0)

    top_trader = trader_buy_volume.most_common(1)
    top_trader_volume = top_trader[0][1] if top_trader else 0

    first_ts = evs[0].get("ts", 0)
    last_ts = evs[-1].get("ts", 0)
    duration = max(0, (last_ts - first_ts) / 1000)

    realtime = [e for e in evs if not e.get("replay", False)]
    first_realtime = realtime[0].get("ts") if realtime else None

    intervals = []
    for a, b in zip(evs, evs[1:]):
        intervals.append(max(0, (b.get("ts", 0) - a.get("ts", 0)) / 1000))

    sequence = []
    for e in evs:
        t = e.get("alertType", "?")
        symbol = {"buy": "B", "sell": "S", "thesis": "T"}.get(t, "?")
        value = float(e.get("usdValue") or 0)
        trader = e.get("trader") or "?"
        sequence.append(
            f"{symbol}:{trader}:${value:,.0f}"
        )

    # Compare first vs second half of the observed timeline.
    midpoint = first_ts + (last_ts - first_ts) / 2

    first_half = [e for e in evs if e.get("ts", 0) <= midpoint]
    second_half = [e for e in evs if e.get("ts", 0) > midpoint]

    first_buy_volume = sum(
        float(e.get("usdValue") or 0)
        for e in first_half
        if e.get("alertType") == "buy"
    )

    second_buy_volume = sum(
        float(e.get("usdValue") or 0)
        for e in second_half
        if e.get("alertType") == "buy"
    )

    results.append({
        "token": evs[0].get("token"),
        "address": address,
        "first_ts": first_ts,
        "last_ts": last_ts,
        "duration_seconds": round(duration, 2),

        "events": len(evs),
        "buys": len(buys),
        "sells": len(sells),
        "thesis": len(thesis),

        "unique_traders": len(traders),
        "unique_buyers": len(unique_buyers),
        "repeat_buy_events": repeats,

        "buy_volume_usd": round(buy_volume, 2),
        "sell_abs_volume_usd": round(sell_abs, 2),

        "largest_buy_usd": round(
            float(largest_buy.get("usdValue") or 0), 2
        ) if largest_buy else 0,

        "top_buyer": top_trader[0][0] if top_trader else None,
        "top_buyer_volume_usd": round(top_trader_volume, 2),
        "top_buyer_share_pct": round(
            top_trader_volume / buy_volume * 100, 2
        ) if buy_volume else 0,

        "first_realtime_ts": first_realtime,

        "avg_inter_event_seconds": round(mean(intervals), 2)
        if intervals else None,

        "first_half_buy_volume_usd": round(first_buy_volume, 2),
        "second_half_buy_volume_usd": round(second_buy_volume, 2),

        "sequence": sequence,
    })

results.sort(
    key=lambda x: (
        x["unique_buyers"],
        x["buy_volume_usd"],
        x["events"],
    ),
    reverse=True,
)

OUTPUT.write_text(
    json.dumps(results, indent=2, ensure_ascii=False)
)

print("=" * 80)
print("FOMO TOKEN TIMELINE ANALYSIS")
print("=" * 80)
print(f"Alerts: {len(events)}")
print(f"Tokens: {len(results)}")
print()

print(
    f"{'TOKEN':<10} "
    f"{'EV':>3} "
    f"{'BUY':>4} "
    f"{'SELL':>4} "
    f"{'TH':>3} "
    f"{'TRAD':>4} "
    f"{'BUYERS':>6} "
    f"{'BUY USD':>14} "
    f"{'CONC%':>7}"
)

print("-" * 80)

for r in results:
    print(
        f"{str(r['token']):<10} "
        f"{r['events']:>3} "
        f"{r['buys']:>4} "
        f"{r['sells']:>4} "
        f"{r['thesis']:>3} "
        f"{r['unique_traders']:>4} "
        f"{r['unique_buyers']:>6} "
        f"${r['buy_volume_usd']:>13,.0f} "
        f"{r['top_buyer_share_pct']:>6.1f}%"
    )

print()
print("=" * 80)
print("TOP TOKENS BY BUYER CONVERGENCE")
print("=" * 80)

for r in sorted(
    results,
    key=lambda x: (
        x["unique_buyers"],
        x["thesis"],
        x["buy_volume_usd"],
    ),
    reverse=True,
)[:10]:
    print(
        f"{r['token']:<10} "
        f"buyers={r['unique_buyers']} "
        f"repeat={r['repeat_buy_events']} "
        f"thesis={r['thesis']} "
        f"buy=${r['buy_volume_usd']:,.0f} "
        f"concentration={r['top_buyer_share_pct']:.1f}%"
    )

print()
print("=" * 80)
print("TOKEN EVENT SEQUENCES")
print("=" * 80)

for r in results:
    if r["events"] >= 2:
        print()
        print(
            f"{r['token']} "
            f"({r['duration_seconds']:.1f}s, "
            f"{r['unique_buyers']} unique buyers)"
        )
        print(" -> ".join(r["sequence"]))

print()
print("=" * 80)
print(f"Saved: {OUTPUT}")
print("=" * 80)

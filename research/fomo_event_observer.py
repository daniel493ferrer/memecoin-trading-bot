import asyncio
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
import websockets
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.environ["FOMO_API_KEY"]

WS_URL = f"wss://api.fomoapi.io/ws/alerts?key={API_KEY}&chain=solana"

OUT = Path("research/results/fomo_event_observations.jsonl")

# seconds after the FOMO event
OFFSETS = [0, 5, 10, 20, 30, 60, 300]

# Prevent duplicate observation jobs for the same event.
seen = set()


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def get_stats(token: str):
    url = f"https://api.fomoapi.io/v2/token/{token}/stats"
    params = {
        "networkId": "1399811149",
    }

    r = requests.get(
        url,
        params=params,
        headers={"Authorization": f"Bearer {API_KEY}"},
        timeout=15,
    )

    r.raise_for_status()
    return r.json()


def append(record):
    OUT.parent.mkdir(parents=True, exist_ok=True)

    with OUT.open("a", encoding="utf-8") as f:
        f.write(json.dumps(record, separators=(",", ":")) + "\n")


async def observe(alert):
    event_id = alert.get("eventId") or alert.get("id")

    if not event_id or event_id in seen:
        return

    seen.add(event_id)

    token = alert.get("tokenAddress")

    if not token:
        return

    # Prefer execution timestamp when FOMO provides it.
    event_ts_ms = alert.get("execTs") or alert.get("ts")

    if not event_ts_ms:
        return

    event_ts = event_ts_ms / 1000

    base = {
        "eventId": event_id,
        "alertId": alert.get("id"),
        "alertType": alert.get("alertType"),
        "source": alert.get("source"),
        "replay": alert.get("replay", False),
        "trader": alert.get("trader"),
        "userId": alert.get("userId"),
        "token": alert.get("token"),
        "tokenAddress": token,
        "chain": alert.get("chain"),
        "chainId": alert.get("chainId"),
        "tradeId": alert.get("tradeId"),
        "ts": alert.get("ts"),
        "execTs": alert.get("execTs"),
        "positionValueUsd": alert.get("positionValueUsd"),
        "usdValue": alert.get("usdValue"),
        "text": alert.get("text"),
        "observedAt": now_iso(),
    }

    print(
        f"\nFOMO BUY: {alert.get('token')} "
        f"{alert.get('trader')} "
        f"${alert.get('positionValueUsd')}"
    )

    for offset in OFFSETS:
        target = event_ts + offset

        delay = target - time.time()

        if delay > 0:
            await asyncio.sleep(delay)

        try:
            stats = await asyncio.to_thread(get_stats, token)

            record = {
                **base,
                "offsetSeconds": offset,
                "capturedAt": now_iso(),
                "stats": stats,
            }

            append(record)

            w5 = stats.get("windows", {}).get("5m", {})

            print(
                f"  T+{offset:>3}s "
                f"buys={w5.get('buys')} "
                f"sells={w5.get('sells')} "
                f"net=${w5.get('netVolumeUsd')} "
                f"ratio={w5.get('buySellRatio')}"
            )

        except Exception as e:
            append({
                **base,
                "offsetSeconds": offset,
                "capturedAt": now_iso(),
                "error": repr(e),
            })

            print(f"  T+{offset:>3}s ERROR: {e}")


async def main():
    print("=" * 70)
    print("FOMO EVENT OBSERVER")
    print("=" * 70)
    print(f"Output: {OUT}")
    print("Offsets:", OFFSETS)
    print("WebSocket: /ws/alerts")
    print()
    print("Capturing BUY events for 10 minutes...")
    print()

    end = time.time() + 600

    async with websockets.connect(
        WS_URL,
        ping_interval=20,
        ping_timeout=20,
        max_size=4 * 1024 * 1024,
    ) as ws:

        print("CONNECTED")

        async for raw in ws:
            if time.time() >= end:
                break

            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            if msg.get("type") != "alert":
                continue

            # Ignore buffered historical events.
            if msg.get("replay") is True:
                continue

            if msg.get("chain") != "solana":
                continue

            if msg.get("alertType") != "buy":
                continue

            asyncio.create_task(observe(msg))

    print("\n10-minute capture finished.")
    print(f"Results: {OUT}")


if __name__ == "__main__":
    asyncio.run(main())

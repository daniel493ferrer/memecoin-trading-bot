import json
import os
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

INPUT = Path("research/results/fomo_feed_2026-10-06T17-57-16-643Z.jsonl")
OUTPUT = Path("research/results/fomo_trade_details.json")
ENV = Path(".env")

def get_key():
    key = os.environ.get("FOMO_API_KEY")
    if key:
        return key.strip()

    if ENV.exists():
        for line in ENV.read_text().splitlines():
            if line.startswith("FOMO_API_KEY="):
                return line.split("=", 1)[1].strip()

    raise SystemExit("FOMO_API_KEY no encontrado")

KEY = get_key()

HEADERS = {
    "authorization": f"Bearer {KEY}",
    "accept": "application/json",
    "user-agent": "fomo-research/1.0",
}

def get_json(url, retries=4):
    for attempt in range(1, retries + 1):
        req = Request(url, headers=HEADERS)

        try:
            with urlopen(req, timeout=30) as r:
                return r.status, json.loads(r.read().decode())

        except HTTPError as e:
            body = ""
            try:
                body = e.read().decode()
            except Exception:
                pass

            if e.code == 401:
                return 401, {"error": "invalid_api_key"}

            if e.code == 402:
                return 402, {"error": "credits_exhausted"}

            if e.code == 404:
                return 404, {"error": "not_found"}

            if e.code == 503:
                print(f"    503 retryable ({attempt}/{retries})")
                if attempt < retries:
                    time.sleep(2 ** (attempt - 1))
                    continue
                return 503, {"error": "service_unavailable", "body": body}

            return e.code, {"error": f"http_{e.code}", "body": body}

        except (URLError, TimeoutError) as e:
            print(f"    network/timeout ({attempt}/{retries}): {e}")
            if attempt < retries:
                time.sleep(2 ** (attempt - 1))
                continue
            return 0, {"error": str(e)}

    return 0, {"error": "unknown"}

# ------------------------------------------------------------
# 1. Probe API
# ------------------------------------------------------------

print("=" * 70)
print("FOMO API PROBE")
print("=" * 70)

for endpoint in [
    "https://api.fomoapi.io/health",
    "https://api.fomoapi.io/v1",
]:
    status, data = get_json(endpoint, retries=2)
    print()
    print(endpoint)
    print("HTTP:", status)
    print(json.dumps(data, indent=2)[:3000])

    if status in (401, 402):
        raise SystemExit("API key / créditos no permiten continuar.")

print()

# ------------------------------------------------------------
# 2. Load feed
# ------------------------------------------------------------

alerts = []

with INPUT.open() as f:
    for line in f:
        try:
            x = json.loads(line)
        except json.JSONDecodeError:
            continue

        if x.get("type") == "alert" and x.get("tradeId"):
            alerts.append(x)

unique = {}

for x in alerts:
    unique[x["tradeId"]] = x

print("=" * 70)
print("TRADE RECOVERY")
print("=" * 70)
print(f"Alertas con tradeId : {len(alerts)}")
print(f"Trade IDs únicos    : {len(unique)}")
print()

# ------------------------------------------------------------
# 3. Resume previous progress
# ------------------------------------------------------------

results = {}

if OUTPUT.exists():
    try:
        results = json.loads(OUTPUT.read_text())
        print(f"Recuperados previamente: {len(results)}")
    except Exception:
        results = {}

print()

# ------------------------------------------------------------
# 4. Sequential recovery
# ------------------------------------------------------------

for i, (trade_id, alert) in enumerate(unique.items(), 1):

    if trade_id in results:
        print(
            f"[{i}/{len(unique)}] "
            f"{alert.get('token','?'):10} "
            f"{alert.get('alertType','?'):7} "
            f"{alert.get('trader','?'):20} "
            f"SKIP"
        )
        continue

    url = f"https://api.fomoapi.io/v2/trades/{trade_id}"

    print(
        f"[{i}/{len(unique)}] "
        f"{alert.get('token','?'):10} "
        f"{alert.get('alertType','?'):7} "
        f"{alert.get('trader','?'):20}",
        flush=True,
    )

    status, data = get_json(url)

    if status == 200:
        results[trade_id] = {
            "alert": alert,
            "trade": data,
            "http_status": status,
        }
        print(" OK")

    elif status == 404:
        results[trade_id] = {
            "alert": alert,
            "trade": None,
            "http_status": 404,
            "error": "not_found",
        }
        print(" NOT_FOUND")

    elif status == 503:
        print(" FAILED_503")

    elif status == 402:
        raise SystemExit(
            "FOMO API: créditos agotados (HTTP 402)."
        )

    elif status == 401:
        raise SystemExit(
            "FOMO API: API key inválida (HTTP 401)."
        )

    else:
        print(f" FAILED_HTTP_{status}")

    # Guardar progreso después de cada consulta exitosa.
    OUTPUT.write_text(
        json.dumps(results, indent=2, ensure_ascii=False)
    )

    # No bombardear el servicio.
    time.sleep(1.0)

print()
print("=" * 70)
print("RESULTADO")
print("=" * 70)
print(f"Solicitados : {len(unique)}")
print(f"Recuperados : {len(results)}")
print(f"Pendientes  : {len(unique) - len(results)}")
print(f"Archivo     : {OUTPUT}")
print("=" * 70)

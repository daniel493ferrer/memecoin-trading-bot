import fs from 'node:fs';

const readJsonl = (f) =>
  fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);

const alerts = readJsonl('data/fomo_live_alerts.jsonl');
const prices = readJsonl('data/fomo_prices.jsonl').filter((p) => p.priceUsd > 0);

const series = new Map();
for (const p of prices) {
  if (!series.has(p.mint)) series.set(p.mint, []);
  series.get(p.mint).push([p.ts, p.priceUsd]);
}
for (const arr of series.values()) arr.sort((a, b) => a[0] - b[0]);

function firstAtOrAfter(mint, t, maxGap) {
  const arr = series.get(mint);
  if (!arr) return null;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; }
  const s = arr[lo];
  return s && s[0] - t <= maxGap ? s : null;
}
function nearest(mint, t, tol) {
  const arr = series.get(mint);
  if (!arr) return null;
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid][0] < t) lo = mid + 1; else hi = mid; }
  let best = null;
  for (const i of [lo - 1, lo]) {
    const s = arr[i];
    if (s && Math.abs(s[0] - t) <= tol && (!best || Math.abs(s[0] - t) < Math.abs(best[0] - t))) best = s;
  }
  return best;
}

const HORIZONS = [30, 60, 180, 300, 900];
const byMint = new Map();
for (const a of alerts) {
  if (!a.tokenAddress) continue;
  if (!byMint.has(a.tokenAddress)) byMint.set(a.tokenAddress, []);
  byMint.get(a.tokenAddress).push(a);
}

const events = [];
for (const [mint, list] of byMint) {
  list.sort((x, y) => x.receivedAt - y.receivedAt);
  for (const a of list) {
    if (a.alertType !== 'buy' || !(a.usdValue > 0)) continue;
    const t = a.receivedAt;
    const prev = list.filter((b) => b.receivedAt < t && t - b.receivedAt <= 300_000);
    const prevBuys = prev.filter((b) => b.alertType === 'buy');
    const entry = firstAtOrAfter(mint, t, 12_000);
    if (!entry) continue;
    const ret = {};
    for (const h of HORIZONS) {
      const ex = nearest(mint, entry[0] + h * 1000, 6_000);
      ret[h] = ex ? (ex[1] / entry[1] - 1) * 100 : null;
    }
    events.push({
      mint, symbol: a.token, usd: a.usdValue, ret,
      isFirst: !list.some((b) => b.alertType === 'buy' && b.receivedAt < t && t - b.receivedAt <= 1_800_000),
      priorBuyers: new Set(prevBuys.filter((b) => b.trader !== a.trader).map((b) => b.trader)).size,
      thesis5m: prev.filter((b) => b.alertType === 'thesis').length,
    });
  }
}

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const mean = (v) => v.reduce((a, b) => a + b, 0) / (v.length || 1);
const f = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');

function report(title, rows) {
  console.log(`\n== ${title} (eventos: ${rows.length}${rows.length < 30 ? ', POCOS: no confiable' : ''})`);
  console.log('horizonte | n | mediana% | promedio% | ganan>0 | ganan>5% (cubre costos)');
  for (const h of HORIZONS) {
    const v = rows.map((r) => r.ret[h]).filter((x) => x !== null);
    if (!v.length) { console.log(`${String(h).padStart(5)}s | 0`); continue; }
    const w0 = (v.filter((x) => x > 0).length / v.length) * 100;
    const w5 = (v.filter((x) => x > 5).length / v.length) * 100;
    console.log(`${String(h).padStart(5)}s | ${v.length} | ${f(median(v))} | ${f(mean(v))} | ${f(w0, 0)}% | ${f(w5, 0)}%`);
  }
}

const base = [];
for (const [mint, arr] of series) {
  for (let i = 0; i < arr.length; i += 12) {
    const ret = {};
    for (const h of HORIZONS) {
      const ex = nearest(mint, arr[i][0] + h * 1000, 6_000);
      ret[h] = ex ? (ex[1] / arr[i][1] - 1) * 100 : null;
    }
    base.push({ ret });
  }
}

console.log(`alertas: ${alerts.length} | precios: ${prices.length} | tokens con precio: ${series.size} | compras analizables: ${events.length}`);
report('LÍNEA BASE (momentos al azar, sin alerta)', base);
report('TODAS LAS COMPRAS', events);
report('SOLO PRIMERA COMPRA POR TOKEN', events.filter((e) => e.isFirst));
report('compra < $5k', events.filter((e) => e.usd < 5_000));
report('compra $5k-$20k', events.filter((e) => e.usd >= 5_000 && e.usd < 20_000));
report('compra $20k-$100k', events.filter((e) => e.usd >= 20_000 && e.usd < 100_000));
report('compra >= $100k', events.filter((e) => e.usd >= 100_000));
report('0 otros traders compraron antes (5 min)', events.filter((e) => e.priorBuyers === 0));
report('1 otro trader compró antes', events.filter((e) => e.priorBuyers === 1));
report('2+ otros traders compraron antes', events.filter((e) => e.priorBuyers >= 2));
report('con 1+ thesis en los últimos 5 min', events.filter((e) => e.thesis5m > 0));
report('sin thesis reciente', events.filter((e) => e.thesis5m === 0));

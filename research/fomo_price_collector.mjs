// Recolector: escucha alertas FOMO en vivo y guarda el precio real de cada token
// desde el momento de la alerta. NO compra nada. Salida en data/.
import fs from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';

const OUT_DIR = 'data';
fs.mkdirSync(OUT_DIR, { recursive: true });

function loadKey() {
  if (process.env.FOMO_API_KEY) return process.env.FOMO_API_KEY;
  try {
    const txt = fs.readFileSync('.env', 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^\s*FOMO_API_KEY\s*=\s*(.*?)\s*$/);
      if (m) return m[1].replace(/^['"]|['"]$/g, '');
    }
  } catch {}
  return '';
}

const KEY = loadKey();
if (!KEY || KEY === 'TU_API_KEY') {
  console.error('Falta FOMO_API_KEY en .env');
  process.exit(1);
}

const WS_URL = 'wss://api.fomoapi.io/ws/alerts';
const PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const POLL_MS = 5_000;
const TRACK_MS = 30 * 60 * 1000;
const MAX_ACTIVE = 50;

const alertsOut = fs.createWriteStream(path.join(OUT_DIR, 'fomo_live_alerts.jsonl'), { flags: 'a' });
const pricesOut = fs.createWriteStream(path.join(OUT_DIR, 'fomo_prices.jsonl'), { flags: 'a' });

const active = new Map(); // mint -> { symbol, lastBuyAt }
const stats = { buys: 0, sells: 0, thesis: 0, replaySkipped: 0, polls: 0, pollErrors: 0, pricesSaved: 0, noPrice: 0 };
let errLogged = 0;
let sampleShown = false;

function pickPrice(entry) {
  if (!entry) return null;
  const n = Number(entry.usdPrice ?? entry.price);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function snapshot(mints, reason) {
  if (mints.length === 0) return;
  const ts = Date.now();
  try {
    const res = await fetch(`${PRICE_URL}?ids=${mints.join(',')}`, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!sampleShown) {
      sampleShown = true;
      console.log('ejemplo de respuesta de precio:', JSON.stringify(body).slice(0, 300));
    }
    stats.polls++;
    for (const mint of mints) {
      const entryObj = body[mint] ?? body.data?.[mint];
      const price = pickPrice(entryObj);
      if (price === null) stats.noPrice++; else stats.pricesSaved++;
      pricesOut.write(JSON.stringify({ ts, mint, symbol: active.get(mint)?.symbol ?? null, priceUsd: price, createdAt: entryObj?.createdAt ?? null, liquidity: entryObj?.liquidity ?? null, reason }) + '\n');
    }
  } catch (e) {
    stats.pollErrors++;
    if (errLogged < 5) { errLogged++; console.warn('error al pedir precio:', e.message); }
  }
}

let polling = false;
setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    const now = Date.now();
    for (const [mint, info] of active) {
      if (now - info.lastBuyAt > TRACK_MS) active.delete(mint);
    }
    await snapshot([...active.keys()], 'poll');
  } finally {
    polling = false;
  }
}, POLL_MS);

function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  lastMsgAt = Date.now();
  if (msg.type === 'welcome') {
    console.log('conectado a FOMO. filtro:', JSON.stringify(msg.filter), 'realtime:', msg.realtime);
    return;
  }
  if (msg.type !== 'alert') return;
  if (msg.replay === true) { stats.replaySkipped++; return; }

  const receivedAt = Date.now();
  alertsOut.write(JSON.stringify({ receivedAt, ...msg }) + '\n');

  if (msg.alertType === 'thesis') { stats.thesis++; return; }
  if (msg.alertType === 'sell') { stats.sells++; return; }
  if (msg.alertType !== 'buy') return;

  stats.buys++;
  const mint = msg.tokenAddress;
  if (!mint) return;
  const isNew = !active.has(mint);
  if (isNew && active.size >= MAX_ACTIVE) {
    let oldest = null;
    for (const [m, info] of active) if (!oldest || info.lastBuyAt < active.get(oldest).lastBuyAt) oldest = m;
    if (oldest) active.delete(oldest);
  }
  active.set(mint, { symbol: msg.token ?? null, lastBuyAt: receivedAt });
  if (isNew) void snapshot([mint], 'first_buy');
}

let ws = null;
let delay = 1_000;
let lastMsgAt = Date.now();

function connect() {
  const url = `${WS_URL}?key=${encodeURIComponent(KEY)}&chain=solana`;
  ws = new WebSocket(url);
  ws.on('open', () => { delay = 1_000; lastMsgAt = Date.now(); });
  ws.on('message', onMessage);
  ws.on('error', (e) => console.warn('error de conexión FOMO:', e.message));
  ws.on('close', () => {
    console.warn(`FOMO desconectado, reintentando en ${delay / 1000}s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30_000);
  });
}
connect();

setInterval(() => {
  if (ws && Date.now() - lastMsgAt > 70_000) { lastMsgAt = Date.now(); ws.terminate(); }
}, 15_000);

setInterval(() => {
  console.log(new Date().toISOString(), 'activos:', active.size, JSON.stringify(stats));
}, 60_000);

process.on('SIGINT', () => {
  console.log('cerrando...');
  alertsOut.end();
  pricesOut.end(() => process.exit(0));
});

# Guía rápida del bot

## Modo prueba y modo real

- **Por defecto arranca en modo prueba (paper)**: simula compras y ventas con
  precios reales, sin tocar tu dinero. Empieza con **10 SOL simulados**.
- **Modo real**: pon `LIVE_TRADING=true` en `.env` y tu clave privada en
  `wallets.json`. Comprueba tu saldo y espera 10 s antes de operar.
- Cada operación cerrada queda en **`data/paper-trades.csv`** (o
  `data/live-trades.csv`): token, hora y precio de entrada, hora y precio de
  salida, razón de salida, PnL, liquidez y número de holders al entrar.
  Se abre con Excel o Google Sheets.

## 1. Filtros de prevención (si falla uno, no compra)

- **Simulación de venta** (anti-honeypot): cotiza comprar y revender en Jupiter;
  si no hay ruta de venta o la ida y vuelta pierde más de **25 %**, no compra.
- **Mint y freeze authority revocadas**, y sin extensiones trampa de Token-2022
  (hooks que bloquean ventas, delegado permanente, impuesto de transferencia > 10 %,
  pausa de transferencias).
- **Top 10 holders ≤ 30 %** del supply, **sin contar pools** de liquidez.
- **Liquidez mínima $10 000** (`scanner.minLiquidityUsd`).

## 2. Entrada

- Token con **menos de 30 minutos** de vida (`scanner.launch.maxAgeMinutes`).
- Subió **más de 40 % en los últimos 5 minutos** (`scanner.launch.minPriceChange5mPct`).
- **Volumen creciendo**: el de los últimos 5 min supera al de los 5 min anteriores.
- **Compradores creciendo**: compradores únicos de los últimos 5 min (GeckoTerminal)
  por encima de los 5 min anteriores; si GeckoTerminal no responde, se usa el
  número de compras.
- **1 % del capital** por operación (`entry.positionPctOfOperatingCapital`),
  **máximo 5 posiciones** (`entry.maxOpenPositions`).

## 3. Salidas (precio revisado cada 1 segundo)

- **Stop loss −25 %**: vende todo.
- **2x**: vende el **50 %** y el stop del resto sube **al precio de entrada**.
- **5x**: vende el **25 %** del total original.
- **10x**: vende otro **15 %** del original. El **10 %** restante queda como "runner".
- **Trailing stop** desde el precio máximo: **30 %** por debajo de 5x, **20 %**
  entre 5x y 10x, **15 %** por encima de 10x.
- **Por tiempo**: si en **40 minutos** no marca un máximo nuevo, vende.
- **Por volumen**: si el volumen de 5 min cae por debajo del **30 % de su pico** y
  el precio ya bajó de su máximo, vende.

## 4. Salida de emergencia (vende todo al momento)

- La **liquidez cae más de 30 %** desde la entrada.
- **El creador del token vende** (se busca el creador en pump.fun y se vigila su wallet).
- Estas ventas usan **slippage de 25 %** y **priority fee de 0.005 SOL** para entrar
  aunque el precio se desplome.

## 5. Límites de riesgo

- Si la pérdida del día llega al **10 % del capital** con el que empezó el día,
  no abre más operaciones hasta el día siguiente (UTC). Las ventas siguen.
- Si una venta falla: **1 reintento inmediato**; si vuelve a fallar, **alerta**
  (en pantalla y, si conectaste Telegram, en tus "Mensajes guardados") y la
  reintenta cada minuto.

## 6. Resumen diario

Al acabar cada día (UTC) el bot muestra y guarda en `data/daily-summary.csv`:
número de operaciones, win rate, ganancia media, pérdida media y PnL total.
`npm run report` muestra también los últimos 7 días.

## Simulador (probar el bot en segundos)

```bash
npm run simulate                       # 24 horas simuladas
npm run simulate -- --hours 6 --seed 3 # otra duración / otro mercado inventado
```

Inventa memecoins graduadas con historias típicas (runners que hacen 2x–25x,
pump & dump, rugs, honeypots, tokens que se apagan, creadores que venden) y
las pasa por **los mismos filtros, entrada y salidas del bot** con un reloj
acelerado. Al final muestra cuántas compró de cada tipo, por qué rechazó las
demás y el resultado por razón de salida. Las operaciones quedan en
`simulation/data/paper-trades.csv`.

**Sirve para comprobar que el bot hace lo que debe** (y para ver el efecto de
cambiar `config.json`), **no para saber si ganará en el mercado real**: el
resultado depende de cómo se inventa el mercado.

## Cómo arrancarlo

```bash
git pull
npm install
npm run reset-paper
npm start
```

`.env` necesita `HELIUS_API_KEY` (y opcionalmente `TELEGRAM_API_ID`/`TELEGRAM_API_HASH`
+ `npm run telegram-login` para recibir alertas en Telegram).

## Otras estrategias (apagadas, se activan en `config.json`)

- `graduation.enabled`: comprar graduados de pump.fun que aguantan tras graduarse.
- `copy.enabled`: copiar wallets (con `hunter.enabled` las busca solo, e
  `influencers.enabled` lee canales de Telegram).
- `scanner.mode`: `launch` (actual), `graduated`, `pullback` o `momentum`.

**Importante:** ningún bot garantiza ganancias. Prueba en paper antes de usar dinero real.

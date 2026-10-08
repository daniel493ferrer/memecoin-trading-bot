# Guía rápida del bot

## Qué hace

Cada 20 segundos el bot revisa los tokens de Solana que se están moviendo
(fuentes gratuitas: GeckoTerminal y DexScreener). Cuando uno **está subiendo
fuerte ahora mismo**, lo compra y lo vende cuando cae un **20 % desde su
máximo**. No tiene límite de ganancia: si sigue subiendo, lo mantiene.

**Compra un token cuando, en los últimos 5 minutos:**
- subió **+30 % o más**,
- movió **$10 000 o más** de volumen,
- tuvo **40 compras o más**, con más compras que ventas (1.2 compras por venta),
- tiene **$15 000 o más** de liquidez (para poder vender luego),
- y pasa la revisión de seguridad: nadie puede crear más tokens ni congelarlos,
  y los 10 mayores dueños no tienen más del 35 %.

**Vende cuando:**
- cae **20 % desde su precio más alto** (o 20 % desde la compra si nunca subió),
- o pasa **1 hora** sin que ocurra lo anterior.

**Dinero:** hasta **3 tokens a la vez**, cada uno con el **25 % del capital**.
El **25 % restante es reserva** y nunca se usa. Si en un día se pierden
**0.1 SOL**, deja de comprar hasta el día siguiente (las ventas siguen).

## Cómo arrancarlo

```bash
git pull
npm install
npm start
```

Tu archivo `.env` necesita:

```
HELIUS_API_KEY=tu-clave-de-helius
LIVE_TRADING=false
```

PumpPortal **ya no hace falta** (el escáner no usa datos de pago).

## Modo prueba y modo real

| | Modo prueba (`LIVE_TRADING=false`) | Modo real (`LIVE_TRADING=true`) |
|---|---|---|
| Dinero | Simulado (empieza con 1 SOL) | Tu SOL real |
| Necesita `wallets.json` | No | Sí, con tu clave privada |
| Registro de operaciones | `logs/paper-trades.jsonl` | `logs/trades.jsonl` |

Para pasar a real: pon tu clave privada en `wallets.json` (copia
`wallets.example.json`), cambia `LIVE_TRADING=true` en `.env` y arranca. El bot
comprueba tu saldo y espera 10 segundos antes de operar (Ctrl+C para cancelar).

## Qué verás en pantalla

| Mensaje | Significa |
|---|---|
| `scanner: 120 tokens checked, 2 pumping per rules` | Ciclo de revisión hecho |
| `XYZ pumping: +45% 5m ...` | Encontró un token que cumple las reglas |
| `[PAPER] BOUGHT XYZ` | Compró (simulado) |
| `XYZ: trailing stop hit` | Cayó 20 % desde su máximo, vende |
| `[PAPER] CLOSED XYZ ... PnL` | Vendió; muestra la ganancia o pérdida |
| `skip XYZ: safety rejected` | Lo descartó por seguridad |

## Ver resultados

```bash
npm run report
```

Muestra cuántas operaciones ganaron, cuánto se ganó o perdió en total y el
saldo de la cuenta de prueba. Todo lo que el escáner vio queda en
`data/scanner.jsonl`.

## Ajustar las reglas

Todo está en `config.json`:

| Quieres... | Cambia |
|---|---|
| Comprar subidas más fuertes | `scanner.minPriceChange5mPct` (ej. 50) |
| Exigir más actividad | `scanner.minBuys5m`, `scanner.minVolume5mUsd` |
| Vender antes o después en la caída | `exit.trailingStop.trailPct` y `exit.stopLossPct` |
| Cambiar el tamaño de cada compra | `entry.positionPctOfOperatingCapital` (% del capital sin la reserva) |
| Cambiar la reserva | `entry.reservePct` |
| Cambiar cuántos tokens a la vez | `entry.maxOpenPositions` |
| Cambiar el límite de pérdida diaria | `risk.maxDailyLossSol` |

Reinicia el bot (Ctrl+C y `npm start`) después de cambiar algo.

## Si algo falla

| Mensaje | Solución |
|---|---|
| `scanner: no feed returned any token` | Revisa tu conexión a internet |
| `Helius rejected the RPC request (401 ...)` | Tu `HELIUS_API_KEY` es incorrecta: cópiala de dashboard.helius.dev, sin comillas ni espacios |
| `GeckoTerminal rate limit hit` | Normal de vez en cuando; se pausa 60 s solo |
| `safety rejected: mint account unavailable (...)` | Problema con Helius; el texto entre paréntesis dice cuál |
| `no Jupiter route` | Jupiter no encontró cómo comprar o vender ese token; se reintenta solo |

**Importante:** el bot no garantiza ganancias. Pruébalo en modo prueba antes
de usar dinero real, y nunca pongas más de lo que estés dispuesto a perder.

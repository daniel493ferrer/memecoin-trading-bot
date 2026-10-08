# Guía rápida del bot

## Qué hace

Cada 20 segundos el bot revisa los tokens de Solana que se están moviendo
(fuentes gratuitas: GeckoTerminal y DexScreener). Cuando uno **está subiendo
fuerte ahora mismo**, lo compra y lo vende cuando cae un **20 % desde su
máximo**. No tiene límite de ganancia: si sigue subiendo, lo mantiene.

**Compra un token solo si TODO se cumple** (tendencia confirmada, no pico):
- tiene **1 hora de vida o más** (la mayoría muere en su primera hora),
- **$30 000+ de liquidez** y capitalización menor de $20M (espacio para crecer),
- subió **+40 % o más en la última hora** con **$100 000+ de volumen** en esa hora,
- **sigue subiendo ahora**: entre **+5 % y +40 % en 5 min** (más de +40 % es un pico:
  comprarlo es comprar el techo, y los datos dicen que eso pierde),
- el volumen de los últimos 5 min va **por encima del ritmo de la hora** (el interés
  acelera, no se apaga), con **50+ compras** y **1.3 compras por venta**,
- pasa la seguridad: nadie puede crear más tokens ni congelarlos, y los 10 mayores
  dueños no tienen más del 30 %.

**Vende así:**
- **−25 %** desde la compra: corta la pérdida.
- Al llegar a **2x**: vende la **mitad** (recuperas lo invertido; el resto va gratis).
- Desde **1.5x**, si cae **25 % desde su máximo**: vende el resto. Sin tope de ganancia.
- A las **4 horas** sale si nada de lo anterior pasó.

**Dinero:** hasta **3 tokens a la vez**, cada uno con el **25 % del capital**.
El **25 % restante es reserva** y nunca se usa. Si en un día se pierden
**0.25 SOL**, deja de comprar hasta el día siguiente (las ventas siguen).

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

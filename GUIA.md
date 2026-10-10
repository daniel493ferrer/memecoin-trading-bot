# Guía rápida del bot

## Qué hace

Cada 20 segundos el bot revisa los tokens que se están moviendo en **Solana,
Base, BNB Chain y Robinhood Chain**
(fuentes gratuitas: GeckoTerminal y DexScreener). Cuando uno **está subiendo
fuerte ahora mismo**, lo compra y lo vende cuando cae un **20 % desde su
máximo**. No tiene límite de ganancia: si sigue subiendo, lo mantiene.

**Modo actual: `pullback` (comprar el rebote).** Compra un token solo si:
- **subió +100 % o más en 6 horas** (es un token fuerte),
- **está corrigiendo**: en la última hora cayó entre **−10 % y −40 %**
  (un descanso, no un desplome),
- **empieza a rebotar**: entre **+2 % y +25 % en 5 minutos**,
- hay volumen real y **más compras que ventas**,
- pasa la revisión de seguridad.

La idea: los que compran cuando "ya está subiendo" llegan tarde y pierden
(lo confirmaron ~15 operaciones de prueba: 1 ganadora). Aquí se compra la
corrección de un token que ya demostró fuerza, más barato que el pico.

El modo anterior sigue disponible: `config.json` → `scanner.mode: "momentum"`.

**Vende así:**
- **−15 %** desde la compra: corta la pérdida.
- Al llegar a **2x**: vende la **mitad** (recuperas lo invertido; el resto va gratis).
- Desde **1.5x**, si cae **25 % desde su máximo**: vende el resto. Sin tope de ganancia.
- A las **4 horas** sale si nada de lo anterior pasó.

**Dinero:** hasta **3 tokens a la vez**, cada uno con el **25 % del capital**.
El **25 % restante es reserva** y nunca se usa. Si en un día se pierden
**0.25 SOL**, deja de comprar hasta el día siguiente (las ventas siguen).

## Tokens graduados (pausada: `graduation.enabled: false`)

Cuando un token de pump.fun **se gradúa** (completa su curva y pasa a PumpSwap):
1. El bot **no compra en el momento de graduarse**: ahí venden los primeros.
2. Toma el precio **1 minuto después** y espera **5 minutos**.
3. **Compra** solo si en ese tiempo: **no cayó más de 10 %**, **no está cayendo
   ahora**, hay **más compras que ventas** (1.2 por venta) y **$5 000+ de volumen
   en 5 min**, y pasa la revisión de seguridad.
4. Sale con las reglas de siempre.

Los avisos de graduación de PumpPortal son gratis. Todo queda en `data/graduation.jsonl`.
Se ajusta en `config.json` → `graduation`.

## Copy trading automático (copiar wallets que ganan)

**No tienes que buscar wallets.** El bot las encuentra solo:

1. Cuando un token de Solana sube **+300 % en 6 horas** (un ganador claro), el
   bot lee su historial en la blockchain y anota quién lo **compró al menos 3x
   más barato** que el precio actual. Ignora a los que compraron en el primer
   segundo: son el creador y sus bots, imposibles de copiar.
2. Si la **misma wallet** aparece comprando temprano en **2 ganadores distintos**,
   pasa a ser **líder** y el bot **copia sus compras** desde ese momento
   (máximo 15 líderes).
3. **Señal de consenso:** el bot **solo compra cuando 2 o más líderes compran el
   mismo token en menos de 5 minutos** (`copy.minLeadersAgree`). Una sola wallet
   puede ser suerte o una trampa; varias a la vez es una señal fuerte.
   Pon `1` si quieres copiar cada compra de cada líder.
4. Cuando el líder vende la mitad o más, el bot vende. Los stops normales siguen.
5. Si después de **4 operaciones copiadas** una wallet da pérdida, **el bot la
   descarta solo**.

En pantalla verás `hunter: ...` cuando analiza ganadores y `new leader` cuando
empieza a copiar a alguien. Todo queda guardado en `data/leaders.json` y se
conserva al reiniciar. `npm run report` muestra **"by copied wallet"**.

Al principio tarda: necesita ver varios ganadores para encontrar wallets que se
repitan (de unas horas a un día). Usa tu clave de Helius; el plan gratuito
alcanza.

Si quieres añadir wallets a mano además de las automáticas: `config.json` →
`copy.wallets` con `{ "address": "...", "label": "nombre" }`.

## Señales de influencers (Telegram)

El bot puede leer **canales de Telegram de "calls"** con tu propia cuenta y
contar cada token que publiquen como **un voto** en el consenso.

- **Nunca compra solo porque un influencer lo diga**: necesita además al menos
  **una wallet líder comprándolo** en los mismos 5 minutos
  (`influencers.requireWalletVote`). Comprar solo por el aviso pierde de media,
  porque el influencer y su grupo compraron antes.
- Ejemplo: canal publica el token + una wallet líder lo compra = **compra**.

**Cómo activarlo (una sola vez):**
1. Entra en https://my.telegram.org → "API development tools" → crea una app.
   Copia el `api_id` y el `api_hash`.
2. Añádelos a tu `.env`:
   ```
   TELEGRAM_API_ID=123456
   TELEGRAM_API_HASH=abcdef...
   ```
3. Inicia sesión: `npm run telegram-login` (te pide tu número y el código que
   te manda Telegram). Se guarda en `data/telegram.session`. **No lo compartas**:
   da acceso a tu Telegram.
4. Pon los canales en `config.json` → `influencers.channels`, por ejemplo
   `["nombredelcanal", "otrocanal"]` (el nombre que sale en t.me/nombredelcanal).
5. `npm start`. Verás `influencers: canal posted ...` cada vez que publiquen.

Todo lo que publican queda en `data/influencers.jsonl`.

## Varias redes

- **Solana** opera en modo prueba y en modo real.
- **Base, BNB y Robinhood** funcionan **solo en modo prueba**: sirven para medir en
  qué red gana más la estrategia antes de construir compras reales ahí.
- En esas redes se revisa antes de "comprar" que el token no sea una trampa
  (honeypot, impuestos ocultos) con GoPlus, que es gratis.
- `npm run report` muestra al final **"by chain"**: % de aciertos y rendimiento por red.
- Para quitar o añadir redes: `config.json` → `scanner.chains`. Al arrancar, el
  bot muestra `DexScreener chain ids seen...` con los nombres exactos de redes.

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

## Empezar la prueba desde cero

```bash
npm run reset-paper
```

Borra el saldo simulado y archiva las operaciones de prueba anteriores (así el
límite de pérdida diaria vuelve a cero). No toca nada del modo real.

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

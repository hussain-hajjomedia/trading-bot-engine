## XAUUSD PHASE 1 TRADING PLAN (FOR AI ENGINE)

This is a **Phase 1, ultra‑simple, production‑ready spec** for an AI trading agent focused **only on XAUUSD**, using **intraday + short swing** logic.  
Goal: **few, high‑quality trades**, risk **0.5–1% per trade**, easy to backtest manually, and easy to port into your existing `indicators.js` style.

---

## 1. Scope & Philosophy

- **Instrument**: `XAUUSD` (spot gold vs USD) only.
- **Style**: 
  - Intraday and short swing trades (holding from hours to a couple of days).
  - Trend‑following **pullback** system (buy dips in uptrend, sell rallies in downtrend).
- **Risk profile**:
  - Per‑trade risk capped at **0.5–1.0%** of account.
  - Fewer trades, but each trade must have:
    - Clear higher‑timeframe trend alignment.
    - Volatility‑aware SL (using ATR).
    - Simple R‑multiple TPs.
- **Complexity**:
  - **Phase 1 is intentionally simple**: no Supertrend, no order blocks, no FVGs.
  - Only the most standard tools used by top trend traders in gold: **EMAs, ATR, simple RSI filter**.

---

## 2. Timeframes, History & Inputs

The engine will use **4 timeframes**, all in candles (OHLCV):

- **1D (Daily)** – Macro bias filter.
- **4H** – Primary swing trend & main volatility reference (ATR).
- **1H** – Intraday trend & pullback detection.
- **15m** – Execution timing (exact entry, SL/TP snapshot).

### 2.1 History length per timeframe

You can continue to feed **up to 500 candles** per timeframe as you do for crypto.  
Internally, the logic will mostly rely on:

- **1D**: last **200** bars (≈ 1 year).
- **4H**: last **250** bars (≈ 40 days).
- **1H**: last **300** bars (≈ 2 weeks).
- **15m**: last **400** bars (≈ 4 days).

Implementation detail:

- Input payload (similar style to `indicators.js`):
  - `kline_15m`: up to 500 15m candles.
  - `kline_1h`: up to 500 1h candles.
  - `kline_4h`: up to 500 4h candles.
  - `kline_1d`: up to 500 1d candles.
- Engine **normalizes and slices** to the last N bars internally; older data is ignored in Phase 1.

---

## 3. Indicators (Phase 1 Set)

All indicators are computed from **close prices** (and highs/lows for ATR) of each timeframe:

### 3.1 Exponential Moving Averages (EMAs)

On **each timeframe (1D, 4H, 1H, 15m)**:

- `EMA20` – short‑term trend / “fast value”.
- `EMA50` – medium‑term trend / main value zone.
- `EMA200` – long‑term trend filter.

*(On 15m, EMA200 is optional for Phase 1, but keep it for consistency.)*

### 3.2 Average True Range (ATR)

- `ATR14` on each timeframe, with **primary focus on 4H**:
  - `ATR4H = ATR14_4H` is used for:
    - SL distance.
    - R‑multiples for TP.

### 3.3 RSI (simple filter, not a signal generator)

- `RSI14` on **1H** only:
  - Used as a **soft filter**:
    - Avoid **new longs** when `RSI1H > 75` (very stretched).
    - Avoid **new shorts** when `RSI1H < 25`.
  - Can be disabled by a flag if needed; it is not core to the signal logic.

No MACD, Supertrend, OB, FVG, etc. in Phase 1.

---

## 4. Trend & Bias Logic (Simple 3‑Layer Model)

We define **bias** based on D1 + 4H + 1H.  
All comparisons use the **latest closed candle** on that timeframe.

### 4.1 Daily (1D) Macro Bias

- **Bullish D1 bias** if:
  - `Close_D1 > EMA50_D1`, and  
  - `EMA50_D1 > EMA200_D1`.

- **Bearish D1 bias** if:
  - `Close_D1 < EMA50_D1`, and  
  - `EMA50_D1 < EMA200_D1`.

- Otherwise: **D1 bias = NEUTRAL**.

### 4.2 4H Primary Trend

- **Bullish 4H trend** if:
  - `Close_4H > EMA50_4H`, and  
  - `EMA20_4H > EMA50_4H`.

- **Bearish 4H trend** if:
  - `Close_4H < EMA50_4H`, and  
  - `EMA20_4H < EMA50_4H`.

- Else: **4H trend = RANGE/CHOP** → **no new trades** in Phase 1.

### 4.3 1H Alignment

- For **long bias**:
  - `Close_1H > EMA50_1H`.

- For **short bias**:
  - `Close_1H < EMA50_1H`.

If 1H is clearly **against** the 4H trend, engine skips new trades.

### 4.4 Combined Bias & Confidence

- **Bias**:
  - If **D1 bullish** AND **4H bullish** → **Bias = BUY**.
  - If **D1 bearish** AND **4H bearish** → **Bias = SELL**.
  - Else → **Bias = HOLD** (no trade in Phase 1).

- **Bias Confidence (0–1)**:
  - D1, 4H, and 1H all aligned in the same direction → **0.9**.
  - D1 & 4H aligned, 1H “not against” (e.g. just crossed EMA50) → **0.7**.
  - Everything else → ≤ **0.4** (no trade).

---

## 5. Trade Setup & Entry Rules

We combine **1H pullback** + **15m trigger** in the direction of the higher‑timeframe bias.

### 5.1 Long Setup (mirror for Shorts)

**Context requirements:**

1. `Bias = BUY` (from D1+4H).
2. `4H trend = Bullish` (as defined above).
3. `Close_1H > EMA50_1H` (1H aligned with uptrend).
4. Optional RSI filter: `RSI1H ≤ 75`.

If any of these fail → **no long setup**.

**1H Pullback condition (single‑candle logic):**

- Latest 1H candle:
  - `Low_1H <= EMA20_1H`  (price dipped into or below EMA20), and
  - `Close_1H >= EMA20_1H` (closed back above EMA20).

*(Optional stricter rule: reject if `Close_1H < EMA50_1H`.)*

This represents a **buy‑the‑dip into the value zone** in an uptrend.

**15m Long Entry Trigger (after 1H pullback):**

- Latest 15m candle:
  - `Close_15m > EMA20_15m`.
  - For extra confirmation (optional): `EMA8_15m > EMA21_15m`.

- **Entry Price**:
  - Set **`Entry = Close_15m`** of the **first candle** that meets the 15m trigger after a valid 1H pullback.

### 5.2 Short Setup

Mirror logic:

**Context:**

1. `Bias = SELL`.
2. `4H trend = Bearish`.
3. `Close_1H < EMA50_1H`.
4. Optional filter: `RSI1H ≥ 25`.

**1H Pullback:**

- Latest 1H candle:
  - `High_1H >= EMA20_1H`  (price rallied into/above EMA20), and
  - `Close_1H <= EMA20_1H` (closed back below EMA20).

**15m Short Trigger:**

- Latest 15m candle:
  - `Close_15m < EMA20_15m`.
  - Optional: `EMA8_15m < EMA21_15m`.

- **Entry Price**:
  - `Entry = Close_15m` of the first trigger candle after valid 1H pullback.

---

## 6. Stop Loss (SL) – Simple ATR‑Based Rule

### 6.1 Core idea

- Use **4H ATR14** as a **universal volatility reference**.
- Let `ATR4H = ATR14_4H` (latest fully closed 4H candle).
- Define SL distance:
  - `SL_dist = 1.5 × ATR4H`.

### 6.2 SL placement

- **Long trades**:
  - `SL_raw = Entry - SL_dist`.
  - Optional simplification:
    - Look at last **5** 1H lows, find `SwingLow1H = min(last 5 lows)`.
    - Final SL: `SL = min(SL_raw, SwingLow1H)` (choose the **lower** of the two for more protection).
  - For the cleanest Phase 1 implementation, you can **start with `SL = SL_raw` only** and add swing logic later.

- **Short trades**:
  - `SL_raw = Entry + SL_dist`.
  - Optional: compare with max of last 5 1H highs and use the higher one; or just use `SL_raw` in Phase 1.

### 6.3 Risk link (0.5–1% of account)

The engine doesn’t need to compute position size yet, but the logic is:

- Let `R = |Entry - SL|` (in price units).
- `RiskPerTradeUSD = RiskPercent × AccountEquity` where `RiskPercent ∈ [0.005, 0.01]`.
- `PositionSize = RiskPerTradeUSD / R`.

For now, the engine should **output `Entry`, `SL`, and `R`** so you can do sizing externally or later.

---

## 7. Take Profit (TP) – Simple R‑Multiples

Define:

- `R = |Entry - SL|`.

For **all trades**:

- **TP1**:
  - Long:  `TP1 = Entry + 1.3 × R`.
  - Short: `TP1 = Entry - 1.3 × R`.

- **TP2**:
  - Long:  `TP2 = Entry + 2.0 × R`.
  - Short: `TP2 = Entry - 2.0 × R`.

Execution guideline (trading procedure, not engine requirement):

- Close **50%** of position at **TP1**, move SL to **breakeven**, let remaining 50% run towards **TP2**.

No extra structure‑based TPs in Phase 1; R‑multiples are enough to backtest and reason about.

---

## 8. Signal Quality & Execution Flags

The engine produces **signals** and **confidence** for your Google Sheet.

### 8.1 Final Signal

- **`Final Signal`** values:
  - `BUY` – if all of the following are true:
    - `Bias = BUY` (D1+4H).
    - 4H bullish trend.
    - 1H aligned (`Close_1H > EMA50_1H`).
    - Valid 1H pullback.
    - Fresh 15m long trigger.
  - `SELL` – symmetric conditions for shorts.
  - `HOLD` – otherwise (no new trade).

### 8.2 Final Signal Confidence (0–1)

Simple, discrete levels:

- If D1, 4H, and 1H all aligned and clean 1H pullback → **0.85–0.9**.
- If D1 & 4H aligned, 1H just regained alignment (e.g. just crossed EMA50) → **0.7**.
- If conditions are weak or mixed → **≤ 0.4**, and engine sets `Final Signal = HOLD`.

You can also set `Close Confidence = Final Signal Confidence` in Phase 1, or repurpose it later.

### 8.3 Execute Order flag

- **`Execute Order`**:
  - `YES` if:
    - `Final Signal` is `BUY` or `SELL`, and
    - `Final Signal Confidence >= 0.7`, and
    - This is the **first 15m trigger** after a new 1H pullback (avoid duplicate rows for the same exact setup).
  - `NO` otherwise.

---

## 9. Suggested Google Sheet Columns (Phase 1)

One **row per signal** (per trigger), captured at the **close of the 15m trigger candle**.

### 9.1 Identity & timing

- `Timestamp` – timestamp of 15m trigger candle close.
- `Symbol` – `XAUUSD`.
- `Timeframe_Trigger` – `15m`.

### 9.2 Trend & bias context

- `Bias` – BUY / SELL / HOLD.
- `Bias_Confidence` – numeric (e.g. 0.9, 0.7).
- `Trend_4H` – BULL / BEAR / RANGE.
- `Align_1H` – ABOVE_EMA50 / BELOW_EMA50 / NEUTRAL.
- Optional: `RSI_1H` – numeric value of RSI14 on 1H.

### 9.3 Signal & execution

- `Final_Signal` – BUY / SELL / HOLD.
- `Final_Signal_Confidence` – 0–1.
- `Execute_Order` – YES / NO.
- `AI_Analysis` – short text summary (e.g. “D1+4H bullish, 1H pullback to EMA20, 15m bullish trigger”).

### 9.4 Prices & risk

- `Last_Price` – latest price at logging (same as entry in practice).
- `Entry_Price` – trigger candle close on 15m.
- `SL` – numeric SL.
- `TP1` – numeric TP1.
- `TP2` – numeric TP2.
- `R_Distance` – `abs(Entry_Price - SL)`.
- `ATR4H` – latest ATR14 on 4H.
- `SL_Distance_ATR` – `R_Distance / ATR4H`.

### 9.5 Optional structure info (future phases)

Keep (but can be simple placeholders in Phase 1):

- `4H_Swing_Support` – (for now can be null or simple last swing low).
- `4H_Swing_Resistance` – (for now can be null or simple last swing high).
- `Market_Structure` – simple label: TREND_UP / TREND_DOWN / RANGE (derived from 4H).

### 9.6 Meta / evaluation

- `Manual_Backtest` – WIN / LOSS / SKIP / NOTE.
- `Notes` – free text.

---

## 10. Engine Output Structure (Phase 1 Draft)

To integrate with your style from `indicators.js`, the XAUUSD Phase 1 handler can return a compact JSON like:

```json
{
  "symbol": "XAUUSD",
  "timestamp": 1710000000000,
  "last_price": 2321.50,
  "bias": "BUY",
  "bias_confidence": 0.9,
  "trend_4h": "BULL",
  "align_1h": "ABOVE_EMA50",
  "rsi_1h": 58.2,
  "final_signal": "BUY",
  "final_signal_confidence": 0.88,
  "execute_order": true,
  "entry_price": 2321.50,
  "stop_loss": 2309.20,
  "take_profit_1": 2339.00,
  "take_profit_2": 2360.80,
  "atr_4h": 8.2,
  "r_distance": 12.3,
  "sl_distance_atr": 1.50,
  "market_structure_4h": "TREND_UP"
}
```

This is enough to:

- Fill all Phase 1 Google Sheet columns.
- Manually backtest entries, SL, and TP behavior.
- Later evolve into a richer structure (with zones, OBs, etc.) without breaking the basic schema.

---

## 11. Next Steps (Implementation)

1. **Create a dedicated handler** for XAUUSD (e.g. `indicators-xauusd.js`) that:
   - Accepts the same candle inputs as `indicators.js` (15m, 1H, 4H, 1D, up to 500 candles each).
   - Computes EMAs, ATR, RSI as defined.
   - Applies trend, pullback, and trigger rules from this plan.
   - Returns a small JSON payload as in section 10.
2. **Hook this output** into your Google Sheet logger so each `execute_order = true` event writes one row.
3. **Manual backtest** 50–100 signals to see:
   - Win rate.
   - Typical R achieved per trade.
   - Whether TP1/TP2 levels are realistic for your intraday/swing window.

Once Phase 1 is stable and feels right for gold, we can **layer in Phase 2 complexity** (Supertrend, structure‑based zones, partial exits, regime filters) building on the same skeleton.



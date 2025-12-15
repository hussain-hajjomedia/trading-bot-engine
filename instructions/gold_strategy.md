Nice — I turned that long walkthrough into a **clean, code-ready swing-trading strategy tailored for GOLD (XAU/USD)**. Everything below is written so you can implement it in Python/Pine/pseudocode without guessing. I include exact numeric rules you can tweak, detection functions to implement, and the exact signal data you should output.

If you want, I can next convert this into runnable Python (pandas) backtest code or TradingView Pine code.

---

# GOLD — Swing Trading Strategy (code-ready)

## Quick summary

Trade only **with the higher-timeframe trend** (weekly → daily → 4H). Use daily/weekly **Area(s) of Interest (AOI)** as take-profit zones. Use 4H/1H/30m for entries (precision). Require multi-TF confluence and a minimum Risk:Reward (R:R) before taking trades. Prefer London / New York session momentum for execution.

---

## Timeframes (TF)

* `TF_weekly` = 1W
* `TF_daily` = 1D
* `TF_4h` = 4H
* `TF_1h` = 1H
* `TF_30m` = 30m
* (optionally) `TF_15m` for fine entry

---

## Core parameters (defaults tuned for GOLD)

* `min_AOI_touches = 3` (minimum touches to validate daily/weekly AOI)
* `consolidation_max_range = 0.5 * ATR(20)` (a consolidation candle's range must be ≤ this to consider “sideways”)
* `impulse_multiplier = 3.0` (an impulse candle body ≥ `impulse_multiplier * avg_body(N)` marks the breakout/impulse)
* `AOI_zone_padding = 0.0` (optional percent expand/shrink zone)
* `min_RR = 2.5` (require reward / risk ≥ 2.5)
* `stop_padding = 0.25 * ATR(20)` (pad SL below/above zone)
* `EMA_entry_period = 21` (use EMA21 for rejection confluence on 30m/1h)
* `session_filter = ["London", "NewYork"]` (prefer entries close to these sessions)
* `max_stop_pct_of_account = 0.5%` (risk management limit — optional)

---

## Definitions (precise)

**Trend (per TF)**

* `uptrend` if the TF shows **higher highs & higher lows** or more robustly: last confirmed swing low (`valid_low`) is above previous valid_low and price > last valid_low; and price has broken previous valid_high.
* `downtrend` symmetric: lower lows & lower highs, price < last valid_high.

**Valid Swing Low / High**

* A swing low becomes **valid** when price **later breaks above the prior swing high** formed before the low. (Follow transcript rule.)
* Similarly for swing high: valid when later price breaks the prior swing low.

**Area of Interest (AOI) — Daily / Weekly**

* Identify consolidation area (2–6 candles) followed by strong impulse (bullish for demand / bearish for supply).
* Define AOI bounds: `zone_low = min(low of consolidation candles)` and `zone_high = max(high of consolidation candles)` (or use last consolidation candle low→high as transcript suggests).
* Validate AOI only if there are ≥ `min_AOI_touches` price interactions (close or wick touches) on the same TF (daily or weekly).

**Impulse**

* An impulse candle is `abs(body) >= impulse_multiplier * mean_abs_body(N=10)` OR `candle_range >= impulse_multiplier * ATR(20)`.

**Confluence Signals**
Examples to score trade:

* TF alignment (weekly/daily/4H trend in same direction)
* AOI is on daily/weekly (adds strong score)
* Rejection from EMA21 on 30m/1h
* Bearish/Bullish engulfing candle on 30m/1h
* Structure rejection on 4H (price touches AOI and fails to break structure)
* Session timing (entry near London / NY open)

---

## Grading / Confluence (numeric, code-friendly)

Score components (each yields points):

* `weekly_trend_in_dir` = 10 points
* `daily_trend_in_dir` = 10 points
* `4h_trend_in_dir` = 10 points
* `AOI_on_daily_or_weekly` = 10 points
* `30m_bear_engulfing_or_bull_engulfing` = 5 points
* `EMA21_rejection_30m` = 5 points
* `4h_structural_rejection` = 5 points
* `session_overlap_preferred` = 5 points

**Take trade threshold**: `total_score >= 25` (recommended) **AND** R:R ≥ `min_RR`.
(You can raise threshold to 30+ for stricter entries.)

---

## Entry / SL / TP rules (exact)

### For **short** trades (when weekly/daily/4H are bearish)

1. **Trend check**: weekly, daily, and 4H must be bearish (or at least daily+4H bearish and weekly neutral).
2. **AOI**: Identify a daily/weekly **supply** AOI with ≥ `min_AOI_touches`. AOI must be above current price (we sell into supply).
3. **Wait for retrace**: price must retrace into AOI (touch within AOI bounds, including wick).
4. **Entry trigger (choose one or require 2)**:

   * 30m bearish engulfing candle within AOI, OR
   * 30m or 1H bearish rejection candle (long wick up, close lower) inside AOI, OR
   * Price rejection from EMA21 on 30m/1h, OR
   * 4H structural rejection candle within AOI.
5. **Set SL**: `SL = AOI_high + stop_padding` (or above the right shoulder/head if using H&S).
6. **Set TP**: `TP = next_valid_structure_low` (usually the next daily structure low or weekly structure level). Prefer exiting a few ticks/pips before a major psychological level to account for spread (transcript: exit just before psychological lvl).
7. **R:R test**: `RR = (entry_price - TP) / (SL - entry_price)`. Accept if `RR >= min_RR`.
8. **Execute** when confluence grade and RR pass.

### For **long** trades (mirror above)

* AOI is **demand** (below price). Entry when price retraces down to demand zone and bullish confluence on 30m/1h/4H. SL = AOI_low - stop_padding. TP = next valid structure high.

---

## Session & timing

* Prefer entries at or just before the London open or New York open (increases momentum).
* Allow trades outside session if confluence is very strong and RR is high, but reduce position size.

---

## Position sizing (straightforward)

1. Compute `risk_amount = account_balance * max_stop_pct_of_account` (e.g., 0.5%) — or user-set $ risk.
2. `position_size = risk_amount / (abs(entry_price - SL) * contract_value)`
   For gold, account for contract size / lot sizing and spread.

---

## Execution outputs (signal format)

When conditions met, output:

```
{
  "signal": "SHORT" or "LONG",
  "entry": float,
  "stop_loss": float,
  "take_profit": float,
  "risk": float,                # $ risk (or pips)
  "reward": float,              # $ reward
  "RR": float,
  "confluence_score": int,
  "TF_trend": {"weekly":"down","daily":"down","4h":"down"},
  "AOI": {"tf":"daily","low":float,"high":float,"touches":int},
  "confluences": ["4H_structure_rejection", "30m_bearish_engulf", "EMA21_rejection", ...],
  "session": "NewYork" or "London" or "Other",
  "note": "Close before psychological 1900"   # optional
}
```

---

## Suggested function breakdown (pseudocode)

Use these functions/modules:

* `compute_swing_structure(df, tf)` → returns list of valid highs/lows (with timestamps)
* `trend_on_tf(df, tf)` → "up"/"down"/"neutral"
* `find_AOIs(df, tf)` → list of AOI zones with touch counts
* `is_impulse(candle, df)` → boolean
* `is_consolidation(candles)` → boolean
* `detect_candlestick_pattern(df, tf, pattern)` → e.g., Bearish Engulfing
* `ema_rejection(df, tf, period)` → boolean
* `score_trade(context)` → int (sum confluences)
* `calc_RR(entry, sl, tp)` → float
* `position_size(account, entry, sl, risk_pct)` → float
* `generate_signal_if_ready()` → returns signal JSON above

---

## Implementation notes & gold-specific tips

* Gold (XAUUSD) often has **larger spikes** and **higher ATR** — use ATR-based SL padding (`stop_padding = 0.25 * ATR(20)` or tune).
* Watch for economic news (US jobs, FOMC) — consider skipping or reducing size during major releases. (You can add a news blackout filter.)
* Spreads for gold vary by broker/time — always account for spread when calculating SL/TP (subtract spread from TP or add to SL).
* Psychological round numbers (e.g., 1900, 2000) are often respected on daily/weekly — good TP zones.

---

## Example concrete numeric flow (short entry)

1. Weekly/daily/4H all bearish → each gives 10 points. score=30.
2. Found daily supply AOI with 4 touches → +10 → score=40.
3. Price retraces into AOI and 30m bearish engulfing forms → +5 → 45.
4. EMA21 on 30m shows rejection → +5 → 50.
5. Compute entry = 1,950; SL = 1,964 (AOI_high + padding); TP = 1,880 (next daily structure low).
6. `risk = 14` points; `reward = 70` points; `RR = 70/14 = 5.0` → >= 2.5 → trade taken.
7. Output signal JSON and position size.

---

## Final checklist (before executing code signal)

* [ ] Multi-TF trend in direction (weekly/daily/4H) OR at least daily+4H with weekly neutral
* [ ] AOI validated on daily or weekly with ≥ 3 touches
* [ ] Price retrace into AOI (touch)
* [ ] At least `score_threshold` confluence points (default 25)
* [ ] R:R ≥ `min_RR` (2.5) after SL/TP calculation
* [ ] Position sizing computed and within risk limits
* [ ] (Optional) Not in a major news blackout

---

If you want I’ll convert this into **(pick one)**:

* runnable **Python backtest script** (pandas) with example XAUUSD CSV inputs, OR
* **TradingView Pine** script that flags signals on chart, OR
* structured **pseudocode** you can hand to a developer.

Which one should I generate next?

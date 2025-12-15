# **Crypto Trading Strategy**

## **1. MARKET STRUCTURE DETECTION**

Goal: Determine if the market is in an **uptrend** or **downtrend**, using a strict rule for what counts as a “valid swing high/low”.

### **1.1 Definitions**

* **Valid Low (Swing Low)**:
  A low becomes a *valid* swing low **only if price breaks the previous swing high after forming it**.
* **Valid High (Swing High)**:
  A high becomes a *valid* swing high **only if price breaks the previous swing low after forming it**.

This fixes the main confusion in typical swing detection.

### **1.2 Uptrend Condition**

You are in an uptrend when:

* There is a confirmed valid low.
* Price has broken the previous valid high.
* Price has **not** broken below the current valid low.

### **1.3 Downtrend Condition**

You are in a downtrend when:

* There is a confirmed valid high.
* Price has broken the previous valid low.
* Price has **not** broken above the current valid high.

### **1.4 Trend Switching Logic**

* Trend switches to **downtrend** when price breaks the current valid low.
* Trend switches to **uptrend** when price breaks the current valid high.

### **1.5 Swing Identification Algorithm**

When price creates a temporary low candidate L:

* Mark the high immediately before L as `previous_high`.
* If later price breaks above `previous_high`:

  * L becomes **valid_low**.

Same logic for highs.



## **2. SUPPLY AND DEMAND ZONE DETECTION**

After trend direction is known:

### **2.1 Only Use the Zones That Match the Trend**

* Uptrend → use **demand** zones only.
* Downtrend → use **supply** zones only.

### **2.2 Zone Definition**

A **demand zone** is identified when:

* Price was in consolidation or sideways movement.
* Followed by a strong bullish impulse.
* The demand zone is defined as:

  ```
  low_of_last_consolidation_candle
  to
  high_of_last_consolidation_candle_before_impulse
  ```

A **supply zone** is defined the same way but with bearish impulses.

### **2.3 Consolidation Detection Logic (simple version)**

A consolidation region is:

* A sequence of N candles (often 2–5) where:

  * Average range is small.
  * No new higher high and higher low or lower low and lower high relative to past few candles.
  * Price is mostly horizontal.

You can define this numerically in code (I can help).

### **2.4 Impulse Detection Logic**

An impulse is:

* A move of at least `X` times the average candle body size.
* Or price moving Y% in a single direction with no pullbacks.
* Or simply a big candle compared to previous N candles.

We can formalize it if needed.



## **3. ENTRY RULES**

### **3.1 Entry in Uptrend**

Enter long when:

1. Trend = uptrend.
2. A demand zone is identified.
3. Price retraces into that demand zone.
4. Entry trigger:

   * You can enter immediately when price touches the zone, or
   * Require a confirmation candle (e.g., bullish engulfing inside the zone).

### **3.2 Entry in Downtrend**

Enter short when:

1. Trend = downtrend.
2. A supply zone is identified.
3. Price retraces into that supply zone.
4. Entry trigger:

   * Enter on first touch, or
   * Require a bearish confirmation candle.



## **4. STOP LOSS (SL) AND TAKE PROFIT (TP)**

### **4.1 In Uptrend**

* **Stop Loss**: just below the demand zone low.
* **TP**: the most recent valid swing high.

### **4.2 In Downtrend**

* SL: just above the supply zone high.
* TP: the most recent valid swing low.



## **5. RISK TO REWARD FILTER (R:R ≥ 2.5:1)**

After SL and TP are calculated:

* Compute `risk = entry_price - stop_loss` (absolute value)
* Compute `reward = take_profit - entry_price` (absolute value)
* If

  ```
  reward / risk < 2.5
  ```

  → **Do NOT take the trade.**

Trades only execute when R:R ≥ 2.5.



## **6. COMPLETE TRADE EXECUTION LOGIC**

Putting it all together:

### **For Long Trades:**

1. Detect trend → must be UP.
2. Identify valid low → verify trend.
3. Detect a demand zone (consolidation → impulse).
4. Wait for price retrace into demand zone.
5. Set:

   * SL = demand_zone_low
   * TP = previous_valid_high
6. Check R:R ≥ 2.5.
7. If true → execute long.

### **For Short Trades:**

1. Detect trend → must be DOWN.
2. Identify valid high → verify trend.
3. Detect a supply zone.
4. Wait for price retrace into supply zone.
5. Set:

   * SL = supply_zone_high
   * TP = previous_valid_low
6. Check R:R ≥ 2.5.
7. If true → execute short.



## **7. DATA STRUCTURES YOU’LL NEED IN CODE**

Here is what your algorithm needs to track:

```
current_trend: "up" or "down"
valid_high: float
valid_low: float

candidate_high: float
candidate_low: float

demand_zones: list of zones (each zone = {low, high})
supply_zones: list of zones

active_trade: None or {entry, sl, tp, direction}
```



## **8. SIGNAL OUTPUT**

The engine will output the following signals:

```
SIGNAL: LONG  
ENTRY: <price at which the user should enter the trade> 
STOP LOSS: <price>  
TAKE PROFIT 1: <price>  
TAKE PROFIT 2: <price>  
RR: <value>  
```


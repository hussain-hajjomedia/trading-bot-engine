// api/indicators.js — SCALP + CONDITIONAL FIBONACCI PULLBACK (A-only)
// Output format unchanged. Always returns SL/TP for level1/2/3.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const payload = req.body || {};
  let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

  // ---------- Utilities ----------
  function tryParseMaybeJson(input) {
    if (input === undefined || input === null) return null;
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') { try { return JSON.parse(input); } catch { return input; } }
    if (typeof input === 'object') return input;
    return null;
  }
  function extractArrayFromPossibleWrapper(x) {
    if (x === undefined || x === null) return [];
    if (Array.isArray(x)) return x;
    if (typeof x === 'object') {
      if (Array.isArray(x.data)) return x.data;
      if (Array.isArray(x.body)) return x.body;
    }
    return [];
  }
  function parseInputField(field) {
    const p = tryParseMaybeJson(field);
    return extractArrayFromPossibleWrapper(p);
  }

  kline_15m = parseInputField(kline_15m);
  kline_1h  = parseInputField(kline_1h);
  kline_4h  = parseInputField(kline_4h);
  kline_1d  = parseInputField(kline_1d);

  const BINANCE_FIELDS = 12;
  function chunkFlatNumericArray(arr, fields = BINANCE_FIELDS) {
    if (!Array.isArray(arr)) return [];
    if (arr.length > 0 && !Array.isArray(arr[0]) && arr.length % fields === 0) {
      const out = [];
      for (let i = 0; i < arr.length; i += fields) out.push(arr.slice(i, i + fields));
      return out;
    }
    return arr;
  }
  function normalizeCandleRow(row) {
    if (!row) return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
    const safe = (v) => {
      if (v === undefined || v === null) return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };
    if (Array.isArray(row)) {
      return {
        openTime: safe(row[0]),
        open: safe(row[1]),
        high:  safe(row[2]),
        low:   safe(row[3]),
        close: safe(row[4]),
        volume: safe(row[5]),
        closeTime: safe(row[6]),
        trades: safe(row[8]),
      };
    } else if (typeof row === 'object') {
      return {
        openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
        open:  safe(row.open ?? row.o ?? row.price ?? null),
        high:  safe(row.high ?? row.h ?? null),
        low:   safe(row.low  ?? row.l ?? null),
        close: safe(row.close ?? row.c ?? null),
        volume: safe(row.volume ?? row.v ?? null),
        closeTime: safe(row.closeTime ?? null),
        trades: safe(row.trades ?? row.n ?? null),
      };
    }
    return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
  }
  function normalizeCandlesRaw(raw) {
    if (!raw) return [];
    if (Array.isArray(raw) && raw.length > 0 && !Array.isArray(raw[0])) {
      const chunked = chunkFlatNumericArray(raw, BINANCE_FIELDS);
      if (Array.isArray(chunked) && chunked.length > 0 && Array.isArray(chunked[0])) {
        return chunked.map(normalizeCandleRow);
      }
    }
    if (Array.isArray(raw)) return raw.map(normalizeCandleRow);
    if (typeof raw === 'object') {
      if (Array.isArray(raw.data)) return raw.data.map(normalizeCandleRow);
      if (Array.isArray(raw.body)) return raw.body.map(normalizeCandleRow);
    }
    return [];
  }

  const normalized = {
    '15m': normalizeCandlesRaw(kline_15m),
    '1h' : normalizeCandlesRaw(kline_1h),
    '4h' : normalizeCandlesRaw(kline_4h),
    '1d' : normalizeCandlesRaw(kline_1d),
  };

  // ---------- Indicator helpers ----------
  const toNum = (v) => (v == null ? null : Number(v));
  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] == null ? 0 : values[i];
      sum += v;
      if (i >= period) sum -= (values[i - period] == null ? 0 : values[i - period]);
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }
  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0) return out;
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) { out[i] = null; continue; }
      prev = prev == null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    }
    for (let i = 0; i < period - 1 && i < out.length; i++) out[i] = null;
    return out;
  }
  function rsiWilder(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    let gains = 0, losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    let avgGain = gains / period, avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? Math.abs(d) : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    }
    return out;
  }
  function macd(values, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((v, i) =>
      emaFast[i] == null || emaSlow[i] == null ? null : emaFast[i] - emaSlow[i]
    );
    const signalLine = ema(macdLine.map(v => v == null ? 0 : v), signal);
    const hist = macdLine.map((v, i) =>
      v == null || signalLine[i] == null ? null : v - signalLine[i]
    );
    return { macdLine, signalLine, hist };
  }
  function trueRange(highs, lows, closes) {
    const tr = [];
    for (let i = 0; i < highs.length; i++) {
      if (i === 0) tr.push(highs[i] - lows[i]);
      else {
        const a = highs[i] - lows[i];
        const b = Math.abs(highs[i] - closes[i - 1]);
        const c = Math.abs(lows[i] - closes[i - 1]);
        tr.push(Math.max(a, b, c));
      }
    }
    return tr;
  }
  function atr(highs, lows, closes, period = 14) {
    const tr = trueRange(highs, lows, closes);
    const out = new Array(tr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < tr.length; i++) {
      if (i < period) { sum += tr[i]; if (i === period - 1) out[i] = sum / period; continue; }
      out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
  }
  function superTrend(highs, lows, closes, period = 10, mult = 3) {
    const atrArr = atr(highs, lows, closes, period);
    const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
    const upper = hl2.map((v, i) => v + mult * (atrArr[i] == null ? 0 : atrArr[i]));
    const lower = hl2.map((v, i) => v - mult * (atrArr[i] == null ? 0 : atrArr[i]));
    const finalUpper = new Array(closes.length).fill(null);
    const finalLower = new Array(closes.length).fill(null);
    const st = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { finalUpper[i] = upper[i]; finalLower[i] = lower[i]; continue; }
      finalUpper[i] = Math.min(upper[i] == null ? Infinity : upper[i], finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]);
      finalLower[i] = Math.max(lower[i] == null ? -Infinity : lower[i], finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]);
      if (finalLower[i] == null || finalUpper[i] == null) st[i] = null;
      else st[i] = closes[i] > finalLower[i] ? finalLower[i] : finalUpper[i];
    }
    return st;
  }

  // ---------- Micro-structure (swing points) ----------
  function findSwingPoints(candles, lookback = 2) {
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const swingHighs = [], swingLows = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      const high = highs[i], low = lows[i];
      let isHigh = true, isLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (!(high > highs[i - j] && high > highs[i + j])) isHigh = false;
        if (!(low  < lows [i - j] && low  < lows [i + j])) isLow = false;
      }
      if (isHigh) swingHighs.push({ index: i, price: high });
      if (isLow)  swingLows .push({ index: i, price: low  });
    }
    return { swingHighs, swingLows };
  }

  function analyzeTimeframe(tfName, candles) {
    const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes  = candles.map(c => toNum(c.close));
    const highs   = candles.map(c => toNum(c.high));
    const lows    = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));
    if (closes.length < 5) return result;

    // Scalp set
    const sma50    = sma(closes, 50);
    const sma200   = sma(closes, 200);
    const ema9Arr  = ema(closes, 9);
    const ema21Arr = ema(closes, 21);
    const rsi14    = rsiWilder(closes, 14);
    const macdObj  = macd(closes);
    const atr7Arr  = atr(highs, lows, closes, 7);
    const stArr    = superTrend(highs, lows, closes, 10, 3);

    const i = closes.length - 1;
    const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
    result.last = last;

    result.indicators = {
      sma50: sma50[i], sma200: sma200[i],
      ema9: ema9Arr[i], ema21: ema21Arr[i],
      rsi14: rsi14[i],
      macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i], macd_hist: macdObj.hist[i],
      atr7: atr7Arr[i],
      supertrend: stArr[i],
      volume: volumes[i],
    };

    // Scalp scoring
    let score = 0;
    if (last.close != null && result.indicators.ema9 != null) score += (last.close > result.indicators.ema9 ? 8 : -8);
    if (result.indicators.ema9 != null && result.indicators.ema21 != null) score += (result.indicators.ema9 > result.indicators.ema21 ? 6 : -6);
    if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
      if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) score += 8;
      else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) score -= 8;
    }
    if (result.indicators.supertrend != null && last.close != null) score += (last.close > result.indicators.supertrend ? 7 : -7);
    if (result.indicators.rsi14 != null) { if (result.indicators.rsi14 < 30) score += 2; else if (result.indicators.rsi14 > 70) score -= 2; }

    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    if (result.score >= 26) result.signal = 'STRONG BUY';
    else if (result.score >= 10) result.signal = 'BUY';
    else if (result.score <= -26) result.signal = 'STRONG SELL';
    else if (result.score <= -10) result.signal = 'SELL';
    else result.signal = 'HOLD';

    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  // ---------- Voting (scalp bias) ----------
  const tfWeight = { '15m': 3.0, '1h': 1.5, '4h': 0.5, '1d': 0.2 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
  for (const tf of Object.keys(tfResults)) {
    const s = tfResults[tf].signal;
    const w = tfWeight[tf] || 1;
    tally[s] += w;
  }
  let final_signal = 'HOLD';
  const strongBuyWeight  = tally['STRONG BUY'];
  const strongSellWeight = tally['STRONG SELL'];
  const buyWeight  = tally['BUY']  + strongBuyWeight  * 1.3;
  const sellWeight = tally['SELL'] + strongSellWeight * 1.3;

  if (strongBuyWeight >= 2.5 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 2.5 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 3.0) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 3.0) final_signal = 'SELL';
  else final_signal = 'HOLD';

  // ---------- ATR reference (15m ATR7 preferred) ----------
  function atr15() {
    const r15 = tfResults['15m']?.indicators?.atr7;
    if (r15 != null) return r15;
    const highs = normalized['15m'].map(c => c.high);
    const lows  = normalized['15m'].map(c => c.low);
    const closes= normalized['15m'].map(c => c.close);
    const arr = atr(highs, lows, closes, 7);
    return arr[arr.length - 1] ?? null;
  }
  const lastClose15 = tfResults['15m']?.last?.close ?? null;
  const atrRef = (() => {
    const a = atr15();
    if (a != null) return a;
    return lastClose15 != null ? lastClose15 * 0.003 : 1; // fallback
  })();

  // ---------- Conditional Fibonacci (A: pullback-only) ----------
  // Find latest impulse on 15m using swing points
  const swings15 = findSwingPoints(normalized['15m']);
  function latestImpulseFromSwings(sw) {
    if (!sw || !sw.swingHighs.length || !sw.swingLows.length) return null;
    const lastHigh = sw.swingHighs[sw.swingHighs.length - 1];
    const lastLow  = sw.swingLows [sw.swingLows .length - 1];
    // Determine order by index (which came later)
    if (lastLow.index < lastHigh.index) {
      // Up impulse low -> high
      return { dir: 'UP', low: lastLow.price, high: lastHigh.price, iLow: lastLow.index, iHigh: lastHigh.index };
    } else if (lastHigh.index < lastLow.index) {
      // Down impulse high -> low
      return { dir: 'DOWN', high: lastHigh.price, low: lastLow.price, iHigh: lastHigh.index, iLow: lastLow.index };
    }
    return null;
  }
  const impulse = latestImpulseFromSwings(swings15);

  // Confirm impulse strength (leg >= 3x ATR or >= 0.35% of price)
  const price15 = lastClose15;
  const legSize = (impulse && impulse.high != null && impulse.low != null) ? Math.abs(impulse.high - impulse.low) : null;
  const strongImpulse =
    legSize != null &&
    atrRef != null &&
    (legSize >= atrRef * 3 || (price15 != null && legSize / price15 >= 0.0035));

  // Directional and timeframe alignment (15m + 1h)
  const sig15 = tfResults['15m']?.signal || 'HOLD';
  const sig1h = tfResults['1h']?.signal  || 'HOLD';
  const alignedUp   = (sig15.includes('BUY')  && sig1h.includes('BUY'));
  const alignedDown = (sig15.includes('SELL') && sig1h.includes('SELL'));

  // Activate Fib only if impulse strong AND aligned with multi-TF bias AND final signal agrees
  const fibModeActive =
    impulse &&
    strongImpulse &&
    (
      (impulse.dir === 'UP'   && alignedUp   && final_signal.includes('BUY')) ||
      (impulse.dir === 'DOWN' && alignedDown && final_signal.includes('SELL'))
    );

  // Compute Fib prices for pullback (0.5–0.618) and extension (1.272)
  function fibPullbackAndTargets(imp) {
    if (!imp || imp.low == null || imp.high == null) return null;
    const low = imp.low, high = imp.high;
    const leg = Math.abs(high - low);
    if (!Number.isFinite(leg) || leg === 0) return null;

    if (imp.dir === 'UP') {
      const fib50  = low + 0.50 * leg;
      const fib618 = low + 0.618 * leg;
      const ext1272 = low + 1.272 * leg;
      return { dir: 'UP', pullLow: Math.min(fib50, fib618), pullHigh: Math.max(fib50, fib618), swingStop: low, tp1: high, tp2: ext1272 };
    } else {
      const fib50  = high - 0.50 * leg;
      const fib618 = high - 0.618 * leg;
      const ext1272 = high - 1.272 * leg;
      return { dir: 'DOWN', pullLow: Math.min(fib50, fib618), pullHigh: Math.max(fib50, fib618), swingStop: high, tp1: low, tp2: ext1272 };
    }
  }
  const fib = fibModeActive ? fibPullbackAndTargets(impulse) : null;

  // ---------- Entry band ----------
  const ema15 = tfResults['15m']?.indicators?.ema9 ?? lastClose15 ?? null;
  const st15  = tfResults['15m']?.indicators?.supertrend ?? lastClose15 ?? null;
  const trend =
    final_signal.includes('BUY') ? 'UP' :
    final_signal.includes('SELL') ? 'DOWN' : 'SIDEWAYS';

  // Clamp helper
  function clampBandAround(p, rawLow, rawHigh, maxPct, minPctWidth) {
    if (p == null || rawLow == null || rawHigh == null) return { low: rawLow, high: rawHigh };
    let lo = Math.min(rawLow, rawHigh);
    let hi = Math.max(rawLow, rawHigh);
    const maxAbs = p * maxPct;
    if (Math.abs(lo - p) > maxAbs) lo = p - maxAbs;
    if (Math.abs(hi - p) > maxAbs) hi = p + maxAbs;
    const minWidth = p * minPctWidth;
    if ((hi - lo) < minWidth) { lo = p - minWidth / 2; hi = p + minWidth / 2; }
    return { low: lo, high: hi };
  }

  // Base bands: if Fib active, use 0.5–0.618 zone (with ATR padding); else EMA/ST bands
  function bandsForLevels() {
    const p = price15;
    if (fib && fibModeActive) {
      // Pad the fib pullback zone by ATR fractions per level
      const pad1 = atrRef * 0.10;
      const pad2 = atrRef * 0.20;
      const pad3 = atrRef * 0.35;
      const baseLow  = fib.pullLow;
      const baseHigh = fib.pullHigh;
      return {
        level1: clampBandAround(p, baseLow  - pad1, baseHigh + pad1, 0.006, 0.0005), // 0.6% cap
        level2: clampBandAround(p, baseLow  - pad2, baseHigh + pad2, 0.008, 0.0008), // 0.8%
        level3: clampBandAround(p, baseLow  - pad3, baseHigh + pad3, 0.012, 0.0010), // 1.2%
      };
    } else {
      // Non-fib fallback: EMA/ST bands (tight)
      let rawLow, rawHigh;
      if (trend === 'UP') { rawLow = Math.min(ema15, st15); rawHigh = ema15; }
      else if (trend === 'DOWN') { rawLow = ema15; rawHigh = Math.max(ema15, st15); }
      else { rawLow = p; rawHigh = p; }
      return {
        level1: clampBandAround(p, rawLow, rawHigh, 0.004, 0.0005), // 0.4%
        level2: clampBandAround(p, rawLow, rawHigh, 0.006, 0.0008), // 0.6%
        level3: clampBandAround(p, rawLow, rawHigh, 0.010, 0.0010), // 1.0%
      };
    }
  }
  const bands = bandsForLevels();

  // Entry price = mid of level1 band (consistent)
  const entryPrice = (() => {
    const b = bands.level1;
    if (b && b.low != null && b.high != null) return (b.low + b.high) / 2;
    return price15 ?? tfResults['1h']?.last?.close ?? null;
  })();

  // ---------- Stops & Targets ----------
  // Scalp multipliers (tight)
  const slMultipliers = { level1: 0.8, level2: 1.1, level3: 1.5 };

  function limitExtremes(entry, val, pct, factor = 1) {
    if (!Number.isFinite(entry) || !Number.isFinite(val)) return val;
    const cap = entry * pct * factor;
    if (Math.abs(val - entry) > cap) return entry + Math.sign(val - entry) * cap;
    return val;
  }

  function computeStopsAndTargets(dir, entry, atrVal, m) {
    const e = Number.isFinite(entry) ? entry : (Number.isFinite(price15) ? price15 : null);
    const a = Number.isFinite(atrVal) ? atrVal : (e != null ? e * 0.003 : 1);
    if (e == null) return { sl: null, tp1: null, tp2: null };

    let sl, tp1, tp2;

    if (fib && fibModeActive) {
      // Use structure + fib extension for TPs
      if (dir === 'UP') {
        const structuralSL = (fib.swingStop != null) ? (fib.swingStop - a * 0.10) : (e - a * m);
        sl  = Math.min(structuralSL, e - a * m);
        tp1 = Number.isFinite(fib.tp1) ? fib.tp1 : (e + a * m * 1.0);
        tp2 = Number.isFinite(fib.tp2) ? fib.tp2 : (e + a * m * 2.0);
      } else if (dir === 'DOWN') {
        const structuralSL = (fib.swingStop != null) ? (fib.swingStop + a * 0.10) : (e + a * m);
        sl  = Math.max(structuralSL, e + a * m);
        tp1 = Number.isFinite(fib.tp1) ? fib.tp1 : (e - a * m * 1.0);
        tp2 = Number.isFinite(fib.tp2) ? fib.tp2 : (e - a * m * 2.0);
      } else {
        sl  = e - a * m;
        tp1 = e + a * m * 0.8;
        tp2 = e + a * m * 1.6;
      }
    } else {
      // Non-fib fallback
      if (dir === 'UP') {
        sl  = e - a * m;
        tp1 = e + a * m * 1.0;
        tp2 = e + a * m * 2.0;
      } else if (dir === 'DOWN') {
        sl  = e + a * m;
        tp1 = e - a * m * 1.0;
        tp2 = e - a * m * 2.0;
      } else {
        sl  = e - a * m;
        tp1 = e + a * m * 0.8;
        tp2 = e + a * m * 1.6;
      }
    }

    // Safety caps (scalp): 2% from entry, TP2 up to 3%
    sl  = limitExtremes(e, sl, 0.02, 1.0);
    tp1 = limitExtremes(e, tp1, 0.02, 1.0);
    tp2 = limitExtremes(e, tp2, 0.03, 1.0);

    return { sl, tp1, tp2 };
  }

  // Assemble suggestions
  const suggestions = {};
  for (const lvl of ['level1', 'level2', 'level3']) {
    const m = slMultipliers[lvl];
    const band = bands[lvl] || bands.level1;
    const { sl, tp1, tp2 } = computeStopsAndTargets(trend, entryPrice, atrRef, m);

    suggestions[lvl] = {
      entry: entryPrice,
      entry_range: { low: band?.low ?? entryPrice, high: band?.high ?? entryPrice },
      stop_loss: sl,
      take_profit_1: tp1,
      take_profit_2: tp2,
      atr_used: atrRef,
      sl_multiplier: m,
    };
  }

  // ---------- Output (unchanged schema) ----------
  const votes = {};
  for (const tf of Object.keys(tfResults)) votes[tf] = tfResults[tf].signal;

  const output = {
    symbol: symbol || null,
    exchangeSymbol: exchangeSymbol || null,
    final_signal,
    votesSummary: { byTf: votes },
    suggestions,
    reasons: [],        // kept empty for your sheet
    details: tfResults, // full TF data
  };

  return res.status(200).json(output);
}

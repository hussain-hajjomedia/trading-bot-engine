// api/indicators.js

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
    if (typeof input === 'string') {
      try {
        return JSON.parse(input);
      } catch {
        return input;
      }
    }
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
  kline_1h = parseInputField(kline_1h);
  kline_4h = parseInputField(kline_4h);
  kline_1d = parseInputField(kline_1d);

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
        high: safe(row[2]),
        low: safe(row[3]),
        close: safe(row[4]),
        volume: safe(row[5]),
        closeTime: safe(row[6]),
        trades: safe(row[8]),
      };
    } else if (typeof row === 'object') {
      return {
        openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
        open: safe(row.open ?? row.o ?? row.price ?? null),
        high: safe(row.high ?? row.h ?? null),
        low: safe(row.low ?? row.l ?? null),
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
    '1h': normalizeCandlesRaw(kline_1h),
    '4h': normalizeCandlesRaw(kline_4h),
    '1d': normalizeCandlesRaw(kline_1d),
  };

  console.log('[indicators] symbol=', symbol, 'lengths=', {
    '15m': normalized['15m'].length,
    '1h': normalized['1h'].length,
    '4h': normalized['4h'].length,
    '1d': normalized['1d'].length,
  });

  // ---------- Indicator helpers ----------
  const toNum = (v) => (v == null ? null : Number(v));

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0) return out;
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i] == null ? 0 : values[i];
      sum += v;
      if (i >= period) {
        sum -= (values[i - period] == null ? 0 : values[i - period]);
      }
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
      // safer check for nulls
      if (finalLower[i] == null || finalUpper[i] == null) st[i] = null;
      else st[i] = closes[i] > finalLower[i] ? finalLower[i] : finalUpper[i];
    }
    return st;
  }

  function bollinger(values, period = 20, mult = 2) {
    const out = [];
    for (let i = 0; i < values.length; i++) {
      if (i < period - 1) { out.push({ upper: null, middle: null, lower: null }); continue; }
      const slice = values.slice(i - period + 1, i + 1).filter(v => v != null);
      if (slice.length < period) { out.push({ upper: null, middle: null, lower: null }); continue; }
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      out.push({ upper: mean + mult * sd, middle: mean, lower: mean - mult * sd });
    }
    return out;
  }

  // ---------- Analysis ----------
  function analyzeTimeframe(tfName, candles) {
    const result = { tf: tfName, length: candles.length, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes = candles.map(c => toNum(c.close));
    const highs = candles.map(c => toNum(c.high));
    const lows = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));
    if (closes.length < 5) { result.reasons.push('insufficient candles'); return result; }

    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsi14 = rsiWilder(closes, 14);
    const macdObj = macd(closes);
    const atr14 = atr(highs, lows, closes, 14);
    const st = superTrend(highs, lows, closes, 10, 3);
    const bb = bollinger(closes, 20, 2);

    // volume sma20 for confirmation
    const volSMA20 = sma(volumes, 20);

    const i = closes.length - 1;
    const last = { open: closes[i], high: highs[i], low: lows[i], close: closes[i], volume: volumes[i], time: candles[i].openTime };
    result.last = last;

    result.indicators = {
      sma50: sma50[i], sma200: sma200[i], ema9: ema9[i], ema21: ema21[i],
      rsi14: rsi14[i], macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i],
      macd_hist: macdObj.hist[i], atr14: atr14[i], supertrend: st[i],
      bb_upper: bb[i]?.upper, bb_mid: bb[i]?.middle, bb_lower: bb[i]?.lower,
      vol_sma20: volSMA20[i], volume: volumes[i]
    };

    let score = 0;
    const reasons = [];

    // regime detection: if SMA50 is very close to SMA200, we are in sideways market
    const sma50v = result.indicators.sma50;
    const sma200v = result.indicators.sma200;
    let sidewaysFactor = 1; // default no reduction
    if (sma50v != null && sma200v != null) {
      const diffPct = Math.abs(sma50v - sma200v) / Math.max(1, Math.abs(sma200v));
      // if within 0.8% -> strongly sideways; 0.8-2% -> somewhat sideways
      if (diffPct < 0.008) sidewaysFactor = 0.35;
      else if (diffPct < 0.02) sidewaysFactor = 0.7;
      else sidewaysFactor = 1;
      if (sidewaysFactor < 1) reasons.push('market appears sideways (SMA50≈SMA200)');
    }

    // time-frame weighting (per-tf multipliers applied at caller level; here we compute base contributions)
    // base contributions (these will be multiplied by tfWeight when aggregating across TFs)
    // Adjusted (smaller per-item values to avoid runaway scores)
    if (last.close != null && result.indicators.sma50 != null) {
      if (last.close > result.indicators.sma50) { score += 6 * sidewaysFactor; reasons.push('price > SMA50'); }
      else { score -= 6 * sidewaysFactor; reasons.push('price < SMA50'); }
    }

    if (result.indicators.sma50 != null && result.indicators.sma200 != null) {
      if (result.indicators.sma50 > result.indicators.sma200) { score += 8 * sidewaysFactor; reasons.push('SMA50 > SMA200'); }
      else { score -= 8 * sidewaysFactor; reasons.push('SMA50 < SMA200'); }
    }

    if (last.close != null && result.indicators.ema9 != null) {
      if (last.close > result.indicators.ema9) { score += 5 * sidewaysFactor; reasons.push('price > EMA9'); }
      else { score -= 5 * sidewaysFactor; reasons.push('price < EMA9'); }
    }

    if (result.indicators.ema9 != null && result.indicators.ema21 != null) {
      if (result.indicators.ema9 > result.indicators.ema21) { score += 3 * sidewaysFactor; reasons.push('EMA9 > EMA21'); }
      else { score -= 3 * sidewaysFactor; reasons.push('EMA9 < EMA21'); }
    }

    // MACD confirmation
    if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
      if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) { score += 10 * sidewaysFactor; reasons.push('MACD bullish'); }
      else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) { score -= 10 * sidewaysFactor; reasons.push('MACD bearish'); }
    }

    // SuperTrend
    if (result.indicators.supertrend != null && last.close != null) {
      if (last.close > result.indicators.supertrend) { score += 7 * sidewaysFactor; reasons.push('SuperTrend bullish'); }
      else { score -= 7 * sidewaysFactor; reasons.push('SuperTrend bearish'); }
    }

    // RSI mild adjustments (avoid huge weights)
    if (result.indicators.rsi14 != null) {
      if (result.indicators.rsi14 < 30) { score += 2 * sidewaysFactor; reasons.push('RSI oversold'); }
      else if (result.indicators.rsi14 > 70) { score -= 2 * sidewaysFactor; reasons.push('RSI overbought'); }
    }

    // Bollinger context (small weight)
    if (result.indicators.bb_upper != null && result.indicators.bb_lower != null) {
      if (last.close > result.indicators.bb_upper) { score += 1 * sidewaysFactor; reasons.push('price above BB upper'); }
      else if (last.close < result.indicators.bb_lower) { score += 1 * sidewaysFactor; reasons.push('price below BB lower'); }
    }

    // Volume confirmation (important for swing)
    if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
      if (result.indicators.volume > result.indicators.vol_sma20 * 1.25) {
        score += 6 * sidewaysFactor;
        reasons.push('volume spike (vol > 1.25x volSMA20)');
      } else if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) {
        score -= 3 * sidewaysFactor;
        reasons.push('below average volume');
      }
    }

    // cap score to avoid runaway
    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    if (result.score >= 30) result.signal = 'STRONG BUY';
    else if (result.score >= 12) result.signal = 'BUY';
    else if (result.score <= -30) result.signal = 'STRONG SELL';
    else if (result.score <= -12) result.signal = 'SELL';
    else result.signal = 'HOLD';

    result.reasons = reasons;
    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  // ---------- Voting (swing-optimized weights) ----------
  // Increased weight for larger TFs, reduced small TF influence
  const tfWeight = { '15m': 0.5, '1h': 1.5, '4h': 2.5, '1d': 3.5 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
  for (const tf of Object.keys(tfResults)) {
    const s = tfResults[tf].signal;
    const w = tfWeight[tf] || 1;
    tally[s] += w;
  }

  let final_signal = 'HOLD';
  const strongBuyWeight = tally['STRONG BUY'];
  const strongSellWeight = tally['STRONG SELL'];
  const buyWeight = tally['BUY'] + strongBuyWeight * 1.5;
  const sellWeight = tally['SELL'] + strongSellWeight * 1.5;

  // swing-tuned thresholds (higher bar to classify)
  if (strongBuyWeight >= 3.5 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 3.5 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 3.5) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 3.5) final_signal = 'SELL';
  else final_signal = 'HOLD';

  // ---------- Entry & Targets (swing-tuned, capped ranges) ----------
  const refTf = tfResults['1h']?.last?.close ? '1h' : tfResults['15m']?.last?.close ? '15m' : '4h';
  const ref = tfResults[refTf];
  const ema9v = ref.indicators.ema9;
  const stv = ref.indicators.supertrend;
  const lastCandle = normalized[refTf][normalized[refTf].length - 1];

  const trend = final_signal.includes('BUY')
    ? 'UP'
    : final_signal.includes('SELL')
    ? 'DOWN'
    : 'SIDEWAYS';

  const emaSafe = (v) => (v != null && !isNaN(v) ? v : null);
  const stSafe = (v) => (v != null && !isNaN(v) ? v : null);

  const emaVal = emaSafe(ema9v);
  const stVal = stSafe(stv);
  const lastClose = ref?.last?.close ?? null;

  // determine ATR reference (prefer 1h/4h/1d for swing sizing)
  function pickAtr(tf) {
    const r = tfResults[tf];
    if (r?.indicators?.atr14 != null) return r.indicators.atr14;
    return null;
  }
  let atrRef =
    pickAtr('1h') ||
    pickAtr('4h') ||
    pickAtr('1d') ||
    pickAtr('15m') ||
    null;

  if (atrRef == null && lastClose != null) atrRef = lastClose * 0.005; // fallback small volatility estimate

  // entry range logic with caps: define max allowed pct moves (swing-friendly)
  const MAX_ENTRY_PCT = 0.015; // 1.5% for level1 base maximum
  const MAX_ENTRY_PCT_L2 = 0.03; // 3%
  const MAX_ENTRY_PCT_L3 = 0.05; // 5%
  const MIN_ENTRY_PCT = 0.001; // 0.1% minimal range

  // initial raw entryLow/high computation (similar to prior logic but we will clamp)
  let rawEntryLow = null, rawEntryHigh = null;
  if (trend === 'UP') {
    if (emaVal && stVal) {
      rawEntryLow = Math.min(emaVal, stVal);
      rawEntryHigh = emaVal;
    } else if (emaVal) {
      rawEntryLow = emaVal * 0.995;
      rawEntryHigh = emaVal * 1.005;
    } else {
      rawEntryLow = lastClose * 0.995;
      rawEntryHigh = lastClose * 1.005;
    }
  } else if (trend === 'DOWN') {
    if (emaVal && stVal) {
      rawEntryLow = emaVal;
      rawEntryHigh = Math.max(emaVal, stVal);
    } else if (emaVal) {
      rawEntryLow = emaVal * 0.995;
      rawEntryHigh = emaVal * 1.005;
    } else {
      rawEntryLow = lastClose * 0.995;
      rawEntryHigh = lastClose * 1.005;
    }
  } else {
    rawEntryLow = lastClose;
    rawEntryHigh = lastClose;
  }

  // Helper to clamp entry ranges to sensible swing-friendly percentages around lastClose and relative to ATR
  function clampEntryRange(rawLow, rawHigh, lastPrice, maxPct) {
    if (!lastPrice || rawLow == null || rawHigh == null) return { low: rawLow, high: rawHigh };
    // ensure rawLow <= rawHigh
    if (rawLow > rawHigh) { const tmp = rawLow; rawLow = rawHigh; rawHigh = tmp; }

    // compute distance from last price and clamp
    const lowPct = Math.abs((rawLow - lastPrice) / lastPrice);
    const highPct = Math.abs((rawHigh - lastPrice) / lastPrice);

    const cappedLow = lowPct > maxPct ? (rawLow < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct)) : rawLow;
    const cappedHigh = highPct > maxPct ? (rawHigh < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct)) : rawHigh;

    // ensure the range is not too tiny: at least MIN_ENTRY_PCT percent width
    let finalLow = Math.min(cappedLow, cappedHigh);
    let finalHigh = Math.max(cappedLow, cappedHigh);
    const widthPct = Math.abs((finalHigh - finalLow) / Math.max(1, lastPrice));
    if (widthPct < MIN_ENTRY_PCT) {
      // expand symmetrically
      const half = (MIN_ENTRY_PCT * lastPrice) / 2;
      finalLow = lastPrice - half;
      finalHigh = lastPrice + half;
    }
    return { low: finalLow, high: finalHigh };
  }

  // base entry range (level1, level2, level3) with progressive maxPct
  const lvl1 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT);
  const lvl2 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L2);
  const lvl3 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L3);

  // Use ATR to further limit unrealistic SL/TP values
  const entryPrice =
    (lvl1.low != null && lvl1.high != null) ? (lvl1.low + lvl1.high) / 2
    : (lastClose != null ? lastClose : null);

  // ---------- ATR & SL/TP (swing-tuned, more conservative sizing) ----------
  const slMultipliers = { level1: 1.0, level2: 1.6, level3: 2.4 }; // tightened compared to prior
  const suggestions = {};
  const levels = ['level1', 'level2', 'level3'];
  const rawRanges = { level1: lvl1, level2: lvl2, level3: lvl3 };

  for (const lvl of levels) {
    const m = slMultipliers[lvl];
    let sl = null, tp1 = null, tp2 = null;

    const range = rawRanges[lvl];
    // ensure entry within that range
    const entry = entryPrice != null ? entryPrice : (range.low != null ? (range.low + range.high) / 2 : null);

    if (entry == null || atrRef == null) {
      // fallback: small absolute SL/TP
      sl = entry ? entry - (entry * 0.01) : null;
      tp1 = entry ? entry + (entry * 0.015) : null;
      tp2 = entry ? entry + (entry * 0.03) : null;
    } else {
      if (trend === 'UP') {
        sl = entry - atrRef * m;
        tp1 = entry + atrRef * (m * 1.2);
        tp2 = entry + atrRef * (m * 2.2);
      } else if (trend === 'DOWN') {
        sl = entry + atrRef * m;
        tp1 = entry - atrRef * (m * 1.2);
        tp2 = entry - atrRef * (m * 2.2);
      } else {
        // sideways small targets
        sl = entry - atrRef * m;
        tp1 = entry + atrRef * (m * 0.8);
        tp2 = entry + atrRef * (m * 1.6);
      }
    }

    // Final safety clamps: do not propose SL farther than MAX_ENTRY_PCT_L3 from entry
    const maxSLDistance = Math.max( Math.abs(entry * MAX_ENTRY_PCT_L3), atrRef * 0.5 );
    if (sl != null && Math.abs(sl - entry) > maxSLDistance) {
      sl = entry - Math.sign(entry - sl) * maxSLDistance;
    }

    // same for TP
    const maxTPDistance = Math.max( Math.abs(entry * 0.08), atrRef * 4 ); // allow reasonable upside
    if (tp1 != null && Math.abs(tp1 - entry) > maxTPDistance) {
      tp1 = entry + Math.sign(tp1 - entry) * maxTPDistance;
    }
    if (tp2 != null && Math.abs(tp2 - entry) > maxTPDistance * 1.6) {
      tp2 = entry + Math.sign(tp2 - entry) * maxTPDistance * 1.6;
    }

    suggestions[lvl] = {
      entry: entry,
      entry_range: { low: range.low, high: range.high },
      stop_loss: sl,
      take_profit_1: tp1,
      take_profit_2: tp2,
      atr_used: atrRef,
      sl_multiplier: m,
    };
  }

  // ---------- Compose final output ----------
  const votes = {};
  for (const tf of Object.keys(tfResults)) votes[tf] = tfResults[tf].signal;

  const reasons = [];
  for (const tf of Object.keys(tfResults)) {
    const r = tfResults[tf];
    if (r.reasons?.length)
      reasons.push({ timeframe: tf, score: r.score, reasons: r.reasons.slice(0, 6) });
  }

  const output = {
    symbol: symbol || null,
    exchangeSymbol: exchangeSymbol || null,
    final_signal,
    votesSummary: {
      weighted: {
        buyWeight: buyWeight,
        sellWeight: sellWeight,
        strongBuyWeight,
        strongSellWeight,
      },
      byTf: votes,
    },
    suggestions,
    reasons,
    details: tfResults,
  };

  console.log('[indicators] final_signal=', final_signal, 'votesSummary=', output.votesSummary);
  return res.status(200).json(output);
}

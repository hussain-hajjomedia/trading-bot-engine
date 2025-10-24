// api/indicators.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const payload = req.body || {};
  let {
    symbol,
    exchangeSymbol,
    kline_15m,
    kline_1h,
    kline_4h,
    kline_1d
  } = payload;

  // ---------- Utilities for parsing & normalization ----------
  function tryParseMaybeJson(input) {
    if (input === undefined || input === null) return null;
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
      // try JSON.parse
      try {
        const p = JSON.parse(input);
        return p;
      } catch (e) {
        // not JSON — maybe comma-separated; return as-is
        return input;
      }
    }
    if (typeof input === 'object') return input;
    return null;
  }

  function extractArrayFromPossibleWrapper(x) {
    if (x === undefined || x === null) return [];
    // If array-of-arrays or array-of-objects
    if (Array.isArray(x)) return x;
    // If object with .data or .body
    if (typeof x === 'object') {
      if (Array.isArray(x.data)) return x.data;
      if (Array.isArray(x.body)) return x.body;
      // maybe keys are timeframe inside object (not expected here)
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

  // Binance candle shape is typically 12 fields per candle (openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, tbBaseVol, tbQuoteVol, ignore)
  const BINANCE_FIELDS = 12;

  function isArrayOfArrays(arr) {
    return Array.isArray(arr) && arr.length > 0 && Array.isArray(arr[0]);
  }

  function isArrayOfObjects(arr) {
    return Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && !Array.isArray(arr[0]);
  }

  // If we get a flattened flat numeric array (rare), chunk into candles
  function chunkFlatNumericArray(arr, fields = BINANCE_FIELDS) {
    if (!Array.isArray(arr)) return [];
    // check if first is not array and length divisible by fields
    if (arr.length > 0 && !Array.isArray(arr[0]) && (arr.length % fields === 0)) {
      const out = [];
      for (let i = 0; i < arr.length; i += fields) {
        out.push(arr.slice(i, i + fields));
      }
      return out;
    }
    return arr;
  }

  // Normalize a single candle row (array or object) into object with numeric fields
  function normalizeCandleRow(row) {
    if (!row) return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
    if (Array.isArray(row)) {
      const safe = (v) => {
        if (v === undefined || v === null) return null;
        const n = Number(v);
        return Number.isNaN(n) ? null : n;
      };
      return {
        openTime: safe(row[0]),
        open: safe(row[1]),
        high: safe(row[2]),
        low: safe(row[3]),
        close: safe(row[4]),
        volume: safe(row[5]),
        closeTime: safe(row[6]),
        trades: safe(row[8])
      };
    } else if (typeof row === 'object') {
      const safe = (v) => (v === undefined || v === null ? null : Number(v));
      return {
        openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
        open: safe(row.open ?? row.o ?? row.price ?? null),
        high: safe(row.high ?? row.h ?? null),
        low: safe(row.low ?? row.l ?? null),
        close: safe(row.close ?? row.c ?? null),
        volume: safe(row.volume ?? row.v ?? null),
        closeTime: safe(row.closeTime ?? null),
        trades: safe(row.trades ?? row.n ?? null)
      };
    } else {
      return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
    }
  }

  function normalizeCandlesRaw(raw) {
    // Accept: array-of-arrays, array-of-objects, or flat numeric -> chunk
    if (!raw) return [];
    // attempt chunking first if first element is not array
    if (Array.isArray(raw) && raw.length > 0 && !Array.isArray(raw[0])) {
      // maybe chunk flat numeric arrays
      const chunked = chunkFlatNumericArray(raw, BINANCE_FIELDS);
      if (Array.isArray(chunked) && chunked.length > 0 && Array.isArray(chunked[0])) {
        return chunked.map(normalizeCandleRow);
      }
    }
    // if array-of-arrays or array-of-objects
    if (Array.isArray(raw)) {
      return raw.map(normalizeCandleRow);
    }
    // object wrapper: try data/body
    if (typeof raw === 'object') {
      if (Array.isArray(raw.data)) return raw.data.map(normalizeCandleRow);
      if (Array.isArray(raw.body)) return raw.body.map(normalizeCandleRow);
    }
    return [];
  }

  // Normalize each timeframe
  const normalized = {
    '15m': normalizeCandlesRaw(kline_15m),
    '1h': normalizeCandlesRaw(kline_1h),
    '4h': normalizeCandlesRaw(kline_4h),
    '1d': normalizeCandlesRaw(kline_1d)
  };

  // Logging for debug in Vercel logs
  console.log('[indicators] symbol=', symbol, 'lengths=', {
    '15m': normalized['15m'].length,
    '1h': normalized['1h'].length,
    '4h': normalized['4h'].length,
    '1d': normalized['1d'].length
  });

  // ---------- Indicator implementations (pure JS, resilient) ----------
  const toNum = (v) => (v == null ? null : Number(v));

  function sma(values, period) {
    if (!Array.isArray(values)) return [];
    const out = new Array(values.length).fill(null);
    if (period <= 0) return out;
    let sum = 0;
    let count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      sum += (v == null ? 0 : v);
      count++;
      if (i >= period) {
        const rem = values[i - period];
        sum -= (rem == null ? 0 : rem);
        count--;
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
      if (prev == null) prev = v;
      else prev = v * k + prev * (1 - k);
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
      const d = (values[i] == null || values[i - 1] == null) ? 0 : (values[i] - values[i - 1]);
      if (d > 0) gains += d; else losses += Math.abs(d);
    }
    let avgGain = gains / period, avgLoss = losses / period;
    out[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
    for (let i = period + 1; i < values.length; i++) {
      const d = (values[i] == null || values[i - 1] == null) ? 0 : (values[i] - values[i - 1]);
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
    const macdLine = values.map((v, i) => (emaFast[i] == null || emaSlow[i] == null) ? null : emaFast[i] - emaSlow[i]);
    const signalLine = ema(macdLine.map(v => v == null ? 0 : v), signal);
    const hist = macdLine.map((v, i) => (v == null || signalLine[i] == null) ? null : v - signalLine[i]);
    return { macdLine, signalLine, hist };
  }

  function trueRange(highs, lows, closes) {
    const tr = [];
    for (let i = 0; i < highs.length; i++) {
      if (i === 0) tr.push((highs[i] == null || lows[i] == null) ? null : (highs[i] - lows[i]));
      else {
        const a = (highs[i] == null || lows[i] == null) ? null : (highs[i] - lows[i]);
        const b = (highs[i] == null || closes[i - 1] == null) ? null : Math.abs(highs[i] - closes[i - 1]);
        const c = (lows[i] == null || closes[i - 1] == null) ? null : Math.abs(lows[i] - closes[i - 1]);
        const cand = [a, b, c].filter(x => x != null);
        tr.push(cand.length ? Math.max(...cand) : null);
      }
    }
    return tr;
  }

  function atr(highs, lows, closes, period = 14) {
    const tr = trueRange(highs, lows, closes);
    // ATR via Wilder smoothing (use SMA of TR for first value then smoothed)
    const out = new Array(tr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < tr.length; i++) {
      if (tr[i] == null) { out[i] = null; continue; }
      if (i < period) { sum += tr[i]; if (i === period - 1) out[i] = sum / period; continue; }
      out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
  }

  function superTrend(highs, lows, closes, period = 10, mult = 3) {
    const atrArr = atr(highs, lows, closes, period);
    const hl2 = highs.map((h, i) => (h == null || lows[i] == null) ? null : (h + lows[i]) / 2);
    const upper = hl2.map((v, i) => v == null || atrArr[i] == null ? null : v + mult * atrArr[i]);
    const lower = hl2.map((v, i) => v == null || atrArr[i] == null ? null : v - mult * atrArr[i]);
    const finalUpper = new Array(closes.length).fill(null);
    const finalLower = new Array(closes.length).fill(null);
    const st = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) { finalUpper[i] = upper[i]; finalLower[i] = lower[i]; st[i] = null; continue; }
      finalUpper[i] = (upper[i] == null || finalUpper[i - 1] == null) ? upper[i] : Math.min(upper[i], finalUpper[i - 1]);
      finalLower[i] = (lower[i] == null || finalLower[i - 1] == null) ? lower[i] : Math.max(lower[i], finalLower[i - 1]);
      if (st[i - 1] === finalUpper[i - 1]) {
        st[i] = (closes[i] < finalUpper[i]) ? finalUpper[i] : finalLower[i];
      } else {
        st[i] = (closes[i] > finalLower[i]) ? finalLower[i] : finalUpper[i];
      }
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

  // ADX calculation (Wilder's method)
  function adx(highs, lows, closes, period = 14) {
    const length = highs.length;
    const plusDM = new Array(length).fill(0);
    const minusDM = new Array(length).fill(0);
    const tr = trueRange(highs, lows, closes);
    for (let i = 1; i < length; i++) {
      const up = highs[i] - highs[i - 1];
      const down = lows[i - 1] - lows[i];
      plusDM[i] = (up > down && up > 0) ? up : 0;
      minusDM[i] = (down > up && down > 0) ? down : 0;
    }
    // Smooth
    function rma(arr, p) { // Wilder RMA
      const out = new Array(arr.length).fill(null);
      let sum = 0;
      for (let i = 0; i < arr.length; i++) {
        if (i < p) { sum += (arr[i] == null ? 0 : arr[i]); if (i === p - 1) out[i] = sum / p; continue; }
        out[i] = (out[i - 1] * (p - 1) + (arr[i] == null ? 0 : arr[i])) / p;
      }
      return out;
    }
    const trR = rma(tr, period);
    const plusR = rma(plusDM, period);
    const minusR = rma(minusDM, period);
    const plusDI = plusR.map((v, i) => (v == null || trR[i] == null || trR[i] === 0) ? null : (100 * v / trR[i]));
    const minusDI = minusR.map((v, i) => (v == null || trR[i] == null || trR[i] === 0) ? null : (100 * v / trR[i]));
    const dx = plusDI.map((p, i) => (p == null || minusDI[i] == null || (p + minusDI[i] === 0)) ? null : (100 * Math.abs(p - minusDI[i]) / (p + minusDI[i])));
    const adxArr = rma(dx.map(d => d == null ? 0 : d), period);
    return { plusDI, minusDI, dx, adx: adxArr };
  }

  function vwap(candles) {
    // naive VWAP over provided candles
    let cumPV = 0, cumVol = 0;
    const out = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      const typical = (c.high == null || c.low == null || c.close == null) ? null : ((c.high + c.low + c.close) / 3);
      if (typical == null || c.volume == null) { out.push(null); continue; }
      cumPV += typical * c.volume;
      cumVol += c.volume;
      out.push(cumVol === 0 ? null : (cumPV / cumVol));
    }
    return out;
  }

  function obv(candles) {
    const out = [];
    let cum = 0;
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) { out.push(0); continue; }
      const prev = candles[i - 1];
      if (c.close == null || prev.close == null || c.volume == null) { out.push(cum); continue; }
      if (c.close > prev.close) cum += c.volume;
      else if (c.close < prev.close) cum -= c.volume;
      out.push(cum);
    }
    return out;
  }

  function stochastic(candles, kPeriod = 14, dPeriod = 3) {
    const highs = candles.map(c => c.high), lows = candles.map(c => c.low), closes = candles.map(c => c.close);
    const k = new Array(candles.length).fill(null);
    for (let i = kPeriod - 1; i < candles.length; i++) {
      const hh = Math.max(...highs.slice(i - kPeriod + 1, i + 1).filter(v => v != null));
      const ll = Math.min(...lows.slice(i - kPeriod + 1, i + 1).filter(v => v != null));
      const cl = closes[i];
      k[i] = (hh === ll || cl == null) ? null : (100 * (cl - ll) / (hh - ll));
    }
    // d is sma of k
    const d = sma(k, dPeriod);
    return { k, d };
  }

  // ---------- Scoring & signal logic ----------
  // We'll compute a score per timeframe from 0..100 (approx) based on indicator confirmations.
  // Weights can be tuned. We'll use a conservative weighting tuned for clarity.

  function analyzeTimeframe(tfName, candles) {
    const notes = [];
    const result = { tf: tfName, length: candles.length, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };

    // create numeric series
    const closes = candles.map(c => toNum(c.close));
    const highs = candles.map(c => toNum(c.high));
    const lows = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));

    // minimum requirements
    const minRequired = 26; // for MACD(26) etc
    if (closes.length < 5) {
      result.reasons.push('insufficient candles (<5)');
      result.signal = 'HOLD';
      return result;
    }

    // calculate indicators (use available length, but some may be null if short)
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsi14 = rsiWilder(closes, 14);
    const macdObj = macd(closes, 12, 26, 9);
    const atr14 = atr(highs, lows, closes, 14);
    const st = superTrend(highs, lows, closes, 10, 3);
    const bb = bollinger(closes, 20, 2);
    const vwapArr = vwap(candles);
    const obvArr = obv(candles);
    const stoch = stochastic(candles, 14, 3);
    const adxObj = adx(highs, lows, closes, 14);

    const i = closes.length - 1;
    const last = {
      open: closes[i],
      high: highs[i],
      low: lows[i],
      close: closes[i],
      volume: volumes[i],
      time: candles[i] ? candles[i].openTime : null
    };

    result.last = last;
    result.indicators = {
      sma50: sma50[i] ?? null,
      sma200: sma200[i] ?? null,
      ema9: ema9[i] ?? null,
      ema21: ema21[i] ?? null,
      rsi14: rsi14[i] ?? null,
      macd: macdObj.macdLine[i] ?? null,
      macd_signal: macdObj.signalLine[i] ?? null,
      macd_hist: macdObj.hist[i] ?? null,
      atr14: atr14[i] ?? null,
      supertrend: st[i] ?? null,
      bb_upper: (bb[i] && bb[i].upper) ? bb[i].upper : null,
      bb_mid: (bb[i] && bb[i].middle) ? bb[i].middle : null,
      bb_lower: (bb[i] && bb[i].lower) ? bb[i].lower : null,
      vwap: vwapArr[i] ?? null,
      obv: obvArr[i] ?? null,
      stoch_k: stoch.k[i] ?? null,
      stoch_d: stoch.d[i] ?? null,
      adx: adxObj.adx[i] ?? null,
      plusDI: adxObj.plusDI[i] ?? null,
      minusDI: adxObj.minusDI[i] ?? null
    };

    // Scoring system: each check adds/subtracts points (weights sum approx 100)
    let score = 0;
    const reasons = [];

    // Trend strength
    const hasSMA50 = result.indicators.sma50 != null;
    const hasSMA200 = result.indicators.sma200 != null;
    if (hasSMA50 && hasSMA200) {
      if (last.close > result.indicators.sma50) { score += 8; reasons.push('price > SMA50'); }
      else reasons.push('price <= SMA50');
      if (result.indicators.sma50 > result.indicators.sma200) { score += 10; reasons.push('SMA50 > SMA200 (bullish bias)'); }
      else reasons.push('SMA50 <= SMA200 (bearish bias)');
    } else if (hasSMA50) {
      if (last.close > result.indicators.sma50) { score += 5; reasons.push('price > SMA50 (partial)'); }
    }

    // EMA momentum
    if (result.indicators.ema9 != null) {
      if (last.close > result.indicators.ema9) { score += 6; reasons.push('price > EMA9'); } else reasons.push('price <= EMA9');
    }
    if (result.indicators.ema21 != null) {
      if (result.indicators.ema9 > result.indicators.ema21) { score += 4; reasons.push('EMA9 > EMA21 (short momentum)'); } else reasons.push('EMA9 <= EMA21');
    }

    // MACD momentum
    if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
      if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) { score += 12; reasons.push('MACD bullish'); }
      else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) { score -= 8; reasons.push('MACD bearish'); }
    }

    // SuperTrend
    if (result.indicators.supertrend != null) {
      if (last.close > result.indicators.supertrend) { score += 10; reasons.push('SuperTrend bullish'); } else { score -= 6; reasons.push('SuperTrend bearish'); }
    }

    // ADX: trend strength
    if (result.indicators.adx != null) {
      if (result.indicators.adx >= 25) { score += 8; reasons.push(`ADX ${Math.round(result.indicators.adx)} strong trend`); }
      else if (result.indicators.adx >= 20) { score += 4; reasons.push(`ADX ${Math.round(result.indicators.adx)} moderate`); }
      else reasons.push(`ADX ${result.indicators.adx ? Math.round(result.indicators.adx) : 'n/a'} weak`);
    }

    // RSI: avoid overbought/oversold extremes; mild scoring
    if (result.indicators.rsi14 != null) {
      if (result.indicators.rsi14 < 30) { score += 3; reasons.push('RSI oversold'); }
      else if (result.indicators.rsi14 > 70) { score -= 4; reasons.push('RSI overbought'); }
    }

    // Bollinger: price outside band may indicate move; give small weight
    if (result.indicators.bb_upper != null && result.indicators.bb_lower != null) {
      if (last.close > result.indicators.bb_upper) { score += 2; reasons.push('price above BB upper'); }
      else if (last.close < result.indicators.bb_lower) { score += 2; reasons.push('price below BB lower (possible reversal)'); }
    }

    // VWAP & OBV: volume confirmation
    if (result.indicators.vwap != null) {
      if (last.close > result.indicators.vwap) { score += 5; reasons.push('price > VWAP (intraday buy pressure)'); } else reasons.push('price <= VWAP');
    }
    // OBV slope last 5
    if (obvArr.length >= 6) {
      const obvSlope = obvArr[obvArr.length - 1] - obvArr[Math.max(0, obvArr.length - 6)];
      if (obvSlope > 0) { score += 3; reasons.push('OBV rising'); } else reasons.push('OBV falling or flat');
    }

    // Stochastic: not strongly weighted, prevents entries when overbought
    if (result.indicators.stoch_k != null && result.indicators.stoch_d != null) {
      if (result.indicators.stoch_k < 20 && result.indicators.stoch_d < 20) { score += 2; reasons.push('Stochastic oversold'); }
      if (result.indicators.stoch_k > 80 && result.indicators.stoch_d > 80) { score -= 2; reasons.push('Stochastic overbought'); }
    }

    // Volatility spike detection: ATR relative to mean ATR
    if (atr14 && atr14.length > 20) {
      const recentAtr = atr14.filter(x => x != null).slice(-20);
      const meanAtr = recentAtr.reduce((a, b) => a + (b || 0), 0) / Math.max(1, recentAtr.length);
      const lastAtr = atr14[i] ?? 0;
      if (meanAtr > 0 && lastAtr > meanAtr * 1.8) { result.volatilitySpike = true; reasons.push('ATR spike'); score -= 5; }
    }

    // Compose final score with clamps
    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    result.reasons = reasons;

    // Decide signal thresholds:
    // Strong Buy if score >= 30
    // Buy if score >= 12
    // Sell if score <= -12
    // Strong Sell if score <= -30
    if (result.score >= 30) result.signal = 'STRONG BUY';
    else if (result.score >= 12) result.signal = 'BUY';
    else if (result.score <= -30) result.signal = 'STRONG SELL';
    else if (result.score <= -12) result.signal = 'SELL';
    else result.signal = 'HOLD';

    return result;
  }

  // Analyze each timeframe
  const tfResults = {};
  for (const tf of Object.keys(normalized)) {
    tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);
  }

  // ---------- Voting & final decision ----------
  // Votes weighting: more weight to higher timeframes
  const weight = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };

  for (const tf of Object.keys(tfResults)) {
    const r = tfResults[tf];
    tally[r.signal] = (tally[r.signal] || 0) + weight[tf];
  }

  // Decide final signal using weighted rules
  // prioritize strong signals on higher TFs
  let final_signal = 'HOLD';
  // if any STRONG BUY in 4h/1d and not many sell weight => STRONG BUY
  const strongBuyWeight = (tally['STRONG BUY'] || 0);
  const strongSellWeight = (tally['STRONG SELL'] || 0);
  const buyWeight = (tally['BUY'] || 0) + strongBuyWeight * 1.5;
  const sellWeight = (tally['SELL'] || 0) + strongSellWeight * 1.5;

  if (strongBuyWeight >= 4 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 4 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 4) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 4) final_signal = 'SELL';
  else final_signal = 'HOLD';

  // ---------- Entry / SL / TP suggestions ----------
  // Use last close on 1h as primary reference (fall back to 15m)
  const refTf = (tfResults['1h'] && tfResults['1h'].last.close != null) ? '1h' : (tfResults['15m'] && tfResults['15m'].last.close != null) ? '15m' : '4h';
  const ref = tfResults[refTf] || { last: { close: null }, indicators: {} };
  const entryPrice = ref.last.close || null;

  // ATR-based SL: use ATR from ref timeframe or nearest available
  function pickAtr(tf) {
    const r = tfResults[tf];
    if (r && r.indicators && r.indicators.atr14 != null) return r.indicators.atr14;
    return null;
  }
  let atrRef = pickAtr(refTf) || pickAtr('15m') || pickAtr('1h') || pickAtr('4h') || pickAtr('1d') || null;

  // if ATR missing, estimate from price * small percentage
  if (atrRef == null && entryPrice != null) atrRef = entryPrice * 0.005; // 0.5% fallback

  // Risk level multipliers (client supplied semantics)
  // Level 1: DCA (conservative) — small risk → use tighter SL multiplier
  // Level 2: up to 5% risk — moderate
  // Level 3: up to 10% risk — aggressive
  const slMultipliers = { level1: 1.2, level2: 1.8, level3: 2.8 };

  const suggestions = {};
  const levels = ['level1', 'level2', 'level3'];
  for (const lvl of levels) {
    const m = slMultipliers[lvl];
    const sl = (entryPrice != null && atrRef != null) ? (entryPrice - (atrRef * m)) : null; // for BUY; if SELL, flip logic
    const tp1 = (entryPrice != null && atrRef != null) ? (entryPrice + atrRef * (m * 1.5)) : null;
    const tp2 = (entryPrice != null && atrRef != null) ? (entryPrice + atrRef * (m * 3)) : null;
    suggestions[lvl] = {
      entry: entryPrice,
      stop_loss: sl,
      take_profit_1: tp1,
      take_profit_2: tp2,
      atr_used: atrRef,
      sl_multiplier: m
    };
  }

  // Compose votes object (human readable counts by timeframe)
  const votes = {};
  for (const tf of Object.keys(tfResults)) votes[tf] = tfResults[tf].signal;

  // Collect reasons actionable: top reasons across TFs
  const reasons = [];
  for (const tf of Object.keys(tfResults)) {
    const r = tfResults[tf];
    if (r.reasons && r.reasons.length) reasons.push({ timeframe: tf, score: r.score, reasons: r.reasons.slice(0, 6) });
  }

  // Final output payload
  const output = {
    symbol: symbol || null,
    exchangeSymbol: exchangeSymbol || null,
    final_signal,
    votesSummary: {
      weighted: { buyWeight: buyWeight, sellWeight: sellWeight, strongBuyWeight, strongSellWeight },
      byTf: votes
    },
    suggestions,
    reasons,
    details: tfResults
  };

  // Logging
  console.log('[indicators] final_signal=', final_signal, 'votesSummary=', output.votesSummary);

  return res.status(200).json(output);
}

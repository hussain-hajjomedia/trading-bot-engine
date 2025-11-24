// api/indicators-gold.js
// Phase 1 XAUUSD engine – simple trend-following pullback system

const BINANCE_FIELDS = 12;

// ---------- Input normalization helpers (copied & simplified from indicators.js) ----------
function tryParseMaybeJson(input) {
  if (input === undefined || input === null) return null;
  if (Array.isArray(input)) return input;
  if (typeof input === 'string') {
    try { return JSON.parse(input); } catch { return input; }
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
  let arr = extractArrayFromPossibleWrapper(p);

  // Special handling for AlphaVantage-style wrapper you use for gold:
  // kline_15m / 1h / 4h / 1d are like:
  // [ { meta: {...}, values: [ { datetime, open, high, low, close }, ... ], status: "ok" } ]
  if (Array.isArray(arr) && arr.length > 0) {
    const first = arr[0];
    if (first && typeof first === 'object' && Array.isArray(first.values)) {
      return first.values;
    }
  }

  return arr;
}

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
  if (!row) {
    return { openTime: null, open: null, high: null, low: null, close: null, volume: null };
  }
  const safeNum = (v) => {
    if (v === undefined || v === null) return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const safeTime = (v) => {
    if (v === undefined || v === null) return null;
    // If it's already a number, use it
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    // Try numeric string first
    const asNum = Number(v);
    if (!Number.isNaN(asNum)) return asNum;
    // Fallback: try Date parsing (for "2025-11-24 20:15:00" etc.)
    const parsed = Date.parse(v);
    return Number.isNaN(parsed) ? null : parsed;
  };
  if (Array.isArray(row)) {
    return {
      openTime: safeTime(row[0]),
      open: safeNum(row[1]),
      high: safeNum(row[2]),
      low: safeNum(row[3]),
      close: safeNum(row[4]),
      volume: safeNum(row[5]),
    };
  } else if (typeof row === 'object') {
    return {
      // Accept multiple time keys, including your "datetime"
      openTime: safeTime(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? row.datetime ?? null),
      open: safeNum(row.open ?? row.o ?? row.price ?? null),
      high: safeNum(row.high ?? row.h ?? null),
      low: safeNum(row.low ?? row.l ?? null),
      close: safeNum(row.close ?? row.c ?? null),
      volume: safeNum(row.volume ?? row.v ?? null),
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

function takeLast(arr, n) {
  if (!Array.isArray(arr)) return [];
  if (arr.length <= n) return arr;
  return arr.slice(arr.length - n);
}

function finalizeCandles(rawArr) {
  if (!Array.isArray(rawArr)) return [];
  const arr = rawArr.filter(c => c && c.openTime != null && Number.isFinite(Number(c.openTime)));
  arr.sort((a, b) => Number(a.openTime) - Number(b.openTime));
  const out = [];
  const seen = new Set();
  for (let i = 0; i < arr.length; i++) {
    const ot = Number(arr[i].openTime);
    if (seen.has(ot)) continue;
    seen.add(ot);
    out.push(arr[i]);
  }
  return out;
}

// ---------- Indicator helpers ----------
const toNum = (v) => (v == null ? null : Number(v));

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
    if (i < period) {
      sum += tr[i];
      if (i === period - 1) out[i] = sum / period;
      continue;
    }
    out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
  }
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

// Compute core indicators for a given timeframe
function computeTfIndicators(candles, options = {}) {
  const { needRsi } = options;
  const closes = candles.map(c => toNum(c.close));
  const highs = candles.map(c => toNum(c.high));
  const lows = candles.map(c => toNum(c.low));
  const len = closes.length;
  if (!len) {
    return {
      ok: false,
      last: null,
      ema20: null,
      ema50: null,
      ema200: null,
      atr14: null,
      rsi14: null
    };
  }

  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const ema200Arr = ema(closes, 200);
  const atrArr = atr(highs, lows, closes, 14);
  const rsiArr = needRsi ? rsiWilder(closes, 14) : null;

  const i = len - 1;
  return {
    ok: true,
    last: candles[i],
    ema20: ema20Arr[i],
    ema50: ema50Arr[i],
    ema200: ema200Arr[i],
    atr14: atrArr[i],
    rsi14: rsiArr ? rsiArr[i] : null
  };
}

// Map confidence (0..1) and direction to STRONG SELL/SELL/HOLD/BUY/STRONG BUY
function finalSignalLabel(direction, confidence) {
  const c = Number(confidence);
  if (!direction || !Number.isFinite(c) || c < 0.5) return 'HOLD';
  if (direction === 'UP') {
    if (c >= 0.85) return 'STRONG BUY';
    if (c >= 0.70) return 'BUY';
    return 'HOLD';
  }
  if (direction === 'DOWN') {
    if (c >= 0.85) return 'STRONG SELL';
    if (c >= 0.70) return 'SELL';
    return 'HOLD';
  }
  return 'HOLD';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

    // Normalize input candles
    kline_15m = parseInputField(kline_15m);
    kline_1h = parseInputField(kline_1h);
    kline_4h = parseInputField(kline_4h);
    kline_1d = parseInputField(kline_1d);

    const normalized = {
      '15m': takeLast(finalizeCandles(normalizeCandlesRaw(kline_15m)), 400),
      '1h': takeLast(finalizeCandles(normalizeCandlesRaw(kline_1h)), 300),
      '4h': takeLast(finalizeCandles(normalizeCandlesRaw(kline_4h)), 250),
      '1d': takeLast(finalizeCandles(normalizeCandlesRaw(kline_1d)), 200),
    };

    // If we don't have enough data on key TFs, just return HOLD
    if (!normalized['4h'].length || !normalized['1h'].length || !normalized['15m'].length || !normalized['1d'].length) {
      return res.status(200).json({
        symbol: symbol || 'XAUUSD',
        last_price: null,
        tf_used: '15m',
        bias: 'HOLD',
        bias_confidence: 0,
        final_signal: 'HOLD',
        final_signal_confidence: 0,
        execute_order: false,
        order_plan: null,
        reason: 'insufficient_data'
      });
    }

    // Compute indicators per timeframe
    const tfD = computeTfIndicators(normalized['1d']);
    const tf4h = computeTfIndicators(normalized['4h']);
    const tf1h = computeTfIndicators(normalized['1h'], { needRsi: true });
    const tf15m = computeTfIndicators(normalized['15m']);

    const lastPrice =
      toNum(tf15m.last?.close) ??
      toNum(tf1h.last?.close) ??
      toNum(tf4h.last?.close) ??
      toNum(tfD.last?.close) ??
      null;

    // ---------- Bias & trend evaluation ----------
    let d1Bias = 'NEUTRAL';
    if (Number.isFinite(tfD.last?.close) && Number.isFinite(tfD.ema50) && Number.isFinite(tfD.ema200)) {
      if (tfD.last.close > tfD.ema50 && tfD.ema50 > tfD.ema200) d1Bias = 'BULLISH';
      else if (tfD.last.close < tfD.ema50 && tfD.ema50 < tfD.ema200) d1Bias = 'BEARISH';
    }

    let trend4h = 'RANGE';
    if (Number.isFinite(tf4h.last?.close) && Number.isFinite(tf4h.ema50) && Number.isFinite(tf4h.ema20)) {
      if (tf4h.last.close > tf4h.ema50 && tf4h.ema20 > tf4h.ema50) trend4h = 'BULLISH';
      else if (tf4h.last.close < tf4h.ema50 && tf4h.ema20 < tf4h.ema50) trend4h = 'BEARISH';
    }

    let align1h = 'NEUTRAL';
    if (Number.isFinite(tf1h.last?.close) && Number.isFinite(tf1h.ema50)) {
      if (tf1h.last.close > tf1h.ema50) align1h = 'ABOVE_EMA50';
      else if (tf1h.last.close < tf1h.ema50) align1h = 'BELOW_EMA50';
    }

    // Combined bias
    let bias = 'HOLD';
    if (d1Bias === 'BULLISH' && trend4h === 'BULLISH') bias = 'BUY';
    else if (d1Bias === 'BEARISH' && trend4h === 'BEARISH') bias = 'SELL';

    // Bias confidence
    let biasConfidence = 0.3;
    if (bias === 'BUY') {
      if (d1Bias === 'BULLISH' && trend4h === 'BULLISH' && align1h === 'ABOVE_EMA50') biasConfidence = 0.9;
      else if (d1Bias === 'BULLISH' && trend4h === 'BULLISH') biasConfidence = 0.7;
      else biasConfidence = 0.4;
    } else if (bias === 'SELL') {
      if (d1Bias === 'BEARISH' && trend4h === 'BEARISH' && align1h === 'BELOW_EMA50') biasConfidence = 0.9;
      else if (d1Bias === 'BEARISH' && trend4h === 'BEARISH') biasConfidence = 0.7;
      else biasConfidence = 0.4;
    } else {
      biasConfidence = 0.3;
    }

    // ---------- Setup & trigger detection ----------
    const rsi1h = Number.isFinite(tf1h.rsi14) ? tf1h.rsi14 : null;
    const allowLongRsi = !(Number.isFinite(rsi1h) && rsi1h > 75);
    const allowShortRsi = !(Number.isFinite(rsi1h) && rsi1h < 25);

    const last1h = tf1h.last;
    const last15m = tf15m.last;

    const close1h = toNum(last1h?.close);
    const high1h = toNum(last1h?.high);
    const low1h = toNum(last1h?.low);

    const close15m = toNum(last15m?.close);

    const ema20_1h = tf1h.ema20;
    const ema50_1h = tf1h.ema50;
    const ema20_15m = tf15m.ema20;

    // Long context
    const canLong =
      bias === 'BUY' &&
      trend4h === 'BULLISH' &&
      align1h === 'ABOVE_EMA50' &&
      allowLongRsi;

    // Short context
    const canShort =
      bias === 'SELL' &&
      trend4h === 'BEARISH' &&
      align1h === 'BELOW_EMA50' &&
      allowShortRsi;

    // 1H pullback conditions
    const longPullback1h =
      canLong &&
      Number.isFinite(low1h) &&
      Number.isFinite(close1h) &&
      Number.isFinite(ema20_1h) &&
      low1h <= ema20_1h &&
      close1h >= ema20_1h &&
      (!Number.isFinite(ema50_1h) || close1h >= ema50_1h);

    const shortPullback1h =
      canShort &&
      Number.isFinite(high1h) &&
      Number.isFinite(close1h) &&
      Number.isFinite(ema20_1h) &&
      high1h >= ema20_1h &&
      close1h <= ema20_1h &&
      (!Number.isFinite(ema50_1h) || close1h <= ema50_1h);

    // 15m trigger conditions
    const longTrigger15m =
      longPullback1h &&
      Number.isFinite(close15m) &&
      Number.isFinite(ema20_15m) &&
      close15m > ema20_15m;

    const shortTrigger15m =
      shortPullback1h &&
      Number.isFinite(close15m) &&
      Number.isFinite(ema20_15m) &&
      close15m < ema20_15m;

    let tradeDirection = null; // 'UP' or 'DOWN'
    if (longTrigger15m) tradeDirection = 'UP';
    else if (shortTrigger15m) tradeDirection = 'DOWN';

    // ---------- SL / TP construction ----------
    const atr4h = Number.isFinite(tf4h.atr14) ? tf4h.atr14 : null;
    let entryPrice = lastPrice;
    let sl = null;
    let tp1 = null;
    let tp2 = null;
    let rDistance = null;

    if (tradeDirection && Number.isFinite(entryPrice) && Number.isFinite(atr4h)) {
      const slDist = 1.5 * atr4h; // 1.5x ATR(4H)
      if (tradeDirection === 'UP') {
        sl = entryPrice - slDist;
      } else if (tradeDirection === 'DOWN') {
        sl = entryPrice + slDist;
      }
      if (Number.isFinite(sl)) {
        rDistance = Math.abs(entryPrice - sl);
        if (tradeDirection === 'UP') {
          tp1 = entryPrice + 1.3 * rDistance;
          tp2 = entryPrice + 2.0 * rDistance;
        } else {
          tp1 = entryPrice - 1.3 * rDistance;
          tp2 = entryPrice - 2.0 * rDistance;
        }
      }
    }

    // ---------- Final signal confidence ----------
    let finalSignalConfidence = 0;
    if (tradeDirection) {
      // Base on bias confidence and presence of pullback+trigger
      const setupScore = (longPullback1h || shortPullback1h) ? 0.2 : 0;
      const triggerScore = (longTrigger15m || shortTrigger15m) ? 0.2 : 0;
      finalSignalConfidence = Math.min(1, biasConfidence + setupScore + triggerScore);
      // Clamp minimum if fully valid
      if (finalSignalConfidence < 0.7 && (longTrigger15m || shortTrigger15m)) {
        finalSignalConfidence = 0.7;
      }
    } else {
      finalSignalConfidence = biasConfidence * 0.5;
    }

    const finalSignal = finalSignalLabel(tradeDirection, finalSignalConfidence);
    const executeOrder =
      (finalSignal === 'BUY' ||
        finalSignal === 'STRONG BUY' ||
        finalSignal === 'SELL' ||
        finalSignal === 'STRONG SELL') &&
      finalSignalConfidence >= 0.7 &&
      Number.isFinite(entryPrice) &&
      Number.isFinite(sl) &&
      Number.isFinite(tp1);

    const orderPlan = executeOrder
      ? {
          side: finalSignal, // STRONG BUY/BUY/SELL/STRONG SELL
          entry: entryPrice,
          stop_loss: sl,
          take_profit_1: tp1,
          take_profit_2: tp2,
          r_distance: rDistance,
          atr_4h_used: atr4h,
          tf_entry: '15m',
          profit_taking: {
            tp1_close_percent: 50,
            tp2_close_percent: 50,
            breakeven_after_tp1: true
          }
        }
      : null;

    const output = {
      symbol: symbol || 'XAUUSD',
      timestamp: normalized['4h']?.[normalized['4h'].length - 1]?.openTime ?? null,
      last_price: lastPrice,
      tf_used: '15m',

      bias,
      bias_confidence: Number(biasConfidence.toFixed(3)),
      trend_4h: trend4h,
      align_1h: align1h,
      rsi_1h: Number.isFinite(rsi1h) ? Number(rsi1h.toFixed(2)) : null,

      final_signal: finalSignal,
      final_signal_confidence: Number(finalSignalConfidence.toFixed(3)),
      execute_order: !!executeOrder,

      entry_price: Number.isFinite(entryPrice) ? entryPrice : null,
      stop_loss: Number.isFinite(sl) ? sl : null,
      take_profit_1: Number.isFinite(tp1) ? tp1 : null,
      take_profit_2: Number.isFinite(tp2) ? tp2 : null,
      r_distance: Number.isFinite(rDistance) ? rDistance : null,
      atr_4h: Number.isFinite(atr4h) ? atr4h : null,
      sl_distance_atr: Number.isFinite(rDistance) && Number.isFinite(atr4h) && atr4h > 0
        ? Number((rDistance / atr4h).toFixed(2))
        : null,

      order_plan: orderPlan
    };

    return res.status(200).json(output);
  } catch (err) {
    console.error('[gold] error', err && (err.stack || err.message || err));
    return res.status(500).json({
      error: 'internal error',
      detail: String(err && (err.stack || err.message || err))
    });
  }
};



// api/indicators-gold-scalp.js
// Phase 1b XAUUSD scalp engine – intraday breakout / impulse trades
// Input and output schema intentionally mirror api/indicators-gold.js

const BINANCE_FIELDS = 12;

// ---------- Input normalization helpers (same as indicators-gold.js) ----------
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

  // AlphaVantage-style wrapper:
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
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    const asNum = Number(v);
    if (!Number.isNaN(asNum)) return asNum;
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

    // Normalize candles
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

    // Indicators per TF
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

    // ---------- Bias (scalp version: focus on 4H + 1H, D1 as soft filter) ----------
    let d1Bias = 'NEUTRAL';
    if (Number.isFinite(tfD.last?.close) && Number.isFinite(tfD.ema50) && Number.isFinite(tfD.ema200)) {
      if (tfD.last.close > tfD.ema50 && tfD.ema50 > tfD.ema200) d1Bias = 'BULLISH';
      else if (tfD.last.close < tfD.ema50 && tfD.ema50 < tfD.ema200) d1Bias = 'BEARISH';
    }

    function trendFromEma(tf) {
      if (!Number.isFinite(tf.last?.close) || !Number.isFinite(tf.ema20) || !Number.isFinite(tf.ema50)) {
        return 'RANGE';
      }
      if (tf.last.close > tf.ema50 && tf.ema20 > tf.ema50) return 'BULLISH';
      if (tf.last.close < tf.ema50 && tf.ema20 < tf.ema50) return 'BEARISH';
      return 'RANGE';
    }

    const trend4h = trendFromEma(tf4h);
    const trend1h = trendFromEma(tf1h);

    let bias = 'HOLD';
    if (trend4h === 'BULLISH' && trend1h === 'BULLISH') bias = 'BUY';
    else if (trend4h === 'BEARISH' && trend1h === 'BEARISH') bias = 'SELL';

    // Bias confidence: reward 4H+1H agreement, boost when D1 agrees
    let biasConfidence = 0.3;
    if (bias === 'BUY') {
      if (d1Bias === 'BULLISH') biasConfidence = 0.9;
      else biasConfidence = 0.7; // strong intraday trend even if D1 neutral
    } else if (bias === 'SELL') {
      if (d1Bias === 'BEARISH') biasConfidence = 0.9;
      else biasConfidence = 0.7;
    } else {
      biasConfidence = 0.3;
    }

    // ---------- Scalp setup: 15m range breakout / impulse ----------
    const rsi1h = Number.isFinite(tf1h.rsi14) ? tf1h.rsi14 : null;
    const allowLongRsi = !(Number.isFinite(rsi1h) && rsi1h > 80); // more tolerant
    const allowShortRsi = !(Number.isFinite(rsi1h) && rsi1h < 20);

    const candles15 = normalized['15m'];
    const closes15 = candles15.map(c => toNum(c.close));
    const highs15 = candles15.map(c => toNum(c.high));
    const lows15 = candles15.map(c => toNum(c.low));

    const len15 = closes15.length;
    const lastIdx15 = len15 - 1;

    const lastClose15 = closes15[lastIdx15];
    const lastHigh15 = highs15[lastIdx15];
    const lastLow15 = lows15[lastIdx15];
    const lastOpen15 = toNum(candles15[lastIdx15]?.open);

    const ema20_15m = tf15m.ema20;

    const N_BREAK = 8; // lookback for local range
    function recentExtremes() {
      if (len15 < N_BREAK + 2) return { prevHigh: null, prevLow: null };
      const start = Math.max(0, len15 - (N_BREAK + 1));
      const end = len15 - 1; // exclude current
      const sliceHighs = highs15.slice(start, end).filter(Number.isFinite);
      const sliceLows = lows15.slice(start, end).filter(Number.isFinite);
      if (!sliceHighs.length || !sliceLows.length) return { prevHigh: null, prevLow: null };
      return {
        prevHigh: Math.max(...sliceHighs),
        prevLow: Math.min(...sliceLows)
      };
    }

    const { prevHigh, prevLow } = recentExtremes();

    // Simple 15m true-range average to gauge impulse size
    function avgTrueRange15(n = 20) {
      if (len15 < 2) return null;
      const highs = highs15.slice(-n - 1);
      const lows = lows15.slice(-n - 1);
      const closes = closes15.slice(-n - 1);
      const trArr = trueRange(highs, lows, closes);
      const valid = trArr.filter(Number.isFinite);
      if (!valid.length) return null;
      return valid.reduce((a, b) => a + b, 0) / valid.length;
    }

    const avgTr15 = avgTrueRange15(20);
    const lastRange15 =
      Number.isFinite(lastHigh15) && Number.isFinite(lastLow15)
        ? (lastHigh15 - lastLow15)
        : null;

    // Long breakout/impulse on 15m
    const canLong =
      bias === 'BUY' &&
      allowLongRsi &&
      Number.isFinite(lastClose15) &&
      Number.isFinite(prevHigh) &&
      Number.isFinite(ema20_15m);

    const longBreakout15m =
      canLong &&
      lastClose15 > prevHigh && // break above recent range
      lastClose15 > ema20_15m && // above local value
      Number.isFinite(lastOpen15) &&
      lastClose15 > lastOpen15 && // bullish body
      Number.isFinite(lastRange15) &&
      Number.isFinite(avgTr15) &&
      lastRange15 >= 1.1 * avgTr15; // impulse stronger than recent average

    // Short breakout/impulse on 15m
    const canShort =
      bias === 'SELL' &&
      allowShortRsi &&
      Number.isFinite(lastClose15) &&
      Number.isFinite(prevLow) &&
      Number.isFinite(ema20_15m);

    const shortBreakout15m =
      canShort &&
      lastClose15 < prevLow && // break below recent range
      lastClose15 < ema20_15m &&
      Number.isFinite(lastOpen15) &&
      lastClose15 < lastOpen15 && // bearish body
      Number.isFinite(lastRange15) &&
      Number.isFinite(avgTr15) &&
      lastRange15 >= 1.1 * avgTr15;

    let tradeDirection = null; // 'UP' or 'DOWN'
    let breakoutLevel = null;
    if (longBreakout15m) {
      tradeDirection = 'UP';
      breakoutLevel = prevHigh;
    } else if (shortBreakout15m) {
      tradeDirection = 'DOWN';
      breakoutLevel = prevLow;
    }

    // ---------- SL / TP & entry range (scalp-sized) ----------
    const atr4h = Number.isFinite(tf4h.atr14) ? tf4h.atr14 : null;
    let entryPrice = null;
    let sl = null;
    let tp1 = null;
    let tp2 = null;
    let rDistance = null;
    let entryRangeLow = null;
    let entryRangeHigh = null;

    if (tradeDirection && Number.isFinite(lastPrice) && Number.isFinite(atr4h)) {
      entryPrice = lastPrice;

      // Tighter SL for scalp: 1.0 * ATR(4H)
      const slDist = 1.0 * atr4h;
      if (tradeDirection === 'UP') {
        sl = entryPrice - slDist;
      } else if (tradeDirection === 'DOWN') {
        sl = entryPrice + slDist;
      }
      if (Number.isFinite(sl)) {
        rDistance = Math.abs(entryPrice - sl);
        // Slightly tighter R-multiples for scalps
        if (tradeDirection === 'UP') {
          tp1 = entryPrice + 1.0 * rDistance;
          tp2 = entryPrice + 1.6 * rDistance;
        } else {
          tp1 = entryPrice - 1.0 * rDistance;
          tp2 = entryPrice - 1.6 * rDistance;
        }
      }

      // Entry range around breakout level and entry
      if (Number.isFinite(atr4h) && Number.isFinite(entryPrice)) {
        const a = atr4h;
        const coreLevel = Number.isFinite(breakoutLevel) ? breakoutLevel : entryPrice;
        const bandPad = 0.2 * a;
        let bandLow;
        let bandHigh;

        if (tradeDirection === 'UP') {
          bandLow = coreLevel - bandPad;
          bandHigh = entryPrice + bandPad;
        } else {
          bandLow = entryPrice - bandPad;
          bandHigh = coreLevel + bandPad;
        }

        // Ensure reasonable width for scalp: 0.15–0.6 ATR
        const minW = 0.15 * a;
        const maxW = 0.6 * a;
        let width = bandHigh - bandLow;
        if (!Number.isFinite(width) || width <= 0) {
          bandLow = entryPrice - minW / 2;
          bandHigh = entryPrice + minW / 2;
          width = bandHigh - bandLow;
        } else if (width < minW) {
          const mid = (bandLow + bandHigh) / 2;
          bandLow = mid - minW / 2;
          bandHigh = mid + minW / 2;
        } else if (width > maxW) {
          const mid = (bandLow + bandHigh) / 2;
          bandLow = mid - maxW / 2;
          bandHigh = mid + maxW / 2;
        }

        entryRangeLow = bandLow;
        entryRangeHigh = bandHigh;
      }
    }

    // ---------- Final signal confidence (scalp) ----------
    let finalSignalConfidence = 0;
    if (tradeDirection) {
      // Combine bias strength with breakout quality and impulse size
      const biasScore = biasConfidence; // 0.7 or 0.9 mostly
      let breakoutScore = 0;
      if (tradeDirection === 'UP' && longBreakout15m) breakoutScore = 0.2;
      if (tradeDirection === 'DOWN' && shortBreakout15m) breakoutScore = 0.2;

      let impulseScore = 0;
      if (Number.isFinite(lastRange15) && Number.isFinite(avgTr15) && avgTr15 > 0) {
        const ratio = lastRange15 / avgTr15;
        if (ratio >= 1.4) impulseScore = 0.15;
        else if (ratio >= 1.1) impulseScore = 0.1;
      }

      finalSignalConfidence = Math.min(1, biasScore + breakoutScore + impulseScore);
      if (finalSignalConfidence < 0.7) finalSignalConfidence = 0.7; // minimum for valid scalp setup
    } else {
      finalSignalConfidence = biasConfidence * 0.6;
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
          side: finalSignal,
          entry: entryPrice,
          entry_range: Number.isFinite(entryRangeLow) && Number.isFinite(entryRangeHigh)
            ? { low: entryRangeLow, high: entryRangeHigh }
            : null,
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

    // Confidence labels
    function confidenceLabel(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return 'low';
      if (v >= 0.7) return 'high';
      if (v >= 0.4) return 'medium';
      return 'low';
    }

    const biasConfLabel = confidenceLabel(biasConfidence);
    const finalConfLabel = confidenceLabel(finalSignalConfidence);

    const output = {
      symbol: symbol || 'XAUUSD',
      timestamp: normalized['15m'][normalized['15m'].length - 1]?.openTime ?? null,
      last_price: lastPrice,
      tf_used: '15m',

      bias,
      bias_confidence: `${biasConfidence.toFixed(3)} (${biasConfLabel})`,
      trend_4h: trend4h,
      align_1h: trend1h, // show 1h trend context for scalps
      rsi_1h: Number.isFinite(rsi1h) ? Number(rsi1h.toFixed(2)) : null,

      final_signal: finalSignal,
      final_signal_confidence: `${finalSignalConfidence.toFixed(3)} (${finalConfLabel})`,
      execute_order: !!executeOrder,

      entry_price: Number.isFinite(entryPrice) ? entryPrice : null,
      entry_price_range: Number.isFinite(entryRangeLow) && Number.isFinite(entryRangeHigh)
        ? { low: entryRangeLow, high: entryRangeHigh }
        : null,
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
    console.error('[gold-scalp] error', err && (err.stack || err.message || err));
    return res.status(500).json({
      error: 'internal error',
      detail: String(err && (err.stack || err.message || err))
    });
  }
};



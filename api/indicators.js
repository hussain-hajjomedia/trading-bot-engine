// api/indicators.js
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const payload = req.body;
  let { symbol, exchangeSymbol, klines } = payload || {};

  // Handle klines sent as a JSON string
  try {
    if (typeof klines === 'string') {
      klines = JSON.parse(klines);
    }
    if (klines === null || typeof klines !== 'object') {
      throw new Error('Invalid klines format: must be an object or JSON string');
    }
  } catch (err) {
    res.status(400).json({ error: 'Failed to parse klines', details: err.message });
    return;
  }

  // Helper: convert possible node shapes to an array-of-arrays (Binance style) or array-of-objects
  function extractCandles(maybe) {
    // If null/undefined -> return empty array
    if (maybe === undefined || maybe === null) return [];

    // If it's already an array of arrays -> return as-is
    if (Array.isArray(maybe) && maybe.length > 0 && Array.isArray(maybe[0])) {
      return maybe;
    }

    // If it's an array of objects with open/high/low/close/volume
    if (Array.isArray(maybe) && maybe.length > 0 && typeof maybe[0] === 'object' && !Array.isArray(maybe[0])) {
      // convert to array-of-arrays for consistent parsing later
      return maybe.map(o => {
        // If it already has numeric properties, map them to Binance format indices:
        // [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, tbBaseVolume, tbQuoteVolume, ignore]
        // We will set undefined fields to null if missing
        const openTime = o.openTime ?? o.t ?? o.time ?? o.timestamp ?? null;
        const open = o.open ?? o.o ?? o.price ?? null;
        const high = o.high ?? o.h ?? null;
        const low = o.low ?? o.l ?? null;
        const close = o.close ?? o.c ?? null;
        const volume = o.volume ?? o.v ?? null;
        const closeTime = o.closeTime ?? null;
        const quoteAssetVolume = o.quoteAssetVolume ?? null;
        const trades = o.trades ?? o.n ?? null;
        const tbBaseVolume = o.tbBaseVolume ?? null;
        const tbQuoteVolume = o.tbQuoteVolume ?? null;
        const ignore = null;
        return [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, tbBaseVolume, tbQuoteVolume, ignore];
      });
    }

    // If maybe is an object with .data or .body that contain arrays
    if (typeof maybe === 'object') {
      if (Array.isArray(maybe.data) && maybe.data.length > 0) {
        return extractCandles(maybe.data);
      }
      if (Array.isArray(maybe.body) && maybe.body.length > 0) {
        return extractCandles(maybe.body);
      }
      // If it's a key/value where keys are timeframes (e.g., { "15m": [...] }), we expect the caller to pass the correct field.
    }

    // If maybe is a flat array of numbers (stringified to array) try chunking to 12-field candles
    if (Array.isArray(maybe) && maybe.length > 0 && typeof maybe[0] !== 'object') {
      const FIELDS = 12;
      if (maybe.length % FIELDS === 0) {
        const out = [];
        for (let i = 0; i < maybe.length; i += FIELDS) out.push(maybe.slice(i, i + FIELDS));
        return out;
      }
    }

    // else fallback -> no candles
    return [];
  }

  // Helper: convert array-of-arrays into array-of-objects with numeric fields
  function normalizeArrayCandleRowToObject(arrRow) {
    // arrRow expected like Binance: [openTime, open, high, low, close, volume, closeTime, quoteAssetVolume, trades, tbBaseVolume, tbQuoteVolume, ignore]
    const safe = idx => {
      // protect against undefined and string to number conversion
      const v = arrRow[idx];
      if (v === undefined || v === null) return null;
      // Some values may be numbers already; handle strings like "107.23"
      const n = Number(v);
      return Number.isNaN(n) ? (typeof v === 'string' ? v : null) : n;
    };
    return {
      openTime: safe(0),
      open: safe(1),
      high: safe(2),
      low: safe(3),
      close: safe(4),
      volume: safe(5),
      closeTime: safe(6),
      quoteAssetVolume: safe(7),
      trades: safe(8),
      tbBaseVolume: safe(9),
      tbQuoteVolume: safe(10),
      ignore: safe(11)
    };
  }

  // Now build the per-timeframe normalized structure
  const tfNames = Object.keys(klines); // klines is expected e.g. { "15m": [...], "1h": [...], ... }
  // If user passed only arrays (no timeframe keys), we attempt to detect by conventional keys; but we require timeframe keys.
  // Build normalized container
  const normalized = {}; // { "15m": [ {openTime, open, high, low, close, volume, ...}, ... ], ... }

  for (const tf of tfNames) {
    const raw = klines[tf];
    const rows = extractCandles(raw); // ensure array-of-arrays
    // Convert rows into array-of-objects
    const objs = rows.map(row => {
      if (Array.isArray(row)) {
        return normalizeArrayCandleRowToObject(row);
      } else if (typeof row === 'object' && row !== null) {
        // Already an object — normalize numeric fields
        const toNum = v => {
          if (v === undefined || v === null) return null;
          const n = Number(v);
          return Number.isNaN(n) ? (typeof v === 'string' ? v : null) : n;
        };
        return {
          openTime: toNum(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
          open: toNum(row.open ?? row.o ?? null),
          high: toNum(row.high ?? row.h ?? null),
          low: toNum(row.low ?? row.l ?? null),
          close: toNum(row.close ?? row.c ?? null),
          volume: toNum(row.volume ?? row.v ?? null),
          closeTime: toNum(row.closeTime ?? null),
          trades: toNum(row.trades ?? row.n ?? null),
          quoteAssetVolume: toNum(row.quoteAssetVolume ?? null),
          tbBaseVolume: toNum(row.tbBaseVolume ?? null),
          tbQuoteVolume: toNum(row.tbQuoteVolume ?? null),
          ignore: null
        };
      } else {
        // unknown row shape -> null placeholder
        return { openTime: null, open: null, high: null, low: null, close: null, volume: null, closeTime: null, trades: null };
      }
    });

    normalized[tf] = objs;
  }

  // DEBUG logs - Vercel console
  console.log(`[indicators] symbol=${symbol} frames=${Object.keys(normalized).join(',')} lengths=`, Object.fromEntries(Object.entries(normalized).map(([k, v]) => [k, v.length])));

  // Utility numeric helpers and indicators (Wilder RSI, EMA, SMA, MACD, ATR, SuperTrend etc.)
  const toNumber = v => (v === null || v === undefined) ? null : Number(v);

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    if (period <= 0) return out;
    let sum = 0, count = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      const n = v === null ? 0 : Number(v);
      sum += n;
      count++;
      if (i >= period) {
        const sub = values[i - period];
        sum -= (sub === null ? 0 : Number(sub));
        count--;
      }
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v === null) { out[i] = null; continue; }
      const n = Number(v);
      if (prev === null) { prev = n; out[i] = prev; continue; }
      prev = (n * k) + (prev * (1 - k));
      out[i] = prev;
    }
    for (let i = 0; i < period - 1 && i < out.length; i++) out[i] = null;
    return out;
  }

  function rsiWilder(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < 2) return out;
    let gain = 0, loss = 0, avgGain = null, avgLoss = null;
    for (let i = 1; i < values.length; i++) {
      const change = (values[i] === null || values[i - 1] === null) ? 0 : values[i] - values[i - 1];
      const g = Math.max(0, change);
      const l = Math.max(0, -change);
      if (i <= period) {
        gain += g; loss += l;
        if (i === period) { avgGain = gain / period; avgLoss = loss / period; const rs = avgLoss === 0 ? 100 : avgGain / avgLoss; out[i] = 100 - (100 / (1 + rs)); }
      } else {
        // Wilder smoothing
        avgGain = ((avgGain * (period - 1)) + g) / period;
        avgLoss = ((avgLoss * (period - 1)) + l) / period;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        out[i] = 100 - (100 / (1 + rs));
      }
    }
    return out;
  }

  function macd(values, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((v, i) => (emaFast[i] === null || emaSlow[i] === null) ? null : emaFast[i] - emaSlow[i]);
    const signalLine = ema(macdLine.map(v => v === null ? 0 : v), signal);
    const hist = macdLine.map((v, i) => (v === null || signalLine[i] === null) ? null : v - signalLine[i]);
    return { macdLine, signalLine, hist };
  }

  function trueRange(highs, lows, closes) {
    const tr = [];
    for (let i = 0; i < highs.length; i++) {
      if (i === 0) tr.push(highs[i] === null || lows[i] === null ? null : highs[i] - lows[i]);
      else {
        const a = highs[i] === null || lows[i] === null ? null : highs[i] - lows[i];
        const b = highs[i] === null || closes[i - 1] === null ? null : Math.abs(highs[i] - closes[i - 1]);
        const c = lows[i] === null || closes[i - 1] === null ? null : Math.abs(lows[i] - closes[i - 1]);
        const vals = [a, b, c].filter(v => v !== null);
        tr.push(vals.length ? Math.max(...vals) : null);
      }
    }
    return tr;
  }

  function atr(highs, lows, closes, period = 14) {
    const tr = trueRange(highs, lows, closes);
    const out = new Array(tr.length).fill(null);
    let sum = 0;
    for (let i = 0; i < tr.length; i++) {
      if (tr[i] === null) { out[i] = null; continue; }
      if (i < period) { sum += tr[i]; if (i === period - 1) out[i] = sum / period; continue; }
      out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
  }

  // SuperTrend simplified
  function superTrend(highs, lows, closes, period = 10, mult = 3) {
    const atrArr = atr(highs, lows, closes, period);
    const hl2 = highs.map((h, i) => (h === null || lows[i] === null) ? null : (h + lows[i]) / 2);
    const upper = hl2.map((v, i) => v === null || atrArr[i] === null ? null : v + mult * atrArr[i]);
    const lower = hl2.map((v, i) => v === null || atrArr[i] === null ? null : v - mult * atrArr[i]);
    const finalUpper = new Array(closes.length).fill(null);
    const finalLower = new Array(closes.length).fill(null);
    const st = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) {
        finalUpper[i] = upper[i];
        finalLower[i] = lower[i];
        st[i] = null;
        continue;
      }
      finalUpper[i] = (upper[i] === null || finalUpper[i - 1] === null) ? upper[i] : Math.min(upper[i], finalUpper[i - 1]);
      finalLower[i] = (lower[i] === null || finalLower[i - 1] === null) ? lower[i] : Math.max(lower[i], finalLower[i - 1]);
      // choose
      if (st[i - 1] === finalUpper[i - 1]) {
        st[i] = (closes[i] < finalUpper[i]) ? finalUpper[i] : finalLower[i];
      } else {
        st[i] = (closes[i] > finalLower[i]) ? finalLower[i] : finalUpper[i];
      }
    }
    return st;
  }

  // Now compute indicators per timeframe
  const out = { symbol: symbol || null, final_signal: 'HOLD', votes: { BUY: 0, SELL: 0, HOLD: 0 }, details: { symbol, exchangeSymbol, timeframes: {} } };

  for (const tf of Object.keys(normalized)) {
    const arrObjs = normalized[tf]; // array of objects {openTime,open,high,low,close,volume,...}
    // make numeric arrays for calculations
    const opens = arrObjs.map(o => o ? (o.open === null ? null : Number(o.open)) : null);
    const highs = arrObjs.map(o => o ? (o.high === null ? null : Number(o.high)) : null);
    const lows = arrObjs.map(o => o ? (o.low === null ? null : Number(o.low)) : null);
    const closes = arrObjs.map(o => o ? (o.close === null ? null : Number(o.close)) : null);
    const volumes = arrObjs.map(o => o ? (o.volume === null ? null : Number(o.volume)) : null);

    // If not enough candles to compute standard indicators, return nulls for this tf
    const lastIndex = closes.length - 1;
    const minRequired = 26; // need at least 26 for MACD slow, ATR 14, etc.
    if (closes.length < minRequired) {
      out.details.timeframes[tf] = {
        last: { open: null, high: null, low: null, close: null, volume: null },
        indicators: { sma50: null, ema9: null, rsi14: null, macd: null, signal: null, hist: null, atr14: null },
        signal: 'HOLD'
      };
      out.votes.HOLD++;
      continue;
    }

    // compute indicators
    const sma50Arr = sma(closes, 50);
    const ema9Arr = ema(closes, 9);
    const rsi14Arr = rsiWilder(closes, 14);
    const macdObj = macd(closes, 12, 26, 9);
    const atr14Arr = atr(highs, lows, closes, 14);
    const stArr = superTrend(highs, lows, closes, 10, 3);

    const indicators = {
      sma50: sma50Arr[lastIndex] ?? null,
      ema9: ema9Arr[lastIndex] ?? null,
      rsi14: rsi14Arr[lastIndex] ?? null,
      macd: macdObj.macdLine[lastIndex] ?? null,
      signal: macdObj.signalLine[lastIndex] ?? null,
      hist: macdObj.hist[lastIndex] ?? null,
      atr14: atr14Arr[lastIndex] ?? null,
      supertrend: stArr[lastIndex] ?? null
    };

    const last = {
      open: opens[lastIndex] ?? null,
      high: highs[lastIndex] ?? null,
      low: lows[lastIndex] ?? null,
      close: closes[lastIndex] ?? null,
      volume: volumes[lastIndex] ?? null
    };

    // simple signal logic (same as before)
    let signal = 'HOLD';
    const macdBull = indicators.macd !== null && indicators.signal !== null && indicators.macd > indicators.signal && indicators.hist > 0;
    const macdBear = indicators.macd !== null && indicators.signal !== null && indicators.macd < indicators.signal && indicators.hist < 0;
    const superBull = indicators.supertrend !== null && last.close !== null && last.close > indicators.supertrend;
    const superBear = indicators.supertrend !== null && last.close !== null && last.close < indicators.supertrend;
    const volSpike = indicators.atr14 !== null && last.volume !== null && last.volume > (2 * (volumes.slice(Math.max(0, lastIndex - 20), lastIndex + 1).reduce((a, b) => (a + (b || 0)), 0) / Math.min(20, lastIndex + 1)));

    if (macdBull && superBull && last.close !== null && indicators.ema9 !== null && last.close > indicators.ema9) {
      signal = volSpike ? 'STRONG BUY' : 'BUY';
    } else if (macdBear && superBear && last.close !== null && indicators.ema9 !== null && last.close < indicators.ema9) {
      signal = volSpike ? 'STRONG SELL' : 'SELL';
    } else {
      signal = 'HOLD';
    }

    out.details.timeframes[tf] = {
      last,
      indicators,
      signal
    };

    out.votes[signal === 'BUY' || signal === 'STRONG BUY' ? 'BUY' : signal === 'SELL' || signal === 'STRONG SELL' ? 'SELL' : 'HOLD']++;
  }

  // Determine final_signal from votes
  if (out.votes['BUY'] >= 2 || out.votes['BUY'] >= 1 && out.votes['HOLD'] === 0) out.final_signal = 'BUY';
  if (out.votes['SELL'] >= 2 || out.votes['SELL'] >= 1 && out.votes['HOLD'] === 0) out.final_signal = 'SELL';
  // strong detection
  // (you can refine rules later)
  if (out.votes['BUY'] === 0 && out.votes['SELL'] === 0 && out.votes['HOLD'] > 0) out.final_signal = 'HOLD';

  // Return JSON response
  res.status(200).json(out);
}

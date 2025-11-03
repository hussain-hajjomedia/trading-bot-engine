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
    return { openTime: null, open: null, high: null, low: null, volume: null };
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

  console.log('[indicators] symbol=', symbol);

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
      const mean = slice.reduce((a, b) => a + b, 0) / period;
      const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
      const sd = Math.sqrt(variance);
      out.push({ upper: mean + mult * sd, middle: mean, lower: mean - mult * sd });
    }
    return out;
  }

  // ---------- SMC Swing Functions ----------
  function findSwingPoints(candles, lookback = 2) {
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const swingHighs = [];
    const swingLows = [];

    for (let i = lookback; i < highs.length - lookback; i++) {
      let high = highs[i], low = lows[i];
      let isSwingHigh = true, isSwingLow = true;
      for (let j = 1; j <= lookback; j++) {
        if (!(high > highs[i - j] && high > highs[i + j])) isSwingHigh = false;
        if (!(low < lows[i - j] && low < lows[i + j])) isSwingLow = false;
      }
      if (isSwingHigh) swingHighs.push({ price: high });
      if (isSwingLow) swingLows.push({ price: low });
    }
    return { swingHighs, swingLows };
  }

  function nearestSwingBelow(price, swings) {
    let below = swings.filter(s => s.price < price).map(s => s.price);
    if (!below.length) return null;
    return Math.max(...below);
  }

  function nearestSwingAbove(price, swings) {
    let above = swings.filter(s => s.price > price).map(s => s.price);
    if (!above.length) return null;
    return Math.min(...above);
  }

  // ---------- Analysis ----------
  function analyzeTimeframe(tfName, candles) {
    const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes = candles.map(c => toNum(c.close));
    const highs = candles.map(c => toNum(c.high));
    const lows = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));
    if (closes.length < 5) return result;

    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const rsi14 = rsiWilder(closes, 14);
    const macdObj = macd(closes);
    const atr14 = atr(highs, lows, closes, 14);
    const st = superTrend(highs, lows, closes, 10, 3);
    const bb = bollinger(closes, 20, 2);
    const volSMA20 = sma(volumes, 20);
    const i = closes.length - 1;
    const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
    result.last = last;

    result.indicators = {
      sma50: sma50[i], sma200: sma200[i], ema9: ema9[i], ema21: ema21[i],
      rsi14: rsi14[i], macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i],
      macd_hist: macdObj.hist[i], atr14: atr14[i], supertrend: st[i],
      bb_upper: bb[i]?.upper, bb_mid: bb[i]?.middle, bb_lower: bb[i]?.lower,
      vol_sma20: volSMA20[i], volume: volumes[i]
    };

    let score = 0, reasons = [];
    const sma50v = result.indicators.sma50, sma200v = result.indicators.sma200;
    let sidewaysFactor = 1;

    if (sma50v != null && sma200v != null) {
      const diffPct = Math.abs(sma50v - sma200v) / Math.max(1, Math.abs(sma200v));
      if (diffPct < 0.008) sidewaysFactor = 0.35;
      else if (diffPct < 0.02) sidewaysFactor = 0.7;
    }

    if (last.close > sma50v) score += 6 * sidewaysFactor;
    else score -= 6 * sidewaysFactor;
    if (sma50v > sma200v) score += 8 * sidewaysFactor;
    else score -= 8 * sidewaysFactor;
    if (last.close > result.indicators.ema9) score += 5 * sidewaysFactor;
    else score -= 5 * sidewaysFactor;
    if (result.indicators.ema9 > result.indicators.ema21) score += 3 * sidewaysFactor;
    else score -= 3 * sidewaysFactor;

    if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0)
      score += 10 * sidewaysFactor;
    else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0)
      score -= 10 * sidewaysFactor;

    if (last.close > result.indicators.supertrend) score += 7 * sidewaysFactor;
    else score -= 7 * sidewaysFactor;

    if (result.indicators.rsi14 < 30) score += 2;
    if (result.indicators.rsi14 > 70) score -= 2;
    if (result.indicators.volume > result.indicators.vol_sma20 * 1.25) score += 6;
    if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) score -= 3;

    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    if (result.score >= 30) result.signal = 'STRONG BUY';
    else if (result.score >= 12) result.signal = 'BUY';
    else if (result.score <= -30) result.signal = 'STRONG SELL';
    else if (result.score <= -12) result.signal = 'SELL';

    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  const tfWeight = { '15m': 0.5, '1h': 1.5, '4h': 2.5, '1d': 3.5 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };

  for (const tf of Object.keys(tfResults)) tally[tfResults[tf].signal] += tfWeight[tf] || 1;

  let final_signal = 'HOLD';
  const strongBuyWeight = tally['STRONG BUY'];
  const strongSellWeight = tally['STRONG SELL'];
  const buyWeight = tally['BUY'] + strongBuyWeight * 1.5;
  const sellWeight = tally['SELL'] + strongSellWeight * 1.5;

  if (strongBuyWeight >= 3.5 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 3.5 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 3.5) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 3.5) final_signal = 'SELL';

  const refTf = tfResults['1h']?.last?.close ? '1h' : tfResults['15m']?.last?.close ? '15m' : '4h';
  const ref = tfResults[refTf];
  const emaVal = ref.indicators.ema9;
  const stVal = ref.indicators.supertrend;
  const lastClose = ref.last.close;

  function pickAtr(tf) {
    const r = tfResults[tf];
    return r?.indicators?.atr14 ?? null;
  }

  let atrRef = pickAtr('1h') || pickAtr('4h') || pickAtr('1d') || pickAtr('15m');

  const swings4h = findSwingPoints(normalized['4h']);
  const swings1h = findSwingPoints(normalized['1h']);

  const price = lastClose;
  const swingLow4h = nearestSwingBelow(price, swings4h.swingLows);
  const swingHigh4h = nearestSwingAbove(price, swings4h.swingHighs);
  const swingLow1h = nearestSwingBelow(price, swings1h.swingLows);
  const swingHigh1h = nearestSwingAbove(price, swings1h.swingHighs);

  const structureLow = swingLow4h ?? swingLow1h ?? (price - atrRef * 2);
  const structureHigh = swingHigh4h ?? swingHigh1h ?? (price + atrRef * 2);

  function blend(a, b, weight = 0.5) {
    if (a == null) return b;
    if (b == null) return a;
    return a * weight + b * (1 - weight);
  }

  let rawEntryLow, rawEntryHigh;
  if (final_signal.includes('BUY')) {
    rawEntryLow = blend(Math.min(emaVal, stVal), structureLow, 0.6);
    rawEntryHigh = blend(emaVal, price, 0.6);
  } else if (final_signal.includes('SELL')) {
    rawEntryLow = blend(price, emaVal, 0.6);
    rawEntryHigh = blend(Math.max(emaVal, stVal), structureHigh, 0.6);
  } else {
    rawEntryLow = price;
    rawEntryHigh = price;
  }

  const entry = (rawEntryLow + rawEntryHigh) / 2;

  const suggestions = {};
  const levels = ['level1', 'level2', 'level3'];
  const slMultipliers = { level1: 1.0, level2: 1.6, level3: 2.4 };

  for (const lvl of levels) {
    const m = slMultipliers[lvl];
    let sl, tp1, tp2;

    if (final_signal.includes('BUY')) {
      const structuralSL = structureLow != null ? structureLow * 0.997 : entry - atrRef * m;
      sl = Math.min(structuralSL, entry - atrRef * m);
      tp1 = entry + atrRef * (m * 1.2);
      tp2 = entry + atrRef * (m * 2.2);
    } else if (final_signal.includes('SELL')) {
      const structuralSL = structureHigh != null ? structureHigh * 1.003 : entry + atrRef * m;
      sl = Math.max(structuralSL, entry + atrRef * m);
      tp1 = entry - atrRef * (m * 1.2);
      tp2 = entry - atrRef * (m * 2.2);
    } else {
      sl = entry - atrRef * m;
      tp1 = entry + atrRef * (m * 0.8);
      tp2 = entry + atrRef * (m * 1.6);
    }

    suggestions[lvl] = {
      entry,
      entry_range: { low: rawEntryLow, high: rawEntryHigh },
      stop_loss: sl,
      take_profit_1: tp1,
      take_profit_2: tp2,
      atr_used: atrRef,
      sl_multiplier: m
    };
  }

  const votes = {};
  for (const tf of Object.keys(tfResults)) votes[tf] = tfResults[tf].signal;

  const output = {
    symbol,
    exchangeSymbol,
    final_signal,
    votesSummary: { byTf: votes },
    suggestions,
    reasons: [],
    details: tfResults
  };

  return res.status(200).json(output);
}

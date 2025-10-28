// api/indicators.js

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  const payload = req.body || {};
  let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d } = payload;

  // ---------- Utilities for parsing & normalization ----------
  function tryParseMaybeJson(input) {
    if (input === undefined || input === null) return null;
    if (Array.isArray(input)) return input;
    if (typeof input === 'string') {
      try {
        const p = JSON.parse(input);
        return p;
      } catch (e) {
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
    if (!row)
      return { openTime: null, open: null, high: null, low: null, close: null, volume: null };

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
        openTime: safe(row.openTime ?? row.t ?? row.time ?? null),
        open: safe(row.open ?? row.o ?? null),
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
      return chunked.map(normalizeCandleRow);
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

  // ---------- Indicator Functions ----------
  const toNum = (v) => (v == null ? null : Number(v));

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      sum += v || 0;
      if (i >= period) sum -= values[i - period] || 0;
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
      if (v == null) continue;
      if (prev == null) prev = v;
      else prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function rsiWilder(values, period = 14) {
    const out = new Array(values.length).fill(null);
    if (values.length < period + 1) return out;
    let gains = 0,
      losses = 0;
    for (let i = 1; i <= period; i++) {
      const d = values[i] - values[i - 1];
      if (d > 0) gains += d;
      else losses += Math.abs(d);
    }
    let avgGain = gains / period,
      avgLoss = losses / period;
    out[period] = 100 - 100 / (1 + avgGain / avgLoss);
    for (let i = period + 1; i < values.length; i++) {
      const d = values[i] - values[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  function macd(values, fast = 12, slow = 26, signal = 9) {
    const emaFast = ema(values, fast);
    const emaSlow = ema(values, slow);
    const macdLine = values.map((_, i) =>
      emaFast[i] && emaSlow[i] ? emaFast[i] - emaSlow[i] : null
    );
    const signalLine = ema(macdLine.map((v) => v ?? 0), signal);
    const hist = macdLine.map((v, i) => (v && signalLine[i] ? v - signalLine[i] : null));
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
      if (i < period) {
        sum += tr[i];
        if (i === period - 1) out[i] = sum / period;
      } else out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
    }
    return out;
  }

  function superTrend(highs, lows, closes, period = 10, mult = 3) {
    const atrArr = atr(highs, lows, closes, period);
    const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
    const upper = hl2.map((v, i) => v + mult * atrArr[i]);
    const lower = hl2.map((v, i) => v - mult * atrArr[i]);
    const finalUpper = new Array(closes.length).fill(null);
    const finalLower = new Array(closes.length).fill(null);
    const st = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
      if (i === 0) {
        finalUpper[i] = upper[i];
        finalLower[i] = lower[i];
        continue;
      }
      finalUpper[i] = Math.min(upper[i], finalUpper[i - 1]);
      finalLower[i] = Math.max(lower[i], finalLower[i - 1]);
      if (st[i - 1] === finalUpper[i - 1]) {
        st[i] = closes[i] < finalUpper[i] ? finalUpper[i] : finalLower[i];
      } else {
        st[i] = closes[i] > finalLower[i] ? finalLower[i] : finalUpper[i];
      }
    }
    return st;
  }

  // ---------- Scoring & signal logic ----------
  function analyzeTimeframe(tfName, candles) {
    const result = { tf: tfName, indicators: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);
    if (closes.length < 20) return result;

    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, 200);
    const ema9 = ema(closes, 9);
    const ema21 = ema(closes, 21);
    const macdObj = macd(closes);
    const rsi14 = rsiWilder(closes);
    const atr14 = atr(highs, lows, closes);
    const st = superTrend(highs, lows, closes);

    const i = closes.length - 1;
    const last = { close: closes[i], high: highs[i], low: lows[i] };

    let score = 0;
    const reasons = [];

    // SMA
    if (sma50[i] && sma200[i]) {
      if (last.close > sma50[i]) { score += 8; reasons.push('price > SMA50'); } 
      else { score -= 8; reasons.push('price < SMA50'); }
      if (sma50[i] > sma200[i]) { score += 10; reasons.push('SMA50 > SMA200'); } 
      else { score -= 10; reasons.push('SMA50 < SMA200'); }
    }

    // EMA
    if (ema9[i] && ema21[i]) {
      if (ema9[i] > ema21[i]) { score += 6; reasons.push('EMA9 > EMA21'); } 
      else { score -= 6; reasons.push('EMA9 < EMA21'); }
      if (last.close > ema9[i]) { score += 4; reasons.push('price > EMA9'); } 
      else { score -= 4; reasons.push('price < EMA9'); }
    }

    // MACD
    if (macdObj.macdLine[i] && macdObj.signalLine[i]) {
      if (macdObj.macdLine[i] > macdObj.signalLine[i]) { score += 12; reasons.push('MACD bullish'); }
      else { score -= 12; reasons.push('MACD bearish'); }
    }

    // SuperTrend
    if (st[i] && last.close > st[i]) { score += 10; reasons.push('SuperTrend bullish'); }
    else if (st[i]) { score -= 10; reasons.push('SuperTrend bearish'); }

    // RSI
    if (rsi14[i]) {
      if (rsi14[i] > 70) { score -= 5; reasons.push('RSI overbought'); }
      else if (rsi14[i] < 30) { score += 5; reasons.push('RSI oversold'); }
    }

    result.score = Math.max(-100, Math.min(100, Math.round(score)));

    if (result.score >= 40) result.signal = 'STRONG BUY';
    else if (result.score >= 15) result.signal = 'BUY';
    else if (result.score <= -40) result.signal = 'STRONG SELL';
    else if (result.score <= -15) result.signal = 'SELL';
    else result.signal = 'HOLD';

    result.reasons = reasons;
    result.indicators = { ema9: ema9[i], supertrend: st[i], atr14: atr14[i], lastClose: last.close };
    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  // ---------- Final Signal ----------
  const weight = { '15m': 1, '1h': 2, '4h': 3, '1d': 4 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };

  for (const tf in tfResults) tally[tfResults[tf].signal] += weight[tf];

  const buyWeight = tally['BUY'] + tally['STRONG BUY'] * 1.5;
  const sellWeight = tally['SELL'] + tally['STRONG SELL'] * 1.5;
  let final_signal = 'HOLD';
  if (buyWeight > sellWeight && buyWeight >= 4) final_signal = buyWeight > 6 ? 'STRONG BUY' : 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 4)
    final_signal = sellWeight > 6 ? 'STRONG SELL' : 'SELL';

  // ---------- Entry / SL / TP ----------
  const refTf = tfResults['1h'] ? '1h' : '15m';
  const ref = tfResults[refTf];
  const { ema9, supertrend, atr14, lastClose } = ref.indicators;

  const trend = final_signal.includes('BUY') ? 'UP' : final_signal.includes('SELL') ? 'DOWN' : 'SIDEWAYS';
  let entryLow = null, entryHigh = null;

  if (trend === 'UP') {
    entryLow = Math.min(supertrend, ema9);
    entryHigh = ema9;
  } else if (trend === 'DOWN') {
    entryLow = ema9;
    entryHigh = Math.max(supertrend, ema9);
  } else {
    entryLow = entryHigh = lastClose;
  }

  const entryPrice = (entryLow && entryHigh) ? (entryLow + entryHigh) / 2 : lastClose;
  const atrRef = atr14 || lastClose * 0.005;

  const slMultipliers = { level1: 1.2, level2: 1.8, level3: 2.8 };
  const suggestions = {};
  for (const lvl of Object.keys(slMultipliers)) {
    const m = slMultipliers[lvl];
    const sl = trend === 'UP' ? entryPrice - atrRef * m : entryPrice + atrRef * m;
    const tp1 = trend === 'UP' ? entryPrice + atrRef * (m * 1.5) : entryPrice - atrRef * (m * 1.5);
    const tp2 = trend === 'UP' ? entryPrice + atrRef * (m * 3) : entryPrice - atrRef * (m * 3);
    suggestions[lvl] = { entry: entryPrice, entry_range: { low: entryLow, high: entryHigh }, stop_loss: sl, take_profit_1: tp1, take_profit_2: tp2, atr_used: atrRef };
  }

  const output = { symbol, exchangeSymbol, final_signal, suggestions, tfResults, tally };
  console.log('[indicators] final_signal=', final_signal, 'tally=', tally);
  res.status(200).json(output);
}

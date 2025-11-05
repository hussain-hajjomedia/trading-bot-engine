// api/indicators.js  — SCALP VERSION (keeps exact output shape)

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

  // ---------- Swing/scalp helpers ----------
  function findSwingPoints(candles, lookback = 2) {
    const highs = candles.map(c => c.high);
    const lows  = candles.map(c => c.low);
    const swingHighs = [], swingLows = [];
    for (let i = lookback; i < highs.length - lookback; i++) {
      let high = highs[i], low = lows[i];
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
  function nearestSwingBelow(price, swings) {
    const below = swings.filter(s => s.price < price).map(s => s.price);
    if (!below.length) return null;
    return Math.max(...below);
  }
  function nearestSwingAbove(price, swings) {
    const above = swings.filter(s => s.price > price).map(s => s.price);
    if (!above.length) return null;
    return Math.min(...above);
  }

  // ---------- Timeframe analysis ----------
  function analyzeTimeframe(tfName, candles) {
    // For scalp, emphasize fast signals and recent bars
    const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes  = candles.map(c => toNum(c.close));
    const highs   = candles.map(c => toNum(c.high));
    const lows    = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));
    if (closes.length < 20) return result; // need enough for BB/ATR

    const sma50    = sma(closes, 50);
    const sma200   = sma(closes, 200);
    const ema9Arr  = ema(closes, 9);
    const ema21Arr = ema(closes, 21);
    const rsi14    = rsiWilder(closes, 14);
    const macdObj  = macd(closes, 8, 21, 5);        // CHANGE: faster MACD for scalp
    const atr7Arr  = atr(highs, lows, closes, 7);   // CHANGE: faster ATR for scalp sizing
    const atr14Arr = atr(highs, lows, closes, 14);
    const stArr    = superTrend(highs, lows, closes, 10, 3);
    const bb       = bollinger(closes, 20, 2);
    const volSMA20 = sma(volumes, 20);

    const i = closes.length - 1;
    const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
    result.last = last;

    result.indicators = {
      sma50: sma50[i], sma200: sma200[i],
      ema9: ema9Arr[i], ema21: ema21Arr[i],
      rsi14: rsi14[i],
      macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i], macd_hist: macdObj.hist[i],
      atr7: atr7Arr[i], atr14: atr14Arr[i],
      supertrend: stArr[i],
      bb_upper: bb[i]?.upper, bb_mid: bb[i]?.middle, bb_lower: bb[i]?.lower,
      vol_sma20: volSMA20[i], volume: volumes[i]
    };

    // Scoring: price vs EMA9/21 has more weight, MACD fast, BB pierces, volume bursts
    let score = 0;
    const ema9v = result.indicators.ema9, ema21v = result.indicators.ema21;

    // Sideways throttle using 50/200 gap
    const sma50v = result.indicators.sma50, sma200v = result.indicators.sma200;
    let sidewaysFactor = 1;
    if (sma50v != null && sma200v != null) {
      const diffPct = Math.abs(sma50v - sma200v) / Math.max(1, Math.abs(sma200v));
      if (diffPct < 0.006) sidewaysFactor = 0.3;
      else if (diffPct < 0.015) sidewaysFactor = 0.7;
    }

    // Fast momentum
    if (last.close != null && ema9v != null) score += (last.close > ema9v ? 7 : -7) * sidewaysFactor;
    if (ema9v != null && ema21v != null)     score += (ema9v > ema21v ? 5 : -5) * sidewaysFactor;

    // MACD fast
    if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
      if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) score += 8 * sidewaysFactor;
      else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) score -= 8 * sidewaysFactor;
    }

    // BB pierce for mean reversion edges (small)
    if (result.indicators.bb_upper != null && result.indicators.bb_lower != null) {
      if (last.close > result.indicators.bb_upper) score -= 2;  // stretched up -> mean revert risk
      if (last.close < result.indicators.bb_lower) score += 2;  // stretched down
    }

    // SuperTrend context
    if (result.indicators.supertrend != null && last.close != null)
      score += (last.close > result.indicators.supertrend ? 4 : -4) * sidewaysFactor;

    // Volume burst
    if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
      if (result.indicators.volume > result.indicators.vol_sma20 * 1.4) score += 5;
      else if (result.indicators.volume < result.indicators.vol_sma20 * 0.6) score -= 2;
    }

    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    if (result.score >= 22) result.signal = 'STRONG BUY';
    else if (result.score >= 10) result.signal = 'BUY';
    else if (result.score <= -22) result.signal = 'STRONG SELL';
    else if (result.score <= -10) result.signal = 'SELL';
    else result.signal = 'HOLD';

    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  // ---------- Voting (SCALP weights) ----------
  // Emphasize 15m heavily, 1h as higher-TF filter, 4h/1d as weak bias only.
  const tfWeight = { '15m': 3.0, '1h': 1.2, '4h': 0.5, '1d': 0.3 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
  for (const tf of Object.keys(tfResults)) {
    const s = tfResults[tf].signal;
    const w = tfWeight[tf] || 1;
    tally[s] += w;
  }

  let final_signal = 'HOLD';
  const strongBuyWeight  = tally['STRONG BUY'];
  const strongSellWeight = tally['STRONG SELL'];
  const buyWeight  = tally['BUY']  + strongBuyWeight  * 1.4;
  const sellWeight = tally['SELL'] + strongSellWeight * 1.4;

  // For scalp we lower absolute thresholds but require 1h not to be opposite-strong
  if (strongBuyWeight >= 2.6 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 2.6 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 3.0) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 3.0) final_signal = 'SELL';
  else final_signal = 'HOLD';

  // ---------- Regime Detection (light filter for scalp) ----------
  function mean(arr) {
    const v = arr.filter(x => x != null);
    if (!v.length) return null;
    return v.reduce((a, b) => a + b, 0) / v.length;
  }

  function detectRegime() {
    const r15 = tfResults['15m'];
    const r1h = tfResults['1h'];
    if (!r15 || !r1h) return 'NEUTRAL';

    // 15m ATR7 percentile vs its 30-bar average
    const highs = normalized['15m'].map(c => c.high);
    const lows  = normalized['15m'].map(c => c.low);
    const closes= normalized['15m'].map(c => c.close);
    const atr7 = atr(highs, lows, closes, 7);
    const lastAtr = atr7[atr7.length - 1] ?? null;
    const win = atr7.slice(-30).filter(x => x != null);
    const base = mean(win);
    const hot  = lastAtr && base ? lastAtr > base * 1.35 : false;
    const cold = lastAtr && base ? lastAtr < base * 0.7  : false;

    if (hot)  return 'FAST';
    if (cold) return 'SLOW';
    // align with 1h bias
    const biasUp   = r1h && r1h.signal.includes('BUY');
    const biasDown = r1h && r1h.signal.includes('SELL');
    if (biasUp)   return 'BIAS_UP';
    if (biasDown) return 'BIAS_DOWN';
    return 'NEUTRAL';
  }

  const marketRegime = detectRegime();

  // ---------- Entry & Targets (scalp playbook) ----------
  // Anchor on 15m; 1h used as bias filter; 4h/1d only for veto in extremes
  const refTf = '15m';
  const ref   = tfResults[refTf];
  const price = ref?.last?.close ?? null;
  const ema9v = ref?.indicators?.ema9 ?? null;
  const ema21v= ref?.indicators?.ema21 ?? null;
  const stv   = ref?.indicators?.supertrend ?? null;
  const bbU   = ref?.indicators?.bb_upper ?? null;
  const bbL   = ref?.indicators?.bb_lower ?? null;

  // Scalp ATR reference: prefer ATR7 on 15m; fallback to ATR14 15m, then 1h ATR7
  function pickAtrScalp() {
    const r15 = tfResults['15m'], r1h = tfResults['1h'];
    if (r15?.indicators?.atr7 != null)  return r15.indicators.atr7;
    if (r15?.indicators?.atr14 != null) return r15.indicators.atr14;
    if (r1h?.indicators?.atr7 != null)  return r1h.indicators.atr7;
    return price != null ? price * 0.0035 : null; // ~0.35% fallback
  }
  const atrRef = pickAtrScalp();

  // Micro structure (15m)
  const swings15 = findSwingPoints(normalized['15m'], 2);
  const swingLow15  = nearestSwingBelow(price, swings15.swingLows);
  const swingHigh15 = nearestSwingAbove(price, swings15.swingHighs);

  // Direction
  const dir =
    final_signal.includes('BUY')  ? 'UP'  :
    final_signal.includes('SELL') ? 'DOWN': 'SIDEWAYS';

  // Build a tight entry band around EMA9/EMA21 with BB guardrails
  function buildScalpEntry(dir, p, e9, e21, bbUpper, bbLower) {
    if (p == null) return { low: null, high: null };
    const maxPct = 0.006; // 0.6% default width cap for scalp L1
    if (dir === 'UP') {
      const baseLow  = Math.min(e9 ?? p, e21 ?? p);
      const baseHigh = e9 ?? p;
      let low  = baseLow != null ? baseLow : p * 0.998;
      let high = baseHigh != null ? baseHigh : p * 1.002;
      // don’t place low below BB lower in up bias
      if (bbLower != null) low = Math.max(low, bbLower);
      // cap width
      const width = Math.abs(high - low);
      const cap   = p * maxPct;
      if (width > cap) {
        const mid = (low + high) / 2;
        low  = mid - cap / 2;
        high = mid + cap / 2;
      }
      return { low, high };
    } else if (dir === 'DOWN') {
      const baseLow  = e9 ?? p;
      const baseHigh = Math.max(e9 ?? p, e21 ?? p);
      let low  = baseLow  != null ? baseLow  : p * 0.998;
      let high = baseHigh != null ? baseHigh : p * 1.002;
      // don’t place high above BB upper in down bias
      if (bbUpper != null) high = Math.min(high, bbUpper);
      const width = Math.abs(high - low);
      const cap   = p * maxPct;
      if (width > cap) {
        const mid = (low + high) / 2;
        low  = mid - cap / 2;
        high = mid + cap / 2;
      }
      // ensure correct ordering
      if (low > high) { const t = low; low = high; high = t; }
      return { low, high };
    } else {
      return { low: p * 0.999, high: p * 1.001 };
    }
  }

  const lvl1Band = buildScalpEntry(dir, price, ema9v, ema21v, bbU, bbL);

  // Level widths for L2/L3 slightly larger
  function widen(band, p, pct) {
    if (!band || band.low == null || band.high == null || !p) return band;
    const mid = (band.low + band.high) / 2;
    const half = p * pct / 2;
    return { low: mid - half, high: mid + half };
  }
  const lvl2Band = widen(lvl1Band, price, 0.010); // 1.0%
  const lvl3Band = widen(lvl1Band, price, 0.016); // 1.6%

  // Stop: beyond nearest swing + small ATR buffer
  function scalpStop(dir, entry, swingLow, swingHigh, atr) {
    if (entry == null) return null;
    const buf = Math.max(atr * 0.6, entry * 0.0015); // 0.15% min
    if (dir === 'UP')   return Math.min(entry - buf, swingLow  != null ? swingLow  - buf * 0.3 : entry - buf);
    if (dir === 'DOWN') return Math.max(entry + buf, swingHigh != null ? swingHigh + buf * 0.3 : entry + buf);
    return dir;
  }

  // Entry price = mid of L1 band
  const entryPrice = (lvl1Band.low != null && lvl1Band.high != null) ? (lvl1Band.low + lvl1Band.high) / 2 : price;

  const slL1 = scalpStop(dir, entryPrice, swingLow15, swingHigh15, atrRef);

  // Targets: R-multiples for scalps; boost a bit if 1h bias agrees
  const oneHBiasUp   = tfResults['1h']?.signal.includes('BUY');
  const oneHBiasDown = tfResults['1h']?.signal.includes('SELL');
  let biasBoost = 1.0;
  if ((dir === 'UP' && oneHBiasUp) || (dir === 'DOWN' && oneHBiasDown)) biasBoost = 1.15;

  function rMultipleTargets(dir, entry, stop, r1 = 1.0, r2 = 2.0) {
    if (entry == null || stop == null) return { tp1: null, tp2: null };
    const risk = Math.abs(entry - stop);
    if (risk === 0) return { tp1: null, tp2: null };
    if (dir === 'UP')   return { tp1: entry + risk * r1 * biasBoost, tp2: entry + risk * r2 * biasBoost };
    if (dir === 'DOWN') return { tp1: entry - risk * r1 * biasBoost, tp2: entry - risk * r2 * biasBoost };
    return { tp1: null, tp2: null };
  }
  const { tp1: tp1L1, tp2: tp2L1 } = rMultipleTargets(dir, entryPrice, slL1, 1.0, 2.0);

  // Build suggestions for level2/3 using slightly wider bands and larger risk buffers
  function scaleStop(dir, entry, swingLow, swingHigh, atr, mult) {
    const base = scalpStop(dir, entry, swingLow, swingHigh, atr);
    if (base == null) return null;
    if (dir === 'UP')   return base + (entry - base) * (mult - 1);  // farther
    if (dir === 'DOWN') return base - (base - entry) * (mult - 1);
    return base;
  }

  const lvlStops = {
    level1: slL1,
    level2: scaleStop(dir, entryPrice, swingLow15, swingHigh15, atrRef, 1.3),
    level3: scaleStop(dir, entryPrice, swingLow15, swingHigh15, atrRef, 1.6),
  };

  const lvlTargets = {
    level1: { tp1: tp1L1, tp2: tp2L1 },
    level2: rMultipleTargets(dir, entryPrice, lvlStops.level2, 1.0, 2.2),
    level3: rMultipleTargets(dir, entryPrice, lvlStops.level3, 1.0, 2.5),
  };

  // Confluence veto: avoid trading against strong 1h if 15m signal is weak
  const reasons = [];
  if (dir === 'UP') {
    if (tfResults['1h']?.signal.includes('SELL') && Math.max(buyWeight, sellWeight) < 3.6) {
      final_signal = 'HOLD';
      reasons.push('VETO: 1h bias opposite and 15m edge not strong');
    }
  } else if (dir === 'DOWN') {
    if (tfResults['1h']?.signal.includes('BUY') && Math.max(buyWeight, sellWeight) < 3.6) {
      final_signal = 'HOLD';
      reasons.push('VETO: 1h bias opposite and 15m edge not strong');
    }
  }

  // Suggestions object (unchanged shape)
  const suggestions = {};
  function bandFor(level) {
    if (level === 'level1') return lvl1Band;
    if (level === 'level2') return lvl2Band;
    return lvl3Band;
  }
  for (const level of ['level1', 'level2', 'level3']) {
    const band = bandFor(level);
    const stop = lvlStops[level];
    const tps  = lvlTargets[level];
    suggestions[level] = {
      entry: entryPrice,
      entry_range: { low: band.low, high: band.high },
      stop_loss: stop,
      take_profit_1: tps.tp1,
      take_profit_2: tps.tp2,
      atr_used: atrRef,
      sl_multiplier: level === 'level1' ? 1.0 : level === 'level2' ? 1.3 : 1.6,
    };
  }

  // Build readable reasons for the client
  const refDet = tfResults['15m'];
  if (refDet) {
    const r = refDet.indicators;
    if (dir === 'UP') reasons.push('15m EMA9 > EMA21 and price above EMA9 (momentum up)');
    if (dir === 'DOWN') reasons.push('15m EMA9 < EMA21 and price below EMA9 (momentum down)');
    if (refDet.indicators.volume && refDet.indicators.vol_sma20 && refDet.indicators.volume > refDet.indicators.vol_sma20 * 1.4) {
      reasons.push('Volume expansion on 15m (breakouts more reliable)');
    }
    if (stv != null && price != null) reasons.push(price > stv ? 'Above SuperTrend' : 'Below SuperTrend');
    if (marketRegime === 'FAST') reasons.push('Fast volatility regime — tighter stops, quick targets');
    if (marketRegime === 'SLOW') reasons.push('Slow volatility regime — expect slower follow-through');
  }

  const votes = {};
  for (const tf of Object.keys(tfResults)) votes[tf] = tfResults[tf].signal;

  const output = {
    symbol: symbol || null,
    exchangeSymbol: exchangeSymbol || null,
    final_signal,
    votesSummary: { byTf: votes },
    suggestions,
    reasons,
    details: tfResults
  };

  return res.status(200).json(output);
}

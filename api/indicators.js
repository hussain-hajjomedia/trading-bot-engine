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

  // ---------- Swing points ----------
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

  // ---------- Analysis ----------
  function analyzeTimeframe(tfName, candles) {
    const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
    const closes  = candles.map(c => toNum(c.close));
    const highs   = candles.map(c => toNum(c.high));
    const lows    = candles.map(c => toNum(c.low));
    const volumes = candles.map(c => toNum(c.volume));
    if (closes.length < 5) return result;

    const sma50    = sma(closes, 50);
    const sma200   = sma(closes, 200);
    const ema9Arr  = ema(closes, 9);
    const ema21Arr = ema(closes, 21);
    const rsi14    = rsiWilder(closes, 14);
    const macdObj  = macd(closes);
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
      atr14: atr14Arr[i],
      supertrend: stArr[i],
      bb_upper: bb[i]?.upper, bb_mid: bb[i]?.middle, bb_lower: bb[i]?.lower,
      vol_sma20: volSMA20[i], volume: volumes[i]
    };

    let score = 0;
    const sma50v = result.indicators.sma50, sma200v = result.indicators.sma200;
    let sidewaysFactor = 1;

    if (sma50v != null && sma200v != null) {
      const diffPct = Math.abs(sma50v - sma200v) / Math.max(1, Math.abs(sma200v));
      if (diffPct < 0.008) sidewaysFactor = 0.35;
      else if (diffPct < 0.02) sidewaysFactor = 0.7;
    }

    if (last.close != null && sma50v != null) score += (last.close > sma50v ? 6 : -6) * sidewaysFactor;
    if (sma50v != null && sma200v != null)    score += (sma50v > sma200v ? 8 : -8) * sidewaysFactor;
    if (result.indicators.ema9 != null && last.close != null) score += (last.close > result.indicators.ema9 ? 5 : -5) * sidewaysFactor;
    if (result.indicators.ema9 != null && result.indicators.ema21 != null) score += (result.indicators.ema9 > result.indicators.ema21 ? 3 : -3) * sidewaysFactor;

    if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
      if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) score += 10 * sidewaysFactor;
      else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) score -= 10 * sidewaysFactor;
    }

    if (result.indicators.supertrend != null && last.close != null)
      score += (last.close > result.indicators.supertrend ? 7 : -7) * sidewaysFactor;

    if (result.indicators.rsi14 != null) {
      if (result.indicators.rsi14 < 30) score += 2;
      else if (result.indicators.rsi14 > 70) score -= 2;
    }

    if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
      if (result.indicators.volume > result.indicators.vol_sma20 * 1.25) score += 6;
      else if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) score -= 3;
    }

    result.score = Math.max(-100, Math.min(100, Math.round(score)));
    if (result.score >= 30) result.signal = 'STRONG BUY';
    else if (result.score >= 12) result.signal = 'BUY';
    else if (result.score <= -30) result.signal = 'STRONG SELL';
    else if (result.score <= -12) result.signal = 'SELL';

    return result;
  }

  const tfResults = {};
  for (const tf of Object.keys(normalized)) tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);

  // ---------- Voting ----------
  const tfWeight = { '15m': 0.5, '1h': 1.5, '4h': 2.5, '1d': 3.5 };
  const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
  for (const tf of Object.keys(tfResults)) {
    const s = tfResults[tf].signal;
    const w = tfWeight[tf] || 1;
    tally[s] += w;
  }

  let final_signal = 'HOLD';
  const strongBuyWeight  = tally['STRONG BUY'];
  const strongSellWeight = tally['STRONG SELL'];
  const buyWeight  = tally['BUY']  + strongBuyWeight  * 1.5;
  const sellWeight = tally['SELL'] + strongSellWeight * 1.5;

  if (strongBuyWeight >= 3.5 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
  else if (strongSellWeight >= 3.5 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
  else if (buyWeight >= sellWeight && buyWeight >= 3.5) final_signal = 'BUY';
  else if (sellWeight > buyWeight && sellWeight >= 3.5) final_signal = 'SELL';
  else final_signal = 'HOLD';

  // ---------- Regime Detection (Balanced) ----------
  function mean(arr) {
    const v = arr.filter(x => x != null);
    if (!v.length) return null;
    return v.reduce((a, b) => a + b, 0) / v.length;
  }

  function detectRegime() {
    const r4 = tfResults['4h'];
    const r1d = tfResults['1d'];
    const r1h = tfResults['1h'];
    if (!r4 || !r1d || !r1h) return 'NEUTRAL';

    const smaGap4 = (r4.indicators.sma50 != null && r4.indicators.sma200 != null)
      ? Math.abs(r4.indicators.sma50 - r4.indicators.sma200) / Math.max(1, Math.abs(r4.indicators.sma200))
      : null;

    const trendUp = r1d.indicators.sma50 != null && r1d.indicators.sma200 != null &&
                    r4.indicators.sma50  != null && r4.indicators.sma200  != null &&
                    r1d.indicators.sma50 >  r1d.indicators.sma200 &&
                    r4.indicators.sma50  >  r4.indicators.sma200 &&
                    r4.last.close > r4.indicators.sma50 &&
                    r4.last.close > r4.indicators.sma200 &&
                    r4.last.close > r4.indicators.supertrend;

    const trendDown = r1d.indicators.sma50 != null && r1d.indicators.sma200 != null &&
                      r4.indicators.sma50  != null && r4.indicators.sma200  != null &&
                      r1d.indicators.sma50 <  r1d.indicators.sma200 &&
                      r4.indicators.sma50  <  r4.indicators.sma200 &&
                      r4.last.close < r4.indicators.sma50 &&
                      r4.last.close < r4.indicators.sma200 &&
                      r4.last.close < r4.indicators.supertrend;

    const highs1h = normalized['1h'].map(c => c.high);
    const lows1h  = normalized['1h'].map(c => c.low);
    const closes1h= normalized['1h'].map(c => c.close);
    const atr1hArr = atr(highs1h, lows1h, closes1h, 14);
    const lastAtr = atr1hArr[atr1hArr.length - 1] ?? null;
    const atrWindow = atr1hArr.slice(-30).filter(x => x != null);
    const avgAtr = mean(atrWindow);
    const expansion = (lastAtr != null && avgAtr != null) ? lastAtr > avgAtr * 1.3 : false;
    const squeeze   = (lastAtr != null && avgAtr != null) ? lastAtr < avgAtr * 0.7 : false;

    if (expansion) return 'VOL_EXPANSION';
    if (squeeze)   return 'SQUEEZE';
    if (trendUp)   return 'TREND_UP';
    if (trendDown) return 'TREND_DOWN';
    if (smaGap4 != null && smaGap4 < 0.012) return 'CHOP';
    return 'NEUTRAL';
  }

  const marketRegime = detectRegime();

  // ---------- Entry & Targets (Structure + Regime + Fibonacci exits) ----------
  const refTf = tfResults['1h']?.last?.close ? '1h' : tfResults['15m']?.last?.close ? '15m' : '4h';
  const ref    = tfResults[refTf];
  const emaVal = ref.indicators.ema9;
  const stVal  = ref.indicators.supertrend;
  const lastClose = ref.last.close;

  function pickAtr(tf) {
    const r = tfResults[tf];
    return r?.indicators?.atr14 ?? null;
  }
  let atrRef = pickAtr('1h') || pickAtr('4h') || pickAtr('1d') || pickAtr('15m');
  if (atrRef == null && lastClose != null) atrRef = lastClose * 0.005;

  // swings (4h primary, 1h secondary)
  const swings4h = findSwingPoints(normalized['4h']);
  const swings1h = findSwingPoints(normalized['1h']);
  const price = lastClose;
  const swingLow4h  = nearestSwingBelow(price, swings4h.swingLows);
  const swingHigh4h = nearestSwingAbove(price, swings4h.swingHighs);
  const swingLow1h  = nearestSwingBelow(price, swings1h.swingLows);
  const swingHigh1h = nearestSwingAbove(price, swings1h.swingHighs);

  const structureLow  = swingLow4h  ?? swingLow1h  ?? (price - atrRef * 2);
  const structureHigh = swingHigh4h ?? swingHigh1h ?? (price + atrRef * 2);

  function blend(a, b, weight = 0.5) {
    if (a == null) return b;
    if (b == null) return a;
    return a * weight + b * (1 - weight);
  }

  // Base entry from structure + ema/st
  let rawEntryLow, rawEntryHigh;
  if (final_signal.includes('BUY')) {
    rawEntryLow  = blend(Math.min(emaVal, stVal), structureLow, 0.6);
    rawEntryHigh = blend(emaVal, price, 0.6);
  } else if (final_signal.includes('SELL')) {
    rawEntryLow  = blend(price, emaVal, 0.6);
    rawEntryHigh = blend(Math.max(emaVal, stVal), structureHigh, 0.6);
  } else {
    rawEntryLow = price; rawEntryHigh = price;
  }

  // Regime-based adjustments (Balanced)
  let MAX_ENTRY_PCT = 0.015, MAX_ENTRY_PCT_L2 = 0.03, MAX_ENTRY_PCT_L3 = 0.05;
  const MIN_ENTRY_PCT = 0.001;
  const baseSL = { level1: 1.0, level2: 1.6, level3: 2.4 };

  // Fib target choice defaults; we will only use in TREND regimes
  let useFibTargets = false;
  let fibExtChoice = 1.382; // default
  if (marketRegime === 'TREND_UP' || marketRegime === 'TREND_DOWN') {
    MAX_ENTRY_PCT = 0.012;
    useFibTargets = true;
    // In stronger composite vote, allow 1.618
    if (Math.max(buyWeight, sellWeight) >= 5.0) fibExtChoice = 1.618;
  } else if (marketRegime === 'CHOP') {
    MAX_ENTRY_PCT = 0.018; MAX_ENTRY_PCT_L2 = 0.035; MAX_ENTRY_PCT_L3 = 0.055;
    baseSL.level1 += 0.2; baseSL.level2 += 0.2; baseSL.level3 += 0.2;
    // optional guard: weak edge -> HOLD
    const edgeWeak = Math.abs(buyWeight - sellWeight) < 1.0;
    if (edgeWeak) final_signal = 'HOLD';
  } else if (marketRegime === 'VOL_EXPANSION') {
    rawEntryLow  = blend(rawEntryLow,  structureLow,  0.75);
    rawEntryHigh = blend(rawEntryHigh, structureHigh, 0.75);
    baseSL.level1 += 0.15; baseSL.level2 += 0.15; baseSL.level3 += 0.15;
  } else if (marketRegime === 'SQUEEZE') {
    baseSL.level1 -= 0.1; baseSL.level2 -= 0.1; baseSL.level3 -= 0.1;
  }

  function clampEntryRange(rawLow, rawHigh, lastPrice, maxPct) {
    if (!lastPrice || rawLow == null || rawHigh == null) return { low: rawLow, high: rawHigh };
    if (rawLow > rawHigh) { const t = rawLow; rawLow = rawHigh; rawHigh = t; }

    const lowPct  = Math.abs((rawLow  - lastPrice) / lastPrice);
    const highPct = Math.abs((rawHigh - lastPrice) / lastPrice);

    const cappedLow  = lowPct  > maxPct ? (rawLow  < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct)) : rawLow;
    const cappedHigh = highPct > maxPct ? (rawHigh < lastPrice ? lastPrice * (1 - maxPct) : lastPrice * (1 + maxPct)) : rawHigh;

    let finalLow  = Math.min(cappedLow, cappedHigh);
    let finalHigh = Math.max(cappedLow, cappedHigh);
    const widthPct = Math.abs((finalHigh - finalLow) / Math.max(1, lastPrice));
    if (widthPct < MIN_ENTRY_PCT) {
      const half = (MIN_ENTRY_PCT * lastPrice) / 2;
      finalLow  = lastPrice - half;
      finalHigh = lastPrice + half;
    }
    return { low: finalLow, high: finalHigh };
  }

  const lvl1 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT);
  const lvl2 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L2);
  const lvl3 = clampEntryRange(rawEntryLow, rawEntryHigh, lastClose, MAX_ENTRY_PCT_L3);

  const entryPrice =
    (lvl1.low != null && lvl1.high != null) ? (lvl1.low + lvl1.high) / 2
    : (lastClose != null ? lastClose : null);

  // ---------- Fibonacci target helper ----------
  // Build impulse from latest confirmed swings on 4h (prefer) or 1h
  function computeFibTargets(trendDir) {
    // pick swings from 4h; if not enough points, try 1h
    const sh4 = swings4h.swingHighs;
    const sl4 = swings4h.swingLows;
    const sh1 = swings1h.swingHighs;
    const sl1 = swings1h.swingLows;

    function lastPair(highs, lows) {
      if (highs.length < 1 || lows.length < 1) return null;
      // Find most recent swing high and swing low with correct order for impulse
      const lastHigh = highs[highs.length - 1];
      const lastLow  = lows [lows .length - 1];
      // We don't have indices ordering between arrays in this simple finder,
      // so approximate: use nearest to price for direction
      return { high: lastHigh.price, low: lastLow.price };
    }

    let pair = lastPair(sh4, sl4) || lastPair(sh1, sl1);
    if (!pair) return { tp1: null, tp2: null, refHigh: null, refLow: null };

    const high = pair.high;
    const low  = pair.low;
    const leg  = Math.abs(high - low);

    if (!isFinite(leg) || leg === 0) return { tp1: null, tp2: null, refHigh: high, refLow: low };

    if (trendDir === 'UP') {
      const priorHigh = Math.max(high, low) === high ? high : structureHigh; // safety
      const ext1382   = low + 1.382 * (high - low);
      const ext1618   = low + 1.618 * (high - low);
      return { tp1: priorHigh, tp2: fibExtChoice === 1.618 ? ext1618 : ext1382, refHigh: priorHigh, refLow: low };
    } else if (trendDir === 'DOWN') {
      const priorLow  = Math.min(high, low) === low ? low : structureLow;
      const ext1382   = high - 1.382 * (high - low);
      const ext1618   = high - 1.618 * (high - low);
      return { tp1: priorLow, tp2: fibExtChoice === 1.618 ? ext1618 : ext1382, refHigh: high, refLow: priorLow };
    }
    return { tp1: null, tp2: null, refHigh: high, refLow: low };
  }

  const suggestions = {};
  const levels = ['level1', 'level2', 'level3'];

  for (const lvl of levels) {
    const m = baseSL[lvl];
    let sl = null, tp1 = null, tp2 = null;
    const entry = entryPrice;

    if (entry == null || atrRef == null) {
      // Fallback if missing refs
      sl  = entry ? entry - entry * 0.01 : null;
      tp1 = entry ? entry + entry * 0.015 : null;
      tp2 = entry ? entry + entry * 0.03  : null;
    } else {
      if (final_signal.includes('BUY')) {
        const structuralSL = structureLow != null ? structureLow * 0.997 : entry - atrRef * m;
        sl = Math.min(structuralSL, entry - atrRef * m);

        if (useFibTargets) {
          const fib = computeFibTargets('UP');
          tp1 = fib.tp1 ?? (entry + atrRef * (m * 1.2));
          tp2 = fib.tp2 ?? (entry + atrRef * (m * 2.2));
        } else {
          tp1 = entry + atrRef * (m * 1.2);
          tp2 = entry + atrRef * (m * 2.2);
        }
      } else if (final_signal.includes('SELL')) {
        const structuralSL = structureHigh != null ? structureHigh * 1.003 : entry + atrRef * m;
        sl = Math.max(structuralSL, entry + atrRef * m);

        if (useFibTargets) {
          const fib = computeFibTargets('DOWN');
          tp1 = fib.tp1 ?? (entry - atrRef * (m * 1.2));
          tp2 = fib.tp2 ?? (entry - atrRef * (m * 2.2));
        } else {
          tp1 = entry - atrRef * (m * 1.2);
          tp2 = entry - atrRef * (m * 2.2);
        }
      } else {
        // SIDEWAYS: conservative ATR targets
        sl  = entry - atrRef * m;
        tp1 = entry + atrRef * (m * 0.8);
        tp2 = entry + atrRef * (m * 1.6);
      }
    }

    // Safety clamps on TPs to avoid absurd numbers
    const maxTPDistance = Math.max(Math.abs(entry * 0.08), atrRef * 4);
    if (tp1 != null && Math.abs(tp1 - entry) > maxTPDistance) {
      tp1 = entry + Math.sign(tp1 - entry) * maxTPDistance;
    }
    if (tp2 != null && Math.abs(tp2 - entry) > maxTPDistance * 1.6) {
      tp2 = entry + Math.sign(tp2 - entry) * maxTPDistance * 1.6;
    }

    suggestions[lvl] = {
      entry: entry,
      entry_range: lvl === 'level1' ? { low: lvl1.low, high: lvl1.high }
                 : lvl === 'level2' ? { low: lvl2.low, high: lvl2.high }
                 : { low: lvl3.low, high: lvl3.high },
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
    symbol: symbol || null,
    exchangeSymbol: exchangeSymbol || null,
    final_signal,
    votesSummary: { byTf: votes },
    suggestions,
    reasons: [],
    details: tfResults
  };

  return res.status(200).json(output);
}

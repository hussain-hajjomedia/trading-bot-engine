// api/indicators.js — SCALP + CONDITIONAL FIBONACCI PULLBACK (15m + 1h aware)
// Output format unchanged. Always returns SL/TP for level1/2/3.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d, tickSize, priceTickSize, stepSize, strictNulls } = payload;
    strictNulls = (strictNulls === false) ? false : true;

    console.log('[indicators] start', { symbol, exchangeSymbol });

    // ---------- Utilities ----------
    function tryParseMaybeJson(input) {
      if (input == null) return null;
      if (Array.isArray(input)) return input;
      if (typeof input === 'string') {
        try { return JSON.parse(input); } catch { return input; }
      }
      return input;
    }

    function extractArrayFromPossibleWrapper(x) {
      if (x == null) return [];
      if (Array.isArray(x)) return x;
      if (typeof x === 'object') {
        if (Array.isArray(x.data)) return x.data;
        if (Array.isArray(x.body)) return x.body;
      }
      return [];
    }

    function parseInputField(field) {
      return extractArrayFromPossibleWrapper(tryParseMaybeJson(field));
    }

    kline_15m = parseInputField(kline_15m);
    kline_1h  = parseInputField(kline_1h);
    kline_4h  = parseInputField(kline_4h);
    kline_1d  = parseInputField(kline_1d);

    console.log('[indicators] raw lengths', {
      '15m': Array.isArray(kline_15m) ? kline_15m.length : null,
      '1h': Array.isArray(kline_1h) ? kline_1h.length : null,
      '4h': Array.isArray(kline_4h) ? kline_4h.length : null,
      '1d': Array.isArray(kline_1d) ? kline_1d.length : null,
    });

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
      '1h' : normalizeCandlesRaw(kline_1h),
      '4h' : normalizeCandlesRaw(kline_4h),
      '1d' : normalizeCandlesRaw(kline_1d),
    };

    console.log('[indicators] normalized lengths', {
      '15m': normalized['15m'].length,
      '1h': normalized['1h'].length,
      '4h': normalized['4h'].length,
      '1d': normalized['1d'].length,
    });

    // Ensure ascending sort by openTime, dedupe by openTime, drop incomplete last bar if closeTime is in the future
    function finalizeCandles(rawArr) {
      if (!Array.isArray(rawArr)) return [];
      const arr = rawArr
        .filter(c => c && c.openTime != null && Number.isFinite(Number(c.openTime)));
      arr.sort((a, b) => Number(a.openTime) - Number(b.openTime));
      const out = [];
      const seen = new Set();
      for (let i = 0; i < arr.length; i++) {
        const ot = Number(arr[i].openTime);
        if (seen.has(ot)) continue;
        seen.add(ot);
        out.push(arr[i]);
      }
      if (out.length) {
        const last = out[out.length - 1];
        const ct = last && last.closeTime != null ? Number(last.closeTime) : null;
        if (ct != null && Number.isFinite(ct) && ct > Date.now()) out.pop();
      }
      return out;
    }
    normalized['15m'] = finalizeCandles(normalized['15m']);
    normalized['1h']  = finalizeCandles(normalized['1h']);
    normalized['4h']  = finalizeCandles(normalized['4h']);
    normalized['1d']  = finalizeCandles(normalized['1d']);

    console.log('[indicators] finalized lengths', {
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

    function superTrendCanonical(highs, lows, closes, period = 10, mult = 3) {
      const len = closes.length;
      const atrArr = atr(highs, lows, closes, period);
      const hl2 = highs.map((h, i) => (h + lows[i]) / 2);
      const upperBasic = hl2.map((v, i) => v + mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const lowerBasic = hl2.map((v, i) => v - mult * (atrArr[i] == null ? 0 : atrArr[i]));
      const finalUpper = new Array(len).fill(null);
      const finalLower = new Array(len).fill(null);
      const st = new Array(len).fill(null);
      const trend = new Array(len).fill(null);
      for (let i = 0; i < len; i++) {
        if (i === 0) {
          finalUpper[i] = upperBasic[i];
          finalLower[i] = lowerBasic[i];
          st[i] = null; trend[i] = null;
          continue;
        }
        finalUpper[i] = (upperBasic[i] < (finalUpper[i - 1] ?? Infinity) || closes[i - 1] > (finalUpper[i - 1] ?? Infinity))
          ? upperBasic[i] : finalUpper[i - 1];
        finalLower[i] = (lowerBasic[i] > (finalLower[i - 1] ?? -Infinity) || closes[i - 1] < (finalLower[i - 1] ?? -Infinity))
          ? lowerBasic[i] : finalLower[i - 1];
        if (st[i - 1] == null) {
          st[i] = closes[i] >= finalLower[i] ? finalLower[i] : finalUpper[i];
        } else if (st[i - 1] === finalUpper[i - 1]) {
          st[i] = closes[i] <= finalUpper[i] ? finalUpper[i] : finalLower[i];
        } else {
          st[i] = closes[i] >= finalLower[i] ? finalLower[i] : finalUpper[i];
        }
        trend[i] = (st[i] === finalLower[i]) ? 1 : -1;
      }
      return { st, trend };
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

    function nearestSwingBelow(price, swings) {
      if (!Array.isArray(swings) || swings.length === 0) return null;
      const below = swings.filter(s => s.price < price).map(s => s.price);
      if (!below.length) return null;
      return Math.max(...below);
    }
    function nearestSwingAbove(price, swings) {
      if (!Array.isArray(swings) || swings.length === 0) return null;
      const above = swings.filter(s => s.price > price).map(s => s.price);
      if (!above.length) return null;
      return Math.min(...above);
    }

    // ---------- Analysis (scalp-specific) ----------
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
      const atr7Arr  = atr(highs, lows, closes, 7);
      const atr14Arr = atr(highs, lows, closes, 14);
      const stObj    = superTrendCanonical(highs, lows, closes, 10, 3);
      const stArr    = stObj.st;

      const i = closes.length - 1;
      const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
      result.last = last;

      result.indicators = {
        sma50: sma50[i], sma200: sma200[i],
        ema9: ema9Arr[i], ema21: ema21Arr[i],
        rsi14: rsi14[i],
        macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i], macd_hist: macdObj.hist[i],
        atr7: atr7Arr[i],
        atr14: atr14Arr[i],
        supertrend: stArr[i],
        volume: volumes[i],
      };

      // Scalp scoring (kept aggressive but controlled)
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

    // ---------- Voting (scalp bias with equal 15m/1h importance) ----------
    const tfWeight = { '15m': 2.0, '1h': 2.0, '4h': 0.6, '1d': 0.2 };
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

    // ---------- ATR reference (15m only) ----------
    const lastClose15 = tfResults['15m']?.last?.close ?? null;
    const atrRef = tfResults['15m']?.indicators?.atr14 ?? tfResults['15m']?.indicators?.atr7 ?? (lastClose15 != null ? lastClose15 * 0.003 : 1);

    console.log('[indicators] atrRef', atrRef);

    // ---------- Conditional Fibonacci (pullback-only) ----------
    const swings15 = findSwingPoints(normalized['15m']);
    const swings1h = findSwingPoints(normalized['1h']);

    // Detect BOS on 15m and derive the impulse that caused it
    function detectBosFromSwings(candles, swings) {
      if (!candles || !candles.length || !swings) return null;
      const closes = candles.map(c => toNum(c.close));
      const lastClose = closes[closes.length - 1];
      const sh = (swings.swingHighs || []).map(x => x.index).sort((a,b)=>a-b);
      const sl = (swings.swingLows  || []).map(x => x.index).sort((a,b)=>a-b);
      if (!sh.length || !sl.length) return null;
      const lastHighIdx = sh[sh.length - 1];
      const lastLowIdx  = sl[sl.length - 1];
      const lastHighVal = toNum(candles[lastHighIdx]?.high);
      const lastLowVal  = toNum(candles[lastLowIdx]?.low);
      let dir = null;
      if (Number.isFinite(lastHighVal) && lastClose > lastHighVal) dir = 'UP';
      else if (Number.isFinite(lastLowVal) && lastClose < lastLowVal) dir = 'DOWN';
      if (!dir) return null;
      if (dir === 'UP') {
        const startIdx = lastLowIdx, endIdx = lastHighIdx;
        const low = toNum(candles[startIdx]?.low), high = toNum(candles[endIdx]?.high);
        if (Number.isFinite(low) && Number.isFinite(high)) return { dir, low, high, iLow: startIdx, iHigh: endIdx };
      } else {
        const startIdx = lastHighIdx, endIdx = lastLowIdx;
        const high = toNum(candles[startIdx]?.high), low = toNum(candles[endIdx]?.low);
        if (Number.isFinite(low) && Number.isFinite(high)) return { dir, high, low, iHigh: startIdx, iLow: endIdx };
      }
      return null;
    }
    const bos15 = detectBosFromSwings(normalized['15m'], swings15);

    function impulseFromSw(sw) {
      if (!sw) return null;
      const highArr = Array.isArray(sw.swingHighs) ? sw.swingHighs : [];
      const lowArr = Array.isArray(sw.swingLows) ? sw.swingLows : [];
      if (highArr.length === 0 || lowArr.length === 0) return null;
      const lastHigh = highArr[highArr.length - 1];
      const lastLow  = lowArr[lowArr.length - 1];
      if (!lastHigh || !lastLow) return null;
      if (lastLow.index < lastHigh.index) {
        return { dir: 'UP', low: lastLow.price, high: lastHigh.price, iLow: lastLow.index, iHigh: lastHigh.index };
      } else if (lastHigh.index < lastLow.index) {
        return { dir: 'DOWN', high: lastHigh.price, low: lastLow.price, iHigh: lastHigh.index, iLow: lastLow.index };
      }
      return null;
    }

    function pickImpulse() {
      const imp15 = impulseFromSw(swings15);
      const imp1h = impulseFromSw(swings1h);
      if (!imp15) return imp1h;
      if (!imp1h) return imp15;
      const size15 = Math.abs((imp15.high ?? 0) - (imp15.low ?? 0));
      const size1h = Math.abs((imp1h.high ?? 0) - (imp1h.low ?? 0));
      // prefer the stronger leg (1h if > 1.5x)
      return (size1h > size15 * 1.5) ? imp1h : imp15;
    }

    let impulse = pickImpulse();
    if (bos15 && bos15.low != null && bos15.high != null) impulse = bos15;
    console.log('[indicators] impulse', impulse);

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

    console.log('[indicators] fibModeActive', fibModeActive, 'strongImpulse', strongImpulse, 'alignedUp', alignedUp, 'alignedDown', alignedDown);

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
    console.log('[indicators] fib', fib);

    // ---------- Multi-impulse confluence (15m): golden pocket + 0.714 + 1.382/1.618 ----------
    function buildImpulseList(sw) {
      if (!sw || !sw.swingHighs || !sw.swingLows) return [];
      const piv = [
        ...sw.swingHighs.map(h => ({ t:'H', i:h.index, p:h.price })),
        ...sw.swingLows.map(l => ({ t:'L', i:l.index, p:l.price })),
      ].sort((a,b)=>a.i-b.i);
      const legs = [];
      for (let k = 1; k < piv.length; k++) {
        const a = piv[k-1], b = piv[k];
        if (a.t === b.t) continue;
        if (a.t === 'L' && b.t === 'H') legs.push({ dir:'UP', low:a.p, high:b.p, iLow:a.i, iHigh:b.i });
        if (a.t === 'H' && b.t === 'L') legs.push({ dir:'DOWN', high:a.p, low:b.p, iHigh:a.i, iLow:b.i });
      }
      return legs.slice(-6);
    }
    function fibsForLeg(leg) {
      if (!leg || leg.low == null || leg.high == null) return null;
      const low = leg.low, high = leg.high;
      const gpLow = low < high ? (low + 0.618*(high-low)) : (high + 0.618*(low-high));
      const gpHigh= low < high ? (low + 0.65 *(high-low)) : (high + 0.65 *(low-high));
      const r0714 = low < high ? (low + 0.714*(high-low)) : (high + 0.714*(low-high));
      const ext1382= low < high ? (low + 1.382*(high-low)) : (high - 1.382*(high-low));
      const ext1618= low < high ? (low + 1.618*(high-low)) : (high - 1.618*(high-low));
      return {
        dir: leg.dir,
        gp: { low: Math.min(gpLow,gpHigh), high: Math.max(gpLow,gpHigh) },
        r0714,
        ext1382, ext1618
      };
    }
    const legs15 = buildImpulseList(swings15);
    const fibsList = legs15.map(fibsForLeg).filter(Boolean);
    function zonesFromFibs(f) {
      return [
        { label:'golden_pocket_0.618_0.65', type:'retr', low:f.gp.low, high:f.gp.high, dir:f.dir, includes0714:false },
        { label:'retracement_0.714', type:'retr', low:f.r0714, high:f.r0714, dir:f.dir, includes0714:true },
        { label:'extension_1.382', type:'ext', low:f.ext1382, high:f.ext1382, dir:f.dir, includes0714:false },
        { label:'extension_1.618', type:'ext', low:f.ext1618, high:f.ext1618, dir:f.dir, includes0714:false }
      ];
    }
    const allZones = fibsList.flatMap(zonesFromFibs).filter(z => Number.isFinite(z.low) && Number.isFinite(z.high));
    function overlap(a,b) {
      const lo = Math.max(Math.min(a.low,a.high), Math.min(b.low,b.high));
      const hi = Math.min(Math.max(a.low,a.high), Math.max(b.low,b.high));
      return lo <= hi ? { low:lo, high:hi } : null;
    }
    const hotZones = [];
    for (let i=0;i<allZones.length;i++){
      for (let j=i+1;j<allZones.length;j++){
        const o = overlap(allZones[i], allZones[j]);
        if (o) {
          const includes0714 = allZones[i].includes0714 || allZones[j].includes0714;
          const includesExt  = (allZones[i].type === 'ext' || allZones[j].type === 'ext');
          hotZones.push({ low:o.low, high:o.high, includes0714, includesExt, labels:[allZones[i].label, allZones[j].label] });
        }
      }
    }
    function scoreHotZone(z) {
      const a = Number.isFinite(atrRef) ? atrRef : (lastClose15 ?? 0) * 0.003;
      const width = Math.max(1e-9, z.high - z.low);
      const widthScore = Math.max(0, 1 - (width / (a*1.0)));
      const highs = (swings15?.swingHighs || []).map(s=>Number(s.price)).filter(Number.isFinite);
      const lows  = (swings15?.swingLows  || []).map(s=>Number(s.price)).filter(Number.isFinite);
      const refList = highs.concat(lows);
      const structScore = (() => {
        if (!refList.length) return 0;
        const mid = (z.low+z.high)/2;
        const d = Math.min(...refList.map(p=>Math.abs(mid-p)));
        const sigma = a * 1.0;
        return Math.exp(-(d*d)/(2*sigma*sigma));
      })();
      const inc0714 = z.includes0714 ? 0.25 : 0;
      const incExt  = z.includesExt  ? 0.15 : 0;
      return Math.max(0, Math.min(1, 0.5*widthScore + 0.25*structScore + inc0714 + incExt));
    }
    const scoredHot = hotZones.map(z => ({ ...z, score: scoreHotZone(z) }))
                              .sort((a,b)=>b.score-a.score)
                              .slice(0,3);

    // ---------- FVG detection (15m primary, 1h secondary) and boost ----------
    function detectFVG(candles) {
      const out = [];
      for (let i = 1; i < candles.length - 1; i++) {
        const prev = candles[i-1], cur = candles[i], next = candles[i+1];
        if (!prev || !cur || !next) continue;
        const prevHigh = toNum(prev.high), prevLow = toNum(prev.low);
        const nextHigh = toNum(next.high), nextLow = toNum(next.low);
        if (Number.isFinite(nextLow) && Number.isFinite(prevHigh) && nextLow > prevHigh) {
          out.push({ type:'bull', low: prevHigh, high: nextLow, center:(prevHigh+nextLow)/2, index:i });
        }
        if (Number.isFinite(nextHigh) && Number.isFinite(prevLow) && nextHigh < prevLow) {
          out.push({ type:'bear', low: nextHigh, high: prevLow, center:(nextHigh+prevLow)/2, index:i });
        }
      }
      return out;
    }
    const fvg15 = detectFVG(normalized['15m']);
    const fvg1h = detectFVG(normalized['1h']);
    function zoneHasFvgOverlap(z) {
      const has = (arr) => arr.some(g => !(z.high < g.low || z.low > g.high));
      return has(fvg15) || has(fvg1h);
    }
    const scoredWithFvg = scoredHot.map(z => {
      const fvg = zoneHasFvgOverlap(z);
      const bonus = fvg ? 0.08 : 0;
      return { ...z, score: Math.max(0, Math.min(1, z.score + bonus)), fvg_overlap: fvg };
    }).sort((a,b)=>b.score-a.score);
    // ---------- Entry band (15m + 1h integration) ----------
    const ema15 = tfResults['15m']?.indicators?.ema9 ?? null;
    const ema1h = tfResults['1h']?.indicators?.ema9 ?? null;
    const st15  = tfResults['15m']?.indicators?.supertrend ?? null;
    const st1h  = tfResults['1h']?.indicators?.supertrend ?? null;

    const basePrice = (ema15 != null && ema1h != null)
      ? (ema15 * 0.6 + ema1h * 0.4)
      : (ema15 ?? ema1h ?? lastClose15 ?? lastClose1h ?? null);

    // Determine multi-timeframe trend alignment for entry band
    const trend =
      (sig15.includes('BUY') && sig1h.includes('BUY')) ? 'UP' :
      (sig15.includes('SELL') && sig1h.includes('SELL')) ? 'DOWN' :
      final_signal.includes('BUY') ? 'UP' :
      final_signal.includes('SELL') ? 'DOWN' :
      'SIDEWAYS';

    // clamp helper (declared before use)
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

    // Build blended ema/st for entry bands
    const emaBlend = (ema15 != null && ema1h != null) ? (ema15 * 0.5 + ema1h * 0.5) : (ema15 ?? ema1h ?? basePrice);
    const stBlend  = (st15 != null && st1h != null) ? (st15 * 0.5 + st1h * 0.5) : (st15 ?? st1h ?? basePrice);

    function bandsForLevels() {
      // Prefer confluence hot zone center as anchor; fallback to fib pullback zone; else EMA/ST band
      const ZONE_MIN_SCORE = 0.55;
      const best = (Array.isArray(scoredWithFvg) && scoredWithFvg.length)
        ? (scoredWithFvg.find(z => (z.score ?? 0) >= ZONE_MIN_SCORE) || null)
        : null;
      if (best) {
        const mid = (best.low + best.high) / 2;
        const half1 = Math.max(atrRef * 0.12, (best.high - best.low) * 0.5);
        const half2 = Math.max(atrRef * 0.20, half1 * 1.5);
        const half3 = Math.max(atrRef * 0.30, half1 * 2.2);
        return {
          level1: { low: mid - half1, high: mid + half1 },
          level2: { low: mid - half2, high: mid + half2 },
          level3: { low: mid - half3, high: mid + half3 },
        };
      }
      if (strictNulls) {
        return null;
      }
      // Fib fallback (non-strict)
      if (fib && fibModeActive && fib.pullLow != null && fib.pullHigh != null) {
        const mid = (fib.pullLow + fib.pullHigh) / 2;
        const half1 = Math.max(atrRef * 0.12, (Math.abs(fib.pullHigh - fib.pullLow)) * 0.5);
        const half2 = Math.max(atrRef * 0.20, half1 * 1.5);
        const half3 = Math.max(atrRef * 0.30, half1 * 2.2);
        return {
          level1: { low: mid - half1, high: mid + half1 },
          level2: { low: mid - half2, high: mid + half2 },
          level3: { low: mid - half3, high: mid + half3 },
        };
      }
      // EMA/ST fallback (coherent, no arbitrary clamp) for non-strict mode
      const p = basePrice;
      let rawLow, rawHigh;
      if (trend === 'UP') {
        rawLow = Math.min(emaBlend ?? p, stBlend ?? p);
        rawHigh = emaBlend ?? p;
      } else if (trend === 'DOWN') {
        rawLow = emaBlend ?? p;
        rawHigh = Math.max(emaBlend ?? p, stBlend ?? p);
      } else {
        rawLow = p; rawHigh = p;
      }
      const mid = (rawLow + rawHigh) / 2;
      return {
        level1: { low: mid - atrRef * 0.12, high: mid + atrRef * 0.12 },
        level2: { low: mid - atrRef * 0.20, high: mid + atrRef * 0.20 },
        level3: { low: mid - atrRef * 0.30, high: mid + atrRef * 0.30 },
      };
    }

    const bands = bandsForLevels();
    console.log('[indicators] bands', bands ? { level1: bands.level1, level2: bands.level2, level3: bands.level3 } : null, 'basePrice', basePrice);

    // Entry price = mid of level1 band (consistent) when bands exist
    const entryPrice = (() => {
      if (!bands || !bands.level1) return null;
      const b = bands.level1;
      if (b && b.low != null && b.high != null) return (b.low + b.high) / 2;
      return null;
    })();

    // ---------- Stops & Targets ----------
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

      // Structural SL based on 0.786 of impulse and nearest 15m swing
      const calcRetr786 = () => {
        if (!impulse || impulse.low == null || impulse.high == null) return null;
        const low = impulse.low, high = impulse.high;
        if (dir === 'UP') return low + 0.786 * (high - low);
        if (dir === 'DOWN') return high - 0.786 * (high - low);
        return null;
      };
      const retr786 = calcRetr786();
      const nearestLow = (swings15 && Array.isArray(swings15.swingLows)) ? (() => {
        const p = swings15.swingLows.map(s=>({price:s.price}));
        return (function(price, swings){ if (!Array.isArray(swings) || swings.length===0) return null; const below = swings.filter(s=>s.price < price).map(s=>s.price); if (!below.length) return null; return Math.max(...below); })(e, swings15.swingLows);
      })() : null;
      const nearestHigh= (swings15 && Array.isArray(swings15.swingHighs)) ? (() => {
        const p = swings15.swingHighs.map(s=>({price:s.price}));
        return (function(price, swings){ if (!Array.isArray(swings) || swings.length===0) return null; const above = swings.filter(s=>s.price > price).map(s=>s.price); if (!above.length) return null; return Math.min(...above); })(e, swings15.swingHighs);
      })() : null;

      const ext1272 = (impulse && impulse.low != null && impulse.high != null)
        ? (impulse.dir === 'UP' ? (impulse.low + 1.272*(impulse.high-impulse.low))
                                : (impulse.high - 1.272*(impulse.high-impulse.low))) : null;
      const ext1382 = (impulse && impulse.low != null && impulse.high != null)
        ? (impulse.dir === 'UP' ? (impulse.low + 1.382*(impulse.high-impulse.low))
                                : (impulse.high - 1.382*(impulse.high-impulse.low))) : null;
      const ext1618 = (impulse && impulse.low != null && impulse.high != null)
        ? (impulse.dir === 'UP' ? (impulse.low + 1.618*(impulse.high-impulse.low))
                                : (impulse.high - 1.618*(impulse.high-impulse.low))) : null;

      if (dir === 'UP') {
        const candidates = [];
        if (Number.isFinite(retr786)) candidates.push(retr786 - a * 0.05);
        if (Number.isFinite(nearestLow)) candidates.push(nearestLow - a * 0.05);
        candidates.push(e - a * m);
        sl = Math.min(...candidates.filter(Number.isFinite));
        tp1 = Number.isFinite(ext1272) ? ext1272 : (e + a * m * 1.0);
        tp2 = Number.isFinite(ext1618) ? ext1618 : (e + a * m * 2.0);
      } else if (dir === 'DOWN') {
        const candidates = [];
        if (Number.isFinite(retr786)) candidates.push(retr786 + a * 0.05);
        if (Number.isFinite(nearestHigh)) candidates.push(nearestHigh + a * 0.05);
        candidates.push(e + a * m);
        sl = Math.max(...candidates.filter(Number.isFinite));
        tp1 = Number.isFinite(ext1272) ? ext1272 : (e - a * m * 1.0);
        tp2 = Number.isFinite(ext1618) ? ext1618 : (e - a * m * 2.0);
      } else {
        sl  = e - a * m;
        tp1 = e + a * m * 0.8;
        tp2 = e + a * m * 1.6;
      }

      // Safety caps (scalp): 2% from entry, TP2 up to 3%
      sl  = limitExtremes(e, sl, 0.02, 1.0);
      tp1 = limitExtremes(e, tp1, 0.02, 1.0);
      tp2 = limitExtremes(e, tp2, 0.03, 1.0);

      return { sl, tp1, tp2 };
    }

    // Assemble suggestions (distinct entries per level) with quantization
    function inferTickSize(tfName) {
      const arr = normalized[tfName] || [];
      const vals = [];
      const push = (v) => { const n = Number(v); if (Number.isFinite(n)) vals.push(n); };
      for (let i = Math.max(0, arr.length - 200); i < arr.length; i++) {
        const c = arr[i];
        push(c.close); push(c.open); push(c.high); push(c.low);
      }
      if (vals.length < 2) return 0.01;
      vals.sort((a,b)=>a-b);
      let minStep = Infinity;
      for (let i = 1; i < vals.length; i++) {
        const d = Math.abs(vals[i] - vals[i-1]);
        if (d > 0) minStep = Math.min(minStep, d);
      }
      if (!Number.isFinite(minStep) || minStep === 0) return 0.01;
      const exp = Math.ceil(-Math.log10(minStep));
      const tick = Math.pow(10, -Math.max(0, Math.min(8, exp)));
      if (tick < 0.01) return 0.01;
      if (tick > 1) return 0.1;
      return tick;
    }
    const providedTick = (() => {
      const v = Number(tickSize ?? priceTickSize);
      return (Number.isFinite(v) && v > 0) ? v : null;
    })();
    const tick = providedTick ?? inferTickSize('15m');
    const floorToTick = (p) => (p == null ? p : Math.floor(p / tick) * tick);
    const ceilToTick  = (p) => (p == null ? p : Math.ceil(p / tick) * tick);
    const roundToTick = (p) => (p == null ? p : Math.round(p / tick) * tick);

    const suggestions = {};
    if (bands && bands.level1 && bands.level2 && bands.level3) {
      for (const lvl of ['level1', 'level2', 'level3']) {
        const m = slMultipliers[lvl];
        const band = bands[lvl] || bands.level1;
        const entryL = roundToTick((band.low + band.high) / 2);
        let { sl, tp1, tp2 } = computeStopsAndTargets(trend, entryL, atrRef, m);
        if (trend === 'UP') { sl = floorToTick(sl); tp1 = floorToTick(tp1); tp2 = floorToTick(tp2); }
        else if (trend === 'DOWN') { sl = ceilToTick(sl); tp1 = ceilToTick(tp1); tp2 = ceilToTick(tp2); }
        else { sl = roundToTick(sl); tp1 = roundToTick(tp1); tp2 = roundToTick(tp2); }
        suggestions[lvl] = {
          entry: entryL,
          entry_range: { low: floorToTick(band?.low ?? entryL), high: ceilToTick(band?.high ?? entryL) },
          stop_loss: sl,
          take_profit_1: tp1,
          take_profit_2: tp2,
          atr_used: atrRef,
          sl_multiplier: m,
        };
      }
    }

    if (suggestions.level1) console.log('[indicators] suggestions sample', { lvl1: suggestions.level1, final_signal });

    // ---------- Gates: readiness for execution ----------
    function ltfConfirm(dir) {
      const tf = tfResults['15m'];
      if (!tf) return false;
      const ema9 = tf.indicators?.ema9, ema21 = tf.indicators?.ema21;
      const macd = tf.indicators?.macd, macdSig = tf.indicators?.macd_signal;
      if (!Number.isFinite(ema9) || !Number.isFinite(ema21) || !Number.isFinite(macd) || !Number.isFinite(macdSig)) return false;
      if (dir === 'UP') return (ema9 > ema21) && (macd > macdSig);
      if (dir === 'DOWN') return (ema9 < ema21) && (macd < macdSig);
      return false;
    }
    // Build a primary zone
    const lastPrice = lastClose15 ?? tfResults['15m']?.last?.close ?? null;
    const ZONE_MIN_SCORE = 0.55;
    let bestZone = (Array.isArray(scoredWithFvg) && scoredWithFvg.length)
      ? (scoredWithFvg.find(z => (z.score ?? 0) >= ZONE_MIN_SCORE) || null)
      : null;
    const zoneMid = bestZone ? ((bestZone.low + bestZone.high)/2) : null;
    const pad = Number.isFinite(atrRef) ? atrRef * 0.15 : ((lastPrice ?? 0) * 0.0005);
    const inZone = (bestZone && lastPrice != null)
      ? (lastPrice >= (bestZone.low - pad) && lastPrice <= (bestZone.high + pad))
      : false;
    const dirMap = final_signal.includes('BUY') ? 'UP' : (final_signal.includes('SELL') ? 'DOWN' : null);
    const confirm = dirMap ? ltfConfirm(dirMap) : false;
    // Confidences
    function clamp01(x){ return Math.max(0, Math.min(1, x)); }
    const dist = (bestZone && lastPrice != null) ? Math.abs(zoneMid - lastPrice) : null;
    const prox = dist == null ? 0 : Math.exp(- (dist*dist) / (2 * Math.pow((atrRef ?? (lastPrice*0.003)) * 0.6, 2)));
    const entry_confidence = bestZone ? clamp01(0.6 * prox + 0.25 * (bestZone.score ?? 0) + 0.15 * (confirm ? 1 : 0)) : 0;
    const signal_confidence = clamp01(Math.abs((tfResults['1h']?.score ?? 0)) / 40);
    const ready = (signal_confidence >= 0.6) && (entry_confidence >= 0.6) && confirm && inZone;

    // ---------- Output (scalp, swing-style concise) ----------
    const output = {
      symbol: symbol || null,
      exchangeSymbol: exchangeSymbol || null,
      timestamp: normalized['15m']?.[normalized['15m'].length-1]?.openTime ?? null,
      last_price: lastPrice,
      tf_used: '15m',
      bias: final_signal.includes('BUY') ? 'BUY' : (final_signal.includes('SELL') ? 'SELL' : 'HOLD'),
      bias_confidence: Number(signal_confidence.toFixed(3)),
      entry_confidence: Number(entry_confidence.toFixed(3)),
      position_size_factor: bestZone ? Number((Math.max(0, Math.min(1, (bestZone.score ?? 0)*0.6 + (confirm?0.2:0) + (prox*0.2)))).toFixed(3)) : null,
      position_size_tier: bestZone ? ((bestZone.score ?? 0) >= 0.7 ? 'large' : ((bestZone.score ?? 0) >= 0.4 ? 'normal' : 'small')) : null,
      primary_zone: bestZone ? {
        range_low: bestZone.low,
        range_high: bestZone.high,
        mid: zoneMid,
        includes_0714: !!bestZone.includes0714,
        includes_extension: !!bestZone.includesExt,
        fvg_overlap: !!bestZone.fvg_overlap,
        score: Number((bestZone.score ?? 0).toFixed(3)),
        action: final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : null),
        ltf_ready: !!confirm
      } : null,
      alt_zones: (bestZone && Array.isArray(scoredWithFvg))
        ? scoredWithFvg.filter(z => z !== bestZone && (z.score ?? 0) >= 0.55).slice(0,2).map(z => ({
            range_low: z.low, range_high: z.high, mid: (z.low+z.high)/2,
            includes_0714: !!z.includes0714, includes_extension: !!z.includesExt,
            fvg_overlap: !!z.fvg_overlap, score: Number((z.score ?? 0).toFixed(3))
          }))
        : [],
      order_plan: bestZone && bands && bands.level1 ? {
        side: final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : 'FLAT'),
        entry_range: { low: suggestions.level1.entry_range.low, high: suggestions.level1.entry_range.high },
        entry: suggestions.level1.entry,
        stop: suggestions.level1.stop_loss,
        tp1: suggestions.level1.take_profit_1,
        tp2: suggestions.level1.take_profit_2,
        atr_used: suggestions.level1.atr_used,
        ready
      } : {
        side: final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : 'FLAT'),
        entry_range: { low: null, high: null },
        entry: null, stop: null, tp1: null, tp2: null,
        atr_used: tfResults['15m']?.indicators?.atr14 ?? null,
        ready: false
      },
      flip_zone: bestZone ? {
        price: zoneMid,
        description: bestZone.includes0714 ? 'includes 0.714 confluence' : (bestZone.includesExt ? 'includes extension confluence' : 'confluence zone'),
        action: final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : null),
        direction_after: final_signal.includes('BUY') ? 'BUY' : (final_signal.includes('SELL') ? 'SELL' : null),
        confidence: Number((bestZone.score ?? 0).toFixed(3))
      } : { price: null, description: null, action: null, direction_after: null, confidence: 0 },
      structure: {
        bos: bos15 ? { dir: bos15.dir, broken_level: null, impulse_low: bos15.low, impulse_high: bos15.high } : null,
        swing_support: (() => { const e = lastPrice; if (!e) return null; const lows = swings15?.swingLows || []; const arr = lows.filter(x=>x.price < e).map(x=>x.price); return arr.length? Math.max(...arr): null; })(),
        swing_resistance: (() => { const e = lastPrice; if (!e) return null; const highs = swings15?.swingHighs || []; const arr = highs.filter(x=>x.price > e).map(x=>x.price); return arr.length? Math.min(...arr): null; })()
      }
    };

    console.log('[indicators] output ready');
    return res.status(200).json(output);

  } catch (err) {
    console.error('[indicators] error', err && err.stack ? err.stack : err);
    // return a safe error response but keep schema as nulls to avoid breaking downstream
    return res.status(500).json({ error: String(err), symbol: null, exchangeSymbol: null, final_signal: 'HOLD', suggestions: {}, votesSummary: {}, details: {} });
  }
}

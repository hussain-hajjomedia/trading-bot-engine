// api/indicators-test.js
// Minimal swing engine: 4h structure + BOS, Fib, ATR, trend/regime

const COOLDOWN_STATE = new Map();

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, kline_15m, kline_1h, kline_4h, tickSize, priceTickSize } = payload;

    // ---------- Input parsing (reuse-friendly) ----------
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
        };
      } else if (typeof row === 'object') {
        return {
          openTime: safe(row.openTime ?? row.t ?? row.time ?? row.timestamp ?? null),
          open: safe(row.open ?? row.o ?? row.price ?? null),
          high: safe(row.high ?? row.h ?? null),
          low: safe(row.low ?? row.l ?? null),
          close: safe(row.close ?? row.c ?? null),
          volume: safe(row.volume ?? row.v ?? null),
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

    function takeLast(arr, n = 500) {
      if (!Array.isArray(arr)) return [];
      if (arr.length <= n) return arr;
      return arr.slice(arr.length - n);
    }

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
      // keep in-progress candles – we want latest price
      return out;
    }

    const normalized = {
      '15m': takeLast(finalizeCandles(normalizeCandlesRaw(kline_15m)), 500),
      '1h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_1h)), 500),
      '4h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_4h)), 500),
    };

    function getCurrentPrice() {
      const candles15m = normalized['15m'] || [];
      if (candles15m.length > 0) {
        const last = candles15m[candles15m.length - 1];
        if (last && last.close != null && Number.isFinite(last.close)) return last.close;
      }
      const candles4h = normalized['4h'] || [];
      if (candles4h.length > 0) {
        const last = candles4h[candles4h.length - 1];
        if (last && last.close != null && Number.isFinite(last.close)) return last.close;
      }
      return null;
    }

    const currentPrice = getCurrentPrice();
    if (!Number.isFinite(currentPrice)) {
      return res.status(200).json({
        final_signal: 'HOLD',
        last_price: null,
        entry: null,
        entry_range: { low: null, high: null },
        confidence_pretty: '0.000 (low)',
        stop_loss: null,
        take_profit_1: null,
        take_profit_2: null,
      });
    }

    // ---------- Core indicator helpers ----------
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
        if (i < period) { sum += tr[i]; if (i === period - 1) out[i] = sum / period; continue; }
        out[i] = ((out[i - 1] * (period - 1)) + tr[i]) / period;
      }
      return out;
    }

    // ---------- 4h swing structure & BOS ----------
    function findSwingPoints(candles, lookback = 3, minSeparationMultiplier = 2.0) {
      if (!candles || candles.length < lookback * 2 + 1) {
        return { swingHighs: [], swingLows: [] };
      }
      const highs = candles.map(c => toNum(c.high));
      const lows  = candles.map(c => toNum(c.low));
      const closes = candles.map(c => toNum(c.close));

      // simple ATR for separation
      let atrVal = null;
      if (closes.length >= 14) {
        const atrArr = atr(highs, lows, closes, 14);
        atrVal = atrArr[atrArr.length - 1];
      }
      if (atrVal == null && closes.length > 0) {
        const lastClose = closes[closes.length - 1];
        atrVal = lastClose != null ? lastClose * 0.003 : null;
      }
      const swingHighs = [], swingLows = [];
      const minSep = (atrVal != null && Number.isFinite(atrVal)) ? atrVal * minSeparationMultiplier : null;

      for (let i = lookback; i < highs.length - lookback; i++) {
        const h = highs[i], l = lows[i];
        if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
        let isHigh = true, isLow = true;
        for (let j = 1; j <= lookback; j++) {
          const ph = highs[i - j], nh = highs[i + j];
          const pl = lows[i - j], nl = lows[i + j];
          if (!Number.isFinite(ph) || !Number.isFinite(nh) || !(h > ph && h > nh)) isHigh = false;
          if (!Number.isFinite(pl) || !Number.isFinite(nl) || !(l < pl && l < nl)) isLow = false;
        }
        if (isHigh) {
          if (minSep != null && swingHighs.length) {
            const last = swingHighs[swingHighs.length - 1];
            const sep = Math.abs(h - last.price);
            if (sep < minSep) {
              if (h > last.price) swingHighs[swingHighs.length - 1] = { index: i, price: h };
              continue;
            }
          }
          swingHighs.push({ index: i, price: h });
        }
        if (isLow) {
          if (minSep != null && swingLows.length) {
            const last = swingLows[swingLows.length - 1];
            const sep = Math.abs(l - last.price);
            if (sep < minSep) {
              if (l < last.price) swingLows[swingLows.length - 1] = { index: i, price: l };
              continue;
            }
          }
          swingLows.push({ index: i, price: l });
        }
      }
      return { swingHighs, swingLows };
    }

    function nearestSwingBelow(price, swings) {
      if (!swings || !swings.length) return null;
      const below = swings.filter(s => s.price < price).map(s => s.price);
      if (!below.length) return null;
      return Math.max(...below);
    }

    function nearestSwingAbove(price, swings) {
      if (!swings || !swings.length) return null;
      const above = swings.filter(s => s.price > price).map(s => s.price);
      if (!above.length) return null;
      return Math.min(...above);
    }

    function inferMarketStructure(sw) {
      if (!sw || !Array.isArray(sw.swingHighs) || !Array.isArray(sw.swingLows)) return 'neutral';
      if (sw.swingHighs.length < 2 || sw.swingLows.length < 2) return 'neutral';
      const hLen = sw.swingHighs.length;
      const lLen = sw.swingLows.length;
      const lastHigh = sw.swingHighs[hLen - 1].price;
      const prevHigh = sw.swingHighs[hLen - 2].price;
      const lastLow  = sw.swingLows[lLen - 1].price;
      const prevLow  = sw.swingLows[lLen - 2].price;
      if (![lastHigh, prevHigh, lastLow, prevLow].every(v => Number.isFinite(v))) return 'neutral';
      const higherHigh  = lastHigh > prevHigh;
      const higherLow   = lastLow  > prevLow;
      const lowerHigh   = lastHigh < prevHigh;
      const lowerLow    = lastLow  < prevLow;
      if (higherHigh && higherLow) return 'bullish';
      if (lowerHigh && lowerLow)   return 'bearish';
      return 'range';
    }

    function detectBos4h(candles, swings) {
      if (!candles || !candles.length || !swings) return null;
      const closes = candles.map(c => toNum(c.close));
      const highs  = candles.map(c => toNum(c.high));
      const lows   = candles.map(c => toNum(c.low));
      const vols   = candles.map(c => toNum(c.volume));
      if (closes.length < 10) return null;

      const sh = (swings.swingHighs || []).map(x => x.index).sort((a, b) => a - b);
      const sl = (swings.swingLows || []).map(x => x.index).sort((a, b) => a - b);
      if (!sh.length || !sl.length) return null;

      const lastHighIdx = sh[sh.length - 1];
      const lastLowIdx  = sl[sl.length - 1];
      const lastHighVal = toNum(candles[lastHighIdx]?.high);
      const lastLowVal  = toNum(candles[lastLowIdx]?.low);
      if (!Number.isFinite(lastHighVal) || !Number.isFinite(lastLowVal)) return null;

      const i = closes.length - 1;
      const lastClose = closes[i];
      if (!Number.isFinite(lastClose)) return null;

      let dir = null;
      let brokenLevel = null;
      if (lastClose > lastHighVal) {
        dir = 'UP';
        brokenLevel = lastHighVal;
      } else if (lastClose < lastLowVal) {
        dir = 'DOWN';
        brokenLevel = lastLowVal;
      }
      if (!dir) return null;

      // Require some persistence and basic volume confirmation
      const minHold = 2;
      let holds = 0;
      for (let k = i - minHold + 1; k <= i; k++) {
        if (k < 0) continue;
        if (dir === 'UP' && closes[k] > brokenLevel) holds++;
        if (dir === 'DOWN' && closes[k] < brokenLevel) holds++;
      }
      if (holds < minHold) return null;

      const win = Math.min(20, closes.length);
      const recentVol = vols.slice(-win).filter(Number.isFinite);
      if (!recentVol.length) return { dir, brokenLevel };
      const avg = recentVol.reduce((a, b) => a + b, 0) / recentVol.length;
      const lastVol = vols[i];
      if (!Number.isFinite(lastVol) || lastVol < avg * 0.9) return null;

      return { dir, brokenLevel };
    }

    function dominantImpulse(sw) {
      if (!sw || !Array.isArray(sw.swingHighs) || !Array.isArray(sw.swingLows)) return null;
      const highs = sw.swingHighs.slice();
      const lows  = sw.swingLows.slice();
      if (!highs.length || !lows.length) return null;
      const pivots = [
        ...highs.map(h => ({ type: 'H', index: h.index, price: h.price })),
        ...lows.map(l => ({ type: 'L', index: l.index, price: l.price })),
      ].sort((a, b) => a.index - b.index);
      const legs = [];
      for (let i = 1; i < pivots.length; i++) {
        const a = pivots[i - 1], b = pivots[i];
        if (a.type === b.type) continue;
        if (a.type === 'L' && b.type === 'H') {
          legs.push({ dir: 'UP', low: a.price, high: b.price });
        } else if (a.type === 'H' && b.type === 'L') {
          legs.push({ dir: 'DOWN', high: a.price, low: b.price });
        }
      }
      if (!legs.length) return null;
      return legs[legs.length - 1]; // last leg as dominant
    }

    function computeFibForImpulse(imp) {
      if (!imp || imp.low == null || imp.high == null) return null;
      const high = imp.high, low = imp.low;
      const leg = Math.abs(high - low);
      if (!isFinite(leg) || leg === 0) return null;
      if (imp.dir === 'UP') {
        const retr618 = low + 0.618 * (high - low);
        const retr65  = low + 0.65  * (high - low);
        const ext1272 = low + 1.272 * (high - low);
        const ext1618 = low + 1.618 * (high - low);
        return { dir: 'UP', low, high, retr618, retr65, ext1272, ext1618 };
      } else {
        const retr618 = high - 0.618 * (high - low);
        const retr65  = high - 0.65  * (high - low);
        const ext1272 = high - 1.272 * (high - low);
        const ext1618 = high - 1.618 * (high - low);
        return { dir: 'DOWN', low, high, retr618, retr65, ext1272, ext1618 };
      }
    }

    // ---------- 4h series and ATR ----------
    const candles4h = normalized['4h'] || [];
    if (candles4h.length < 20) {
      return res.status(200).json({
        final_signal: 'HOLD',
        last_price: currentPrice,
        entry: null,
        entry_range: { low: null, high: null },
        confidence_pretty: '0.000 (low)',
        stop_loss: null,
        take_profit_1: null,
        take_profit_2: null,
      });
    }

    const closes4h = candles4h.map(c => toNum(c.close));
    const highs4h  = candles4h.map(c => toNum(c.high));
    const lows4h   = candles4h.map(c => toNum(c.low));
    const atr4hArr = atr(highs4h, lows4h, closes4h, 14);
    let atrRef = atr4hArr[atr4hArr.length - 1];
    if (atrRef == null || !Number.isFinite(atrRef)) atrRef = currentPrice * 0.003;

    // Simple ATR percentile for regime (low/medium/high vol)
    let atrBucket = 'medium';
    const sampleAtr = atr4hArr.slice(-120).filter(Number.isFinite);
    if (sampleAtr.length >= 20 && Number.isFinite(atrRef)) {
      const sorted = [...sampleAtr].sort((a, b) => a - b);
      const idx = sorted.findIndex(v => v >= atrRef);
      const pct = idx < 0 ? 1 : (idx / Math.max(1, sorted.length - 1));
      if (pct <= 0.33) atrBucket = 'low';
      else if (pct <= 0.66) atrBucket = 'medium';
      else atrBucket = 'high';
    }

    // 4h EMA21 for trend
    const ema21_4h = ema(closes4h, 21);
    const lastIdx4h = closes4h.length - 1;
    const ema21Last = ema21_4h[lastIdx4h];
    const ema21Prev = ema21_4h[Math.max(0, lastIdx4h - 10)];

    const swings4h = findSwingPoints(candles4h, 6, 2.0);
    const marketStructure = inferMarketStructure(swings4h);
    const bos4h = detectBos4h(candles4h, swings4h);
    const impulse = dominantImpulse(swings4h);
    const fib = computeFibForImpulse(impulse);

    // ---------- Final signal (direction) ----------
    let final_signal = 'HOLD';
    const price4h = closes4h[lastIdx4h];
    const trendUp = Number.isFinite(ema21Last) && Number.isFinite(ema21Prev) && ema21Last > ema21Prev && price4h > ema21Last;
    const trendDown = Number.isFinite(ema21Last) && Number.isFinite(ema21Prev) && ema21Last < ema21Prev && price4h < ema21Last;

    if (bos4h && bos4h.dir === 'UP' && trendUp && marketStructure === 'bullish') {
      final_signal = 'STRONG BUY';
    } else if (bos4h && bos4h.dir === 'DOWN' && trendDown && marketStructure === 'bearish') {
      final_signal = 'STRONG SELL';
    } else if (trendUp) {
      final_signal = 'BUY';
    } else if (trendDown) {
      final_signal = 'SELL';
    } else {
      final_signal = 'HOLD';
    }

    // ---------- Entry zone (close price & range) ----------
    let entryLow = null;
    let entryHigh = null;
    if (fib && final_signal !== 'HOLD') {
      const baseLow = Math.min(fib.retr618, fib.retr65);
      const baseHigh = Math.max(fib.retr618, fib.retr65);
      // Pad based on ATR bucket
      let padMul;
      if (atrBucket === 'low') padMul = 0.20;
      else if (atrBucket === 'medium') padMul = 0.25;
      else padMul = 0.35;
      const pad = atrRef * padMul;
      entryLow = baseLow - pad;
      entryHigh = baseHigh + pad;
    }

    // If no fib, use simple ATR band around current price
    if (entryLow == null || entryHigh == null) {
      const pad = atrRef * 0.25;
      entryLow = currentPrice - pad;
      entryHigh = currentPrice + pad;
    }

    const entry = (entryLow + entryHigh) / 2;

    // ---------- Structure-based SL and TP ----------
    const lowsPool = swings4h.swingLows || [];
    const highsPool = swings4h.swingHighs || [];
    const dirUp = final_signal.includes('BUY');
    const dirDown = final_signal.includes('SELL');

    let stop_loss = null;
    let tp1 = null;
    let tp2 = null;

    if (dirUp) {
      // SL: below impulse low and below nearest swing low, at least 1.5x ATR
      const impLow = impulse && Number.isFinite(impulse.low) ? impulse.low : null;
      const nearestLow = nearestSwingBelow(entry, lowsPool);
      let slCandidates = [];
      if (impLow != null) slCandidates.push(impLow - atrRef * 0.2);
      if (nearestLow != null) slCandidates.push(nearestLow - atrRef * 0.2);
      slCandidates.push(entry - atrRef * 1.5);
      stop_loss = Math.min(...slCandidates.filter(Number.isFinite));

      // TP1: nearest swing high above entry, else fib ext 1.272, else 1.5x ATR
      const swingHighAbove = nearestSwingAbove(entry, highsPool);
      if (swingHighAbove != null) {
        tp1 = swingHighAbove;
      } else if (fib && Number.isFinite(fib.ext1272)) {
        tp1 = fib.ext1272;
      } else {
        tp1 = entry + atrRef * 1.5;
      }

      // TP2: next swing high beyond TP1, else fib 1.618, else 2x ATR
      const allHighsAbove = highsPool.filter(s => s.price > entry).map(s => s.price).sort((a, b) => a - b);
      if (allHighsAbove.length > 1 && tp1 != null) {
        const second = allHighsAbove.find(h => h > tp1);
        if (second != null) tp2 = second;
      }
      if (tp2 == null && fib && Number.isFinite(fib.ext1618) && fib.ext1618 > tp1) {
        tp2 = fib.ext1618;
      }
      if (tp2 == null) {
        tp2 = entry + atrRef * 2.0;
      }
    } else if (dirDown) {
      // SL: above impulse high and above nearest swing high, at least 1.5x ATR
      const impHigh = impulse && Number.isFinite(impulse.high) ? impulse.high : null;
      const nearestHigh = nearestSwingAbove(entry, highsPool);
      let slCandidates = [];
      if (impHigh != null) slCandidates.push(impHigh + atrRef * 0.2);
      if (nearestHigh != null) slCandidates.push(nearestHigh + atrRef * 0.2);
      slCandidates.push(entry + atrRef * 1.5);
      stop_loss = Math.max(...slCandidates.filter(Number.isFinite));

      // TP1: nearest swing low below entry, else fib ext 1.272, else 1.5x ATR
      const swingLowBelow = nearestSwingBelow(entry, lowsPool);
      if (swingLowBelow != null) {
        tp1 = swingLowBelow;
      } else if (fib && Number.isFinite(fib.ext1272)) {
        tp1 = fib.ext1272;
      } else {
        tp1 = entry - atrRef * 1.5;
      }

      // TP2: next swing low beyond TP1, else fib 1.618, else 2x ATR
      const allLowsBelow = lowsPool.filter(s => s.price < entry).map(s => s.price).sort((a, b) => b - a);
      if (allLowsBelow.length > 1 && tp1 != null) {
        const second = allLowsBelow.find(l => l < tp1);
        if (second != null) tp2 = second;
      }
      if (tp2 == null && fib && Number.isFinite(fib.ext1618) && fib.ext1618 < tp1) {
        tp2 = fib.ext1618;
      }
      if (tp2 == null) {
        tp2 = entry - atrRef * 2.0;
      }
    }

    // Fallbacks if HOLD or something missing
    if (final_signal === 'HOLD') {
      stop_loss = null;
      tp1 = null;
      tp2 = null;
    }

    // ---------- Confidence score ----------
    function clamp01(x) { return Math.max(0, Math.min(1, x)); }

    let conf = 0.5;
    // Trend alignment
    if (final_signal === 'STRONG BUY' || final_signal === 'STRONG SELL') conf += 0.2;
    else if (final_signal === 'BUY' || final_signal === 'SELL') conf += 0.1;
    // Market structure
    if ((marketStructure === 'bullish' && dirUp) || (marketStructure === 'bearish' && dirDown)) conf += 0.15;
    else if ((marketStructure === 'bullish' && dirDown) || (marketStructure === 'bearish' && dirUp)) conf -= 0.2;
    // BOS agreement
    if (bos4h && bos4h.dir === 'UP' && dirUp) conf += 0.15;
    if (bos4h && bos4h.dir === 'DOWN' && dirDown) conf += 0.15;
    // ATR regime
    if (atrBucket === 'low') conf -= 0.05; // quieter regime, slower follow-through
    if (atrBucket === 'high') conf -= 0.05; // more noise and whipsaws
    conf = clamp01(conf);

    function confidenceLabel(x) {
      const v = Number(x);
      if (!Number.isFinite(v)) return 'low';
      if (v >= 0.70) return 'high';
      if (v >= 0.40) return 'medium';
      return 'low';
    }
    const label = confidenceLabel(conf);
    const confidence_pretty = `${conf.toFixed(3)} (${label})`;

    // ---------- Quantization ----------
    function inferTickSize(tfName) {
      const arr = normalized[tfName] || [];
      const vals = [];
      const push = (v) => { const n = Number(v); if (Number.isFinite(n)) vals.push(n); };
      for (let i = Math.max(0, arr.length - 200); i < arr.length; i++) {
        const c = arr[i];
        push(c.close); push(c.open); push(c.high); push(c.low);
      }
      if (vals.length < 2) return 0.01;
      vals.sort((a, b) => a - b);
      let minStep = Infinity;
      for (let i = 1; i < vals.length; i++) {
        const d = Math.abs(vals[i] - vals[i - 1]);
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
    const tick = providedTick ?? inferTickSize('4h');

    const roundToTick = (p) => (p == null ? null : Math.round(p / tick) * tick);

    const qEntry = roundToTick(entry);
    const qLow  = roundToTick(entryLow);
    const qHigh = roundToTick(entryHigh);
    const qSL   = roundToTick(stop_loss);
    const qTP1  = roundToTick(tp1);
    const qTP2  = roundToTick(tp2);

    // ---------- Cooldown (per symbol, simple) ----------
    if (symbol && (final_signal === 'BUY' || final_signal === 'STRONG BUY' || final_signal === 'SELL' || final_signal === 'STRONG SELL')) {
      const key = `${symbol}|${final_signal.includes('BUY') ? 'BUY' : 'SELL'}`;
      const state = COOLDOWN_STATE.get(key);
      const now = Date.now();
      const minMs = 6 * 60 * 60 * 1000; // 6 hours between same-direction swings
      if (state && (now - state.ts) < minMs) {
        // Cooldown: downgrade to HOLD
        final_signal = 'HOLD';
      } else {
        COOLDOWN_STATE.set(key, { ts: now });
      }
    }

    // ---------- Final minimal output ----------
    const output = {
      final_signal,
      last_price: currentPrice,
      entry: qEntry,
      entry_range: { low: qLow, high: qHigh },
      confidence_pretty,
      stop_loss: qSL,
      take_profit_1: qTP1,
      take_profit_2: qTP2,
      market_structure: marketStructure, // 'bullish' | 'bearish' | 'range' | 'neutral' (4h swing view)
    };

    return res.status(200).json(output);
  } catch (err) {
    console.error('[indicators-test] error', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'internal error', detail: String(err && (err.stack || err.message || err)) });
  }
};



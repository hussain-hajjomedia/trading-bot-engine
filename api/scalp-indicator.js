// api/indicators.js — SCALP + CONDITIONAL FIBONACCI PULLBACK (15m + 1h aware)
// Output format unchanged. Always returns SL/TP for level1/2/3.

// --------- Lightweight in-memory store (cooldown; best-effort in serverless) ---------
const COOLDOWN_STATE = new Map();
// --------- Walk-forward calibration cache (per symbol/session) ---------
const WF_CACHE = new Map(); // key: symbol|session -> { params, selectedAt, expiresAt, lastAppliedAt }

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
    const payload = req.body || {};
    let { symbol, exchangeSymbol, kline_15m, kline_1h, kline_4h, kline_1d, tickSize, priceTickSize, stepSize, strictNulls } = payload;
    strictNulls = (strictNulls === false) ? false : true;
    const clientLastReadyIndex = Number.isFinite(Number(payload?.lastReadyIndex)) ? Number(payload.lastReadyIndex) : null;
    const clientLastReadyTime  = Number.isFinite(Number(payload?.lastReadyTime))  ? Number(payload.lastReadyTime)  : null;

    // -------- Feature Flags (Phase 0 scaffolding: all default off) --------
    const inputFlags = (payload && typeof payload.flags === 'object') ? payload.flags : {};
    const flags = {
      instrumentation: !!inputFlags.instrumentation,
      ltf_stability:   !!inputFlags.ltf_stability,
      // Reserved for later phases; keep defined (all off) to avoid undefined checks later
      adaptive_proximity: !!inputFlags.adaptive_proximity,
      regime_filter:      !!inputFlags.regime_filter,
      zone_quality:       !!inputFlags.zone_quality,
      tp_sl_refine:       !!inputFlags.tp_sl_refine,
      cooldown:           !!inputFlags.cooldown,
      wf_calibrate:       !!inputFlags.wf_calibrate,
      of_nudge:           !!inputFlags.of_nudge,
    };

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

    // -------- Helpers for session and calibration --------
    function sessionFromTs(tsMs) {
      const h = new Date(Number(tsMs)).getUTCHours();
      if (h >= 0 && h < 8) return 'ASIA';
      if (h >= 8 && h < 13) return 'EU';
      if (h >= 13 && h < 21) return 'US';
      return 'ASIA_LATE';
    }
    const PADS = [0.25, 0.32]; // keep grid small per request
    const NEAR_FACTORS = [0.50]; // keep constant here; session multiplier varies
    const TRIGS = [0.30, 0.40]; // small grid
    const SESSION_MULTS = [0.95, 1.00, 1.05]; // per-session multiplier
    function generateCombos() {
      const out = [];
      for (const p of PADS) for (const n of NEAR_FACTORS) for (const t of TRIGS) for (const m of SESSION_MULTS) {
        out.push({ padAtr: p, nearHalf: n, trigAtr: t, sessionMult: m });
      }
      return out; // 12 combos
    }
    function getWfCacheKey(sym, sess) { return `${sym||'NA'}|${sess||'NA'}`; }
    function maybeSelectCalibratedParams(sym, sess, arr15) {
      try {
        const key = getWfCacheKey(sym, sess);
        const now = Date.now();
        const cached = WF_CACHE.get(key);
        const enoughBars = Array.isArray(arr15) && arr15.length >= 300;
        const needRefresh = !cached || (cached.expiresAt != null && now >= cached.expiresAt);
        const allowCompute = needRefresh && enoughBars && (now - (cached?.selectedAt || 0) >= 60*60*1000);
        if (!flags.wf_calibrate || !allowCompute) return cached?.params || null;
        // Lightweight replay proxy (sampled): compare proximity-triggered readiness and simple outcomes
        const combos = generateCombos();
        const start = Math.max(0, arr15.length - 864);
        const closes = arr15.map(c=>toNum(c.close));
        const highs  = arr15.map(c=>toNum(c.high));
        const lows   = arr15.map(c=>toNum(c.low));
        const atr14A  = atr(highs, lows, closes, 14);
        function lateEntry(price, entry, atrv) { if (!Number.isFinite(price)||!Number.isFinite(entry)||!Number.isFinite(atrv)||atrv<=0) return false; return Math.abs(price-entry) > (0.25*atrv); }
        let best = null;
        for (const combo of combos) {
          let readyCount=0, tp1Count=0, tp2Count=0, slCount=0, lateCount=0;
          for (let i = start; i < arr15.length-1; i+=3) {
            const price = closes[i];
            const a = atr14A[i];
            if (!Number.isFinite(price) || !Number.isFinite(a) || a <= 0) continue;
            const padAbs = a * combo.padAtr * combo.sessionMult;
            const nearHalf = combo.nearHalf;
            const trigAbs = a * combo.trigAtr * combo.sessionMult;
            const lo = price - padAbs, hi = price + padAbs;
            const nearLo = lo - padAbs*nearHalf, nearHi = hi + padAbs*nearHalf;
            const nxt = closes[i+1];
            if (!Number.isFinite(nxt)) continue;
            const pullReady = nxt >= nearLo && nxt <= nearHi;
            const brkReady = Math.abs(nxt - price) >= trigAbs;
            const isReady = pullReady || brkReady;
            if (isReady) {
              readyCount++;
              const dirUp = nxt > price;
              const tp1Target = dirUp ? (nxt + a*0.8) : (nxt - a*0.8);
              const tp2Target = dirUp ? (nxt + a*1.6) : (nxt - a*1.6);
              const slLevel   = dirUp ? (nxt - a*0.8) : (nxt + a*0.8);
              const fwdEnd = Math.min(arr15.length-1, i+10);
              let hitTp2=false, hitTp1=false, hitSl=false;
              for (let k=i+1;k<=fwdEnd;k++){
                const h = highs[k], l = lows[k];
                if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
                if (dirUp) {
                  if (!hitTp2 && h >= tp2Target) { hitTp2=true; break; }
                  if (!hitTp1 && h >= tp1Target) { hitTp1=true; }
                  if (!hitSl && l <= slLevel) { hitSl=true; break; }
                } else {
                  if (!hitTp2 && l <= tp2Target) { hitTp2=true; break; }
                  if (!hitTp1 && l <= tp1Target) { hitTp1=true; }
                  if (!hitSl && h >= slLevel) { hitSl=true; break; }
                }
              }
              if (hitTp2) tp2Count++; else if (hitTp1) tp1Count++; else if (hitSl) slCount++;
              if (lateEntry(nxt, dirUp ? lo : hi, a)) lateCount++;
            }
          }
          const total = Math.max(1, readyCount);
          const hitRate = readyCount / Math.max(1, Math.floor((arr15.length - start)/3));
          const tp1Rate = tp1Count / total;
          const tp2Rate = tp2Count / total;
          const exp = (tp2Count*1.0 + tp1Count*0.6 - slCount*1.0) / total;
          const lateRate = lateCount / total;
          const candidate = { combo, metrics: { hitRate, tp1Rate, tp2Rate, exp, lateRate } };
          if (!best ||
              candidate.metrics.exp > best.metrics.exp ||
              (candidate.metrics.exp === best.metrics.exp && (candidate.metrics.lateRate < best.metrics.lateRate ||
                                                              (candidate.metrics.lateRate === best.metrics.lateRate && candidate.metrics.tp1Rate > best.metrics.tp1Rate)))) {
            best = candidate;
          }
        }
        if (best) {
          const params = { ...best.combo, selectedAt: now, metrics: best.metrics };
          WF_CACHE.set(key, { params, selectedAt: now, expiresAt: now + 4*60*60*1000, lastAppliedAt: 0 });
          if (flags.instrumentation) console.log('[indicators][wf_calibrate] selected', { symbol, session: sess, params, metrics: best.metrics });
          return params;
        }
        return cached?.params || null;
      } catch (e) {
        if (flags.instrumentation) console.log('[indicators][wf_calibrate] error', String(e));
        return null;
      }
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
    const lastClose15 = (() => {
      const tfLast = tfResults['15m']?.last?.close;
      if (Number.isFinite(tfLast)) return tfLast;
      const arr = normalized['15m'];
      const c = Array.isArray(arr) && arr.length ? Number(arr[arr.length - 1]?.close) : null;
      return Number.isFinite(c) ? c : null;
    })();
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
      const impulseMatchesTrade = !!(impulse && ((dir === 'UP' && impulse.dir === 'UP') || (dir === 'DOWN' && impulse.dir === 'DOWN')));

      if (dir === 'UP') {
        const candidates = [];
        if (Number.isFinite(retr786)) candidates.push(retr786 - a * 0.05);
        if (Number.isFinite(nearestLow)) candidates.push(nearestLow - a * 0.05);
        candidates.push(e - a * m);
        sl = Math.min(...candidates.filter(Number.isFinite));
        if (impulseMatchesTrade) {
          tp1 = Number.isFinite(ext1272) ? ext1272 : (e + a * m * 1.0);
          tp2 = Number.isFinite(ext1618) ? ext1618 : (e + a * m * 2.0);
        } else {
          tp1 = e + a * m * 1.0;
          tp2 = e + a * m * 2.0;
        }
      } else if (dir === 'DOWN') {
        const candidates = [];
        if (Number.isFinite(retr786)) candidates.push(retr786 + a * 0.05);
        if (Number.isFinite(nearestHigh)) candidates.push(nearestHigh + a * 0.05);
        candidates.push(e + a * m);
        sl = Math.max(...candidates.filter(Number.isFinite));
        if (impulseMatchesTrade) {
          tp1 = Number.isFinite(ext1272) ? ext1272 : (e - a * m * 1.0);
          tp2 = Number.isFinite(ext1618) ? ext1618 : (e - a * m * 2.0);
        } else {
          tp1 = e - a * m * 1.0;
          tp2 = e - a * m * 2.0;
        }
      } else {
        sl  = e - a * m;
        tp1 = e + a * m * 0.8;
        tp2 = e + a * m * 1.6;
      }

      // -------- Phase 5: TP/SL refine by regime (behind flag) --------
      if (flags.tp_sl_refine && regimeContext && regimeContext.score != null) {
        if (regimeContext.regime === 'trend') {
          // extend TP2 slightly
          tp2 = Number.isFinite(tp2) ? (tp2 + a * 0.2 * (dir === 'UP' ? 1 : -1)) : tp2;
        } else if (regimeContext.regime === 'chop') {
          // reduce TP2; tighten SL a touch
          tp2 = Number.isFinite(tp2) ? (tp2 - a * 0.2 * (dir === 'UP' ? 1 : -1)) : tp2;
          if (dir === 'UP') sl = Number.isFinite(sl) ? Math.min(sl + a * 0.05, e) : sl;
          else if (dir === 'DOWN') sl = Number.isFinite(sl) ? Math.max(sl - a * 0.05, e) : sl;
        }
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
      if (!Number.isFinite(ema9) || !Number.isFinite(ema21)) return false;
      if (dir === 'UP') return (ema9 > ema21);
      if (dir === 'DOWN') return (ema9 < ema21);
      return false;
    }
    // Build a primary zone
    const lastPrice = (() => {
      if (Number.isFinite(lastClose15)) return lastClose15;
      const tfLast = tfResults['15m']?.last?.close;
      return Number.isFinite(tfLast) ? tfLast : null;
    })();
    const ZONE_MIN_SCORE = 0.55;
    let bestZone = (Array.isArray(scoredWithFvg) && scoredWithFvg.length)
      ? (scoredWithFvg.find(z => (z.score ?? 0) >= ZONE_MIN_SCORE) || null)
      : null;
    const zoneMid = bestZone ? ((bestZone.low + bestZone.high)/2) : null;
    let pad = Number.isFinite(atrRef) ? atrRef * 0.25 : ((lastPrice ?? 0) * 0.0005);
    const inZone = (bestZone && lastPrice != null)
      ? (lastPrice >= (bestZone.low - pad) && lastPrice <= (bestZone.high + pad))
      : false;
    const dirMap = final_signal.includes('BUY') ? 'UP' : (final_signal.includes('SELL') ? 'DOWN' : null);
    // -------- Phase 1: LTF Micro-Stability (behind flag) --------
    function ltfConfirmStable(direction) {
      try {
        const candles = normalized['15m'] || [];
        if (!candles.length) return false;
        const closes = candles.map(c => toNum(c.close));
        const ema9A = ema(closes, 9);
        const ema21A = ema(closes, 21);
        const macdObj = macd(closes);
        const i = closes.length - 1;
        if (i < 1) return false;
        const lastClose = closes[i];
        const atr14Here = atr(candles.map(c=>c.high), candles.map(c=>c.low), closes, 14)[i] ?? null;
        const isHighVol = (Number.isFinite(atr14Here) && Number.isFinite(lastClose))
          ? ((atr14Here / Math.max(1e-9, Math.abs(lastClose))) >= 0.006)
          : false;
        const lagIdx = isHighVol ? (i - 1) : i;
        if (lagIdx < 0) return false;
        const macdAligned = (() => {
          const m = macdObj.macdLine[lagIdx];
          const s = macdObj.signalLine[lagIdx];
          if (!Number.isFinite(m) || !Number.isFinite(s)) return false;
          if (direction === 'UP') return m > s;
          if (direction === 'DOWN') return m < s;
          return false;
        })();
        const requiredStableBars = macdAligned ? 1 : 2; // boost when MACD agrees
        const start = lagIdx - requiredStableBars + 1;
        if (start < 0) return false;
        for (let k = start; k <= lagIdx; k++) {
          const e9 = ema9A[k], e21 = ema21A[k];
          if (!Number.isFinite(e9) || !Number.isFinite(e21)) return false;
          if (direction === 'UP' && !(e9 > e21)) return false;
          if (direction === 'DOWN' && !(e9 < e21)) return false;
        }
        return true;
      } catch (_e) {
        return false;
      }
    }
    const confirm = dirMap
      ? (flags.ltf_stability ? ltfConfirmStable(dirMap) : ltfConfirm(dirMap))
      : false;
    // -------- Phase 2: Adaptive proximity (ATR percentile + session) --------
    let nearZoneHalfFactor = 0.5;
    let hvpPercentile = null;
    if (flags.adaptive_proximity) {
      const arr15 = normalized['15m'] || [];
      const highs15 = arr15.map(c=>toNum(c.high));
      const lows15  = arr15.map(c=>toNum(c.low));
      const closes15= arr15.map(c=>toNum(c.close));
      const atrSeries = atr(highs15, lows15, closes15, 14).filter(v => Number.isFinite(v));
      if (atrSeries.length >= 20) {
        const sample = atrSeries.slice(-120);
        const lastAtr = sample[sample.length - 1];
        const sorted = [...sample].sort((a,b)=>a-b);
        const idx = sorted.findIndex(v => v >= lastAtr);
        const pct = idx < 0 ? 1 : (idx / Math.max(1, sorted.length - 1));
        hvpPercentile = Math.max(0, Math.min(1, pct));
        const bucket = hvpPercentile <= 0.33 ? 'low' : (hvpPercentile <= 0.66 ? 'medium' : 'high');
        // Base mappings
        const pullPadAtr = bucket === 'low' ? 0.20 : (bucket === 'medium' ? 0.25 : 0.32);
        nearZoneHalfFactor = bucket === 'low' ? 0.40 : (bucket === 'medium' ? 0.50 : 0.65);
        if (Number.isFinite(atrRef)) pad = atrRef * pullPadAtr;
        // Session nuance (UTC buckets)
        const lastTs = arr15?.[arr15.length-1]?.openTime ?? Date.now();
        const hour = new Date(Number(lastTs)).getUTCHours();
        const session = (hour >= 0 && hour < 8) ? 'ASIA' : (hour >= 8 && hour < 13) ? 'EU' : (hour >= 13 && hour < 21) ? 'US' : 'ASIA_LATE';
        const padFactor = session === 'ASIA' ? 0.95 : (session === 'US' ? 1.05 : 1.0);
        const nearFactor = session === 'ASIA' ? 0.95 : (session === 'US' ? 1.05 : 1.0);
        pad *= padFactor;
        nearZoneHalfFactor *= nearFactor;
      }
    }

    // -------- Phase A: Walk-forward calibration overlay for pad/near (with safeguards) --------
    let chosenCalib = null;
    if (flags.wf_calibrate) {
      const sess = sessionFromTs(normalized['15m']?.[normalized['15m'].length-1]?.openTime ?? Date.now());
      chosenCalib = maybeSelectCalibratedParams(symbol, sess, normalized['15m']);
      const key = `${symbol||'NA'}|${sess||'NA'}`;
      const cacheEntry = WF_CACHE.get(key);
      const now = Date.now();
      const canApply = !cacheEntry || (now - (cacheEntry.lastAppliedAt || 0) >= 60*60*1000);
      function applySafeguarded(current, target, minV, maxV) {
        if (!Number.isFinite(current) || !Number.isFinite(target)) return current;
        const delta = target - current;
        const maxStep = Math.abs(current) * 0.10;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
        const v = current + step;
        if (Number.isFinite(minV) && Number.isFinite(maxV)) return Math.max(minV, Math.min(maxV, v));
        return v;
      }
      if (canApply && chosenCalib && Number.isFinite(atrRef) && atrRef > 0) {
        const targetPad = atrRef * Math.max(0.15, Math.min(0.7, (chosenCalib.padAtr * chosenCalib.sessionMult)));
        pad = applySafeguarded(pad, targetPad, atrRef*0.15, atrRef*0.7);
        nearZoneHalfFactor = applySafeguarded(nearZoneHalfFactor, chosenCalib.nearHalf, 0.2, 0.8);
        if (cacheEntry) cacheEntry.lastAppliedAt = now;
      }
    }

    const nearZone = (() => {
      if (!bestZone || lastPrice == null) return false;
      if (inZone) return false;
      const halfPad = pad * nearZoneHalfFactor;
      const lower = bestZone.low - halfPad;
      const upper = bestZone.high + halfPad;
      if (!(lastPrice >= lower && lastPrice <= upper)) return false;
      const mid = (bestZone.low + bestZone.high) / 2;
      const prev = normalized['15m']?.[normalized['15m'].length - 2]?.close ?? null;
      if (!Number.isFinite(prev)) return true;
      const dNow = Math.abs(lastPrice - mid);
      const dPrev = Math.abs(prev - mid);
      return dNow < dPrev;
    })();
    // Pullback validity (time + distance) and breakout fallback
    function lastZoneTouchIdx(candles, zoneLow, zoneHigh, lookbackCandles = 12) {
      if (!Array.isArray(candles) || !Number.isFinite(zoneLow) || !Number.isFinite(zoneHigh)) return null;
      const lo = Math.min(zoneLow, zoneHigh), hi = Math.max(zoneLow, zoneHigh);
      const start = Math.max(0, candles.length - 1 - lookbackCandles);
      for (let i = candles.length - 1; i >= start; i--) {
        const c = candles[i];
        const ch = toNum(c?.high), cl = toNum(c?.low);
        if (Number.isFinite(ch) && Number.isFinite(cl) && !(hi < cl || lo > ch)) return i;
      }
      return null;
    }
    const TOUCH_MAX_CANDLES = 3;  // invalid if last touch older than this on 15m
    const lastTouchIdx = (bestZone && normalized['15m'] && normalized['15m'].length)
      ? lastZoneTouchIdx(normalized['15m'], bestZone.low, bestZone.high, 12)
      : null;
    const lastIdx = (normalized['15m']?.length ?? 0) - 1;
    const touchAgeCandles = (lastTouchIdx != null && lastIdx >= 0) ? (lastIdx - lastTouchIdx) : null;
    function distanceFromZone(price, zLow, zHigh) {
      if (!Number.isFinite(price) || !Number.isFinite(zLow) || !Number.isFinite(zHigh)) return Infinity;
      if (price >= zLow && price <= zHigh) return 0;
      if (price < zLow) return (zLow - price);
      return (price - zHigh);
    }
    const distToZoneAbs = (bestZone && Number.isFinite(lastPrice)) ? distanceFromZone(lastPrice, bestZone.low, bestZone.high) : Infinity;
    const atrHalf = Number.isFinite(atrRef) ? (atrRef * 0.5) : Infinity;
    const pullbackInvalidByTime = (touchAgeCandles != null) ? (touchAgeCandles > TOUCH_MAX_CANDLES) : false;
    const pullbackInvalidByDistance = distToZoneAbs > atrHalf;
    const pullbackValid = !!bestZone && !pullbackInvalidByTime && !pullbackInvalidByDistance;
    // Breakout triggers from impulse extensions (forward-only)
    function impulseExtensions(imp) {
      if (!imp || imp.low == null || imp.high == null) return null;
      const low = imp.low, high = imp.high;
      const leg = Math.abs(high - low);
      if (!Number.isFinite(leg) || leg === 0) return null;
      if (imp.dir === 'UP') {
        return {
          dir: 'UP',
          ext1272: low + 1.272 * leg,
          ext1382: low + 1.382 * leg,
          ext1618: low + 1.618 * leg
        };
      } else {
        return {
          dir: 'DOWN',
          ext1272: high - 1.272 * leg,
          ext1382: high - 1.382 * leg,
          ext1618: high - 1.618 * leg
        };
      }
    }
    const impExt = impulseExtensions(impulse);
    function pickBreakoutTrigger(direction, price, ext) {
      if (!direction || !Number.isFinite(price) || !ext) return null;
      const levelsUp = [ext.ext1272, ext.ext1382, ext.ext1618].filter(Number.isFinite).sort((a,b)=>a-b);
      const levelsDown = [ext.ext1618, ext.ext1382, ext.ext1272].filter(Number.isFinite).sort((a,b)=>b-a);
      if (direction === 'UP') {
        for (const lv of levelsUp) if (lv > price) return lv;
      } else if (direction === 'DOWN') {
        for (const lv of levelsDown) if (lv < price) return lv;
      }
      return null;
    }
    const breakoutTrigger = pickBreakoutTrigger(dirMap, lastPrice ?? -Infinity, impExt);
    let TRIGGER_PROX_ATR = 0.40; // default
    if (flags.adaptive_proximity && hvpPercentile != null) {
      const bucket = hvpPercentile <= 0.33 ? 'low' : (hvpPercentile <= 0.66 ? 'medium' : 'high');
      TRIGGER_PROX_ATR = bucket === 'low' ? 0.30 : (bucket === 'medium' ? 0.40 : 0.55);
      // Session nuance
      const lastTs = normalized['15m']?.[normalized['15m'].length-1]?.openTime ?? Date.now();
      const hour = new Date(Number(lastTs)).getUTCHours();
      const session = (hour >= 0 && hour < 8) ? 'ASIA' : (hour >= 8 && hour < 13) ? 'EU' : (hour >= 13 && hour < 21) ? 'US' : 'ASIA_LATE';
      const trigFactor = session === 'ASIA' ? 0.95 : (session === 'US' ? 1.05 : 1.0);
      TRIGGER_PROX_ATR *= trigFactor;
    }
    // -------- Phase A: Walk-forward calibration overlay for trigger proximity --------
    if (flags.wf_calibrate && chosenCalib) {
      const sess = sessionFromTs(normalized['15m']?.[normalized['15m'].length-1]?.openTime ?? Date.now());
      const key = `${symbol||'NA'}|${sess||'NA'}`;
      const cacheEntry = WF_CACHE.get(key);
      const now = Date.now();
      const canApply = !cacheEntry || (now - (cacheEntry.lastAppliedAt || 0) >= 60*60*1000);
      function applySafeguarded(current, target, minV, maxV) {
        if (!Number.isFinite(current) || !Number.isFinite(target)) return current;
        const delta = target - current;
        const maxStep = Math.abs(current) * 0.10;
        const step = Math.sign(delta) * Math.min(Math.abs(delta), maxStep);
        const v = current + step;
        if (Number.isFinite(minV) && Number.isFinite(maxV)) return Math.max(minV, Math.min(maxV, v));
        return v;
      }
      const targetTrig = Math.max(0.15, Math.min(0.7, (chosenCalib.trigAtr * chosenCalib.sessionMult)));
      if (canApply) {
        TRIGGER_PROX_ATR = applySafeguarded(TRIGGER_PROX_ATR, targetTrig, 0.15, 0.7);
        if (cacheEntry) cacheEntry.lastAppliedAt = now;
      }
    }
    // Global clamp
    TRIGGER_PROX_ATR = Math.max(0.15, Math.min(0.7, TRIGGER_PROX_ATR));
    const nearTrigger = (Number.isFinite(breakoutTrigger) && Number.isFinite(lastPrice) && Number.isFinite(atrRef))
      ? (Math.abs(lastPrice - breakoutTrigger) <= (atrRef * TRIGGER_PROX_ATR))
      : false;
    // -------- Phase 3: Regime filter (score + gentle policy bias) --------
    let regimeContext = { score: null, regime: 'neutral' };
    function computeRegimeScore() {
      try {
        const arr15 = normalized['15m'] || [];
        if (arr15.length < 40) return null;
        const closes = arr15.map(c=>toNum(c.close));
        const price = closes[closes.length-1];
        // slope via EMA21
        const ema21A = ema(closes, 21);
        const i = closes.length - 1;
        const lb = Math.max(0, i - 10);
        const slope = (Number.isFinite(ema21A[i]) && Number.isFinite(ema21A[lb]) && Number.isFinite(price))
          ? ((ema21A[i] - ema21A[lb]) / Math.max(1e-9, price))
          : 0;
        const slopeScore = Math.max(0, Math.min(1, Math.abs(slope) / 0.003));
        // hvp percentile reuse
        const hvp = hvpPercentile != null ? hvpPercentile : 0.5;
        // bb width expansion vs median
        const win = 20;
        let widths = [];
        for (let k = Math.max(0, closes.length - 120); k < closes.length; k++) {
          const s = Math.max(0, k - win + 1);
          const seg = closes.slice(s, k+1).filter(Number.isFinite);
          if (seg.length >= 5) {
            const mean = seg.reduce((a,b)=>a+b,0)/seg.length;
            const variance = seg.reduce((a,b)=>a + Math.pow(b-mean,2),0)/seg.length;
            const std = Math.sqrt(variance);
            widths.push(2*std);
          }
        }
        const curW = widths[widths.length-1] ?? 0;
        const medW = widths.length ? [...widths].sort((a,b)=>a-b)[Math.floor(widths.length/2)] : 0;
        const widthRatio = (Number.isFinite(curW) && Number.isFinite(medW) && medW > 0) ? (curW/medW) : 1;
        const widthScore = Math.max(0, Math.min(1, (widthRatio - 0.8) / 0.6)); // >1 = expansion -> trend
        let score = Math.max(0, Math.min(1, (slopeScore*0.5 + hvp*0.25 + widthScore*0.25)));
        // Refinement: RSI21 slope agreement and chop penalty on expansion
        if (flags.regime_filter) {
          const rsi21 = rsiWilder(closes, 21);
          const rlb = Math.max(0, i - 10);
          const rsiSlope = (Number.isFinite(rsi21[i]) && Number.isFinite(rsi21[rlb])) ? (rsi21[i] - rsi21[rlb]) : 0;
          const rsiAgree = (rsiSlope > 0 && slope > 0) || (rsiSlope < 0 && slope < 0);
          if (rsiAgree && Math.abs(rsiSlope) >= 3) score = Math.min(1, score + 0.1);
          let alternations = 0, dir = null;
          for (let k = Math.max(1, i-6); k <= i; k++) {
            const d = closes[k] - closes[k-1];
            const sgn = d >= 0 ? 1 : -1;
            if (dir != null && sgn !== dir) alternations++;
            dir = sgn;
          }
          if (widthRatio > 1.0 && alternations >= 3) score = Math.max(0, score - 0.1);
        }
        return score;
      } catch {
        return null;
      }
    }
    if (flags.regime_filter || flags.tp_sl_refine) {
      const sc = computeRegimeScore();
      if (sc != null) regimeContext = { score: sc, regime: (sc >= 0.6 ? 'trend' : (sc <= 0.4 ? 'chop' : 'neutral')) };
      // apply gentle parameter biasing
      if (flags.regime_filter && regimeContext.score != null) {
        if (regimeContext.regime === 'trend') {
          pad *= 0.95; // stricter pullback
          TRIGGER_PROX_ATR *= 1.10; // looser breakout
        } else if (regimeContext.regime === 'chop') {
          pad *= 1.08; // wider pullback
          TRIGGER_PROX_ATR *= 0.92; // stricter breakout
        }
      }
    }

    // Confidences
    function clamp01(x){ return Math.max(0, Math.min(1, x)); }
    const dist = (bestZone && lastPrice != null) ? Math.abs(zoneMid - lastPrice) : null;
    const prox = dist == null ? 0 : Math.exp(- (dist*dist) / (2 * Math.pow((atrRef ?? (lastPrice*0.003)) * 0.6, 2)));
    let entry_confidence = bestZone ? clamp01(0.6 * prox + 0.25 * (bestZone.score ?? 0) + 0.15 * (confirm ? 1 : 0)) : 0;
    const macdBoostAligned = (() => {
      const tf = tfResults['15m'];
      if (!tf || !dirMap) return false;
      const macd = tf.indicators?.macd, macdSig = tf.indicators?.macd_signal;
      if (!Number.isFinite(macd) || !Number.isFinite(macdSig)) return false;
      if (dirMap === 'UP') return macd > macdSig;
      if (dirMap === 'DOWN') return macd < macdSig;
      return false;
    })();
    if (macdBoostAligned) entry_confidence = clamp01(entry_confidence + 0.05);
    // -------- Phase B: Orderflow/imbalance nudge (confidence-only) --------
    let of_nudge = 0;
    if (flags.of_nudge) {
      const arr15 = normalized['15m'] || [];
      const L = arr15.length;
      if (L >= 25) {
        const highsA = arr15.map(c=>toNum(c.high));
        const lowsA  = arr15.map(c=>toNum(c.low));
        const closesA= arr15.map(c=>toNum(c.close));
        const volsA  = arr15.map(c=>toNum(c.volume));
        const tr = trueRange(highsA, lowsA, closesA);
        const atr14A = atr(highsA, lowsA, closesA, 14);
        const i = L-1;
        const recentTr = [tr[i], tr[i-1], tr[i-2]].filter(Number.isFinite);
        const meanRecentTr = recentTr.length ? recentTr.reduce((a,b)=>a+b,0)/recentTr.length : null;
        const aHere = atr14A[i];
        const expansionHigh = Number.isFinite(meanRecentTr) && Number.isFinite(aHere) && aHere>0 && (meanRecentTr >= aHere*1.2);
        let clvSum = 0, clvCnt = 0;
        for (let k=i-2;k<=i;k++){
          const h=highsA[k], l=lowsA[k], c=closesA[k];
          if (!Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(c)||h===l) continue;
          clvSum += (c - l)/(h - l);
          clvCnt++;
        }
        const clvMean = clvCnt ? clvSum/clvCnt : null;
        let nearHighCnt=0, nearLowCnt=0;
        for (let k=i-4;k<=i;k++){
          const h=highsA[k], l=lowsA[k], c=closesA[k];
          if (!Number.isFinite(h)||!Number.isFinite(l)||!Number.isFinite(c)||h===l) continue;
          const clv = (c - l)/(h - l);
          if (clv >= 0.66) nearHighCnt++;
          if (clv <= 0.34) nearLowCnt++;
        }
        let sma20 = null;
        if (i >= 19) {
          let s=0; for (let k=i-19;k<=i;k++){ const v=volsA[k]; if (Number.isFinite(v)) s+=v; }
          sma20 = s/20;
        }
        const volThrust = Number.isFinite(volsA[i]) && Number.isFinite(sma20) && sma20>0 && (volsA[i] >= 1.2*sma20);
        const bullSig = expansionHigh && Number.isFinite(clvMean) && clvMean >= 0.6 && nearHighCnt >= 2 && !!volThrust;
        const bearSig = expansionHigh && Number.isFinite(clvMean) && clvMean <= 0.4 && nearLowCnt >= 2 && !!volThrust;
        if ((dirMap === 'UP' && bullSig) || (dirMap === 'DOWN' && bearSig)) of_nudge = 0.03;
        else if ((dirMap === 'UP' && bearSig) || (dirMap === 'DOWN' && bullSig)) of_nudge = -0.02;
        else of_nudge = 0;
        entry_confidence = clamp01(entry_confidence + Math.max(-0.03, Math.min(0.03, of_nudge)));
      }
    }
    const signal_confidence = clamp01(Math.abs((tfResults['1h']?.score ?? 0)) / 40);
    // Hybrid readiness: pullback mode uses inZone; breakout mode uses nearTrigger
    let entryMode = (pullbackValid ? 'PULLBACK' : 'BREAKOUT');
    // -------- Phase 4: Zone quality bonus (confidence-only) --------
    if (flags.zone_quality && bestZone) {
      let bonus = 0;
      const confl = (bestZone.includes0714 ? 1 : 0) + (bestZone.includesExt ? 1 : 0) + (bestZone.fvg_overlap ? 1 : 0);
      bonus += Math.min(0.02, confl * 0.01);
      // equal highs/lows sweeps and wick rejections near zone
      const arr15 = normalized['15m'] || [];
      const K = 30;
      const start = Math.max(0, arr15.length - K);
      let eqCount = 0, wickCount = 0;
      for (let k=start; k<arr15.length; k++){
        const c = arr15[k];
        const h = toNum(c?.high), l = toNum(c?.low), o = toNum(c?.open), cl = toNum(c?.close);
        if (!Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(o) || !Number.isFinite(cl)) continue;
        const eps = (atrRef ?? (lastPrice ?? 1)*0.003) * 0.15;
        const nearHigh = Math.abs(h - zoneMid) <= eps || Math.abs(h - bestZone.high) <= eps;
        const nearLow  = Math.abs(l - zoneMid) <= eps || Math.abs(l - bestZone.low)  <= eps;
        // equal highs/lows detection (very rough)
        if (nearHigh || nearLow) eqCount++;
        // wick rejection: long wick touching zone
        const body = Math.abs(cl - o);
        const upperW = h - Math.max(cl, o);
        const lowerW = Math.min(cl, o) - l;
        if ((nearHigh && upperW > body * 1.2) || (nearLow && lowerW > body * 1.2)) wickCount++;
      }
      bonus += Math.min(0.02, (eqCount >= 2 ? 0.01 : 0) + (wickCount >= 2 ? 0.01 : 0));
      // equilibrium bias: zone near 50% of impulse leg
      if (impulse && impulse.low != null && impulse.high != null) {
        const midLeg = (impulse.low + impulse.high)/2;
        const d = Math.abs(((bestZone.low + bestZone.high)/2) - midLeg);
        const tol = (atrRef ?? (lastPrice ?? 1)*0.003) * 0.8;
        if (d <= tol) bonus += 0.01;
      }
      entry_confidence = clamp01(entry_confidence + Math.min(0.05, bonus));
    }
    const bypassLtf = (signal_confidence >= 0.75) && (entry_confidence >= 0.70);
    const ready = (signal_confidence >= 0.6) &&
                  (entry_confidence >= 0.6) &&
                  ((bypassLtf) || confirm) &&
                  (entryMode === 'PULLBACK' ? (inZone || nearZone) : nearTrigger);

    // Regime preference: gently bias entryMode if both conditions nearby
    if (flags.regime_filter && regimeContext.regime === 'trend' && nearTrigger) entryMode = 'BREAKOUT';

    // -------- Phase E: Telemetry sampling (behind flag) --------
    const telemetrySample = flags.instrumentation && (Math.random() < 0.2);
    if (telemetrySample) {
      const gateStates = {
        signal_confidence: Number(signal_confidence.toFixed(3)),
        entry_confidence: Number(entry_confidence.toFixed(3)),
        confirm: !!confirm,
        bypassLtf: !!bypassLtf,
        in_zone: !!inZone,
        near_zone: !!nearZone,
        near_trigger: !!nearTrigger,
        entry_mode: entryMode,
      };
      const gateFailures = [];
      if (!(signal_confidence >= 0.6)) gateFailures.push('signal_confidence');
      if (!(entry_confidence >= 0.6)) gateFailures.push('entry_confidence');
      if (!((bypassLtf) || confirm)) gateFailures.push('ltf_confirm');
      if (!(entryMode === 'PULLBACK' ? (inZone || nearZone) : nearTrigger)) gateFailures.push(entryMode === 'PULLBACK' ? 'proximity_pullback' : 'proximity_breakout');
      // Entry proposal snapshot and classification
      const entrySnapshot = (() => {
        let entryVal = null;
        let range = { low: null, high: null };
        if (entryMode === 'PULLBACK' && suggestions?.level1?.entry != null) {
          entryVal = suggestions.level1.entry;
          range = suggestions.level1.entry_range || range;
        } else if (entryMode === 'BREAKOUT' && Number.isFinite(breakoutTrigger)) {
          entryVal = breakoutTrigger;
          range = { low: entryVal, high: entryVal };
        }
        const priceNow = lastPrice;
        let timing = 'unknown';
        if (Number.isFinite(priceNow) && Number.isFinite(range.low) && Number.isFinite(range.high)) {
          const lo = Math.min(range.low, range.high);
          const hi = Math.max(range.low, range.high);
          const inRange = priceNow >= lo && priceNow <= hi;
          if (inRange) timing = 'in-range';
          else if (dirMap === 'UP') timing = (priceNow > hi) ? 'late' : 'early';
          else if (dirMap === 'DOWN') timing = (priceNow < lo) ? 'late' : 'early';
        }
        return {
          entry: entryVal,
          entry_range_low: range.low,
          entry_range_high: range.high,
          price_now: priceNow,
          timing
        };
      })();
      console.log('[indicators][instrumentation] readiness', {
        ready,
        ready_final: readyFinal,
        gates: gateStates,
        failed: gateFailures,
        proposal: entrySnapshot,
        regime: regimeContext,
        of_nudge,
        wf_params: chosenCalib || null
      });
    }

    // -------- Phase 6: Cooldown (per symbol, best-effort) --------
    let readyFinal = ready;
    let cooldownInfo = null;
    if (flags.cooldown && symbol && dirMap && Array.isArray(normalized['15m'])) {
      const lastIdx = normalized['15m'].length - 1;
      const lastTs = normalized['15m']?.[lastIdx]?.openTime ?? Date.now();
      const key = `${symbol}|${dirMap}`;
      const state = COOLDOWN_STATE.get(key);
      const prevIdx = Number.isInteger(clientLastReadyIndex) ? clientLastReadyIndex : (Number.isInteger(state?.idx) ? state.idx : null);
      const prevTs = Number.isFinite(clientLastReadyTime) ? clientLastReadyTime : (Number.isFinite(state?.ts) ? state.ts : null);
      const M = 4; // bars
      const T = 60*60*1000; // 60 minutes
      const tooSoonByBars = Number.isInteger(prevIdx) && (lastIdx - prevIdx) < M;
      const tooSoonByTime = Number.isFinite(prevTs) && ((Number(lastTs) - prevTs) < T);
      if (readyFinal && (tooSoonByBars || tooSoonByTime)) {
        readyFinal = false;
        cooldownInfo = { blocked: true, barsSince: Number.isInteger(prevIdx) ? (lastIdx - prevIdx) : null, msSince: Number.isFinite(prevTs) ? (Number(lastTs)-prevTs) : null };
      }
      if (readyFinal) COOLDOWN_STATE.set(key, { idx: lastIdx, ts: Number(lastTs) });
    }

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
      // Confidence labels and pretty strings
      ...(() => {
        function confidenceLabel(x) {
          const v = Number(x);
          if (!Number.isFinite(v)) return 'low';
          if (v >= 0.70) return 'high';
          if (v >= 0.40) return 'medium';
          return 'low';
        }
        const bias_confidence_label = confidenceLabel(signal_confidence);
        const entry_confidence_label = confidenceLabel(entry_confidence);
        const flip_confidence_value = Number(((bestZone?.score ?? 0)).toFixed(3));
        const flip_confidence_label = confidenceLabel(flip_confidence_value);
        return {
          bias_confidence_label,
          entry_confidence_label,
          bias_confidence_pretty: `${signal_confidence.toFixed(3)} (${bias_confidence_label})`,
          entry_confidence_pretty: `${entry_confidence.toFixed(3)} (${entry_confidence_label})`,
          // surface flip labels also at top-level for clients if needed
          flip_confidence_label,
          flip_confidence_pretty: `${flip_confidence_value.toFixed(3)} (${flip_confidence_label})`,
        };
      })(),
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
      order_plan: (() => {
        const side = (() => {
          if (final_signal === 'STRONG BUY') return 'STRONG BUY';
          if (final_signal === 'BUY') return 'BUY';
          if (final_signal === 'STRONG SELL') return 'STRONG SELL';
          if (final_signal === 'SELL') return 'SELL';
          return 'HOLD';
        })();
        // Build plan for pullback or breakout
        if (entryMode === 'PULLBACK' && bestZone && bands && bands.level1 && suggestions.level1) {
          const entryVal = suggestions.level1.entry;
          const entryRange = { low: suggestions.level1.entry_range.low, high: suggestions.level1.entry_range.high };
          const entryType = (() => {
            if (dirMap === 'UP') return (Number.isFinite(lastPrice) && Number.isFinite(entryVal) && entryVal < lastPrice) ? 'LIMIT' : 'STOP';
            if (dirMap === 'DOWN') return (Number.isFinite(lastPrice) && Number.isFinite(entryVal) && entryVal > lastPrice) ? 'LIMIT' : 'STOP';
            return null;
          })();
          return {
            side,
            entry_mode: entryMode,
            entry_type: entryType,
            entry_range: entryRange,
            entry: entryVal,
            stop: suggestions.level1.stop_loss,
            tp1: suggestions.level1.take_profit_1,
            tp2: suggestions.level1.take_profit_2,
            atr_used: suggestions.level1.atr_used,
            ready: readyFinal
          };
        }
        // Breakout fallback plan
        const trigger = breakoutTrigger;
        const entryVal = Number.isFinite(trigger) ? trigger : null;
        const entryRange = { low: entryVal, high: entryVal };
        const m = slMultipliers['level1'];
        const stopsTargets = computeStopsAndTargets(dirMap, entryVal, atrRef, m);
        const entryType = (() => {
          if (dirMap === 'UP') return (Number.isFinite(entryVal) && Number.isFinite(lastPrice) && entryVal > lastPrice) ? 'STOP' : 'LIMIT';
          if (dirMap === 'DOWN') return (Number.isFinite(entryVal) && Number.isFinite(lastPrice) && entryVal < lastPrice) ? 'STOP' : 'LIMIT';
          return null;
        })();
        return {
          side,
          entry_mode: entryMode,
          entry_type: entryType,
          entry_range: entryRange,
          entry: entryVal,
          stop: stopsTargets?.sl ?? null,
          tp1: stopsTargets?.tp1 ?? null,
          tp2: stopsTargets?.tp2 ?? null,
          atr_used: atrRef,
          ready: readyFinal
        };
      })(),
      flip_zone: bestZone ? {
        price: zoneMid,
        description: bestZone.includes0714 ? 'includes 0.714 confluence' : (bestZone.includesExt ? 'includes extension confluence' : 'confluence zone'),
        action: final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : null),
        direction_after: final_signal.includes('BUY') ? 'BUY' : (final_signal.includes('SELL') ? 'SELL' : null),
        confidence: Number((bestZone.score ?? 0).toFixed(3)),
        confidence_label: (() => {
          const v = Number((bestZone?.score ?? 0).toFixed(3));
          if (v >= 0.70) return 'high';
          if (v >= 0.40) return 'medium';
          return 'low';
        })(),
        confidence_pretty: (() => {
          const v = Number((bestZone?.score ?? 0).toFixed(3));
          const lbl = (v >= 0.70) ? 'high' : (v >= 0.40 ? 'medium' : 'low');
          return `${v.toFixed(3)} (${lbl})`;
        })()
      } : { price: null, description: null, action: null, direction_after: null, confidence: 0, confidence_label: 'low', confidence_pretty: '0.000 (low)' },
      structure: {
        bos: bos15 ? { dir: bos15.dir, broken_level: null, impulse_low: bos15.low, impulse_high: bos15.high } : null,
        swing_support: (() => { const e = lastPrice; if (!e) return null; const lows = swings15?.swingLows || []; const arr = lows.filter(x=>x.price < e).map(x=>x.price); return arr.length? Math.max(...arr): null; })(),
        swing_resistance: (() => { const e = lastPrice; if (!e) return null; const highs = swings15?.swingHighs || []; const arr = highs.filter(x=>x.price > e).map(x=>x.price); return arr.length? Math.min(...arr): null; })()
      },
      debug: {
        confirm: !!confirm,
        in_zone: !!inZone,
        near_trigger: !!nearTrigger,
        entry_mode: entryMode,
        ready_final: !!readyFinal,
        regime: regimeContext,
        of_nudge: typeof of_nudge === 'number' ? Number(of_nudge.toFixed(3)) : 0,
        wf_params: chosenCalib || null,
        adaptive_params_used: {
          pad: Number.isFinite(pad) ? Number(pad.toFixed(8)) : null,
          near_zone_half_factor: Number.isFinite(nearZoneHalfFactor) ? Number(nearZoneHalfFactor.toFixed(3)) : null,
          trigger_prox_atr: Number.isFinite(TRIGGER_PROX_ATR) ? Number(TRIGGER_PROX_ATR.toFixed(3)) : null
        }
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

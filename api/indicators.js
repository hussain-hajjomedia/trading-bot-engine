// api/indicators-swing.js
// Full swing indicator engine — copy/paste ready
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Only POST allowed' });
    return;
  }

  try {
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

    // normalize and limit to last 500 candles as you said
    function takeLast(arr, n = 500) {
      if (!Array.isArray(arr)) return [];
      if (arr.length <= n) return arr;
      return arr.slice(arr.length - n);
    }

    // Ensure ascending sort by openTime, dedupe by openTime, drop incomplete last bar if closeTime is in the future
    function finalizeCandles(rawArr) {
      if (!Array.isArray(rawArr)) return [];
      const arr = rawArr
        .filter(c => c && c.openTime != null && Number.isFinite(Number(c.openTime)));
      arr.sort((a, b) => Number(a.openTime) - Number(b.openTime));
      // dedupe by openTime (keep first after sorting)
      const out = [];
      const seen = new Set();
      for (let i = 0; i < arr.length; i++) {
        const ot = Number(arr[i].openTime);
        if (seen.has(ot)) continue;
        seen.add(ot);
        out.push(arr[i]);
      }
      // drop last if it has a future closeTime (in-progress bar)
      if (out.length) {
        const last = out[out.length - 1];
        const ct = last && last.closeTime != null ? Number(last.closeTime) : null;
        if (ct != null && Number.isFinite(ct) && ct > Date.now()) out.pop();
      }
      return out;
    }

    const normalized = {
      '15m': takeLast(finalizeCandles(normalizeCandlesRaw(kline_15m)), 500),
      '1h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_1h)), 500),
      '4h' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_4h)), 500),
      '1d' : takeLast(finalizeCandles(normalizeCandlesRaw(kline_1d)), 500),
    };

    console.log('[swing] symbol=', symbol, 'lengths=', {
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
      const trend = new Array(len).fill(null); // 1 up, -1 down
      for (let i = 0; i < len; i++) {
        if (i === 0) {
          finalUpper[i] = upperBasic[i];
          finalLower[i] = lowerBasic[i];
          st[i] = null;
          trend[i] = null;
          continue;
        }
        // Carry-forward logic (classic ST)
        finalUpper[i] = (upperBasic[i] < (finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]) || closes[i - 1] > (finalUpper[i - 1] == null ? Infinity : finalUpper[i - 1]))
          ? upperBasic[i]
          : finalUpper[i - 1];
        finalLower[i] = (lowerBasic[i] > (finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]) || closes[i - 1] < (finalLower[i - 1] == null ? -Infinity : finalLower[i - 1]))
          ? lowerBasic[i]
          : finalLower[i - 1];
        // Determine current ST band and trend state
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
    function findSwingPoints(candles, lookback = 3) {
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
        if (isLow)  swingLows.push({ index: i, price: low });
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

    // ---------- Analysis per timeframe (swing optimized) ----------
    function analyzeTimeframe(tfName, candles) {
      const result = { tf: tfName, indicators: {}, last: {}, score: 0, reasons: [], signal: 'HOLD' };
      const closes = candles.map(c => toNum(c.close));
      const highs = candles.map(c => toNum(c.high));
      const lows = candles.map(c => toNum(c.low));
      const volumes = candles.map(c => toNum(c.volume));
      if (closes.length < 20) return result;

      const sma50 = sma(closes, 50);
      const sma200 = sma(closes, 200);
      const ema9 = ema(closes, 9);
      const ema21 = ema(closes, 21);
      const rsi14 = rsiWilder(closes, 14);
      const macdObj = macd(closes);
      const atr14 = atr(highs, lows, closes, 14);
      const stObj = superTrendCanonical(highs, lows, closes, 10, 3);
      const st = stObj.st;
      const volSMA20 = sma(volumes, 20);

      const i = closes.length - 1;
      const last = { close: closes[i], high: highs[i], low: lows[i], volume: volumes[i], time: candles[i].openTime };
      result.last = last;

      result.indicators = {
        sma50: sma50[i], sma200: sma200[i],
        ema9: ema9[i], ema21: ema21[i],
        rsi14: rsi14[i],
        macd: macdObj.macdLine[i], macd_signal: macdObj.signalLine[i], macd_hist: macdObj.hist[i],
        atr14: atr14[i],
        supertrend: st[i],
        bb_upper: null, bb_mid: null, bb_lower: null,
        vol_sma20: volSMA20[i], volume: volumes[i]
      };

      // scoring rules tuned for swing bias
      let score = 0;
      const sf = 1.0;
      if (last.close != null && result.indicators.sma50 != null) score += (last.close > result.indicators.sma50 ? 6 : -6) * sf;
      if (result.indicators.sma50 != null && result.indicators.sma200 != null) score += (result.indicators.sma50 > result.indicators.sma200 ? 10 : -10) * sf;
      if (last.close != null && result.indicators.ema9 != null) score += (last.close > result.indicators.ema9 ? 5 : -5) * sf;
      if (result.indicators.ema9 != null && result.indicators.ema21 != null) score += (result.indicators.ema9 > result.indicators.ema21 ? 3 : -3) * sf;
      if (result.indicators.macd != null && result.indicators.macd_signal != null && result.indicators.macd_hist != null) {
        if (result.indicators.macd > result.indicators.macd_signal && result.indicators.macd_hist > 0) score += 12 * sf;
        else if (result.indicators.macd < result.indicators.macd_signal && result.indicators.macd_hist < 0) score -= 12 * sf;
      }
      if (result.indicators.supertrend != null && last.close != null) score += (last.close > result.indicators.supertrend ? 8 : -8) * sf;
      if (result.indicators.rsi14 != null) {
        if (result.indicators.rsi14 < 30) score += 2 * sf; else if (result.indicators.rsi14 > 70) score -= 2 * sf;
      }
      if (result.indicators.volume != null && result.indicators.vol_sma20 != null) {
        if (result.indicators.volume > result.indicators.vol_sma20 * 1.3) score += 6 * sf;
        else if (result.indicators.volume < result.indicators.vol_sma20 * 0.7) score -= 3 * sf;
      }

      result.score = Math.max(-200, Math.min(200, Math.round(score)));
      if (result.score >= 40) result.signal = 'STRONG BUY';
      else if (result.score >= 16) result.signal = 'BUY';
      else if (result.score <= -40) result.signal = 'STRONG SELL';
      else if (result.score <= -16) result.signal = 'SELL';
      else result.signal = 'HOLD';

      return result;
    }

    const tfResults = {};
    for (const tf of Object.keys(normalized)) {
      tfResults[tf] = analyzeTimeframe(tf, normalized[tf]);
    }

    console.log('[swing] tfResults sample:', {
      '1d_score': tfResults['1d']?.score, '4h_score': tfResults['4h']?.score, '1h_score': tfResults['1h']?.score
    });

    // ---------- Voting / weights (swing) ----------
    // stronger weight to larger TFs: 1d > 4h > 1h > 15m
    const tfWeight = { '15m': 0.5, '1h': 1.5, '4h': 3.0, '1d': 4.0 };
    const tally = { BUY: 0, SELL: 0, HOLD: 0, 'STRONG BUY': 0, 'STRONG SELL': 0 };
    for (const tf of Object.keys(tfResults)) {
      const s = tfResults[tf].signal;
      const w = tfWeight[tf] || 1;
      tally[s] += w;
    }

    const strongBuyWeight = tally['STRONG BUY'], strongSellWeight = tally['STRONG SELL'];
    const buyWeight = tally['BUY'] + strongBuyWeight * 1.5;
    const sellWeight = tally['SELL'] + strongSellWeight * 1.5;
    let final_signal = 'HOLD';
    if (strongBuyWeight >= 4.0 && buyWeight > sellWeight) final_signal = 'STRONG BUY';
    else if (strongSellWeight >= 4.0 && sellWeight > buyWeight) final_signal = 'STRONG SELL';
    else if (buyWeight >= sellWeight && buyWeight >= 4.0) final_signal = 'BUY';
    else if (sellWeight > buyWeight && sellWeight >= 4.0) final_signal = 'SELL';
    else final_signal = 'HOLD';

    // Predefine flip-zone variables before debugging
    let flip_zone_price = null;
    let flip_zone_confidence = 0;
    let flip_zone_description = null;

        // ---------- DEBUG LOGGING & optional flip-zone override ----------
    try {
      // Helpful logs to diagnose why final_signal is HOLD
      console.log('[indicators][debug] tfResults summary:',
        {
          '15m_score': tfResults['15m']?.score,
          '1h_score': tfResults['1h']?.score,
          '4h_score': tfResults['4h']?.score,
          '1d_score': tfResults['1d']?.score,
          'final_signal_before': final_signal
        }
      );
      console.log('[indicators][debug] last closes:',
        {
          '15m': tfResults['15m']?.last?.close,
          '1h': tfResults['1h']?.last?.close,
          '4h': tfResults['4h']?.last?.close,
          '1d': tfResults['1d']?.last?.close
        }
      );
      console.log('[indicators][debug] flip zone:',
        { flip_zone_price, flip_zone_confidence }
      );
    } catch (e) {
      console.log('[indicators][debug] logging error', e);
    }
    
    // OPTIONAL: Flip-zone override rules
    // Configure these thresholds as you prefer:
    const OVERRIDE_CONFIDENCE = 0.60;    // require >= 0.6 confidence
    const OVERRIDE_MULTI_TF_COUNT = 2;   // require at least 2 higher TFs (1h/4h/1d) aligned with the flip direction
    // Determine current mid price to compare to flip zone
    let currentPrice = tfResults['1h']?.last?.close ?? tfResults['15m']?.last?.close ?? null;
    
    if (typeof flip_zone_price !== 'undefined' && flip_zone_price != null && typeof flip_zone_confidence !== 'undefined') {
      // determine direction: if currentPrice < flip_zone_price => likely trending DOWN through flip zone
      const dirFromFlip = currentPrice != null && currentPrice < flip_zone_price ? 'DOWN' : (currentPrice != null && currentPrice > flip_zone_price ? 'UP' : null);
    
      if (dirFromFlip && flip_zone_confidence >= OVERRIDE_CONFIDENCE && currentPrice != null) {
        // count higher-tf alignment (1h, 4h, 1d)
        let alignCount = 0;
        const checkTfAlign = (tf) => {
          const s = tfResults[tf]?.signal || 'HOLD';
          if (dirFromFlip === 'DOWN' && (s.includes('SELL') || s.includes('STRONG SELL'))) return 1;
          if (dirFromFlip === 'UP' && (s.includes('BUY') || s.includes('STRONG BUY'))) return 1;
          return 0;
        };
        alignCount += checkTfAlign('1h');
        alignCount += checkTfAlign('4h');
        alignCount += checkTfAlign('1d');
    
        console.log('[indicators][debug] flip override candidate', { dirFromFlip, flip_zone_confidence, alignCount });
    
        if (alignCount >= OVERRIDE_MULTI_TF_COUNT) {
          // Overwrite final_signal conservatively
          if (dirFromFlip === 'DOWN') final_signal = 'STRONG SELL';
          else if (dirFromFlip === 'UP') final_signal = 'STRONG BUY';
          console.log('[indicators][debug] final_signal OVERRIDDEN to', final_signal);
        } else {
          console.log('[indicators][debug] override conditions not met (alignCount < threshold)');
        }
      }
    }
    
    console.log('[swing] voting:', { buyWeight, sellWeight, final_signal });

    // ---------- ATR reference (4h) ----------
    function pickAtr4h() {
      const a4h = tfResults['4h']?.indicators?.atr14 ?? null;
      return a4h != null ? a4h : null;
    }
    let atrRef = pickAtr4h();
    const fallbackPrice = tfResults['4h']?.last?.close ?? tfResults['1h']?.last?.close ?? tfResults['15m']?.last?.close ?? null;
    // Percent-of-price fallback only; no absolute floors
    if (atrRef == null && fallbackPrice != null) atrRef = fallbackPrice * 0.003;

    // ---------- Swing structure & Fibonacci projections ----------
    // Prefer 4h for swing structure, fallback to 1h then 15m
    const swings4h = findSwingPoints(normalized['4h'], 3);
    const swings1h = findSwingPoints(normalized['1h'], 3);
    const swings15 = findSwingPoints(normalized['15m'], 3);

    // Dominant impulse detection from swings with ATR/recency threshold (prefer 4h)
    function dominantImpulseFromSwings(sw, atrVal, refPrice, maxLegs = 12) {
      if (!sw || !Array.isArray(sw.swingHighs) || !Array.isArray(sw.swingLows)) return null;
      const highs = sw.swingHighs.slice();
      const lows = sw.swingLows.slice();
      if (!highs.length || !lows.length) return null;
      // Merge pivots by index
      const pivots = [
        ...highs.map(h => ({ type: 'H', index: h.index, price: h.price })),
        ...lows.map(l => ({ type: 'L', index: l.index, price: l.price })),
      ].sort((a, b) => a.index - b.index);
      // Build legs between alternating pivot types
      const legs = [];
      for (let i = 1; i < pivots.length; i++) {
        const a = pivots[i - 1], b = pivots[i];
        if (a.type === b.type) continue;
        if (a.type === 'L' && b.type === 'H') {
          legs.push({ dir: 'UP', low: a.price, high: b.price, start: a.index, end: b.index });
        } else if (a.type === 'H' && b.type === 'L') {
          legs.push({ dir: 'DOWN', high: a.price, low: b.price, start: a.index, end: b.index });
        }
      }
      if (!legs.length) return null;
      // Consider only the last N legs
      const recent = legs.slice(-maxLegs);
      const price = refPrice != null ? refPrice : (recent.length ? (recent[recent.length - 1].high + recent[recent.length - 1].low) / 2 : null);
      const atr = atrVal != null ? atrVal : (price != null ? price * 0.003 : 0);
      const sizeThreshold = Math.max(atr * 2.5, (price != null ? price * 0.003 : 0));
      // Pick the most recent leg meeting threshold; else pick the largest recent leg
      for (let i = recent.length - 1; i >= 0; i--) {
        const leg = recent[i];
        const sz = Math.abs((leg.high ?? 0) - (leg.low ?? 0));
        if (sz >= sizeThreshold && Number.isFinite(sz) && sz > 0) return leg;
      }
      // Fallback: largest leg among recent
      let best = null, bestSize = -Infinity;
      for (const leg of recent) {
        const sz = Math.abs((leg.high ?? 0) - (leg.low ?? 0));
        if (Number.isFinite(sz) && sz > bestSize) { best = leg; bestSize = sz; }
      }
      return best;
    }

    let impulse =
      dominantImpulseFromSwings(swings4h, atrRef, fallbackPrice) ||
      dominantImpulseFromSwings(swings1h, atrRef, fallbackPrice) ||
      dominantImpulseFromSwings(swings15, atrRef, fallbackPrice) ||
      null;

    // compute fib extension/projection for that impulse
    function computeFibForImpulse(imp) {
      if (!imp || imp.low == null || imp.high == null) return null;
      const high = imp.high, low = imp.low;
      const leg = Math.abs(high - low);
      if (!isFinite(leg) || leg === 0) return null;
      if (imp.dir === 'UP') {
        const ext1382 = low + 1.382 * (high - low);
        const ext1618 = low + 1.618 * (high - low);
        const retr50 = low + 0.5 * (high - low);
        const retr618 = low + 0.618 * (high - low);
        return { dir: 'UP', retr50, retr618, ext1382, ext1618, low, high };
      } else {
        const ext1382 = high - 1.382 * (high - low);
        const ext1618 = high - 1.618 * (high - low);
        const retr50 = high - 0.5 * (high - low);
        const retr618 = high - 0.618 * (high - low);
        return { dir: 'DOWN', retr50, retr618, ext1382, ext1618, low, high };
      }
    }

    const fib = computeFibForImpulse(impulse);

    // determine flip-zone candidates:
    // If direction is UP, flip zone = extension area beyond high (ext1382/1618) OR retracement zone 0.5-0.618 for pullback entries.
    // We'll compute distances from current price to these levels and produce confidence.
    currentPrice = fallbackPrice;
    flip_zone_confidence = 0;
    flip_zone_description = null;
    flip_zone_price = null;
    if (fib && currentPrice != null) {
      // closeness scoring: nearer levels => higher confidence that flip could happen there
      function closenessScore(level) {
        if (!Number.isFinite(level) || level === 0) return 0;
        const pct = Math.abs((currentPrice - level) / level);
        // if within 0.5% -> 1.0 ; within 1.5% -> 0.7 ; within 3% -> 0.4 ; else smaller
        if (pct <= 0.005) return 1.0;
        if (pct <= 0.015) return 0.7;
        if (pct <= 0.03) return 0.4;
        if (pct <= 0.06) return 0.15;
        return 0.0;
      }
      const candidates = [];
      if (fib.dir === 'UP') {
        candidates.push({ name: 'retracement 0.5-0.618 zone', low: fib.retr50, high: fib.retr618, score: Math.max(closenessScore(fib.retr50), closenessScore(fib.retr618)) });
        candidates.push({ name: 'extension 1.382', low: fib.ext1382, high: fib.ext1382, score: closenessScore(fib.ext1382) });
        candidates.push({ name: 'extension 1.618', low: fib.ext1618, high: fib.ext1618, score: closenessScore(fib.ext1618) });
      } else {
        candidates.push({ name: 'retracement 0.5-0.618 zone', low: fib.retr50, high: fib.retr618, score: Math.max(closenessScore(fib.retr50), closenessScore(fib.retr618)) });
        candidates.push({ name: 'extension 1.382', low: fib.ext1382, high: fib.ext1382, score: closenessScore(fib.ext1382) });
        candidates.push({ name: 'extension 1.618', low: fib.ext1618, high: fib.ext1618, score: closenessScore(fib.ext1618) });
      }

      // structural support/resistance alignment: check if fib candidate sits near 4h swing high/low
      function structureAlignScore(level) {
        if (!Number.isFinite(level)) return 0;
        const sHigh = swings4h.swingHighs.map(s => s.price || 0);
        const sLow = swings4h.swingLows.map(s => s.price || 0);
        const nearHigh = sHigh.some(p => Math.abs((p - level) / Math.max(1, p)) < 0.02);
        const nearLow = sLow.some(p => Math.abs((p - level) / Math.max(1, p)) < 0.02);
        return nearHigh || nearLow ? 0.6 : 0;
      }

      // SMA gap factor: if SMA50 vs SMA200 on 4h is wide -> less likely immediate flip; if close -> more likely
      let smaGapFactor = 0.5;
      const s50 = tfResults['4h']?.indicators?.sma50, s200 = tfResults['4h']?.indicators?.sma200;
      if (s50 != null && s200 != null) {
        const gapPct = Math.abs(s50 - s200) / Math.max(1, Math.abs(s200));
        if (gapPct < 0.008) smaGapFactor = 1.0;
        else if (gapPct < 0.02) smaGapFactor = 0.8;
        else smaGapFactor = 0.45;
      }

      // volume factor: heavy volume on impulse increases flip validity
      let volFactor = 0.6;
      const vol4h = tfResults['4h']?.indicators?.volume, volSma = tfResults['4h']?.indicators?.vol_sma20;
      if (vol4h != null && volSma != null) volFactor = vol4h > volSma * 1.2 ? 1.0 : 0.6;

      // Combine candidate scores
      candidates.forEach(c => {
        const structScore = structureAlignScore((c.low + c.high) / 2);
        c.combined = (c.score * 0.6 + structScore * 0.25 + smaGapFactor * 0.1 + volFactor * 0.05);
      });
      // pick best candidate
      candidates.sort((a,b) => b.combined - a.combined);
      if (candidates.length) {
        const best = candidates[0];
        flip_zone_confidence = Math.max(0, Math.min(1, best.combined));
      
        // Compute the midpoint of the flip zone (exact price)
        const flipMid = (best.low + best.high) / 2
        flip_zone_price = flipMid;
        flip_zone_description = `${best.name} (${flipMid ? flipMid.toFixed(2) : 'n/a'})`;
      }
    }

    console.log('[swing] fib & flip:', { fibExists: !!fib, flip_zone_confidence, flip_zone_description });

    // ---------- Entry & TP/SL construction ----------
    // Reference timeframe for entry: prefer 4h structural last close
    const refTf = tfResults['4h']?.last?.close ? '4h'
                : tfResults['1h']?.last?.close ? '1h'
                : tfResults['15m']?.last?.close ? '15m' : '4h';
    const ref = tfResults[refTf];
    const lastClose = ref?.last?.close ?? fallbackPrice;

    // structure-based levels: nearest swing support/resistance
    const lowsPool =
      (Array.isArray(swings4h?.swingLows) && swings4h.swingLows.length) ? swings4h.swingLows :
      (Array.isArray(swings1h?.swingLows) && swings1h.swingLows.length) ? swings1h.swingLows :
      (Array.isArray(swings15?.swingLows) && swings15.swingLows.length) ? swings15.swingLows : [];
    const highsPool =
      (Array.isArray(swings4h?.swingHighs) && swings4h.swingHighs.length) ? swings4h.swingHighs :
      (Array.isArray(swings1h?.swingHighs) && swings1h.swingHighs.length) ? swings1h.swingHighs :
      (Array.isArray(swings15?.swingHighs) && swings15.swingHighs.length) ? swings15.swingHighs : [];
    const structureLow = nearestSwingBelow(lastClose, lowsPool) ?? ((lastClose != null && atrRef != null) ? (lastClose - atrRef * 2) : null);
    const structureHigh = nearestSwingAbove(lastClose, highsPool) ?? ((lastClose != null && atrRef != null) ? (lastClose + atrRef * 2) : null);

    // Build EMA21/EMA50 + Fib 0.5–0.618 confluence band on reference TF, sized by ATR
    function buildConfluenceBands() {
      if (lastClose == null) return null;
      const closesRef = (normalized[refTf] || []).map(c => toNum(c.close));
      const ema21Arr = ema(closesRef, 21);
      const ema50Arr = ema(closesRef, 50);
      const ema21v = ema21Arr[ema21Arr.length - 1];
      const ema50v = ema50Arr[ema50Arr.length - 1];
      const emaBand = (ema21v != null && ema50v != null)
        ? { low: Math.min(ema21v, ema50v), high: Math.max(ema21v, ema50v) }
        : null;
      const fibBand = fib
        ? { low: Math.min(fib.retr50, fib.retr618), high: Math.max(fib.retr50, fib.retr618) }
        : null;
      function overlap(a, b) {
        if (!a || !b) return null;
        const lo = Math.max(a.low, b.low);
        const hi = Math.min(a.high, b.high);
        return lo <= hi ? { low: lo, high: hi } : null;
      }
      let base = overlap(emaBand, fibBand) || emaBand || fibBand || { low: lastClose, high: lastClose };
      // If no overlap and both exist, pick the one closer to lastClose
      if (!overlap(emaBand, fibBand) && emaBand && fibBand) {
        const midE = (emaBand.low + emaBand.high) / 2;
        const midF = (fibBand.low + fibBand.high) / 2;
        base = Math.abs(lastClose - midE) <= Math.abs(lastClose - midF) ? emaBand : fibBand;
      }
      const a = Number.isFinite(atrRef) ? atrRef : (lastClose * 0.003);
      const pad1 = a * 0.15;
      const pad2 = a * 0.25;
      const pad3 = a * 0.40;
      function expand(band, pad) {
        if (!band || band.low == null || band.high == null) return { low: lastClose, high: lastClose };
        let lo = Math.min(band.low, band.high) - pad;
        let hi = Math.max(band.low, band.high) + pad;
        // Ensure non-zero width: at least 0.1 * ATR
        const minW = Math.max(a * 0.1, lastClose * 0.0005);
        if ((hi - lo) < minW) {
          const mid = (lo + hi) / 2;
          lo = mid - minW / 2;
          hi = mid + minW / 2;
        }
        return { low: lo, high: hi };
      }
      return {
        level1: expand(base, pad1),
        level2: expand(base, pad2),
        level3: expand(base, pad3),
      };
    }
    const bands = buildConfluenceBands() || { level1: { low: lastClose, high: lastClose }, level2: { low: lastClose, high: lastClose }, level3: { low: lastClose, high: lastClose } };
    const lvl1 = bands.level1, lvl2 = bands.level2, lvl3 = bands.level3;
    const entryPrice = (lvl1.low != null && lvl1.high != null) ? (lvl1.low + lvl1.high) / 2 : (lastClose != null ? lastClose : null);

    // ---------- SL/TP via ATR and Fib (if useful) ----------
    const slMultipliers = { level1: 1.0, level2: 1.6, level3: 2.6 };
    const suggestions = {};
    const levels = ['level1', 'level2', 'level3'];

    // compute fib-based targets for swing (if trend and fib available)
    function computeFibTargets(trendDir) {
      if (!fib) return { tp1: null, tp2: null, refHigh: null, refLow: null };
      if (trendDir === 'UP') return { tp1: fib.high, tp2: fib.ext1618 || fib.ext1382, refHigh: fib.high, refLow: fib.low };
      if (trendDir === 'DOWN') return { tp1: fib.low, tp2: fib.ext1618 || fib.ext1382, refHigh: fib.high, refLow: fib.low };
      return { tp1: null, tp2: null, refHigh: null, refLow: null };
    }

    for (const lvl of levels) {
      const m = slMultipliers[lvl];
      let sl = null, tp1 = null, tp2 = null;
      const entry = entryPrice;

      if (entry == null || atrRef == null) {
        sl = entry ? entry - (entry * 0.02) : null;
        tp1 = entry ? entry + (entry * 0.03) : null;
        tp2 = entry ? entry + (entry * 0.06) : null;
      } else {
        if (final_signal.includes('BUY')) {
          // structural SL: below last major swing low
          const structural = (impulse && impulse.low != null) ? impulse.low * 0.995 : (entry - atrRef * m);
          sl = Math.min(structural, entry - atrRef * m);
          const fibTargets = computeFibTargets('UP');
          tp1 = fibTargets.tp1 ?? (entry + atrRef * (m * 1.2));
          tp2 = fibTargets.tp2 ?? (entry + atrRef * (m * 2.6));
        } else if (final_signal.includes('SELL')) {
          const structural = (impulse && impulse.high != null) ? impulse.high * 1.005 : (entry + atrRef * m);
          sl = Math.max(structural, entry + atrRef * m);
          const fibTargets = computeFibTargets('DOWN');
          tp1 = fibTargets.tp1 ?? (entry - atrRef * (m * 1.2));
          tp2 = fibTargets.tp2 ?? (entry - atrRef * (m * 2.6));
        } else {
          sl = entry - atrRef * m;
          tp1 = entry + atrRef * (m * 0.9);
          tp2 = entry + atrRef * (m * 1.8);
        }
      }

      // safety clamps: do not propose SL farther than 8% and TP farther than 12% (swing safety)
      function clamp(val, base, pct) {
        if (!Number.isFinite(val) || !Number.isFinite(base)) return val;
        const cap = Math.abs(base) * pct;
        if (Math.abs(val - base) > cap) return base + Math.sign(val - base) * cap;
        return val;
      }
      if (entry != null) {
        sl = clamp(sl, entry, 0.08);
        tp1 = clamp(tp1, entry, 0.12);
        tp2 = clamp(tp2, entry, 0.2);
      }

      // Quantize to inferred tick size
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
        // normalize to a clean decimal step
        const exp = Math.ceil(-Math.log10(minStep));
        const tick = Math.pow(10, -Math.max(0, Math.min(8, exp)));
        // snap to common BTCUSDT steps where applicable
        if (tick < 0.01) return 0.01;
        if (tick > 1) return 0.1;
        return tick;
      }
      const tick = inferTickSize(refTf);
      const side = final_signal.includes('BUY') ? 'LONG' : (final_signal.includes('SELL') ? 'SHORT' : 'FLAT');
      const floorToTick = (p) => (p == null ? p : Math.floor(p / tick) * tick);
      const ceilToTick  = (p) => (p == null ? p : Math.ceil(p / tick) * tick);
      const roundToTick = (p) => (p == null ? p : Math.round(p / tick) * tick);

      const qEntry = roundToTick(entry);
      let qSL = sl;
      let qTP1 = tp1;
      let qTP2 = tp2;
      if (side === 'LONG') {
        qSL  = floorToTick(sl);
        qTP1 = floorToTick(tp1);
        qTP2 = floorToTick(tp2);
      } else if (side === 'SHORT') {
        qSL  = ceilToTick(sl);
        qTP1 = ceilToTick(tp1);
        qTP2 = ceilToTick(tp2);
      } else {
        qSL  = roundToTick(sl);
        qTP1 = roundToTick(tp1);
        qTP2 = roundToTick(tp2);
      }

      const qBandLow  = floorToTick(lvl === 'level1' ? lvl1.low : (lvl === 'level2' ? lvl2.low : lvl3.low));
      const qBandHigh = ceilToTick (lvl === 'level1' ? lvl1.high: (lvl === 'level2' ? lvl2.high: lvl3.high));

      suggestions[lvl] = {
        entry: qEntry,
        entry_range: { low: qBandLow, high: qBandHigh },
        stop_loss: qSL,
        take_profit_1: qTP1,
        take_profit_2: qTP2,
        atr_used: atrRef,
        sl_multiplier: m,
      };
    }

    // ---------- Confidence scoring (continuous 0..1) ----------
    function clamp01(x) { return Math.max(0, Math.min(1, x)); }
    // Signal confidence from vote dominance and reference TF score magnitude
    const totalW = Object.keys(tfResults).reduce((s, tf) => s + (tfWeight[tf] || 0), 0);
    const voteDominance = totalW ? Math.abs((buyWeight ?? 0) - (sellWeight ?? 0)) / totalW : 0;
    const refScore = Math.abs(ref?.score ?? 0);
    const scoreNorm = clamp01(refScore / 60);
    const signal_confidence = clamp01(0.6 * voteDominance + 0.4 * scoreNorm);
    // Entry confidence from band proximity, structure alignment, and supertrend alignment
    function gaussian(x, s) { if (!Number.isFinite(x) || !Number.isFinite(s) || s <= 0) return 0; return Math.exp(-(x*x)/(2*s*s)); }
    const bandMid = (lvl1.low != null && lvl1.high != null) ? (lvl1.low + lvl1.high) / 2 : lastClose;
    const distToBand = (lastClose != null && bandMid != null) ? Math.abs(lastClose - bandMid) : null;
    const bandProx = distToBand == null ? 0 : gaussian(distToBand, (atrRef ?? (lastClose*0.003)) * 0.6);
    const structProx = (() => {
      if (bandMid == null) return 0;
      const candidates = [];
      if (Number.isFinite(structureLow)) candidates.push(Math.abs(bandMid - structureLow));
      if (Number.isFinite(structureHigh)) candidates.push(Math.abs(bandMid - structureHigh));
      if (!candidates.length) return 0;
      const d = Math.min(...candidates);
      const s = (atrRef ?? (lastClose*0.003)) * 1.2;
      return gaussian(d, s);
    })();
    const stAlign = (() => {
      const stv = ref?.indicators?.supertrend ?? null;
      if (stv == null || lastClose == null) return 0.4;
      if (final_signal.includes('BUY'))  return lastClose > stv ? 1.0 : 0.2;
      if (final_signal.includes('SELL')) return lastClose < stv ? 1.0 : 0.2;
      return 0.5;
    })();
    const entry_confidence = clamp01(0.55 * bandProx + 0.25 * structProx + 0.20 * stAlign);

    // ---------- Compose final output (structure preserved) ----------
    // Build reasons array like before but include flip_zone_confidence as an object entry so sheet can pick it up
    const reasons = [];
    for (const tf of Object.keys(tfResults)) {
      const r = tfResults[tf];
      if (r.reasons?.length) reasons.push({ timeframe: tf, score: r.score, reasons: r.reasons.slice(0, 6) });
      else reasons.push({ timeframe: tf, score: r.score, reasons: [] });
    }
    // add flip zone object for downstream processing (sheet, LLM)
    reasons.push({
      flip_zone_confidence: flip_zone_confidence,
      flip_zone_price: flip_zone_price,
      flip_zone_description
    });
    // add continuous confidences (kept inside reasons to preserve schema)
    reasons.push({
      signal_confidence,
      entry_confidence
    });

    const output = {
      symbol: symbol || null,
      exchangeSymbol: exchangeSymbol || null,
      final_signal,
      votesSummary: {
        weighted: {
          buyWeight,
          sellWeight,
          strongBuyWeight,
          strongSellWeight,
        },
        byTf: Object.fromEntries(Object.keys(tfResults).map(k => [k, tfResults[k].signal]))
      },
      suggestions,
      reasons,
      details: tfResults,
    };

    console.log('[swing] final output signal=', final_signal);
    return res.status(200).json(output);

  } catch (err) {
    console.error('[swing] error', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'internal error', detail: String(err && (err.stack || err.message || err)) });
  }
}
